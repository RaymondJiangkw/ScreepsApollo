/**
 * 🤖️ Creep 管理模块
 */

import { Apollo as A } from "@/framework/apollo"
import { assertWithMsg, generate_random_hex, largest_less_than, log, LOG_DEBUG } from "@/utils"

/**
 * 外部接口依赖
 */
interface CreepModuleContext {
    /** 发布在成功 Spawn Creep 之后注册的事件 (对外暴露的用处在于 重新 mount 时, 需要对正在 Spawning 的 Creeps 延迟注册) */
    issueRegisterAfterSpawn(creepName: string, callback: (name: string) => void): void
    /**
     * 申请生产新的 Creep.
     * 注意: 这个 API 保证成功, 即错误处理应当在 spawn 模块内部.
     *
     * @param roomName 生产 Creep 的房间 (必须在控制内).
     * @param callback 在 Creep 成功生产后, 执行的回调函数.
     * @param body An array describing the new creep’s body. Should contain 1 to 50 elements with one of these constants:
     *  * WORK
     *  * MOVE
     *  * CARRY
     *  * ATTACK
     *  * RANGED_ATTACK
     *  * HEAL
     *  * TOUGH
     *  * CLAIM
     * @param priority 特权级别, 数字越低, 特权越高.
     * @param memory Memory of the new creep. If provided, it will be immediately stored into Memory.creeps[name].
     * @param workPos Creep 预计的工作地点. 可以根据该信息优化生产 Creep 所选用的 Spawn.
     * @param strict 是否严格要求满足指定 Body
     */
    spawnCreep(roomName: string, callback: (name: string) => void, body: BodyPartConstant[], priority: number, memory?: CreepMemory, workPos?: RoomPosition, strict? : boolean): void
}

const PRIORITY_CRITICAL = 0
const PRIORITY_IMPORTANT = 1
const PRIORITY_NORMAL = 2
const PRIORITY_CASUAL = 3

type CreepTypeDescriptor = {
    /** 体型设计 */
    body: {
        /** 按照 Controller 等级划分. 达到特定 Controller 等级, 发生变化. */
        [controllerLevel: number]: BodyPartConstant[]
    } | BodyPartConstant[], 
    /** 数量设计 (最大数量) */
    amount?: {
        /** 按照 Controller 等级划分. 达到特定 Controller 等级, 发生变化. */
        [controllerLevel: number]: number | 'auto'
    } | number | 'auto', 
    /** 特权级别 */
    priority?: number
    /** 是否允许缩减 Body 以满足现有能量 */
    strict?: boolean
}

class CreepModule {
    /** 生产 Creep 特权级别 —— 危急! */
    PRIORITY_CRITICAL = PRIORITY_CRITICAL
    /** 生产 Creep 特权级别 —— 重要 */
    PRIORITY_IMPORTANT = PRIORITY_IMPORTANT
    /** 生产 Creep 特权级别 —— 正常 */
    PRIORITY_NORMAL = PRIORITY_NORMAL
    /** 生产 Creep 特权级别 —— 随意 */
    PRIORITY_CASUAL = PRIORITY_CASUAL
    /** 可用 Creep 最少尚存 Ticks */
    MINIMUM_TICKS_TO_LIVE = 0
    #emaBeta: number = 0.9
    #context: CreepModuleContext
    #types: { [type: string]: { [controllerLevel: string]: {body: BodyPartConstant[], amount: number | 'auto', priority: number, strict: boolean} } } = {}
    /**
     * 设计特定型号的 Creep
     * @param type 型号名称
     * @param descriptor 型号描述
     */
    design(type: string, descriptor: CreepTypeDescriptor): void {
        assertWithMsg(!(type in this.#types), `无法再次注册已有的 Creep 型号 '${type}'`)
        if ( Array.isArray(descriptor.body) ) descriptor.body = { 1: descriptor.body }
        if ( descriptor.amount === undefined) descriptor.amount = 'auto'
        if ( typeof descriptor.amount !== 'object' ) descriptor.amount = { 1: descriptor.amount }
        if ( descriptor.priority === undefined ) descriptor.priority = PRIORITY_NORMAL
        
        this.#types[type] = {}
        // 特定型号的 Creep 按照 Controller 等级划分体型
        for (const level of Object.keys(CONTROLLER_LEVELS))
            // 为了方便指定, 我们在输入的时候, 不一定需要指明所有的
            // Controller 等级对应的体型和数量. 而是输入的 Controller
            // 等级对应于体型, 数量发生变化.
            this.#types[type][level] = {
                body: largest_less_than(Object.keys(descriptor.body), level) === null ? [ MOVE ] : descriptor.body[largest_less_than(Object.keys(descriptor.body), level)], 
                amount: largest_less_than(Object.keys(descriptor.amount), level) === null ? 0 : descriptor.amount[largest_less_than(Object.keys(descriptor.amount), level)], 
                priority: descriptor.priority, strict: descriptor.strict
            }
    }
    #repo: { [type: string]: {
        [roomName: string]: {
            /** 就绪 (闲置) 的 Creep name 序列 */
            ready: string[], 
            /** 匆忙 (已被占用) 的 Creep name 序列 */
            busy: string[], 
            /** 正在生成的 Creep 数量 (已经加入到生成队列中) */
            spawning: number, 
            /** 数量控制信号量 Id (本质上是对应的 就绪序列 长度) */
            signalId: string, 
            /** 最后一次 Check 是否有消亡的 tick (防止同一 tick 多次申请引发多次无效 Check) */
            lastCheckTick: number, 
            /** 请求该型号和管辖房间的数量 (EMA). 用于自动数量控制. */
            requestEMA: number
        }
    } } = {}
    
    #getRepo(type: string, roomName: string) {
        if ( !(type in this.#repo) ) this.#repo[type] = {}
        if ( !(roomName in this.#repo[type]) ) this.#repo[type][roomName] = { ready: [], busy: [], spawning: 0, signalId: A.proc.signal.createSignal(0), lastCheckTick: Game.time - 1, requestEMA: null }
        return this.#repo[type][roomName]
    }

    #getWaiting(type: string, roomName: string): number {
        const signalId = this.#getRepo(type, roomName).signalId
        return (A.proc as any).signalDict[signalId].stuckList.length
    }
    /**
     * 申请特定型号的 Creep
     * 
     * @atom
     * @param type 型号名称
     * @param roomName 申请的房间名称 (必须在控制内)
     * @param callback 申请到后执行的回调函数
     * @param workPos Creep 预计的工作地点
     */
    acquire(type: string, roomName: string, callback: (name: string) => void, workPos?: RoomPosition) {
        const repo = this.#getRepo(type, roomName)
        if ( repo.lastCheckTick < Game.time ) {
            // 惰性检测: 是否有 Creep 消亡
            for ( const name of [...repo.ready, ...repo.busy] )
                if ( !(name in Game.creeps) )
                    this.cancel(name)
            // _.forEach([...repo.ready], name => !(name in Game.creeps) && this.cancel(name))
            // _.forEach([...repo.busy], name => !(name in Game.creeps) && this.cancel(name))
            repo.lastCheckTick = Game.time

            // 消亡后判定: 是否需要生产新的 Creep
            this.#replenish(type, roomName, workPos)
        }
        
        if ( _.filter(repo.ready, creepName => Game.creeps[creepName] && Game.creeps[creepName].ticksToLive > this.MINIMUM_TICKS_TO_LIVE).length > 0 ) {
            // 此时有可用的 Creep
            const name = _.sortBy( _.filter(repo.ready, creepName => Game.creeps[creepName] && Game.creeps[creepName].ticksToLive > this.MINIMUM_TICKS_TO_LIVE), creepName => Game.creeps[creepName].pos.roomName !== roomName? Infinity : ( workPos? Game.creeps[creepName].pos.getRangeTo(workPos) : 0 ) )[0]
            assertWithMsg( typeof name === "string", `${roomName} => ${type} 匹配到的 creep 无效! 所有可用 creeps: ${JSON.stringify(repo.ready)}` )
            assertWithMsg( A.proc.signal.Swait({ signalId: repo.signalId, lowerbound: 1, request: 1 }) === OK, `申请 模块型号 '${type}', 管辖房间 '${roomName}' 的 Creep 时, 管理闲置数量的信号量数值与闲置数量不匹配` )
            _.remove( repo.ready, v => v === name )
            repo.busy.push(name)
            callback(name)
            return OK
        } else {
            const ret = A.proc.signal.Swait({ signalId: repo.signalId, lowerbound: 1, request: 1 })
            // 请求时判定: 是否需要生产新的 Creep
            this.#replenish(type, roomName, workPos)
            return ret
        }
    }
    /**
     * 归还特定的 Creep
     */
    release(name: string): typeof OK {
        assertWithMsg(name in Game.creeps, `无法找到 Creep '${name}' 以归还`)
        const creep = Game.creeps[name]

        assertWithMsg(creep.memory.spawnType in this.#repo, `无法找到 Creep '${name}' 的型号 '${creep.memory.spawnType}' 以归还`)
        const repo = this.#getRepo(creep.memory.spawnType, creep.memory.spawnRoomName)

        assertWithMsg(_.includes(repo.busy, name), `Creep 模块型号 '${creep.memory.spawnType}' 的管辖房间 '${creep.memory.spawnRoomName}'内无法找到正在被占用的 Creep '${name}'`)

        // 从忙碌队列中删去
        _.pull(repo.busy, name)
        let addedBack = false
        // 移动 creep 到空闲位置
        A.timer.add(Game.time + 1, creepName => {
            const creep = Game.creeps[creepName]
            if ( !creep ) return A.timer.STOP
            if ( !addedBack ) {
                addedBack = true
                repo.ready.push(name)
                // 更新信号量
                A.proc.signal.Ssignal({ signalId: repo.signalId, request: 1 })
            }
            if ( _.includes(repo.busy, creep.name) ) return A.timer.STOP
            if ( creep.pos.lookFor(LOOK_STRUCTURES).filter(s => s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_ROAD).length === 0 ) return A.timer.STOP
            creep.travelTo(creep.pos, { flee: true, ignoreCreeps: false, offRoad: true, avoidStructureTypes: [ STRUCTURE_CONTAINER, STRUCTURE_ROAD ] })
        }, [ creep.name ], `闲置 ${creep}`, 1)

        return OK
    }

    /**
     * 申请生产特定型号新的 Creep
     * 注意: 本函数不进行数量控制
     */
    #issue(type: string, roomName: string, workPos?: RoomPosition) {
        this.#getRepo(type, roomName).spawning += 1
        const controllerLevel = Game.rooms[roomName].controller.level
        const prototype = this.#types[type][controllerLevel]
        const { spawnCreep } = this.#context
        
        return spawnCreep(roomName, 
            /** @CrossRef Relevant function in the constructor */
            (name: string) => {
                const repo = this.#getRepo(type, roomName)
                repo.spawning -= 1
                this.#register(name)
            }, 
            prototype.body, prototype.priority, { spawnType: type, spawnRoomName: roomName }, workPos, prototype.strict
        )
    }

    /** 获得当前期望的最佳数量 (综合考虑设计时的数量设置, 当前拥有的数量, 以及期望的数量) */
    #getExpectedAmount(type: string, roomName: string): number {
        const controllerLevel = Game.rooms[roomName].controller.level
        const descriptor = this.#types[type][controllerLevel]
        const repo = this.#getRepo(type, roomName)
        const currentAmount = repo.ready.length + repo.busy.length + repo.spawning
        const currentRequest = repo.busy.length + this.#getWaiting(type, roomName)
        
        if ( typeof descriptor.amount === "number" ) {
            // 限定最大数量 ( 限定数量 与 请求之间的最大值 )
            return Math.min(currentRequest, descriptor.amount)
        } else if ( descriptor.amount === "auto" ) {
            let amount = null
            if ( repo.requestEMA === null ) amount = currentRequest
            else amount = repo.requestEMA
            // 自动数量控制
            // Log 函数 - 经过 (0, 0), (1, 1)
            const expectedAmount = Math.ceil(Math.log((Math.E - 1) * amount + 1))
            return Math.min(currentRequest, expectedAmount)
        }
    }

    /** 补充特定型号的 Creep 数量 (不检查是否有 Creep 应当消亡) */
    #replenish(type: string, roomName: string, workPos?: RoomPosition) {
        const repo = this.#getRepo(type, roomName)
        const controllerLevel = Game.rooms[roomName].controller.level
        const descriptor = this.#types[type][controllerLevel]
        assertWithMsg( descriptor.amount !== 'auto' || !workPos, `指定 WorkPos 时, 数量不可设置为 auto 由于定时补充数量任务. 但是收到对于 ${roomName} -> ${type} 的 WorkPos 指定!` )
        const currentAmount = repo.ready.length + repo.busy.length + repo.spawning
        const expectedAmount = this.#getExpectedAmount(type, roomName)
        log(LOG_DEBUG, `检查管辖房间 ${roomName}, 型号 ${type} Creep: ${currentAmount}/${expectedAmount}`)
        for ( let i = 0; i < expectedAmount - currentAmount; ++i ) this.#issue(type, roomName, workPos)
    }
    
    /**
     * 注册特定的 Creep 进入本模块进行管理
     * 
     * @param roomName 申请的房间名称 (必须在控制内)
     */
    #register(name: string) {
        assertWithMsg(name in Game.creeps, `无法找到 Creep '${name}' 以注册`)
        const creep = Game.creeps[name]

        // assertWithMsg(creep.memory.spawnType in this.#types, `无法找到 Creep '${name}' 的型号 '${creep.memory.spawnType}' 以注册`)

        const repo = this.#getRepo(creep.memory.spawnType, creep.memory.spawnRoomName)
        assertWithMsg(!_.includes(repo.ready, name) && !_.includes(repo.busy, name), `Creep '${name}' (型号 '${creep.memory.spawnType}') 已经被注册, 无法再次注册`)
        repo.ready.push(name)
        A.proc.signal.Ssignal({ signalId: repo.signalId, request: 1 })

        // 移动 creep 到空闲位置
        A.timer.add(Game.time + 1, creepName => {
            const creep = Game.creeps[creepName]
            if ( !creep ) return A.timer.STOP
            if ( _.includes(repo.busy, creep.name) ) return A.timer.STOP
            if ( creep.pos.lookFor(LOOK_STRUCTURES).filter(s => s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_ROAD).length === 0 ) return A.timer.STOP
            creep.travelTo(creep.pos, { flee: true, ignoreCreeps: false, offRoad: true, avoidStructureTypes: [ STRUCTURE_CONTAINER, STRUCTURE_ROAD ] })
        }, [ creep.name ], `闲置 ${creep}`, 1)
    }

    /**
     * 注销特定的 Creep
     * 注意: 注销时, 并不考虑再次 Spawn 以弥补空位的问题
     */
    cancel(name: string) {
        log(LOG_DEBUG, `正在注销 Creep [${name}] ...`)
        /** 可能出现同一个 Creep 被两次 Cancel 的情况, 即周期性检查取消发生在前, 具体进程取消在后 */
        if ( !(name in Memory.creeps) ) {
            for ( const type in this.#repo ) {
                for (const roomName in this.#repo[type]) {
                    assertWithMsg(this.#repo[type][roomName].ready.indexOf(name) == -1, `${name} 消亡, 但是未在 Creep 数量管理模块 (ready) 中注销`)
                    assertWithMsg(this.#repo[type][roomName].busy.indexOf(name) == -1, `${name} 消亡, 但是未在 Creep 数量管理模块 (busy) 中注销`)
                }
            }
            return 
        }
        if ( Memory.creeps[name].spawnType in this.#types ) {
            const repo = this.#getRepo(Memory.creeps[name].spawnType, Memory.creeps[name].spawnRoomName)

            if ( _.includes(repo.ready, name) ) {
                // 闲置时注销, 此时可能是周期性消亡, 或者是申请 Creep
                // 时发现.
                // 此时, 信号量需要发生改变.
                // 注意: 闲置注销, 注销应当不会引起进程饥饿.
                _.pull(repo.ready, name)
                assertWithMsg(A.proc.signal.Swait({ signalId: repo.signalId, lowerbound: 1, request: 1 }) === OK, `注销闲置 Creep 时, 信号量应该一定大于 0, 但是不是`)
            } else if ( _.includes(repo.busy, name) ) {
                // 被占用时注销, 可能是周期性消亡, 也可能是占用的进程
                // 在执行时出现错误, 发现 Creep 死亡.
                // 此时, 信号量不需要发生改变.
                // 注意: 为了防止原本占用 Creep 的进程不再申请 Creep, 
                // 导致出现最终无 Creep 可用, 却有申请等待的进程, 即
                // 进程饥饿现象, 在消亡时, 进行数量检查并进行补充.
                _.pull(repo.busy, name)
            }
            
            this.#replenish(Memory.creeps[name].spawnType, Memory.creeps[name].spawnRoomName)
        }
        delete Memory.creeps[name]
    }

    constructor(context: CreepModuleContext) {
        this.#context = context

        // 注册周期性消亡 Creep 功能
        const period = CREEP_LIFE_TIME
        // 避免在重启时, 所有周期任务都堆叠在一起
        A.timer.add(Game.time + 1 + Math.floor(Math.random() * period), () => {
            // 释放 Creep 资源
            for (const name in Memory.creeps)
                if ( !(name in Game.creeps) )
                    this.cancel(name)
        }, [], `周期性检查释放消亡 Creep 资源`, period)

        // 注册已有的 Creep
        for (const name in Game.creeps)
            if ( !Game.creeps[name].spawning )
                this.#register(name)
            else {
                const { issueRegisterAfterSpawn } = this.#context
                const creep = Game.creeps[name]
                const type = creep.memory.spawnType
                const roomName = creep.memory.spawnRoomName
                this.#getRepo(type, roomName).spawning += 1
                /** @CrossRef Relevant function in this.#issue */
                issueRegisterAfterSpawn( name, (name: string) => {
                    const repo = this.#getRepo(type, roomName)
                    repo.spawning -= 1
                    this.#register(name)
                } )
            }
        
        // 注册不同型号, 不同归属房间请求数量计算 EMA
        A.timer.add(Game.time + 1, () => {
            for (const type in this.#repo)
                for (const roomName in this.#repo[type]) {
                    const currentRequest = this.#repo[type][roomName].busy.length + this.#getWaiting(type, roomName)
                    if ( this.#repo[type][roomName].requestEMA === null ) this.#repo[type][roomName].requestEMA = currentRequest
                    else this.#repo[type][roomName].requestEMA = this.#repo[type][roomName].requestEMA * this.#emaBeta + currentRequest * (1 - this.#emaBeta)
                }
        }, [], `追踪记录每个管辖房间, 每个型号的 Creep 数量`, 1)

        // 定期检查数量为 `auto` 的 Creep 型号, 补充数量
        A.timer.add(Game.time + 1 + Math.ceil(Math.random() * CREEP_LIFE_TIME), () => {
            for (const type in this.#repo) {
                for (const roomName in this.#repo[type]) {
                    if ( !Game.rooms[roomName] || !Game.rooms[roomName].controller ) continue
                    const controllerLevel = Game.rooms[roomName].controller.level
                    const descriptor = this.#types[type][controllerLevel]
                    if ( descriptor.amount === 'auto' )
                        this.#replenish(type, roomName)
                }
            }
        }, [], `定时检查是否需要补充数量为 auto 的 Creep 型号`, CREEP_LIFE_TIME)
    }
}

/**
 * Creep 生产模块
 */

function calculateBodyCost(bodies: BodyPartConstant[]) {
    let cost = 0
    for ( const body of bodies )
        cost += BODYPART_COST[body]
    return cost
}

function groupBodyCost(bodies: BodyPartConstant[]) {
    let cost = {}
    for ( const body of bodies ) {
        if ( !(body in cost) ) cost[body] = 0.
        cost[body] += BODYPART_COST[body]
    }
    return cost
}

function reduceBody(energyAvailable: number, bodies: BodyPartConstant[]) {
    const total_cost = calculateBodyCost(bodies)
    const body2cost = groupBodyCost(bodies)
    if ( total_cost <= energyAvailable ) return bodies
    else {
        const reduced_bodies = []
        for ( const body of [ TOUGH, CARRY, MOVE, WORK, CLAIM, ATTACK, HEAL, RANGED_ATTACK ] ) {
            if ( body in body2cost ) {
                const num = Math.max(Math.floor(body2cost[body] * energyAvailable / total_cost / BODYPART_COST[body]), 1)
                for ( let i = 0; i < num; ++i ) reduced_bodies.push(body)
            }
        }
        return reduced_bodies
    }
}

type RequestCreepType = {
    callback: (name: string) => void, 
    cost: number, 
    body: BodyPartConstant[], 
    requestTick: number, 
    memory?: CreepMemory, 
    workPos?: RoomPosition, 
    strict: boolean, 
    requestId: string, 
}

class CreepSpawnModule {
    #repo: { [roomName: string]: { [priority: number]: RequestCreepType[] } } = {}
    #issuedRoomNames: string[] = []

    issueRegisterAfterSpawn(creepName: string, callback: (name: string) => void): void {
        A.timer.add(Game.time + 1, (name, callback) => {
            if ( name in Game.creeps && !Game.creeps[name].spawning ) {
                callback(name)
                return A.timer.STOP
            }
        }, [ creepName, callback ], `对于 Creep [${creepName}] 的出生注册`, CREEP_SPAWN_TIME)
    }

    request(roomName: string, callback: (name: string) => void, body: BodyPartConstant[], priority: number, memory?: CreepMemory, workPos?: RoomPosition, strict: boolean = false): void {
        if ( !(roomName in this.#repo) ) this.#repo[roomName] = {}
        if ( !(priority in this.#repo[roomName]) ) this.#repo[roomName][priority] = []
        this.#repo[roomName][priority].push({ callback, cost: calculateBodyCost(body), body, requestTick: Game.time, memory, workPos, requestId: generate_random_hex(32), strict })
    }

    #calRequestAmount(roomName: string): number {
        if ( !(roomName in this.#repo) ) return 0
        let amount = 0
        for ( const priority in this.#repo[roomName] )
            amount += this.#repo[roomName][priority].length
        return amount
    }

    #issueRoomSpawnProc(roomName: string) {
        if ( _.includes(this.#issuedRoomNames, roomName) ) {
            log(LOG_DEBUG, `${roomName} 已经有进程控制 Creep 生产, 但是收到再次创建同样进程的请求. 可能是房间丢失后重新获得?`)
            return
        } else this.#issuedRoomNames.push(roomName)

        const roomSpawnProc = () => {
            // 房间丢失的情况, 则进程休眠
            if ( !(roomName in Game.rooms) || !Game.rooms[roomName].controller.my ) return A.proc.STOP_SLEEP
            if ( !(roomName in this.#repo) ) return A.proc.STOP_SLEEP
            // 每 tick 只检查一次
            const spawns = Game.rooms[roomName].find<FIND_MY_STRUCTURES, StructureSpawn>(FIND_MY_STRUCTURES, {filter: {structureType: STRUCTURE_SPAWN}})
            const availableSpawns = _.filter(spawns, s => !s.spawning )
            if ( availableSpawns.length === 0 ) return A.proc.OK_STOP_CURRENT

            // 按照优先级别顺序
            const priorities = _.sortBy(Object.keys(this.#repo[roomName]))
            let flag = false
            for (const priority of priorities) {
                // 最高响应比优先调度算法
                // 这里等待 tick 乘以的系数应当最好为每秒本房间
                // energy 的产量
                // const orders = _.sortBy(this.#repo[roomName][priority], (element: RequestCreepType) => -((Game.time - element.requestTick) * 50.0 + element.cost) / element.cost)
                const orders = _.sortBy(this.#repo[roomName][priority], (element: RequestCreepType) => element.cost)
                log(LOG_DEBUG, `${roomName} 当前优先级为 ${priority} 的等待生产 Creep 的数量为 ${orders.length}`)
                for (const order of orders) {
                    // 检查是否为特定 Spawn
                    let spawn: StructureSpawn = null
                    if ( order.workPos && _.any(spawns, s => s.pos.getRangeTo(order.workPos) <= 1 ) ) {
                        spawn = _.select(spawns, s => s.pos.getRangeTo(order.workPos) <= 1)[0]
                        if ( !_.any(availableSpawns, s => s.id === spawn.id) ) continue
                    } else
                        spawn = availableSpawns[0]
                    
                    // 无论能量够不够, 都不再往后检查
                    flag = true
                    let cost = order.cost
                    let bodies = order.body
                    // 允许缩减规模时, 缩减能量
                    if ( !order.strict ) {
                        bodies = reduceBody(Game.rooms[roomName].energyAvailable, bodies)
                        cost = calculateBodyCost(bodies)
                    }
                    if ( Game.rooms[roomName].energyAvailable >= cost ) {
                        let name = null
                        while ( !name || name in Game.creeps )
                            name = `${roomName}-${generate_random_hex(4)}`
                        const spawnReturn = spawn.spawnCreep(bodies, name, {
                            memory: order.memory, 
                            directions: (order.workPos && spawn.pos.getRangeTo(order.workPos) <= 1)? [ spawn.pos.getDirectionTo(order.workPos) ] : undefined
                        })
                        assertWithMsg(spawnReturn === OK, `生产 Creep [${bodies}; ${roomName}] 时, 选定的 Spawn [${spawn.id}] 无法成功生产 Creep (ERR Code: ${spawnReturn})`)
                        this.issueRegisterAfterSpawn( name, order.callback )
                        // 删除成功 Spawn 的订单
                        _.remove(this.#repo[roomName][priority] as RequestCreepType[], o => o.requestId === order.requestId)
                    }
                    break
                }
                if ( flag ) break
            }
            const remainingOrderAmount = this.#calRequestAmount(roomName)
            return remainingOrderAmount > 0? A.proc.OK_STOP_CURRENT : A.proc.STOP_SLEEP
        }
        const pid = A.proc.createProc([ roomSpawnProc ], `${roomName} => Spawn`)
        A.proc.trigger('watch', () => {
            if ( !(roomName in Game.rooms) || !Game.rooms[roomName].controller.my ) return false
            const remainingOrderAmount = this.#calRequestAmount(roomName)
            log(LOG_DEBUG, `当前 ${roomName} 内剩余需要生产的 Creep 数量为 ${remainingOrderAmount}.`)
            return remainingOrderAmount > 0
        }, [ pid ])
    }

    constructor() {
        for ( const roomName in Game.rooms ) {
            if ( Game.rooms[roomName].controller && Game.rooms[roomName].controller.my )
                this.#issueRoomSpawnProc(roomName)
        }
        A.proc.trigger('after', Creep.prototype, 'claimController', (returnValue: CreepActionReturnCode, creep: Creep, target: StructureController) => {
            if ( returnValue === OK )
                this.#issueRoomSpawnProc(target.room.name)
            return []
        })
    }
}

const creepSpawnModule = new CreepSpawnModule()
export const creepModule = new CreepModule({
    spawnCreep: (...args) => creepSpawnModule.request(...args), 
    issueRegisterAfterSpawn: (...args) => creepSpawnModule.issueRegisterAfterSpawn(...args)
})