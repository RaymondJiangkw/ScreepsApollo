/**
 * 运输模块
 */

import { assertWithMsg, generate_random_hex, getUsedCapacity, insertSortedBy, log, LOG_DEBUG, raiseNotImplementedError } from "@/utils"
import { Apollo as A } from "@/framework/apollo"
import { creepModule as C } from "./creep"

const PRIORITY_CASUAL = 2
const PRIORITY_NORMAL = 1
const PRIORITY_IMPORTANT = 0

type PriorityType = typeof PRIORITY_IMPORTANT | typeof PRIORITY_NORMAL | typeof PRIORITY_CASUAL

type TransferTaskDescription = {
    id              : string, 
    fromId          : Id<StorableStructure>, 
    /** 无视角时, 给定位置 */
    fromPos         : Pos, 
    toId            : Id<StorableStructure>, 
    /** 无视角时, 给定位置 */
    toPos           : Pos, 
    content         : { resourceType: ResourceConstant, amount: number }[], 
    priority        : PriorityType, 
    afterSignalId?  : string, 
    loseCallback?   : (amount: number, resourceType: ResourceConstant) => void, 
    finishWithdraw  : boolean, 
}

interface TransferOpts {
    priority?: PriorityType
    /** 当可以获取该信号量时, 才开始进行转移 (但是会提前移动到目标地) */
    afterSignalId?: string
    /** 当运输过程中丢失时, 触发回调函数 */
    loseCallback?: (amount: number, resourceType: ResourceConstant) => void
    /** 是否允许不匹配 `loseCallback` 进行合并 */
    allowLooseGrouping?: boolean
}

type TransferTarget = Id<StorableStructure> | { id: Id<StorableStructure> | null, pos: Pos }

class TransferModule {
    PRIORITY_CASUAL: typeof PRIORITY_CASUAL = 2
    PRIORITY_NORMAL: typeof PRIORITY_NORMAL = 1
    PRIORITY_IMPORTANT: typeof PRIORITY_IMPORTANT = 0
    #MAXIMUM_TRANSFERRING_NUM = 2
    #taskQueues: { [roomName: string]: { 
        queue: TransferTaskDescription[], 
        lengthSignalId: string, 
    } } = {}
    #getTaskQueue(roomName: string) {
        if ( !(roomName in this.#taskQueues) ) this.#taskQueues[roomName] = {
            queue: [], lengthSignalId: A.proc.signal.createSignal(0)
        }
        return this.#taskQueues[roomName]
    }
    #issuedRoomNames: string[] = []
    #issueForRoomName(roomName: string) {
        if ( this.#issuedRoomNames.includes(roomName) ) return
        this.#issuedRoomNames.push(roomName)
        for ( let idx = 0; idx < this.#MAXIMUM_TRANSFERRING_NUM; ++idx ) {
            let workerName = null
            let currentTransferTask: TransferTaskDescription = null
            type TargetDict = { [resourceType in ResourceConstant]?: number }
            /** 当前携带的资源 */
            let targetDict: TargetDict = {};
            ((workerName: string, getCurrentTransferTask: () => TransferTaskDescription, setCurrentTransferTack: (v: TransferTaskDescription) => void, targetDict: TargetDict) => {
                /** 先一次性取完, 再一次性送完 */
                A.proc.createProc([
                    ['start', () => A.proc.signal.Swait({ signalId: this.#getTaskQueue(roomName).lengthSignalId, lowerbound: 1, request: 1 })], 
                    () => {
                        setCurrentTransferTack(this.#getTaskQueue(roomName).queue.shift())
                        return A.proc.OK
                    }, 
                    () => C.acquire('transferer', roomName, name => workerName = name), 
                    () => {
                        const creep = Game.creeps[workerName]
                        if ( !creep ) {
                            C.cancel(workerName)
                            workerName = null
                            return [A.proc.STOP_ERR, `Creep [${workerName}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
                        }
                        if ( creep.store.getUsedCapacity() === 0 ) return A.proc.OK
                        for ( const resourceType in creep.store ) {
                            // Drop 在 Container 上会影响资源计算
                            if ( creep.pos.lookFor(LOOK_STRUCTURES).filter(v => v.structureType === STRUCTURE_CONTAINER).length > 0 ) {
                                creep.travelTo( creep.pos, { flee: true, ignoreCreeps: false, range: 1, avoidStructureTypes: [ STRUCTURE_CONTAINER ] } )
                                return A.proc.OK_STOP_CURRENT
                            }
                            creep.drop(resourceType as ResourceConstant)
                            return A.proc.OK_STOP_CURRENT
                        }

                    }, 
                    /** 移动到源 */
                    [ 'moveToSource', () => {
                        const creep = Game.creeps[workerName]
                        /** 检测到错误, 立即释放资源 */
                        if ( !creep ) {
                            // 释放 Creep
                            C.cancel(workerName)
                            workerName = null
                            // 恢复任务, 不用恢复 `from` 的资源, 因为运输一定完成
                            // 相应的资源一定被消耗
                            // 此时 targetDict 应当为空
                            assertWithMsg( !!getCurrentTransferTask(), `'moveToSource'时 Creep 消失, 应当仍然有任务` )
                            assertWithMsg( Object.keys(targetDict).length === 0, `'moveToSource'时 Creep 消失, 应当不携带任何资源` )
                            insertSortedBy(this.#getTaskQueue(roomName).queue, getCurrentTransferTask(), 'priority')
                            A.proc.signal.Ssignal({ signalId: this.#getTaskQueue(roomName).lengthSignalId, request: 1 })
                            setCurrentTransferTack( null )
                            return [A.proc.STOP_ERR, `Creep [${workerName}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
                        }

                        if ( creep.pos.roomName !== getCurrentTransferTask().fromPos.roomName || creep.pos.getRangeTo(getCurrentTransferTask().fromPos.x, getCurrentTransferTask().fromPos.y) > 1 ) {
                            creep.travelTo(new RoomPosition(getCurrentTransferTask().fromPos.x, getCurrentTransferTask().fromPos.y, getCurrentTransferTask().fromPos.roomName))
                            return A.proc.OK_STOP_CURRENT
                        }
                        // 检验 afterSignal
                        if ( !getCurrentTransferTask().afterSignalId ) return [ A.proc.OK_STOP_CUSTOM, 'withdraw' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                        return A.proc.OK
                    }], 
                    () => {
                        /** 等待另一个信号量完成 */
                        const ret = A.proc.signal.Swait({ signalId: getCurrentTransferTask().afterSignalId, lowerbound: 1, request: 0 })
                        if ( ret === A.proc.OK ) {
                            A.proc.signal.destroySignal( getCurrentTransferTask().afterSignalId )
                            getCurrentTransferTask().afterSignalId = undefined
                        }
                        return ret
                    }, 
                    [ 'withdraw', () => {
                        const creep = Game.creeps[workerName]
                        /** 检测到错误, 立即释放资源 */
                        if ( !creep ) {
                            // || creep.ticksToLive < 3
                            // if ( creep ) creep.suicide()
                            // 释放 Creep
                            C.cancel(workerName)
                            workerName = null
                            // 恢复任务
                            // 永久丢失的资源
                            for ( const resourceType in targetDict ) {
                                if ( getCurrentTransferTask().loseCallback )
                                    getCurrentTransferTask().loseCallback(targetDict[resourceType], resourceType as ResourceConstant)
                                const to = Game.getObjectById(getCurrentTransferTask().toId)
                                if ( !!to ) {
                                    // 腾出空间
                                    assertWithMsg( A.res.signal(to.id, A.res.describeCapacity(to, resourceType as ResourceConstant), targetDict[resourceType]) === A.proc.OK )
                                }
                            }
                            if ( !getCurrentTransferTask().finishWithdraw ) {
                                insertSortedBy(this.#getTaskQueue(roomName).queue, getCurrentTransferTask(), 'priority')
                                A.proc.signal.Ssignal({ signalId: this.#getTaskQueue(roomName).lengthSignalId, request: 1 })
                            }
                            
                            targetDict = {}
                            setCurrentTransferTack( null )
                            return [A.proc.STOP_ERR, `Creep [${workerName}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
                        }
                        
                        // 在最后一秒 withdraw 或 transfer 会返回成功, 但是不会执行
                        if ( creep.ticksToLive === 1 ) return A.proc.OK_STOP_CURRENT

                        assertWithMsg( creep.store.getFreeCapacity() > 0 )
                        assertWithMsg( !!getCurrentTransferTask().fromId, `源 Id 未定时, 尚未实现` )

                        const source = Game.getObjectById(getCurrentTransferTask().fromId)
                        if ( !source ) {
                            const to = Game.getObjectById(getCurrentTransferTask().toId)
                            if ( !!to ) {
                                for ( const { resourceType, amount } of getCurrentTransferTask().content )
                                    assertWithMsg( A.res.signal(getCurrentTransferTask().toId, A.res.describeCapacity(to, resourceType), amount) === A.proc.OK )
                                if ( Object.keys(targetDict).length > 0 )
                                    return [ A.proc.OK_STOP_CUSTOM, 'moveToTarget' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                            }
                            targetDict = {}
                            setCurrentTransferTack( null )
                            return [ A.proc.OK_STOP_CUSTOM, 'start' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                        }

                        /** 确定运输的种类和数量 & 确定是否运输完成 */
                        let resourceType = getCurrentTransferTask().content[0].resourceType
                        let amount = Math.min(creep.store.getFreeCapacity(), getCurrentTransferTask().content[0].amount)
                        assertWithMsg( amount >= 0 && amount <= (source.store[resourceType] || 0), `取资源时, ${source} 应至少有 ${amount} ${resourceType} 但只有 ${source.store[resourceType] || 0}.` )
                        assertWithMsg( creep.withdraw(source, resourceType, amount) === OK )
                        A.timer.add(Game.time + 1, (sourceId, capacityType, amount) => A.res.signal(sourceId, capacityType, amount), [source.id, A.res.describeCapacity(source, resourceType), amount], `取资源后, 更新源建筑的容量`)

                        getCurrentTransferTask().content[0].amount -= amount
                        targetDict[resourceType] = amount
                        if ( getCurrentTransferTask().content[0].amount === 0 ) {
                            getCurrentTransferTask().content.shift()
                            getCurrentTransferTask().finishWithdraw = getCurrentTransferTask().content.length === 0
                        }

                        if ( getCurrentTransferTask().finishWithdraw || creep.store.getFreeCapacity() === amount ) return A.proc.OK_STOP_NEXT
                        else return A.proc.OK_STOP_CURRENT
                    } ], 
                    ['moveToTarget', () => {
                        const creep = Game.creeps[workerName]
                        /** 检测到错误, 立即释放资源 */
                        if ( !creep ) {
                            // || creep.ticksToLive < 3
                            // if ( creep ) creep.suicide()
                            // 释放 Creep
                            C.cancel(workerName)
                            workerName = null
                            // 恢复任务
                            // 永久丢失的资源
                            for ( const resourceType in targetDict ) {
                                if ( getCurrentTransferTask().loseCallback )
                                    getCurrentTransferTask().loseCallback(targetDict[resourceType], resourceType as ResourceConstant)
                                const to = Game.getObjectById(getCurrentTransferTask().toId)
                                if ( !!to ) {
                                    // 腾出空间
                                    assertWithMsg( A.res.signal(to.id, A.res.describeCapacity(to, resourceType as ResourceConstant), targetDict[resourceType]) === A.proc.OK )
                                }
                            }
                            if ( !getCurrentTransferTask().finishWithdraw ) {
                                insertSortedBy(this.#getTaskQueue(roomName).queue, getCurrentTransferTask(), 'priority')
                                A.proc.signal.Ssignal({ signalId: this.#getTaskQueue(roomName).lengthSignalId, request: 1 })
                            }
                            
                            targetDict = {}
                            setCurrentTransferTack( null )
                            return [A.proc.STOP_ERR, `Creep [${workerName}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
                        }
                        
                        // 在最后一秒 withdraw 或 transfer 会返回成功, 但是不会执行
                        if ( creep.ticksToLive === 1 ) return A.proc.OK_STOP_CURRENT

                        if ( creep.pos.roomName !== getCurrentTransferTask().toPos.roomName || creep.pos.getRangeTo(getCurrentTransferTask().toPos.x, getCurrentTransferTask().toPos.y) > 1) {
                            creep.travelTo(new RoomPosition(getCurrentTransferTask().toPos.x, getCurrentTransferTask().toPos.y, getCurrentTransferTask().toPos.roomName))
                            return A.proc.OK_STOP_CURRENT
                        }

                        const target = Game.getObjectById(getCurrentTransferTask().toId)
                        if ( !target ) {
                            const source = Game.getObjectById(getCurrentTransferTask().fromId)
                            if ( !!source ) {
                                for ( const { resourceType, amount } of getCurrentTransferTask().content )
                                    assertWithMsg( A.res.signal(getCurrentTransferTask().fromId, resourceType, amount) === A.proc.OK )
                            }
                            targetDict = {}
                            setCurrentTransferTack( null )
                            return [ A.proc.OK_STOP_CUSTOM, 'start' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                        }

                        const resourceType = Object.keys(targetDict)[0] as ResourceConstant
                        const amount = targetDict[resourceType]
                        assertWithMsg( amount <= creep.store[resourceType] && amount <= target.store.getFreeCapacity(resourceType), `transfer -> 242 ${amount}}` )
                        assertWithMsg( creep.transfer(target, resourceType, amount) === OK )
                        A.timer.add(Game.time + 1, (targetId, resourceType, amount) => A.res.signal(targetId, resourceType, amount), [target.id, resourceType, amount], `转移资源后, 更新目标建筑相应资源的数量`)
                        delete targetDict[resourceType]

                        if ( Object.keys(targetDict).length > 0 ) return A.proc.OK_STOP_CURRENT
                        
                        // 归还, 以留空间给更高优先级的任务
                        C.release(workerName)
                        workerName = null
                        targetDict = {}
                        if ( !getCurrentTransferTask().finishWithdraw ) {
                            insertSortedBy(this.#getTaskQueue(roomName).queue, getCurrentTransferTask(), 'priority')
                            A.proc.signal.Ssignal({ signalId: this.#getTaskQueue(roomName).lengthSignalId, request: 1 })
                        }
                        setCurrentTransferTack( null )
                        return [ A.proc.OK_STOP_CUSTOM, 'start' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                    }]
                ], `${roomName} => Transfer ${idx}`)
            })(workerName, () => currentTransferTask, v => currentTransferTask = v, targetDict)
        }
    }
    /** 在给定确切资源种类及数量时, 会一定完成; 无法完成, 则会调用回调函数 (可选). 运输资源时, 应提前 request. */
    transfer( from: TransferTarget, to: TransferTarget, resourceType: ResourceConstant, amount: number, opts: TransferOpts = {} ): void {
        _.defaults(opts, { priority: PRIORITY_NORMAL })
        /** 规整参数 */
        if ( typeof from === 'string' ) {
            assertWithMsg( !!Game.getObjectById(from), `对于传输模块, 给定确定 Id 时, 应当可以获得对象` )
            from = {
                id: from, 
                pos: Game.getObjectById(from).pos
            }
        }
        if ( typeof to === 'string' ) {
            assertWithMsg( !!Game.getObjectById(to), `对于传输模块, 给定确定 Id 时, 应当可以获得对象` )
            to = {
                id: to, 
                pos: Game.getObjectById(to).pos
            }
        }
        /** 校验参数 */
        assertWithMsg( !!to.id, `传输模块中, 目的地的 Id 必须给定` )
        assertWithMsg( !!from.pos && !!to.pos, `传输模块中, 必须给定从哪儿来和到哪儿去的位置` )

        if ( from.pos.roomName === to.pos.roomName ) {
            if ( Game.rooms[from.pos.roomName] && Game.rooms[from.pos.roomName].controller && Game.rooms[from.pos.roomName].controller.my ) {
                // 控制房间内运输
                /** 校验参数 */
                assertWithMsg( !!from.id, `传输模块中, 在控制房间内运输时, Id 必须全部指定` )
                const taskDescription: TransferTaskDescription = {
                    fromId: from.id, fromPos: from.pos, 
                    toId: to.id, toPos: to.pos, 
                    content: [ { resourceType, amount } ], 
                    priority: opts.priority, afterSignalId: opts.afterSignalId, 
                    loseCallback: opts.loseCallback, 
                    finishWithdraw: false, id: generate_random_hex(8), 
                }
                log(LOG_DEBUG, `运输任务 从 ${from.id} 到 ${to.id} 运输 ${resourceType} (${amount})`)
                // 判定 TakeOver
                const queueIds = Object.keys(this.#takeOverInfo).filter(key => this.#takeOverInfo[key].fromIds.includes((from as any).id) && this.#takeOverInfo[key].toIds.includes((to as any).id))
                if ( queueIds.length > 0 )
                    queueIds.forEach(queueId => {
                        // 尝试合并
                        let find = false
                        for ( const t of this.#takeOverInfo[queueId].queue ) {
                            if ( t.fromId === taskDescription.fromId && t.toId === taskDescription.toId && t.priority === taskDescription.priority && t.afterSignalId === taskDescription.afterSignalId && ( opts.allowLooseGrouping || t.loseCallback === taskDescription.loseCallback ) ) {
                                const c = _.filter(t.content, v => v.resourceType === resourceType)[0]
                                if ( !!c ) c.amount += amount
                                else t.content.push({ resourceType, amount })
                                find = true
                                break
                            }
                        }
                        if ( !find ) {
                            insertSortedBy(this.#takeOverInfo[queueId].queue, taskDescription, 'priority')
                            A.proc.signal.Ssignal({ signalId: this.#takeOverInfo[queueId].lengthSignalId, request: 1 })
                        }
                    })
                else {
                    // 尝试合并
                    let find = false
                    for ( const t of this.#getTaskQueue(from.pos.roomName).queue ) {
                        if ( t.fromId === taskDescription.fromId && t.toId === taskDescription.toId && t.priority === taskDescription.priority && t.afterSignalId === taskDescription.afterSignalId && ( opts.allowLooseGrouping || t.loseCallback === taskDescription.loseCallback ) ) {
                            const c = _.filter(t.content, v => v.resourceType === resourceType)[0]
                            if ( !!c ) c.amount += amount
                            else t.content.push({ resourceType, amount })
                            find = true
                            break
                        }
                        // log(LOG_DEBUG, `无法合并 ${JSON.stringify(taskDescription)} 和 ${JSON.stringify(t)}.`)
                    }
                    if ( !find ) {
                        insertSortedBy(this.#getTaskQueue(from.pos.roomName).queue, taskDescription, 'priority')
                        A.proc.signal.Ssignal({ signalId: this.#getTaskQueue(from.pos.roomName).lengthSignalId, request: 1 })
                        // 检验房间发出运输进程
                        this.#issueForRoomName(from.pos.roomName)
                    }
                }
            } else {
                // 非控制房间内运输暂未实现
                raiseNotImplementedError()
            }
        } else {
            // 跨房间运输
            raiseNotImplementedError()
        }
    }
    print( roomName: string ) {
        log(LOG_DEBUG, `${roomName} Transfer 任务:` + JSON.stringify(this.#getTaskQueue(roomName).queue))
    }

    #takeOverInfo: { [ queueId: string ]: { 
        queue: TransferTaskDescription[], 
        lengthSignalId: string, 
        /** 从哪儿来时, 被取代 */
        fromIds: Id<StorableStructure>[], 
        /** 到哪儿时, 被取代 */
        toIds: Id<StorableStructure>[]
    } } = {}
    #getTakeOverId(): string {
        let id = generate_random_hex(8)
        while ( id in this.#takeOverInfo )
            id = generate_random_hex(8)
        return id
    }
    createTakeOver(): { queueId: string, queue: TransferTaskDescription[], lengthSignalId: string } {
        const queueId = this.#getTakeOverId()
        this.#takeOverInfo[queueId] = { 
            queue: [], 
            lengthSignalId: A.proc.signal.createSignal(0), 
            fromIds: [], 
            toIds: []
        }
        return { queueId, queue: this.#takeOverInfo[queueId].queue, lengthSignalId: this.#takeOverInfo[queueId].lengthSignalId }
    }
    bindTakeOver( queueId: string, token: 'from' | 'to' | 'all', structureId: Id<StorableStructure> ) {
        assertWithMsg( queueId in this.#takeOverInfo, `transfer -> 386` )
        if ( (token === 'from' || token === 'all') && !this.#takeOverInfo[queueId].fromIds.includes(structureId) )
            this.#takeOverInfo[queueId].fromIds.push(structureId)
        if ( (token === 'to' || token === 'all') && !this.#takeOverInfo[queueId].toIds.includes(structureId) )
            this.#takeOverInfo[queueId].toIds.push(structureId)
        return this
    }
    removeTakeOver( queueId: string, token: 'from' | 'to' | 'all', structureId: Id<StorableStructure> ) {
        assertWithMsg( queueId in this.#takeOverInfo, `transfer -> 386` )
        if ( (token === 'from' || token === 'all') && !this.#takeOverInfo[queueId].fromIds.includes(structureId) )
            this.#takeOverInfo[queueId].fromIds = _.remove(this.#takeOverInfo[queueId].fromIds, id => id === structureId)
        if ( (token === 'to' || token === 'all') && !this.#takeOverInfo[queueId].toIds.includes(structureId) )
            this.#takeOverInfo[queueId].toIds = _.remove(this.#takeOverInfo[queueId].toIds, id => id === structureId)
        return this
    }
    constructor() {
        C.design('transferer', {
            body: {
                1: [ MOVE, CARRY ], 
                2: [ MOVE, CARRY, CARRY ], 
                4: [ MOVE, MOVE, CARRY, CARRY, CARRY, CARRY ], 
                6: [ MOVE, MOVE, MOVE, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY ], 
                8: [ MOVE, MOVE, MOVE, MOVE, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY ], 
            }, 
            amount: this.#MAXIMUM_TRANSFERRING_NUM
        })
    }
}

export const transferModule = new TransferModule()
global.T = transferModule