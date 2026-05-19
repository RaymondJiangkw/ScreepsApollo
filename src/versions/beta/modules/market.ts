/**
 * 市场管理模块
 * 核心思想是 少则买, 多则卖
 * 自动程序不挂单 (因为挂单需要预留资源, 可能浪费空间)
 * 需要提供函数方便手动挂单和执行单
 * 
 * 主要思路: 维持 storage 和 terminal 内资源
 * terminal 内资源从 storage 中取 (有列表), 或者 买; 特定资源多了, 就卖
 * storage 内资源从 terminal 中取 (有列表), 或者 生产
 */

import { Apollo as A } from '@/framework/apollo'
import { planModule as P } from '@/modules/plan'
import { getTransferUnit, transferModule as T } from "@/modules/transfer"
import { assertWithMsg, getFileNameAndLineNumber, log, LOG_DEBUG, LOG_ERR } from "@/utils"
import { getCentralTransferUnit } from './centralTransfer'
import { getStorageMinMaintainAmount, getTerminalBuyInfo, getTerminalMaintainAmount, getTerminalMaintainFromStorageList, getTerminalMaxMaintainAmount, getTerminalMinMaintainAmount, getTerminalSellList } from '../config.production'

/** 因为不同 Terminal 可能同时执行, 然后 Credits 没有更新, 所以限制同一 tick, 只有一个 order 执行 */
let lastExecutionTick = null

/** 至少有这么多能量, 才开始扫单 */
const MIN_EXECUTION_ENERGY = 500
/** 至少有这么多 Credits, 才开始买货 */
const MIN_BUYING_CREDITS = 10_000

type PriceHistoryTrackerMemory = {
    lastDate: string        // "YYYY-MM-DD"
    fairPrice: number       // EMA of avgPrice
    stddev: number          // EMA of stddevPrice
}

declare global {
    interface Memory {
        priceHistoryTracker?: {[resourceType in ResourceConstant]? : PriceHistoryTrackerMemory};
    }
}

function getPricePolicy(): 'fair' | 'force' {
    if ( !('pricePolicy' in (Memory as any)) ) return 'fair'
    return (Memory as any).pricePolicy
}

class PriceHistoryTracker {
    #DEFAULT_ALPHA = 0.05
    #DEFAULT_MARGIN = 0.08
    #DEFAULT_STDDEV_FACTOR = 0.5
    #DEFAULT_MAX_RELATIVE_STD = 0.5

    #HyperParametersHub: { [resourceType in ResourceConstant]? : { margin: number, stddevFactor: number, maxRelativeStd: number } } = {
        [ RESOURCE_ENERGY ]: {
            margin: 0.05, stddevFactor: 0.25, maxRelativeStd: 0.2
        }
    }

    #ema(oldValue: number, newValue: number, alpha: number): number {
        return oldValue * (1 - alpha) + newValue * alpha;
    }

    #getCache() {
        if ( !Memory.priceHistoryTracker ) Memory.priceHistoryTracker = {}
        return Memory.priceHistoryTracker
    }

    #update(resource: ResourceConstant | CPU_UNLOCK | ACCESS_KEY | PIXEL): void {
        const history = Game.market.getHistory(resource)
        if (history.length === 0 || !Array.isArray(history)) return

        const cache = this.#getCache()

        if (!cache[resource]) cache[resource] = {
            lastDate: null, fairPrice: null, stddev: null
        }
        const state = cache[resource]
        let maxDate = null

        for (const h of history) {
            if (h.avgPrice <= 0 || h.volume <= 0 || h.transactions <= 0) continue

            if (!!state.lastDate && Date.parse(h.date) <= Date.parse(state.lastDate)) continue

            const relativeVolatility = h.stddevPrice / Math.max(h.avgPrice, 0.001);

            const liquidity = Math.log10(h.volume + 10)

            /**
             * volatilityPenalty:
             *   high volatility -> smaller value
             */
            const volatilityPenalty = 1 / (1 + 4 * relativeVolatility)

            /**
             * liquidityBoost:
             *   bounded into [0, 1)
             */
            const liquidityBoost = liquidity / (liquidity + 1);

            const alpha = this.#DEFAULT_ALPHA * volatilityPenalty * liquidityBoost

            if ( !state.fairPrice ) {
                state.fairPrice = h.avgPrice
                state.stddev = h.stddevPrice
            } else {
                state.fairPrice = this.#ema(state.fairPrice, h.avgPrice, alpha)
                state.stddev = this.#ema(state.stddev || 0, h.stddevPrice, alpha)
            }

            if ( !maxDate || Date.parse(h.date) > Date.parse(maxDate) ) maxDate = h.date
        }
        state.lastDate = maxDate || state.lastDate
    }

    #updateAll(): void {
        for (const resource of [...RESOURCES_ALL, CPU_UNLOCK, ACCESS_KEY, PIXEL]) {
            this.#update(resource)
        }
    }

    #getState(resource: ResourceConstant): PriceHistoryTrackerMemory {
        const cache = this.#getCache()
        if ( !(resource in cache) ) this.#update(resource)
        return cache[resource]
    }

    #getThresholds(resource: ResourceConstant): { buyBelow: number; sellAbove: number; fairPrice: number } {
        let options = this.#HyperParametersHub[resource]
        if ( !options ) options = { margin: this.#DEFAULT_MARGIN, stddevFactor: this.#DEFAULT_STDDEV_FACTOR, maxRelativeStd: this.#DEFAULT_MAX_RELATIVE_STD }

        const state = this.#getState(resource);
        if ( !state.fairPrice ) return { buyBelow: 0, sellAbove: Infinity, fairPrice: 0 }

        const margin = options.margin
        const stddevFactor = options.stddevFactor
        const maxRelativeStd = options.maxRelativeStd

        const fair = Math.max(state.fairPrice, 0.001)
        const stddev = state.stddev || 0

        const relativeStd = stddev / fair
        const cappedRelativeStd = Math.min(relativeStd, maxRelativeStd)

        const dynamicMargin = margin + stddevFactor * cappedRelativeStd

        return {
            fairPrice: fair,
            buyBelow: Math.max(0.001, fair * (1 - dynamicMargin)),
            sellAbove: fair * (1 + dynamicMargin),
        }
    }

    #judgePrice(resource: ResourceConstant, price: number): 'hold' | 'buy' | 'sell' {
        const thresholds = this.#getThresholds(resource)
        if (price <= thresholds.buyBelow) return "buy"
        if (price >= thresholds.sellAbove) return "sell"
        return "hold";
    }

    #addEnergyPrice(roomNameU: string, roomNameV: string) {
        return this.#getThresholds(RESOURCE_ENERGY).fairPrice * (1 - Math.exp(-Game.map.getRoomLinearDistance(roomNameU, roomNameV) / 30.))
    }

    isGoodBuy(resource: ResourceConstant, price: number, roomNameU: string, roomNameV: string): boolean {
        if ( getPricePolicy() === 'fair' ) return this.#judgePrice(resource, price + this.#addEnergyPrice(roomNameU, roomNameV)) === "buy"
        else return true
    }

    isGoodSell(resource: ResourceConstant, price: number, roomNameU: string, roomNameV: string): boolean {
        if ( getPricePolicy() === 'fair' ) return this.#judgePrice(resource, price - this.#addEnergyPrice(roomNameU, roomNameV)) === "sell"
        else return true
    }

    estimateFullCostForBuying() {
        let cost = 0
        for ( const resourceType in getTerminalBuyInfo() ) cost += getTerminalBuyInfo()[resourceType].max * this.#getThresholds(resourceType as ResourceConstant).buyBelow
        return cost
    }

    getFairPrice(resource: ResourceConstant) {
        const thresholds = this.#getThresholds(resource)
        console.log(`对于 ${resource}: Buy 阈值 (${thresholds.buyBelow}), Sell 阈值 (${thresholds.sellAbove}), Fair Price (${thresholds.fairPrice})`)
    }

    constructor() {
        this.#updateAll()
        A.timer.add(Game.time + 1, () => {
            this.#updateAll()
        }, [], `监视资源更新`, 24000) // at least 1000 for 1 hr
    }
}

const priceHistoryTracker = new PriceHistoryTracker()

type RoomSpecificMarketDescription = {
    buy: {
        [name in ResourceConstant]?: number
    }
    sell: {
        [name in ResourceConstant]?: number
    }
}

type CommonMarketDescription = {
    buy: {
        [name in PIXEL | ACCESS_KEY | CPU_UNLOCK]: number
    }
    sell: {
        [name in PIXEL | ACCESS_KEY | CPU_UNLOCK]: number
    }
}

function getMemoryCache(name: string): Object {
    if ( !('_market' in Memory) ) (Memory as any)._market = {}
    if ( !(name in (Memory as any)._market) ) (Memory as any)._market[name] = {}
    return (Memory as any)._market[name]
}

/** 用于通用资源 -- cpu / pixel / key etc. */
class MarketCommonDescriptor {
    getDescription() {
        const cache = getMemoryCache('common')
        if ( !('buy' in cache) ) cache['buy'] = {
            [PIXEL]: 0, [ACCESS_KEY]: 0, [CPU_UNLOCK]: 0
        }
        if ( !('sell' in cache) ) cache['sell'] = {
            [PIXEL]: 0, [ACCESS_KEY]: 0, [CPU_UNLOCK]: 0
        }
        return cache as CommonMarketDescription
    }
    #resetDescription(types: ('buy' | 'sell' | 'all') = 'all') {
        const cache = this.getDescription()
        if ( types === 'buy' || types === 'all' )
            cache['buy'] = {
                [PIXEL]: 0, [ACCESS_KEY]: 0, [CPU_UNLOCK]: 0
            }
        if ( types === 'sell' || types === 'all' )
            cache['sell'] = {
                [PIXEL]: 0, [ACCESS_KEY]: 0, [CPU_UNLOCK]: 0
            }
        return cache
    }
    constructor() {
        
    }
}

/** 用于每房间的资源 */
class MarketRoomDescriptor {
    #roomName: string
    getDescription() {
        const cache = getMemoryCache(this.#roomName)
        if ( !('buy' in cache) ) cache['buy'] = {}
        if ( !('sell' in cache) ) cache['sell'] = {}
        return cache as RoomSpecificMarketDescription
    }
    #resetDescription(types: ('buy' | 'sell' | 'all') = 'all') {
        const cache = this.getDescription()
        if ( types === 'buy' || types === 'all' ) cache['buy'] = {}
        if ( types === 'sell' || types === 'all' ) cache['sell'] = {}
        return cache
    }
    constructor(roomName: string) {
        this.#roomName = roomName
        assertWithMsg(!!Game.rooms[roomName] && !!Game.rooms[roomName].controller && Game.rooms[roomName].controller.my, `无法为非自己的房间 ${roomName} 创建市场描述器`)
        /** 检查当前描述是否有效 */
        const requiredCapacity = _.sum(Object.values(this.getDescription()['buy']))
        if ( !Game.rooms[roomName].terminal || A.res.query(Game.rooms[roomName].terminal.id, A.res.CAPACITY) < requiredCapacity ) {
            log(LOG_DEBUG, `无法找到 ${roomName} Terminal 或 Terminal Capacity 不够`)
            this.#resetDescription("buy")
        }
        let sellFlag = true
        for ( const resourceType in this.getDescription()["sell"] ) {
            if ( !Game.rooms[roomName].terminal || A.res.query(Game.rooms[roomName].terminal.id, resourceType as ResourceConstant) < this.getDescription()["sell"][resourceType] ) {
                sellFlag = false
                break
            }
        }
        if ( !sellFlag ) {
            log(LOG_DEBUG, `无法找到 ${roomName} Terminal 或 Terminal 内资源不对`)
            this.#resetDescription("sell")
        }
        /** 重新注册一遍 buy / sell */
        for ( const resourceType in this.getDescription()["buy"] ) {
            assertWithMsg( A.res.request({ id: Game.rooms[roomName].terminal.id, resourceType: A.res.CAPACITY, amount: this.getDescription()["buy"][resourceType] }) === A.proc.OK, getFileNameAndLineNumber() )
        }
        for ( const resourceType in this.getDescription()["sell"] ) {
            assertWithMsg( A.res.request({ id: Game.rooms[roomName].terminal.id, resourceType: resourceType as ResourceConstant, amount: this.getDescription()["sell"][resourceType] }) === A.proc.OK, getFileNameAndLineNumber() )
        }
    }
}

type TerminalStatusDescription = {
    [resourceType in ResourceConstant]?: number
}

class TerminalStatusDescriptor {
    #roomName: string
    getDescription(): TerminalStatusDescription {
        const cache = getMemoryCache(`terminal_${this.#roomName}`)
        return cache as TerminalStatusDescription
    }
    resetDescription() {
        const description = this.getDescription()
        const names = Object.keys(description)
        for (const name of names) delete description[name]
        return description
    }
    constructor(roomName: string) {
        this.#roomName = roomName
    }
}

class MarketModule {
    public tracker: PriceHistoryTracker
    #commonStatus: MarketCommonDescriptor
    #repo: {
        [roomName: string]: {
            terminalStatus: TerminalStatusDescriptor
            resourceStatus: MarketRoomDescriptor
            readySignal: string
        }
    }
    #issueOrderWatcher(orderId: string, reserve: boolean = true) {
        assertWithMsg( orderId in Game.market.orders, `无法找到 Order ${orderId}. Order 创建后必须在下一 tick 才开始监视` )
        if ( !Game.market.orders[orderId].active ) {
            log(LOG_ERR, `${orderId} 并不有效! ${JSON.stringify(Game.market.orders[orderId])}`)
            Game.market.cancelOrder(orderId)
            return
        }
        let lastAmount = Game.market.orders[orderId].amount
        // 不为非资源类 order 创建监视器
        if ( !_.includes(RESOURCES_ALL, Game.market.orders[orderId].resourceType) ) return
        assertWithMsg( !!Game.rooms[Game.market.orders[orderId].roomName] && !!Game.rooms[Game.market.orders[orderId].roomName].controller && Game.rooms[Game.market.orders[orderId].roomName].controller.my, `订单 ${orderId} 的房间 ${Game.market.orders[orderId].roomName} 无效` )
        if ( reserve ) {
            // 提前预留空间
            if ( Game.market.orders[orderId].type === ORDER_SELL ) {
                assertWithMsg( A.res.request({ id: Game.rooms[Game.market.orders[orderId].roomName].terminal.id, resourceType: Game.market.orders[orderId].resourceType as ResourceConstant, amount: Game.market.orders[orderId].amount }) === A.proc.OK, `订单 ${orderId} 卖出 ${Game.market.orders[orderId].amount} ${Game.market.orders[orderId].resourceType}, 但是没有充足余量!` )
            } else {
                assertWithMsg( A.res.request({ id: Game.rooms[Game.market.orders[orderId].roomName].terminal.id, resourceType: A.res.CAPACITY, amount: Game.market.orders[orderId].amount }) === A.proc.OK, `订单 ${orderId} 买入 ${Game.market.orders[orderId].amount} ${Game.market.orders[orderId].resourceType}, 但是没有充足容量!` )
                assertWithMsg( A.res.request({ id: Game.rooms[Game.market.orders[orderId].roomName].storage.id, resourceType: A.res.CAPACITY, amount: Game.market.orders[orderId].amount }) === A.proc.OK, `订单 ${orderId} 买入 ${Game.market.orders[orderId].amount} ${Game.market.orders[orderId].resourceType}, 但是没有充足容量!` )
            }
        }
        A.timer.add(Game.time + 1, () => {
            const order = Game.market.orders[orderId]
            if ( order.amount === 0 || !order.active ) {
                Game.market.cancelOrder(orderId)
                return A.timer.STOP
            }
            if ( order.amount === lastAmount ) return
            let updateAmount = lastAmount - order.amount
            lastAmount = order.amount
            const storage = Game.rooms[order.roomName].storage
            const terminal = Game.rooms[order.roomName].terminal
            if ( !storage || !terminal ) {
                log(LOG_ERR, `订单无法找到 Storage 或 Terminal!`)
                Game.market.cancelOrder(orderId)
                return A.timer.STOP
            }
            if ( order.type === ORDER_SELL )
                assertWithMsg( A.res.signal(Game.rooms[order.roomName].terminal.id, A.res.CAPACITY, updateAmount) === A.proc.OK, `Sell [${orderId}] 完成 ${updateAmount} 后应当成功更新容量` )
            else {
                // Terminal 一 signal 一 request, 抵消
                const resourceType = order.resourceType as ResourceConstant
                const roomName = order.roomName
                const unit = getCentralTransferUnit(Game.rooms[order.roomName].controller.level)
                this.#repo[order.roomName].terminalStatus.getDescription()[order.resourceType] = (this.#repo[order.roomName].terminalStatus.getDescription()[order.resourceType] || 0) + updateAmount
                for ( let patchIdx = 0; patchIdx < Math.ceil(updateAmount / unit); ++patchIdx ) {
                    const patchAmount = Math.min(unit, updateAmount - patchIdx * unit)

                    T.transfer(terminal.id, storage.id, resourceType, patchAmount, {
                        disallowGrouping: true, 
                        loseCallback: () => {
                            this.#repo[roomName].terminalStatus.getDescription()[resourceType] -= patchAmount
                            if ( this.#repo[roomName].terminalStatus.getDescription()[resourceType] === 0 ) {
                                delete this.#repo[roomName].terminalStatus.getDescription()[resourceType]
                            }
                        }, 
                        callback: () => {
                            this.#repo[roomName].terminalStatus.getDescription()[resourceType] -= patchAmount
                            if ( this.#repo[roomName].terminalStatus.getDescription()[resourceType] === 0 ) {
                                delete this.#repo[roomName].terminalStatus.getDescription()[resourceType]
                            }
                        }, 
                        priority: T.PRIORITY_CASUAL
                    })
                }
            }
        }, [], `Order ${orderId} 监视`, 1)
    }
    #issueInstantOrderWatcher(orderId: string, reserve: boolean = true) {
        assertWithMsg( orderId in Game.market.orders, `无法找到 Order ${orderId}. Order 创建后必须在下一 tick 才开始监视` )
        if ( !Game.market.orders[orderId].active ) {
            log(LOG_ERR, `${orderId} 并不有效! ${JSON.stringify(Game.market.orders[orderId])}`)
            Game.market.cancelOrder(orderId)
            return
        }
        assertWithMsg( Game.market.orders[orderId].type === ORDER_BUY, `Instant Order 只支持购买` )
        let lastAmount = Game.market.orders[orderId].amount
        // 不为非资源类 order 创建监视器
        if ( !_.includes(RESOURCES_ALL, Game.market.orders[orderId].resourceType) ) return
        assertWithMsg( !!Game.rooms[Game.market.orders[orderId].roomName] && !!Game.rooms[Game.market.orders[orderId].roomName].controller && Game.rooms[Game.market.orders[orderId].roomName].controller.my, `订单 ${orderId} 的房间 ${Game.market.orders[orderId].roomName} 无效` )
        if ( reserve ) {
            // 提前预留空间
            assertWithMsg( A.res.request({ id: Game.rooms[Game.market.orders[orderId].roomName].terminal.id, resourceType: A.res.CAPACITY, amount: Game.market.orders[orderId].amount }) === A.proc.OK, `订单 ${orderId} 买入 ${Game.market.orders[orderId].amount} ${Game.market.orders[orderId].resourceType}, 但是没有充足容量!` )
        }
        A.timer.add(Game.time + 1, () => {
            const order = Game.market.orders[orderId]
            if ( order.amount === 0 || !order.active ) {
                Game.market.cancelOrder(orderId)
                return A.timer.STOP
            }
            if ( order.amount === lastAmount ) return
            let updateAmount = lastAmount - order.amount
            lastAmount = order.amount
            const terminal = Game.rooms[order.roomName].terminal
            if ( !terminal ) {
                log(LOG_ERR, `订单无法找到 Terminal!`)
                Game.market.cancelOrder(orderId)
                return A.timer.STOP
            }
            const resourceType = order.resourceType as ResourceConstant
            assertWithMsg( A.res.signal(terminal.id, resourceType, updateAmount) === A.proc.OK, getFileNameAndLineNumber() )
        }, [], `Instant Order ${orderId} 监视`, 1)
    }
    /** 用于判断维持 / 买卖, 卖单仍假定在内 */
    #getEffectiveTerminalResourceAmount(roomName: string, resourceType: ResourceConstant) {
        let amount = 0
        if ( !Game.rooms[roomName] ) return amount
        if ( !!Game.rooms[roomName].terminal ) amount += A.res.query(Game.rooms[roomName].terminal.id, resourceType)
        // 检查扫单情况
        // 买卖单 (扫单的) 假定在库内
        if ( roomName in this.#repo ) {
            amount += this.#repo[roomName].resourceStatus.getDescription()["buy"][resourceType] || 0
            amount += this.#repo[roomName].resourceStatus.getDescription()["sell"][resourceType] || 0
        }
        // 检查挂单情况
        for ( const orderId in Game.market.orders ) {
            if ( Game.market.orders[orderId].roomName !== roomName || Game.market.orders[orderId].resourceType !== resourceType || Game.market.orders[orderId].type !== ORDER_SELL ) continue
            // 买单自动转运到 Storage 所以不算
            amount += Game.market.orders[orderId].amount || 0
        }
        return amount
    }
    #calcMaximumAmount(srcRoomName: string, tarRoomName: string, availableEnergy: number, isSendingEnergy: boolean) {
        if ( !isSendingEnergy ) return Math.floor(availableEnergy / (1. - Math.exp(-Game.map.getRoomLinearDistance(srcRoomName, tarRoomName, true) / 30.)))
        else {
            const unitCost = Math.ceil(1 + (1. - Math.exp(-Game.map.getRoomLinearDistance(srcRoomName, tarRoomName, true) / 30.)))
            return Math.floor(availableEnergy / unitCost)
        }
    }
    /** 帮助手动挂单, 挂单直接存 Terminal */
    createInstantOrder(roomName: string, resourceType: ResourceConstant, amount: number, price: number) {
        if ( !Game.rooms[roomName] || !Game.rooms[roomName].terminal ) return `${roomName} 无效, 或 Terminal 无法找到`
        // 校验 Order 是否能够成功
        const requiredCredits = amount * price * (1 + 0.05)
        if ( Game.market.credits < requiredCredits ) return `Credits 不够! 最多只能支持 ${Math.floor(Game.market.credits / price / (1 + 0.05))} 这么多`
        const capacity = A.res.query(Game.rooms[roomName].terminal.id, A.res.CAPACITY)
        if ( amount > capacity ) return `Capacity 不够! 最多只能支持 ${capacity} 这么多`
        assertWithMsg( A.res.request({ id: Game.rooms[roomName].terminal.id, resourceType: A.res.CAPACITY, amount }) === A.proc.OK, getFileNameAndLineNumber() )
        const config = {
            type: ORDER_BUY, resourceType: resourceType, price: price, totalAmount: amount, roomName: roomName
        }
        const retCode = Game.market.createOrder(config)
        assertWithMsg( retCode === OK, getFileNameAndLineNumber() )
        A.timer.add(Game.time + 2, (time, resourceType, price, amount, roomName) => {
            const order = _.filter(Game.market.orders, o => o.created === time && o.type === ORDER_BUY && o.resourceType === resourceType && Math.floor(o.price) === Math.floor(price) && o.totalAmount === amount && o.roomName === roomName)[0]
            assertWithMsg( !!order, `无法找到 (${time}, ${ORDER_BUY}, ${resourceType}, ${price}, ${amount}, ${roomName}) 的订单!` )
            this.#issueInstantOrderWatcher(order.id, false)
        }, [ Game.time, resourceType, price, amount, roomName ], `追踪创建的订单`)
        return `成功挂单! ${retCode}: ${JSON.stringify(config)}`
    }
    /** 帮助手动挂单, 挂单永远往 Storage 里存 */
    createOrder(orderType: ORDER_BUY | ORDER_SELL, roomName: string, resourceType: ResourceConstant, amount: number, price: number) {
        if ( !Game.rooms[roomName] || !Game.rooms[roomName].terminal || !Game.rooms[roomName].storage ) return `${roomName} 无效, 或 Storage / Terminal 无法找到`
        // 校验 Order 是否能够成功
        const requiredCredits = amount * price * (1 + 0.05)
        if ( Game.market.credits < requiredCredits ) return `Credits 不够! 最多只能支持 ${Math.floor(Game.market.credits / price / (1 + 0.05))} 这么多`
        if ( orderType === ORDER_BUY ) {
            const capacity = Math.min(A.res.query(Game.rooms[roomName].terminal.id, A.res.CAPACITY), A.res.query(Game.rooms[roomName].storage.id, A.res.CAPACITY))
            if ( amount > capacity ) return `Capacity 不够! 最多只能支持 ${capacity} 这么多`
            assertWithMsg( A.res.request({ id: Game.rooms[roomName].terminal.id, resourceType: A.res.CAPACITY, amount }) === A.proc.OK, getFileNameAndLineNumber() )
            assertWithMsg( A.res.request({ id: Game.rooms[roomName].storage.id, resourceType: A.res.CAPACITY, amount }) === A.proc.OK, getFileNameAndLineNumber() )
        } else {
            const available = A.res.query(Game.rooms[roomName].terminal.id, resourceType)
            if ( amount > available ) return `Availability 不够! 最多只能支持 ${available} 这么多`
            assertWithMsg( A.res.request({ id: Game.rooms[roomName].terminal.id, resourceType: resourceType, amount }) === A.proc.OK, getFileNameAndLineNumber() )
        }
        const config = {
            type: orderType, resourceType: resourceType, price: price, totalAmount: amount, roomName: roomName
        }
        const retCode = Game.market.createOrder(config)
        assertWithMsg( retCode === OK, getFileNameAndLineNumber() )
        A.timer.add(Game.time + 2, (time, orderType, resourceType, price, amount, roomName) => {
            const order = _.filter(Game.market.orders, o => o.created === time && o.type === orderType && o.resourceType === resourceType && Math.floor(o.price) === Math.floor(price) && o.totalAmount === amount && o.roomName === roomName)[0]
            assertWithMsg( !!order, `无法找到 (${time}, ${orderType}, ${resourceType}, ${price}, ${amount}, ${roomName}) 的订单!` )
            this.#issueOrderWatcher(order.id, false)
        }, [ Game.time, orderType, resourceType, price, amount, roomName ], `追踪创建的订单`)
        return `成功挂单! ${retCode}: ${JSON.stringify(config)}`
    }
    /** 帮助手动成交 */
    deal(orderId: string, amount: number, roomName: string, transferToStorage: boolean = true) {
        assertWithMsg( !!Game.rooms[roomName] && !!Game.rooms[roomName].controller && Game.rooms[roomName].controller.my && !!Game.rooms[roomName].terminal, `${roomName} 房间无效!` )
        if ( Game.rooms[roomName].terminal.cooldown > 0 ) return `Terminal 仍在冷却`
        const order = Game.market.getOrderById(orderId)
        if ( !order ) return `无法找到订单!`
        if ( order.amount < amount ) return `无法成交! 最多成交 ${order.amount} 这么多!`
        const energyCost = Game.market.calcTransactionCost(amount, roomName, order.roomName)
        if ( energyCost > A.res.query(Game.rooms[roomName].terminal.id, RESOURCE_ENERGY) ) return `无法成交! 能量不足, 最多成交 ${Math.floor(A.res.query(Game.rooms[roomName].terminal.id, RESOURCE_ENERGY) / (1 - Math.exp(-Game.map.getRoomLinearDistance(roomName, order.roomName) / 30.0)))}!`

        if ( order.type === ORDER_BUY ) {
            const available = A.res.query(Game.rooms[roomName].terminal.id, order.resourceType as ResourceConstant)
            if ( available < amount ) return `无法成交! 最多成交 ${available} 这么多!`
            assertWithMsg( A.res.request({ id: Game.rooms[roomName].terminal.id, resourceType: RESOURCE_ENERGY, amount: energyCost }) === A.proc.OK, getFileNameAndLineNumber() )
            assertWithMsg( A.res.request({ id: Game.rooms[roomName].terminal.id, resourceType: order.resourceType as ResourceConstant, amount: amount }) === A.proc.OK, getFileNameAndLineNumber() )
            assertWithMsg( Game.market.deal(orderId, amount, roomName) === OK, getFileNameAndLineNumber() )
            A.timer.add(Game.time + 1, (idTerminal, idStorage, orderId, resourceType, energyCost, executionAmount, roomName) => {
                if ( !Game.getObjectById(idTerminal) || !Game.getObjectById(idStorage) ) return
                const terminal = Game.getObjectById(idTerminal) as StructureTerminal
                const storage = Game.getObjectById(idStorage) as StructureStorage
                // 首先判定订单是否真的被执行成功
                const succeed = _.filter(Game.market.outgoingTransactions, tt => !!tt.order && tt.order.id === orderId).length > 0
                if ( !succeed ) {
                    // 归还资源
                    assertWithMsg( A.res.signal(terminal.id, RESOURCE_ENERGY, energyCost ) === A.proc.OK, getFileNameAndLineNumber() )
                    assertWithMsg( A.res.signal(terminal.id, resourceType as ResourceConstant, executionAmount ) === A.proc.OK, getFileNameAndLineNumber() )
                    return
                }
                // 此时成功完成
                assertWithMsg( A.res.signal(terminal.id, A.res.CAPACITY, energyCost + executionAmount) === A.proc.OK, getFileNameAndLineNumber() )
            }, [ Game.rooms[roomName].terminal.id, Game.rooms[roomName].storage.id, orderId, order.resourceType, energyCost, amount, roomName ], `Deal Order ${orderId}`)
        } else {
            if ( Game.market.credits < order.price * amount ) return `无法成交! 最多成交 ${Math.floor(Game.market.credits / order.price)} 这么多!`
            const capacity = transferToStorage ? Math.min(A.res.query(Game.rooms[roomName].terminal.id, A.res.CAPACITY), A.res.query(Game.rooms[roomName].storage.id, A.res.CAPACITY)) : A.res.query(Game.rooms[roomName].terminal.id, A.res.CAPACITY)
            if ( capacity < amount ) return `无法成交! 最多成交 ${capacity} 这么多!`

            assertWithMsg( A.res.request({ id: Game.rooms[roomName].terminal.id, resourceType: RESOURCE_ENERGY, amount: energyCost }) === A.proc.OK, getFileNameAndLineNumber() )
            assertWithMsg( A.res.request({ id: Game.rooms[roomName].terminal.id, resourceType: A.res.CAPACITY, amount: amount }) === A.proc.OK, getFileNameAndLineNumber() )
            if ( transferToStorage ) assertWithMsg( A.res.request({ id: Game.rooms[roomName].storage.id, resourceType: A.res.CAPACITY, amount: amount }) === A.proc.OK, getFileNameAndLineNumber() )

            assertWithMsg( Game.market.deal(order.id, amount, roomName) === OK, getFileNameAndLineNumber() )
            
            A.timer.add(Game.time + 1, (orderId, resourceType, executionAmount, energyCost, idTerminal, idStorage, transferToStorage) => {
                if ( !Game.getObjectById(idTerminal) || !Game.getObjectById(idStorage) ) return
                const terminal = Game.getObjectById(idTerminal) as StructureTerminal
                const storage = Game.getObjectById(idStorage) as StructureStorage
                // 首先判定订单是否真的被执行成功
                const succeed = _.filter(Game.market.incomingTransactions, tt => !!tt.order && tt.order.id === orderId).length > 0
                if ( !succeed ) {
                    // 归还预留空间
                    assertWithMsg( A.res.signal(terminal.id, RESOURCE_ENERGY, energyCost) === A.proc.OK, getFileNameAndLineNumber() )
                    assertWithMsg( A.res.signal(terminal.id, A.res.CAPACITY, executionAmount) === A.proc.OK, getFileNameAndLineNumber() )
                    if ( transferToStorage ) assertWithMsg( A.res.signal(storage.id, A.res.CAPACITY, executionAmount) === A.proc.OK, getFileNameAndLineNumber() )
                    return
                }
                // 此时成功完成
                assertWithMsg( A.res.signal(terminal.id, A.res.CAPACITY, energyCost) === A.proc.OK, getFileNameAndLineNumber() )
                
                if ( transferToStorage ) {
                    this.#repo[roomName].terminalStatus.getDescription()[resourceType] = (this.#repo[roomName].terminalStatus.getDescription()[resourceType] || 0) + executionAmount

                    // 此时 resource 一收一发, 不再重复
                    for ( let patchIdx = 0; patchIdx < Math.ceil(executionAmount / getCentralTransferUnit(Game.rooms[roomName].controller.level)); ++patchIdx ) {
                        const patchAmount = Math.min(getCentralTransferUnit(Game.rooms[roomName].controller.level), executionAmount - patchIdx * getCentralTransferUnit(Game.rooms[roomName].controller.level))
                        T.transfer(terminal.id, storage.id, resourceType, patchAmount, {
                            disallowGrouping: true, 
                            loseCallback: () => {
                                this.#repo[roomName].terminalStatus.getDescription()[resourceType] -= patchAmount
                                if ( this.#repo[roomName].terminalStatus.getDescription()[resourceType] === 0 ) {
                                    delete this.#repo[roomName].terminalStatus.getDescription()[resourceType]
                                }
                            }, 
                            callback: () => {
                                this.#repo[roomName].terminalStatus.getDescription()[resourceType] -= patchAmount
                                if ( this.#repo[roomName].terminalStatus.getDescription()[resourceType] === 0 ) {
                                    delete this.#repo[roomName].terminalStatus.getDescription()[resourceType]
                                }
                            }, 
                            priority: T.PRIORITY_CASUAL
                        })
                    }
                } else {
                    assertWithMsg( A.res.signal(terminal.id, resourceType, executionAmount) === A.proc.OK, getFileNameAndLineNumber() )
                }
            }, [ order.id, order.resourceType, amount, energyCost, Game.rooms[roomName].terminal.id, Game.rooms[roomName].storage.id, transferToStorage ], `执行 ${order.id}`)
        }
    }
    send(srcRoomName: string, tarRoomName: string, resourceType: ResourceConstant, amount: number) {
        if ( !Game.rooms[srcRoomName] || !Game.rooms[srcRoomName].terminal ) return ERR_INVALID_ARGS
        if ( !Game.rooms[tarRoomName] || !Game.rooms[tarRoomName].terminal ) return ERR_INVALID_ARGS
        if ( Game.rooms[srcRoomName].terminal.cooldown > 0 ) return ERR_TIRED
        if ( A.res.query(Game.rooms[srcRoomName].terminal.id, resourceType) < amount || A.res.query(Game.rooms[tarRoomName].terminal.id, A.res.CAPACITY) < amount ) return ERR_INVALID_ARGS
        if ( this.#calcMaximumAmount(srcRoomName, tarRoomName, A.res.query(Game.rooms[srcRoomName].terminal.id, RESOURCE_ENERGY), resourceType === RESOURCE_ENERGY) > amount ) return ERR_INVALID_ARGS
        assertWithMsg( A.res.request({ id: Game.rooms[srcRoomName].terminal.id, resourceType, amount }) === A.proc.OK, getFileNameAndLineNumber() )
        assertWithMsg( A.res.request({ id: Game.rooms[tarRoomName].terminal.id, resourceType: A.res.CAPACITY, amount }) === A.proc.OK, getFileNameAndLineNumber() )
        const retCode = Game.rooms[srcRoomName].terminal.send(resourceType, amount, tarRoomName)
        assertWithMsg( retCode === OK, `${srcRoomName} -> ${tarRoomName}: ${amount} ${resourceType} 失败 (${retCode})` )
        A.timer.add(Game.time + 1, (srcId, tarId, resourceType, amount) => {
            assertWithMsg( A.res.signal(srcId, A.res.CAPACITY, amount) === A.proc.OK, getFileNameAndLineNumber() )
            assertWithMsg( A.res.signal(tarId, resourceType, amount) === A.proc.OK, getFileNameAndLineNumber() )
        }, [ Game.rooms[srcRoomName].terminal.id, Game.rooms[tarRoomName].terminal.id, resourceType, amount ], `更新 send ${srcRoomName} -> ${tarRoomName}: ${amount} ${resourceType}`)
        return OK
    }
    issue(roomName: string) {
        // Terminal 内维持一定的能量数量
        // 每 tick 扫单, 交易达成后执行运输
        // 运输完成后, 再继续扫单

        assertWithMsg( !!Game.rooms[roomName] && !!Game.rooms[roomName].controller && Game.rooms[roomName].controller.my, `无法为 ${roomName} 创建市场模块` )
        this.#repo[roomName] = { terminalStatus: new TerminalStatusDescriptor(roomName), resourceStatus: new MarketRoomDescriptor(roomName), readySignal: A.proc.signal.createSignal(0) }

        const mineralType = Game.rooms[roomName].find(FIND_MINERALS)[0].mineralType

        // 首先, 完成剩余未传输数量
        A.proc.createProc([
            () => P.exist(roomName, 'centralTransfer', 'storage'),
            () => P.exist(roomName, 'centralTransfer', 'terminal'), 
            () => {
                const from = Game.rooms[roomName].terminal
                const to = Game.rooms[roomName].storage
                if ( !from || !to ) {
                    log(LOG_ERR, `无法找到 ${roomName} 的 Storage 或 Terminal, 但是有未完成的任务`)
                    this.#repo[roomName].terminalStatus.resetDescription()
                    return A.proc.OK
                }
                const resourceTypes = Object.keys(this.#repo[roomName].terminalStatus.getDescription()) as ResourceConstant[]
                for ( const resourceType of resourceTypes ) {
                    const amount = Math.min(A.res.query(from.id, resourceType as ResourceConstant), A.res.query(to.id, A.res.CAPACITY), this.#repo[roomName].terminalStatus.getDescription()[resourceType])
                    if ( amount <= 0 ) {
                        delete this.#repo[roomName].terminalStatus.getDescription()[resourceType]
                        continue
                    }
                    this.#repo[roomName].terminalStatus.getDescription()[resourceType] = amount
                    // 创建传输任务
                    for ( let patchIdx = 0; patchIdx < Math.ceil(amount / getCentralTransferUnit(Game.rooms[roomName].controller.level)); ++patchIdx ) {
                        const patchAmount = Math.min(getCentralTransferUnit(Game.rooms[roomName].controller.level), amount - patchIdx * getCentralTransferUnit(Game.rooms[roomName].controller.level))
                        assertWithMsg( A.res.request({ id: from.id, resourceType, amount: patchAmount }) === A.proc.OK, getFileNameAndLineNumber() )
                        assertWithMsg( A.res.request({ id: to.id, resourceType: A.res.CAPACITY, amount: patchAmount }) === A.proc.OK, getFileNameAndLineNumber() )
                        T.transfer(from, to, resourceType, patchAmount, {
                            disallowGrouping: true, 
                            loseCallback: () => {
                                this.#repo[roomName].terminalStatus.getDescription()[resourceType] -= patchAmount
                                if ( this.#repo[roomName].terminalStatus.getDescription()[resourceType] === 0 ) {
                                    delete this.#repo[roomName].terminalStatus.getDescription()[resourceType]
                                }
                            }, 
                            callback: () => {
                                this.#repo[roomName].terminalStatus.getDescription()[resourceType] -= patchAmount
                                if ( this.#repo[roomName].terminalStatus.getDescription()[resourceType] === 0 ) {
                                    delete this.#repo[roomName].terminalStatus.getDescription()[resourceType]
                                }
                            }, 
                            priority: T.PRIORITY_CASUAL
                        })
                    }
                }
                return A.proc.OK
            }, 
            () => {
                assertWithMsg( A.proc.signal.Ssignal({ signalId: this.#repo[roomName].readySignal, request: 1 }) === A.proc.OK, getFileNameAndLineNumber() )
                return A.proc.OK
            }
        ], `清理 ${roomName} 市场剩余传输部分`)

        // Terminal 补充能量 / 矿物
        let oneTimeGeneralFilling = A.proc.signal.createSignal(1)
        let oneTimeMineralFilling = A.proc.signal.createSignal(1)
        const generalPid = A.proc.createProc([
            () => A.proc.signal.Swait({ signalId: this.#repo[roomName].readySignal, lowerbound: 1, request: 0 }), 
            () => P.exist(roomName, 'centralTransfer', 'storage'),
            () => P.exist(roomName, 'centralTransfer', 'terminal'), 
            ['wait', () => A.proc.signal.Swait({ signalId: oneTimeGeneralFilling, lowerbound: 1, request: 0 })], 
            () => {
                const TRANSFER_UNIT = getTransferUnit(Game.rooms[roomName].controller.level)
                const terminal = Game.rooms[roomName].terminal
                const storage = Game.rooms[roomName].storage
                if ( !terminal || !storage ) return [ A.proc.STOP_ERR, `无法在 ${roomName} 找到 Storage 或 Terminal` ] as [ typeof A.proc.STOP_ERR, string ]

                if ( A.res.query(terminal.id, A.res.CAPACITY) <= getTerminalMaintainAmount("free before store") ) return A.proc.STOP_SLEEP

                let isFinish = true
                for ( const resourceType of getTerminalMaintainFromStorageList() ) {
                    if ( (resourceType as any) === "mineral" ) continue
                    if ( this.#getEffectiveTerminalResourceAmount(roomName, resourceType) >= getTerminalMaxMaintainAmount(resourceType) ) continue
                    isFinish = false

                    const amount = A.res.query(storage.id, resourceType)
                    // 因为可能有多种资源, 所以无法仅根据一个 stuck
                    if ( amount < TRANSFER_UNIT || amount < getStorageMinMaintainAmount(resourceType) ) continue

                    const capacity = Math.min(getTerminalMaxMaintainAmount(resourceType) - this.#getEffectiveTerminalResourceAmount(roomName, resourceType), A.res.query(terminal.id, A.res.CAPACITY) - getTerminalMaintainAmount("free before store"), amount)

                    if ( capacity <= 0 ) continue

                    assertWithMsg( A.proc.signal.Swait({ signalId: oneTimeGeneralFilling, lowerbound: 1, request: 1 }) === A.proc.OK, getFileNameAndLineNumber() )
                    assertWithMsg( A.res.request({ id: storage.id, resourceType: resourceType, amount: capacity }) === A.proc.OK, getFileNameAndLineNumber() )
                    assertWithMsg( A.res.request({ id: terminal.id, resourceType: A.res.CAPACITY, amount: capacity }) === A.proc.OK, getFileNameAndLineNumber() )

                    T.transfer(storage.id, terminal.id, resourceType, capacity, { allowLooseGrouping: true, callback: () => A.proc.signal.Ssignal({ signalId: oneTimeGeneralFilling, request: 1 }) })

                    return [ A.proc.OK_STOP_CUSTOM, "wait" ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                }
                if ( isFinish ) return A.proc.STOP_SLEEP
                return A.proc.OK_STOP_CURRENT
            }
        ],`${roomName} Terminal Fill General`, true)

        const mineralPid = A.proc.createProc([
            () => A.proc.signal.Swait({ signalId: this.#repo[roomName].readySignal, lowerbound: 1, request: 0 }), 
            () => P.exist(roomName, 'centralTransfer', 'storage'),
            () => P.exist(roomName, 'centralTransfer', 'terminal'), 
            ['wait', () => A.proc.signal.Swait({ signalId: oneTimeMineralFilling, lowerbound: 1, request: 0 })], 
            () => {
                const TRANSFER_UNIT = getTransferUnit(Game.rooms[roomName].controller.level)
                const terminal = Game.rooms[roomName].terminal
                const storage = Game.rooms[roomName].storage
                if ( !terminal || !storage ) return [ A.proc.STOP_ERR, `无法在 ${roomName} 找到 Storage 或 Terminal` ] as [ typeof A.proc.STOP_ERR, string ]

                if ( this.#getEffectiveTerminalResourceAmount(roomName, mineralType) >= getTerminalMaxMaintainAmount("mineral") || A.res.query(terminal.id, A.res.CAPACITY) <= getTerminalMaintainAmount("free before store") ) return A.proc.STOP_SLEEP

                const amount = A.res.query(storage.id, mineralType)
                if ( amount < TRANSFER_UNIT || amount < getStorageMinMaintainAmount("mineral") )
                    return A.res.request({ id: storage.id, resourceType: mineralType, amount: { lowerbound: getStorageMinMaintainAmount("mineral"), request: 0 } })

                const capacity = Math.min(getTerminalMaxMaintainAmount("mineral") - this.#getEffectiveTerminalResourceAmount(roomName, mineralType), A.res.query(terminal.id, A.res.CAPACITY) - getTerminalMaintainAmount("free before store"), amount)
                if ( capacity <= 0 ) return A.proc.STOP_SLEEP

                assertWithMsg( A.proc.signal.Swait({ signalId: oneTimeMineralFilling, lowerbound: 1, request: 1 }) === A.proc.OK, getFileNameAndLineNumber() )
                assertWithMsg( A.res.request({ id: storage.id, resourceType: mineralType, amount: capacity }) === A.proc.OK, getFileNameAndLineNumber() )
                assertWithMsg( A.res.request({ id: terminal.id, resourceType: A.res.CAPACITY, amount: capacity }) === A.proc.OK, getFileNameAndLineNumber() )
                T.transfer(storage.id, terminal.id, mineralType, capacity, { allowLooseGrouping: true, callback: () => A.proc.signal.Ssignal({ signalId: oneTimeMineralFilling, request: 1 }) })

                return [ A.proc.OK_STOP_CUSTOM, "wait" ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            }
        ],`${roomName} Terminal Fill Mineral`, true)

        A.proc.trigger("watch", () => {
            if ( !Game.rooms[roomName] || !Game.rooms[roomName].storage || !Game.rooms[roomName].terminal || A.res.query(Game.rooms[roomName].terminal.id, A.res.CAPACITY) <= getTerminalMaintainAmount("free before store") ) return false
            let anyResourceNeedFill = false
            for ( const resourceType of getTerminalMaintainFromStorageList() ) {
                if ( (resourceType as any) === "mineral" ) continue
                anyResourceNeedFill = anyResourceNeedFill || this.#getEffectiveTerminalResourceAmount(roomName, resourceType) < getTerminalMinMaintainAmount(resourceType)
                if ( anyResourceNeedFill ) break
            }
            anyResourceNeedFill = anyResourceNeedFill || this.#getEffectiveTerminalResourceAmount(roomName, mineralType) < getTerminalMinMaintainAmount("mineral")
            return anyResourceNeedFill
        }, [ mineralPid, generalPid ])

        // 最后 Terminal 扫单
        A.proc.createProc([
            () => A.proc.signal.Swait({ signalId: this.#repo[roomName].readySignal, lowerbound: 1, request: 0 }), 
            () => P.exist(roomName, 'centralTransfer', 'terminal'), 
            () => {
                const terminal = Game.rooms[roomName].terminal
                if ( !terminal ) return [ A.proc.STOP_ERR, `无法在 ${roomName} 找到 Terminal` ] as [ typeof A.proc.STOP_ERR, string ]
                if ( !!lastExecutionTick && lastExecutionTick >= Game.time ) return A.proc.OK_STOP_CURRENT
                if ( A.res.query(terminal.id, RESOURCE_ENERGY) < MIN_EXECUTION_ENERGY ) return A.res.request({ id: terminal.id, resourceType: RESOURCE_ENERGY, amount: { lowerbound: MIN_EXECUTION_ENERGY, request: 0 } })
                if ( terminal.cooldown > 0 ) return [ A.proc.STOP_SLEEP, terminal.cooldown + 1 ] as [ typeof A.proc.STOP_SLEEP, number ]
                
                // 优先买, 补充资源
                if ( Game.market.credits > MIN_BUYING_CREDITS ) {
                    for (const resourceType in this.#repo[roomName].resourceStatus.getDescription()["buy"]) {
                        const buyAmount = this.#repo[roomName].resourceStatus.getDescription()["buy"][resourceType]
                        if ( buyAmount <= 0 ) continue
                        const order = _.min(Game.market.getAllOrders({type: ORDER_SELL, resourceType: resourceType as ResourceConstant}).filter(o => o.amount > 0), o => o.price)
                        if ( !order || !this.tracker.isGoodBuy(resourceType as ResourceConstant, order.price, roomName, order.roomName) ) continue
                        const sellAmount = order.amount
                        const capacity = A.res.query(terminal.id, A.res.CAPACITY)
                        const maxSupportedAmount = Math.min(Math.floor(A.res.query(terminal.id, RESOURCE_ENERGY) / (1. - Math.exp(-Game.map.getRoomLinearDistance(roomName, order.roomName, true) / 30.))), Math.floor(Game.market.credits / order.price))
                        const executionAmount = Math.min(buyAmount, sellAmount, capacity, maxSupportedAmount)
                        if ( executionAmount <= 0 ) {
                            log(LOG_DEBUG, `无法为 ${roomName} 购买 ${resourceType} (${buyAmount}, ${sellAmount}, ${capacity}, ${maxSupportedAmount})`)
                            continue
                        }
                        const energyCost = Game.market.calcTransactionCost(executionAmount, roomName, order.roomName)
                        assertWithMsg( energyCost <= A.res.query(terminal.id, RESOURCE_ENERGY), `执行订单 ${order.id} (${executionAmount}) 需要 ${energyCost} energy 但是只有 ${A.res.query(terminal.id, RESOURCE_ENERGY)}` )
                        
                        assertWithMsg( A.res.request({ id: terminal.id, resourceType: RESOURCE_ENERGY, amount: energyCost }) === A.proc.OK, getFileNameAndLineNumber() )
                        // 不重复 request
                        // 挂单时已经 request 过
                        // assertWithMsg( A.res.request({ id: terminal.id, resourceType: A.res.CAPACITY, amount: executionAmount }) === A.proc.OK, getFileNameAndLineNumber() )

                        assertWithMsg( Game.market.deal(order.id, executionAmount, roomName) === OK, getFileNameAndLineNumber() )

                        lastExecutionTick = Game.time
                        
                        A.timer.add(Game.time + 1, (orderId, resourceType, oldAmount, executionAmount, energyCost, idTerminal) => {
                            if ( !Game.getObjectById(idTerminal) ) return
                            const terminal = Game.getObjectById(idTerminal) as StructureTerminal
                            // 首先判定订单是否真的被执行成功
                            const succeed = _.filter(Game.market.incomingTransactions, tt => !!tt.order && tt.order.id === orderId).length > 0
                            if ( !succeed ) {
                                // 归还预留空间
                                assertWithMsg( A.res.signal(terminal.id, RESOURCE_ENERGY, energyCost) === A.proc.OK, getFileNameAndLineNumber() )
                                // assertWithMsg( A.res.signal(terminal.id, A.res.CAPACITY, executionAmount) === A.proc.OK, getFileNameAndLineNumber() )
                                return
                            }
                            // 此时成功完成
                            this.#repo[roomName].resourceStatus.getDescription()["buy"][resourceType] -= executionAmount // (落袋为安, 可以直接更新)
                            assertWithMsg( A.res.signal(terminal.id, A.res.CAPACITY, energyCost) === A.proc.OK, getFileNameAndLineNumber() )
                            assertWithMsg( A.res.signal(terminal.id, resourceType, executionAmount) === A.proc.OK, getFileNameAndLineNumber() )
                        }, [ order.id, resourceType, terminal.store.getUsedCapacity(resourceType as ResourceConstant), executionAmount, energyCost, terminal.id ], `执行 ${order.id}`)

                        return A.proc.OK_STOP_CURRENT
                    }
                }

                // 然后卖, 腾出空间
                for ( const resourceType in this.#repo[roomName].resourceStatus.getDescription()["sell"] ) {
                    const sellAmount = this.#repo[roomName].resourceStatus.getDescription()["sell"][resourceType]
                    if ( sellAmount <= 0 ) continue
                    const order = _.max(Game.market.getAllOrders({type: ORDER_BUY, resourceType: resourceType as ResourceConstant}).filter(o => o.amount > 0), o => o.price)
                    if ( !order || !this.tracker.isGoodSell(resourceType as ResourceConstant, order.price, roomName, order.roomName) ) continue
                    const buyAmount = order.amount
                    const available = resourceType === RESOURCE_ENERGY ? Math.floor(A.res.query(terminal.id, RESOURCE_ENERGY) / (1 + (1. - Math.exp(-Game.map.getRoomLinearDistance(roomName, order.roomName, true) / 30.)))) : A.res.query(terminal.id, resourceType as ResourceConstant)
                    const maxSupportedAmount = Math.floor((A.res.query(terminal.id, RESOURCE_ENERGY) - (resourceType === RESOURCE_ENERGY ? Math.min(sellAmount, buyAmount, available) : 0)) / (1. - Math.exp(-Game.map.getRoomLinearDistance(roomName, order.roomName, true) / 30.)))
                    const executionAmount = Math.min(sellAmount, buyAmount, available, maxSupportedAmount)
                    if ( executionAmount <= 0 ) {
                        log(LOG_DEBUG, `无法为 ${roomName} 出售 ${resourceType} (${sellAmount}, ${buyAmount}, ${available}, ${maxSupportedAmount})`)
                        continue
                    }
                    const energyCost = Game.market.calcTransactionCost(executionAmount, roomName, order.roomName)
                    assertWithMsg( energyCost + (resourceType === RESOURCE_ENERGY ? executionAmount : 0) <= A.res.query(terminal.id, RESOURCE_ENERGY), `执行订单 ${order.id} (${executionAmount}) 需要 ${energyCost + (resourceType === RESOURCE_ENERGY ? executionAmount : 0)} energy 但是只有 ${A.res.query(terminal.id, RESOURCE_ENERGY)}` )

                    assertWithMsg( A.res.request({ id: terminal.id, resourceType: RESOURCE_ENERGY, amount: energyCost }) === A.proc.OK, getFileNameAndLineNumber() )
                    // 不重复 request, 挂单时已经 request 过
                    // assertWithMsg( A.res.request({ id: terminal.id, resourceType: resourceType as ResourceConstant, amount: executionAmount }) === A.proc.OK, getFileNameAndLineNumber() )

                    assertWithMsg( Game.market.deal(order.id, executionAmount, roomName) === OK, getFileNameAndLineNumber() )

                    lastExecutionTick = Game.time

                    A.timer.add(Game.time + 1, (orderId, resourceType, oldAmount, executionAmount, energyCost, idTerminal) => {
                        if ( !Game.getObjectById(idTerminal) ) return
                        const terminal = Game.getObjectById(idTerminal) as StructureTerminal
                        // 首先判定订单是否真的被执行成功
                        const succeed = _.filter(Game.market.outgoingTransactions, tt => !!tt.order && tt.order.id === orderId).length > 0
                        if ( !succeed ) {
                            // 归还资源
                            assertWithMsg( A.res.signal(terminal.id, RESOURCE_ENERGY, energyCost ) === A.proc.OK, getFileNameAndLineNumber() )
                            // assertWithMsg( A.res.signal(terminal.id, resourceType, executionAmount ) === A.proc.OK, getFileNameAndLineNumber() )
                            return
                        }
                        // 此时成功完成
                        this.#repo[roomName].resourceStatus.getDescription()["sell"][resourceType] -= executionAmount
                        assertWithMsg( A.res.signal(terminal.id, A.res.CAPACITY, energyCost + executionAmount) === A.proc.OK, getFileNameAndLineNumber() )
                    }, [ order.id, resourceType, terminal.store.getUsedCapacity(resourceType as ResourceConstant), executionAmount, energyCost, terminal.id ], `执行 ${order.id}`)

                    return A.proc.OK_STOP_CURRENT
                }

                return A.proc.OK_STOP_CURRENT
            }
        ], `${roomName} Terminal 扫单`)

        // 更新 买卖 清单
        A.proc.createProc([
            () => A.proc.signal.Swait({ signalId: this.#repo[roomName].readySignal, lowerbound: 1, request: 0 }), 
            () => P.exist(roomName, 'centralTransfer', 'terminal'), 
            () => {
                const terminal = Game.rooms[roomName].terminal
                if ( !terminal ) return [ A.proc.STOP_ERR, `无法在 ${roomName} 找到 Storage 或 Terminal` ] as [ typeof A.proc.STOP_ERR, string ]

                // 检查卖出
                for ( let resourceType of getTerminalSellList() ) {
                    if ( (resourceType as any) === 'mineral' ) resourceType = mineralType
                    if ( A.res.query(terminal.id, resourceType) > 0 ) {
                        const amount = A.res.query(terminal.id, resourceType)
                        assertWithMsg( A.res.request({ id: terminal.id, resourceType, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                        this.#repo[roomName].resourceStatus.getDescription()["sell"][resourceType] = (this.#repo[roomName].resourceStatus.getDescription()["sell"][resourceType] || 0) + amount
                    }
                }

                // 检查买入
                for ( let resourceType in getTerminalBuyInfo() ) {
                    // 不在本房间买同样的资源
                    if ( resourceType === mineralType ) continue
                    if ( this.#getEffectiveTerminalResourceAmount(roomName, resourceType as ResourceConstant) < getTerminalBuyInfo()[resourceType as ResourceConstant].min && A.res.query(terminal.id, A.res.CAPACITY) > getTerminalMaintainAmount("free before store") ) {
                        const amount = Math.min(getTerminalBuyInfo()[resourceType as ResourceConstant].max - this.#getEffectiveTerminalResourceAmount(roomName, resourceType as ResourceConstant), A.res.query(terminal.id, A.res.CAPACITY) - getTerminalMaintainAmount("free before store"))
                        if ( amount <= 0 ) continue
                        assertWithMsg( A.res.request({ id: terminal.id, resourceType: A.res.CAPACITY, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                        this.#repo[roomName].resourceStatus.getDescription()["buy"][resourceType] = (this.#repo[roomName].resourceStatus.getDescription()["buy"][resourceType] || 0) + amount
                    }
                }

                return A.proc.OK_STOP_CURRENT
            }
        ], `${roomName} Terminal 买卖清单更新`)
    }
    constructor(priceHistoryTracker: PriceHistoryTracker) {
        this.#commonStatus = new MarketCommonDescriptor()
        this.#repo = {}
        this.tracker = priceHistoryTracker

        for ( const orderId in Game.market.orders ) this.#issueOrderWatcher(orderId)
    }
}

export const marketModule = new MarketModule(priceHistoryTracker)
global.M = marketModule