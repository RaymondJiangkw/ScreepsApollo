import { assertWithMsg, generate_random_hex, log, LOG_DEBUG, LOG_ERR, LOG_INFO, LOG_PROFILE, stackError, stackLog } from "@/utils"
import { sourceMappedStackTrace } from "@/modules/errorMapper"

// -------------------------------------------------------------

/**
 * 原子函数相关
 */

const STOP_STUCK = "stop_stuck"
const STOP_ERR = "stop_err"
const STOP_SLEEP = "stop_sleep"
const OK_STOP_CURRENT = "ok_stop_current"
const OK_STOP_NEXT = "ok_stop_next"
const OK_STOP_CUSTOM = "ok_stop_custom"

/** 普通原子函数返回值 */
type AtomicFuncReturnCode = OK | typeof OK_STOP_CURRENT | typeof OK_STOP_NEXT | [typeof OK_STOP_CUSTOM, string] | [typeof STOP_ERR, string] | typeof STOP_SLEEP | [typeof STOP_SLEEP, number]
/** 可阻塞的原子函数返回值 */
type StuckableAtomicFuncReturnCode = OK | typeof STOP_STUCK

/** 原子函数 */
type AtomicFunc = () => AtomicFuncReturnCode | StuckableAtomicFuncReturnCode
/** Tag + 原子函数 */
type AtomicFuncWithTag = [string, AtomicFunc]
/** 条件跳转: "JUMP" + 条件 + Tag */
type AtomicJump = ["JUMP", () => boolean, string]

/** 原子函数描述器, 用于构建进程时 */
type AtomicFuncDescriptor = (AtomicFunc | AtomicFuncWithTag | AtomicJump)[]

/**
 * 锁相关
 */

/** 随机生成一个锁的 Id */
const getLockId = () => generate_random_hex(8)

/**
 * 锁类实体
 * 不对外公开
 */
class Lock {
    /** 锁 Id */
    lockId: string
    /** 持有锁的进程 Id */
    holder: ProcId
    /** 请求锁而阻塞的进程 Id 列表 */
    stuckList: ProcId[]
    constructor(lockId: string) {
        this.lockId = lockId
        this.holder = null
        this.stuckList = []
    }
}

/**
 * 锁模块
 */
interface LockModule {
    /** 创建一个新锁 */
    createLock(): string
    /** 销毁一个锁 */
    destroyLock(lockId: string): void
    /** @atom 获得一个锁, 只能在进程流程中运行使用 */
    acquireLock(lockId: string): StuckableAtomicFuncReturnCode
    /** @atom 释放一个锁, 只能在进程流程中运行使用 */
    releaseLock(lockId: string): OK
}

/**
 * 信号集相关
 */

/** 随机生成一个信号量的 Id */
const getSignalId = () => generate_random_hex(8)

/**
 * 信号量类实体
 * 不对外公开
 */
class Signal {
    /** 信号量 Id */
    signalId: string
    /** 因该信号量而阻塞的 [进程 Id, lower bound] 列表 */
    stuckList: [ProcId, number][]
    /** 信号量值 */
    value: number
    constructor(signalId: string, value: number) {
        this.signalId = signalId
        this.stuckList = []
        this.value = value
    }
}

/**
 * 信号量模块
 */
interface SignalModule {
    /** 
     * 创建一个新信号量
     * @param value 初始值
     */
    createSignal(value: number): string
    /** 销毁一个信号量 */
    destroySignal(signalId: string): void
    /** @atom 等待一个信号量集, 只能在进程流程中运行使用 */
    Swait(...signals: {signalId: string, lowerbound: number, request: number}[]): StuckableAtomicFuncReturnCode
    /** @atom 激活一个信号量集, 只能在进程流程中运行使用 */
    Ssignal(...signals: {signalId: string, request: number}[]): StuckableAtomicFuncReturnCode
    /** 获得信号量的值 */
    getValue(signalId: string): number
}

/**
 * 进程相关
 */

export type ProcId = number
const MAX_PROC_ID = 36767

const PROCESS_STATE_SLEEP = "Sleep"
const PROCESS_STATE_READY = "Ready"
const PROCESS_STATE_STUCK = "Stuck"
const PROCESS_STATE_RUNNING = "Running"

/**
 * 进程的类定义
 */
class Process {
    /** 进程号 */
    pid: ProcId
    /** 进程文字描述 (强制要求, 有利于监控与描述) */
    description: string
    /** 进程具体流程 */
    descriptor: AtomicFuncDescriptor
    /** 记录当前进程运行到的原子函数行数 */
    pc: number
    /** Tag 到对应原子函数行数的映射 (缓存加速) */
    tagDict: {[tag: string]: number}
    /** 进程状态 */
    state: typeof PROCESS_STATE_SLEEP | typeof PROCESS_STATE_READY | typeof PROCESS_STATE_STUCK | typeof PROCESS_STATE_RUNNING
    /** 记录进程的时间花销 */
    #cpuCost: number

    constructor(
        pid: ProcId, 
        description: string, 
        descriptor: AtomicFuncDescriptor
    ) {
        this.pid = pid
        this.description = description
        this.descriptor = descriptor

        // 初始化 Cost
        this.#cpuCost = null
        // 初始化当前 PC
        this.pc = 0
        // 计算 Tag 到对应原子函数行数的映射
        this.tagDict = {}
        this.descriptor.forEach((value, index) => {
            // 检查属于 AtomicFuncWithTag
            if ( Array.isArray(value) && value.length === 2 )
                this.tagDict[value[0]] = index
        })
        // 初始化状态
        this.state = PROCESS_STATE_READY

        // 检查跳转的 Tag 都存在
        for (const desc of this.descriptor) {
            if ( Array.isArray(desc) && desc.length === 3 )
                assertWithMsg(desc[2] in this.tagDict, `在检查进程 ${this} 时发现未识别的跳转后标签 ${desc[2]}`)
        }
    }
    
    toString() {
        return `[Proc ${this.pid} (${this.state}): ${this.description}]`
    }

    updateCpuCost(cpuCost: number) {
        this.#cpuCost = cpuCost
    }

    getCpuCost() {
        return this.#cpuCost
    }
}

/**
 * 进程模块的类定义 (Singleton)
 * 
 * 特别的, 暂时不允许 kill 进程 (权限控制问题).
 */
class ProcessModule {
    /**
     * 常量定义
     */
    /** 原子函数返回值 - 停止, 下次执行时, 仍然从当前原子函数重复执行 */
    OK_STOP_CURRENT: typeof OK_STOP_CURRENT = OK_STOP_CURRENT
    /** 原子函数返回值 - 停止, 下次执行时, 从原子函数下一条继续执行 */
    OK_STOP_NEXT: typeof OK_STOP_NEXT = OK_STOP_NEXT
    /** 原子函数返回值 - 停止, 下次执行时, 从指定 Tag 开始继续执行 */
    OK_STOP_CUSTOM: typeof OK_STOP_CUSTOM = OK_STOP_CUSTOM
    /** 原子函数返回值 - 继续执行下一个原子函数 */
    OK: typeof OK = OK
    /** 原子函数返回值 - (特殊) 阻塞当前进程 */
    #STOP_STUCK: typeof STOP_STUCK = STOP_STUCK
    /** 原子函数返回值 - 错误, 在下一 tick 重启运行该进程 */
    STOP_ERR: typeof STOP_ERR = STOP_ERR
    /** 原子函数返回值 - 休眠, 在特定条件下再触发 */
    STOP_SLEEP: typeof STOP_SLEEP = STOP_SLEEP

    /**
     * 辅助变量与函数定义
     */
    /** 当前正在运行的进程 Id, 用于内部阻塞原子函数识别进程 */
    #currentProcId: ProcId = -1
    /** 就绪进程 Id 队列 */
    #processIdReadyQueue: ProcId[] = []
    /** 阻塞进程 Id 队列 */
    #processIdStuckQueue: ProcId[] = []
    /** 休眠进程 Id 队列 */
    #processIdSleepQueue: ProcId[] = []
    /** 映射进程 Id 到进程实体 */
    #procDict: {[ id: ProcId ]: Process} = {}
    /** 断言进程 Id 存在, 用于检查 */
    #assertExistProcId(id: ProcId, task: string) {
        assertWithMsg( id in this.#procDict, `在 ${task} 中, 检查进程 Id ${id} 不存在` )
    }
    /** 断言正在运行的进程 Id, 用于检查 */
    #assertCurrentProcId(id: ProcId, task: string) {
        this.#assertExistProcId(id, `${task} -> 断言进程 Id ${id} 正在运行`)
        assertWithMsg( this.#currentProcId === id, `在 ${task} 中, 检查进程 Id ${id} 是否正在运行, 却发现正在运行的进程为 ${this.#procDict[id]}` )
    }

    /** 可用的进程 Id 链表 */
    #idLinkList: ProcId[] = [ ...Array(MAX_PROC_ID).keys() ]
    /** 获得下一个进程 Id */
    #getProcId(): ProcId {
        // 无可用的进程 Id
        assertWithMsg( this.#idLinkList.length !== 0, `无可用进程 Id` )
        // 返回进程 Id 链表中第一个可用 Id
        return this.#idLinkList.shift()
    }

    /** 对外暴露唤醒进程调试接口, 危险! */
    __wakeUpProc(id: ProcId) {
        this.#wakeUpProc(id)
    }

    /**
     * 将进程从阻塞态唤醒到就绪态
     * 
     * 注意: 考虑到群惊效应, 进程可能被唤醒多次. 因此, 若
     * 进程出于就绪态, 不会报错. 但是因为同一时间只有一个
     * 运行的进程, 而自己不能唤醒自己, 会报错.
     */
    #wakeUpProc(id: ProcId) {
        // 找不到进程 id
        this.#assertExistProcId(id, `唤醒进程 Id ${id}`)
        
        const proc = this.#procDict[id]
        const state = proc.state

        if ( state === PROCESS_STATE_READY )  {
            // 已经处于就绪的进程
            // 无需处理
        } else if ( state === PROCESS_STATE_STUCK ) {
            // 唤醒阻塞中进程
            // 从阻塞进程 Id 队列中删除
            _.pull(this.#processIdStuckQueue, id)
            // 将进程 Id 加入就绪进程 Id 队列中
            this.#processIdReadyQueue.push(id)
        } else if ( state === PROCESS_STATE_RUNNING ) {
            // 唤醒运行中进程
            throw `Error: 进程 ${proc} 处于运行态, 无法被唤醒`
        } else if ( state === PROCESS_STATE_SLEEP ) {
            // 唤醒睡眠中进程
            // 从睡眠进程 Id 队列中删除
            _.pull(this.#processIdSleepQueue, id)
            // 将进程 Id 加入就绪进程 Id 队列中
            this.#processIdReadyQueue.push(id)
        }
        // 调整状态为就绪
        proc.state = PROCESS_STATE_READY
    }

    /** 阻塞进程 */
    #stuckProc(id: ProcId) {
        // 找不到进程 id
        this.#assertExistProcId(id, `阻塞进程 Id ${id}`)

        const proc = this.#procDict[id]
        const state = proc.state

        if ( state === PROCESS_STATE_READY ) {
            // 阻塞就绪进程, 从就绪进程 Id 队列中删去
            _.pull(this.#processIdReadyQueue, id)
        } else if ( state === PROCESS_STATE_RUNNING ) {
            // 阻塞运行进程
            this.#assertCurrentProcId(id, `阻塞进程 Id ${id}`)
            // 重置正在运行的进程 Id
            this.#currentProcId = -1
        } else if ( state === PROCESS_STATE_STUCK ) {
            throw `Error: 进程 ${proc} 已经处于阻塞态, 无法再次被阻塞`
        } else if ( state === PROCESS_STATE_SLEEP ) {
            // 阻塞睡眠中进程
            throw `Error: 进程 ${proc} 处于睡眠态, 无法被阻塞`
        }

        // 调整状态为阻塞
        proc.state = PROCESS_STATE_STUCK
        // 将进程 Id 加入阻塞进程 Id 队列中
        this.#processIdStuckQueue.push(id)
    }

    /** 
     * 销毁进程
     * @todo 给未释放的锁, 信号量或管程提出警告
     */
    #destroyProc(id: ProcId) {
        // 找不到进程 id
        this.#assertExistProcId(id, `销毁进程 Id ${id}`)
        
        const proc = this.#procDict[id]
        const state = proc.state

        if ( state === PROCESS_STATE_READY ) {
            // 销毁就绪进程
            // 从就绪进程 Id 队列中删去
            _.pull(this.#processIdReadyQueue, id)
        } else if ( state === PROCESS_STATE_RUNNING ) {
            // 销毁运行中进程
            // 确认当前只有一个进程正在运行
            // 并且为正被销毁的进程
            this.#assertCurrentProcId(id, `销毁进程 Id ${id}`)
            // 重置正在运行的进程 Id
            this.#currentProcId = -1
        } else if ( state === PROCESS_STATE_STUCK ) {
            // 销毁阻塞进程
            // 从阻塞进程 Id 队列中删去
            _.pull(this.#processIdStuckQueue, id)
        } else if ( state === PROCESS_STATE_SLEEP ) {
            // 销毁睡眠进程
            // 从睡眠进程 Id 队列中删去
            _.pull(this.#processIdSleepQueue, id)
        }
        
        // 从映射中删去实体
        delete this.#procDict[id]
        // 归还进程 Id
        this.#idLinkList.push(id)
    }

    /**
     * 创建进程
     * @param descriptor 进程具体流程
     * @param description 进程简要描述
     * @param sleep 进程初始是否是休眠态, 还是就绪态
     * @returns 进程 Id
     */
    createProc(descriptor: AtomicFuncDescriptor, description: string, sleep: boolean = false): ProcId {
        const id = this.#getProcId()
        const proc = new Process(id, description, descriptor)

        // 将进程注册到映射表中
        this.#procDict[id] = proc
        if ( !sleep ) {
            // 初始化进程状态为就绪态
            proc.state = PROCESS_STATE_READY
            // 将新创建的进程加入到就绪队列当中
            this.#processIdReadyQueue.push(id)
        } else {
            // 初始化进程状态为休眠态
            proc.state = PROCESS_STATE_SLEEP
            // 将新创建的进程加入到休眠队列当中
            this.#processIdSleepQueue.push(id)
        }

        return id
    }
    /** 记录上一次调用 tick 的 Game.time 以保证每 tick 只能执行一次 tick */
    #lastTick: number = -1

    /**
     * 在当前 tick 运行一次
     * 
     * 注意: 本函数每 tick 只能运行一次, 否则会报错.
     * 所以, 请在其它功能模块创建完进程后, 再执行.
     * 
     * 注意: 本函数在运行中, 如果有新的进程被创建, 新
     * 的进程也会被执行.
     */
    tick(): void {
        // 检验为本 tick 第一次调用
        assertWithMsg(this.#lastTick === -1 || this.#lastTick !== Game.time, `进程模块在 ${Game.time} 被重复调用 tick 函数`)
        /** 监视器执行 */
        log(LOG_INFO, `开始运行监视, 监视列表当前大小为 ${this.#watchList.length} ...`)
        const startCpuTime = Game.cpu.getUsed()
        for ( const watchElement of this.#watchList ) {
            if ( watchElement.lastTick === Game.time )
                continue
            else {
                if ( watchElement.lastTick !== Game.time - 1 )
                    log(LOG_ERR, `监视器中监视项目上一次被检查时间为 ${watchElement.lastTick}, 但应当为上一个 tick ${Game.time - 1}` )
                const lastValue = watchElement.lastValue
                const thisValue = watchElement.func()
                watchElement.lastTick = Game.time
                watchElement.lastValue = thisValue
                // log(LOG_DEBUG, `监视项目: ${lastValue}, ${thisValue}`)
                // 由假变真
                if ( !lastValue && thisValue ) {
                    log(LOG_DEBUG, `触发进程 ${_.map(watchElement.wakeUpProcIdList, id => this.#procDict[id])}`)
                    const wakeUpProcIdList = []
                    for ( const pid of watchElement.wakeUpProcIdList ) {
                        // 此时允许 pid 不存在
                        if ( !(pid in this.#procDict) ) continue
                        wakeUpProcIdList.push(pid)
                        const proc = this.#procDict[pid]
                        // 此时除睡眠外, 允许进程状态为就绪, 阻塞
                        assertWithMsg( proc.state !== PROCESS_STATE_RUNNING, `触发进程 ${proc} 时, 进程不应该处于运行态` )
                        // 当且仅当进程为睡眠态时, 才由触发器进行触发
                        if ( proc.state === PROCESS_STATE_SLEEP )
                            this.#wakeUpProc(pid)
                    }
                    watchElement.wakeUpProcIdList = wakeUpProcIdList
                }
            }
        }
        log(LOG_PROFILE, `监视消耗 ${(Game.cpu.getUsed() - startCpuTime).toFixed(2)}`)

        /** 进程执行 */
        log(LOG_INFO, `开始运行进程, 进程池当前大小为 ${this.#processIdReadyQueue.length} ...`)
        // 校验当前没有正在运行的进程
        if ( this.#currentProcId !== -1 ) {
            log(LOG_ERR, `进程模块在 tick 开始时, 发现已有正在运行的进程 Id ${this.#currentProcId}`)
            this.#currentProcId = -1
        }
        // 创建临时就绪进程 Id 队列
        const processIdReadyQueue = []

        while ( this.#processIdReadyQueue.length !== 0 ) {
            // 从就绪队列 Id 中出队头 Id
            const id = this.#processIdReadyQueue.shift()
            const proc = this.#procDict[id]

            // log(LOG_INFO, `运行🔄 进程 [${proc.description}] ...`)

            // 修改状态
            this.#currentProcId = id
            proc.state = PROCESS_STATE_RUNNING

            const startCpuTime = Game.cpu.getUsed()

            // 运行进程
            // 这个不作为 Process 的成员函数存在, 
            // 是因为要访问 进程模块 的私有成员
            while ( true ) {
                // 进程执行结束
                if (proc.pc >= proc.descriptor.length) {
                    this.#destroyProc(id)
                    break
                }
                // 获得当前原子函数描述
                const desc = proc.descriptor[proc.pc]

                if (Array.isArray(desc) && desc.length === 3) {
                    // 条件跳转
                    const condition = desc[1]()

                    if ( condition )
                        proc.pc = proc.tagDict[desc[2]]
                    else
                        proc.pc++
                } else {
                    // 取得原子函数
                    let atomicFunc: AtomicFunc = null
                    if (Array.isArray(desc) && desc.length === 2) atomicFunc = desc[1]
                    else atomicFunc = desc

                    let returnCode = undefined
                    try {
                        returnCode = atomicFunc()
                    } catch (e) {
                        if ( e instanceof Error ) {
                            const errorMessage = Game.rooms.sim
                                ? `沙盒模式无法使用 source-map - 显示原始追踪栈<br>${_.escape(e.stack)}`
                                : `${_.escape(sourceMappedStackTrace(e))}`;
                            /** 输出 错误 */
                            log(LOG_ERR, errorMessage)
                            /** 存储 错误 到 Memory 中以备检查 */
                            stackError(errorMessage)
                            /** 发送 错误 到邮箱 */
                            Game.notify(errorMessage)
                        } else throw e
                        returnCode = this.STOP_ERR
                    }
                    
                    if (returnCode === OK) {
                        // 顺序执行下一条原子函数
                        proc.pc++
                    } else if (returnCode === this.OK_STOP_CURRENT) {
                        // 主动停止, 仍然从本条原子函数开始
                        proc.state = PROCESS_STATE_READY
                        processIdReadyQueue.push(id)
                        // 复原状态
                        this.#currentProcId = -1
                        break
                    } else if (returnCode === this.OK_STOP_NEXT) {
                        // 主动停止, 从下一条原子函数开始
                        proc.pc++
                        // 特殊情况: 进程结束
                        if ( proc.pc >= proc.descriptor.length )
                        this.#destroyProc(id)
                        else {
                            proc.state = PROCESS_STATE_READY
                            processIdReadyQueue.push(id)
                            // 复原状态
                            this.#currentProcId = -1
                        }
                        break
                    } else if (returnCode === this.STOP_SLEEP) {
                        // 休眠, 此时不应被信号量唤醒
                        // 下次从头开始
                        proc.state = PROCESS_STATE_SLEEP
                        this.#processIdSleepQueue.push(id)
                        proc.pc = 0
                        // 复原状态
                        this.#currentProcId = -1
                        break
                    } else if (Array.isArray(returnCode) && returnCode[0] === this.STOP_SLEEP) {
                        // 休眠, 此时不应被信号量唤醒
                        // 下次从头开始
                        proc.state = PROCESS_STATE_SLEEP
                        this.#processIdSleepQueue.push(id)
                        proc.pc = 0
                        // 复原状态
                        this.#currentProcId = -1
                        // 定时唤醒
                        Apollo.timer.add( Game.time + returnCode[1], pid => this.#wakeUpProc(pid), [ proc.pid ], `定时唤醒 ${proc}` )
                        break
                    } else if (returnCode === this.#STOP_STUCK) {
                        // 阻塞, 下次仍然从同一条原子函数开始执行
                        this.#stuckProc(id)
                        break
                    } else if (Array.isArray(returnCode) && returnCode[0] === this.STOP_ERR) {
                        // 错误, 资源的释放应当在进程内部完成
                        // 在下一 tick 重启运行该进程
                        proc.state = PROCESS_STATE_READY
                        processIdReadyQueue.push(id)
                        proc.pc = 0
                        // 输出错误信息
                        log(LOG_ERR, `运行进程 ${proc} 时, 遇到错误: ${returnCode[1]}`)
                        // 复原状态
                        this.#currentProcId = -1
                        break
                    } else if (Array.isArray(returnCode) && returnCode[0] === this.OK_STOP_CUSTOM) {
                        // 复原状态
                        this.#currentProcId = -1

                        // 主动停止, 从特定 Tag 处开始
                        const tag = returnCode[1]
                        assertWithMsg( tag in proc.tagDict, `在执行进程 ${proc} 的过程中, 无法跳转到未定义标签 ${tag}` )
                        
                        proc.state = PROCESS_STATE_READY
                        proc.pc = proc.tagDict[tag]
                        processIdReadyQueue.push(id)
                        break
                    }
                }
            }

            proc.updateCpuCost(Game.cpu.getUsed() - startCpuTime)
            log(LOG_PROFILE, `🔄 进程 [${proc.description}] 消耗 ${proc.getCpuCost().toFixed(2)}, 停止在 ${proc.pc}.`)
        }
        log(LOG_DEBUG, `休眠进程池: ${this.#processIdSleepQueue.map(id => id.toString() + ":[" + this.#procDict[id].description + "," + this.#procDict[id].pc.toString() + "]")} ...`)
        log(LOG_DEBUG, `阻塞进程池: ${this.#processIdStuckQueue.map(id => id.toString() + ":[" + this.#procDict[id].description + "," + this.#procDict[id].pc.toString() + "]")} ...`)
        // 将进程模块的就绪进程 Id 队列指向临时变量
        this.#processIdReadyQueue = processIdReadyQueue
        // 更新上一次调用函数的时间
        this.#lastTick = Game.time
    }

    /** 映射锁 Id 到锁实体 */
    #lockDict: {[lockId: string]: Lock} = {}
    /** 实例上的锁模块 */
    lock: LockModule

    #lockCreateLock() {
        const id = getLockId()
        this.#lockDict[id] = new Lock(id)
        return id
    }
    
    #lockDestroyLock(lockId: string) {
        assertWithMsg( lockId in this.#lockDict, `无法找到锁 ${lockId} 以销毁` )
        
        const lock = this.#lockDict[lockId]
        // 当锁销毁时, 会唤醒所有阻塞的进程
        for (const pid of lock.stuckList)
            this.#wakeUpProc(pid)
    
        delete this.#lockDict[lockId]
    }
    
    #lockAcquireLock(lockId: string): StuckableAtomicFuncReturnCode {
        // 如果 lock 不存在 (可能已经销毁)
        if ( !(lockId in this.#lockDict) )
            return OK
        
        const lock = this.#lockDict[lockId]
        const pid = this.#currentProcId
        // 正在运行的进程不存在
        assertWithMsg( pid !== -1, `在获得锁 ${lockId} 时, 无法找到正在运行的进程以确认想要获得锁的进程` )

        // 如果正有进程持有锁
        if (lock.holder !== null) {
            assertWithMsg( !lock.stuckList.includes(pid), `锁 ${lockId} 的阻塞列表中包含 ${this.#procDict[pid]}, 该进程却又想获得锁` )
            lock.stuckList.push(pid)
            return this.#STOP_STUCK
        }
        
        // 进程持有锁
        lock.holder = pid
        return this.OK
    }
    
    #lockReleaseLock(lockId: string) {
        // 如果 lock 不存在 (可能已经销毁)
        if ( !(lockId in this.#lockDict) )
            return OK
        
        const lock = this.#lockDict[lockId]
        const pid = this.#currentProcId
        // 正在运行的进程不存在
        assertWithMsg( pid !== -1, `在释放锁 ${lockId} 时, 无法找到正在运行的进程以确认想要释放锁的进程` )
        
        // 释放的进程不持有锁
        assertWithMsg( lock.holder === pid, `进程 ${this.#procDict[pid]} 不持有锁 ${lockId}, 但是却期望释放` )
        
        // 重置持有进程
        lock.holder = null
        // 群惊阻塞进程
        for (const id of lock.stuckList)
            this.#wakeUpProc(id)
        // 重置阻塞进程 Id 列表
        lock.stuckList = []
        return this.OK
    }

    /** 映射信号量 Id 到信号量实体 */
    private signalDict: {[id: string]: Signal} = {}
    /** 实例上的信号量模块 */
    signal: SignalModule

    #signalCreateSignal(value: number) {
        const id = getSignalId()
        this.signalDict[id] = new Signal(id, value)
        return id
    }

    #signalDestroySignal(signalId: string) {
        assertWithMsg( signalId in this.signalDict, `无法找到信号量 ${signalId} 以销毁` )
        
        const signal = this.signalDict[signalId]
        // 当信号量销毁时, 会唤醒所有阻塞的进程
        for (const [pid, lb] of signal.stuckList)
            this.#wakeUpProc(pid)
        signal.stuckList = []
        
        delete this.signalDict[signalId]
    }

    #signalSwait(...signals: {signalId: string, lowerbound: number, request: number}[]): StuckableAtomicFuncReturnCode {
        const pid = this.#currentProcId
        
        for (const signalDescriptor of signals) {
            const signal = this.signalDict[signalDescriptor.signalId]
            // 找不到信号量 (可能已经销毁)
            if (!signal) continue
            if (signal.value < signalDescriptor.lowerbound) {
                // 正在运行的进程不存在
                assertWithMsg( pid !== -1, `在获得信号集 ${signals.map(o => o.signalId)} 时, 无法找到正在运行的进程以确认想要获得信号集的进程` )

                assertWithMsg(!signal.stuckList.map(arr => arr[0]).includes(pid), `信号量 ${signal.signalId} 的阻塞列表中包含 ${this.#procDict[pid]}, 该进程却又想获得信号量`)
                
                signal.stuckList.push([pid, signalDescriptor.lowerbound])
                return this.#STOP_STUCK
            }
        }

        for (const signalDescriptor of signals) {
            const signal = this.signalDict[signalDescriptor.signalId]
            // 找不到信号量 (可能已经销毁)
            if (!signal) continue
            signal.value -= signalDescriptor.request
        }
        return this.OK
    }

    #signalSsignal(...signals: {signalId: string, request: number}[]): StuckableAtomicFuncReturnCode {
        // 在激活信号集时, 其实并不需要确定触发的进程 Id
        // const pid = this.#currentProcId
        // 正在运行的进程不存在
        // assertWithMsg( pid !== -1, `在激活信号集 ${signals.map(o => o.signalId)} 时, 无法找到正在运行的进程` )
        
        for (const signalDescriptor of signals) {
            const signal = this.signalDict[signalDescriptor.signalId]
            // 找不到信号量 (可能已经销毁)
            if (!signal) continue
            signal.value += signalDescriptor.request
            for (const [pid, lb] of signal.stuckList)
                this.#wakeUpProc(pid)
                // if ( signal.value >= lb )
                //     this.#wakeUpProc(pid)
                // else
                //     log(LOG_DEBUG, `信号量值 ${signal.value} 不够 ${lb}, 无法唤醒 ${this.#procDict[pid]}`)
            signal.stuckList = []
        }
        
        return this.OK
    }

    /** 触发器模块 */

    #watchList: {
        lastTick: number, 
        lastValue: boolean, 
        func: () => boolean, 
        wakeUpProcIdList: ProcId[]
    }[] = []

    /** 监视类触发, 当条件 (同 tick 内稳定) 由假变为真时, 唤醒休眠中进程 */
    trigger( token: 'watch', func: () => boolean, wakeUpProcIdList: ProcId[] ): void
    /** 执行类触发, 当特定函数执行 (通常为原型上函数) 后, 触发特定函数 */
    trigger( token: 'after', prototype: Object, funcName: string, afterFunc: ( returnValue: any, subject: any, ...args ) => ProcId[] ): void
    trigger( token, arg1, arg2, arg3?) {
        if ( token === 'watch' ) {
            this.#watchList.push({
                lastTick: Game.time, 
                lastValue: false, // 初始为 false, 从而刚开始为 true 时, 直接触发
                func: arg1, 
                wakeUpProcIdList: arg2
            })
        } else if ( token === 'after' ) {
            const func = arg1[arg2]
            const procDict = this.#procDict
            const that = this
            const wakeUpProc = this.#wakeUpProc;
            ((func, procDict, that, wakeUpProc) => arg1[arg2] = function (...args) {
                const returnValue = func.call(this, ...args)
                const wakeUpPidList = arg3(returnValue, this, ...args)

                Apollo.timer.add(Game.time + 1, (wakeUpPidList, procDict, that, wakeUpProc) => {
                    for ( const pid of wakeUpPidList ) {
                        // 此时允许 pid 不存在
                        if ( !(pid in procDict) ) continue
                        const proc = procDict[pid]
                        // 此时除睡眠外, 允许进程状态为就绪, 阻塞
                        assertWithMsg( proc.state !== PROCESS_STATE_RUNNING, `触发进程 ${proc} 时, 进程不应该处于运行态` )
                        log(LOG_DEBUG, `'after' 事件触发, 尝试唤醒 ${proc}`)
                        // 当且仅当进程为睡眠态时, 才由触发器进行触发
                        if ( proc.state === PROCESS_STATE_SLEEP )
                            wakeUpProc.call(that, pid)
                    }
                }, [ wakeUpPidList, procDict, that, wakeUpProc ], `'after' ${arg2} 事件后进程唤醒`)
                
                return returnValue
            })(func, procDict, that, wakeUpProc)
        }
    }

    constructor() {
        // 创建锁子模块
        // 这里之所以采用这种写法, 是因为如果所有相关函数都在
        // 进程模块下, 不太美观. 不如整理到一个子模块下, 但是
        // 子模块又需要访问进程模块的私有属性和方法, 因此采用
        // 共有匿名函数对私有方法包装.
        this.lock = {
            createLock: () => this.#lockCreateLock(), 
            destroyLock: (lockId: string) => this.#lockDestroyLock(lockId), 
            acquireLock: (lockId: string) => this.#lockAcquireLock(lockId), 
            releaseLock: (lockId: string) => this.#lockReleaseLock(lockId)
        }
        // 创建信号量子模块
        this.signal = {
            createSignal: (value: number) => this.#signalCreateSignal(value), 
            destroySignal: (signalId: string) => this.#signalDestroySignal(signalId), 
            Swait: (...signals: {signalId: string, lowerbound: number, request: number}[]) => this.#signalSwait(...signals), 
            Ssignal: (...signals: {signalId: string, request: number}[]) => this.#signalSsignal(...signals), 
            getValue: (signalId: string) => {
                if ( !(signalId in this.signalDict) ) return null
                else return this.signalDict[signalId].value
            }
        }
    }
}

// -------------------------------------------------------------

/**
 * 资源模块的资源定义
 * 除了常规的资源外, 还包含 容量 这种资源
 * 
 * 但是, 部分建筑的不同资源的容量是不共通的.
 * 其中有:
 *  - Lab: energy 和 mineral
 *  - Nuker: energy 和 ghodium
 *  - PowerSpawn: energy 和 power
 * 
 * 所以, 对于容量的描述需要复杂一些. 这里总共归为三类: 
 *  - capacity: 正常的容量, 适用于一般的建筑
 *  - capacity_energy: 能量的容量
 *  - capacity_mineral: mineral / ghodium / power 的容量
 * 
 * 但是, 实际上, 对于 Lab 我们应该对不同的矿物考虑不同的容量.
 * 因为, 假如 Lab 中放了矿物 A, 矿物 B就不能放进去了. 但是, 
 * 这种多重容量的实现过于复杂, 代价很大. 所以我们使用矿物来统一
 * 代替, 表示放当前矿物的情况下能放多少. 这种矿物不共通的问题由
 * 调用段来承担, 例如可以写出这样的代码:
 *  if (lab.mineralType !== yourMineral) return OK_STOP_CURRENT
 * 
 * 而对于只能存放特定资源的建筑来说, 例如 Spawn, 约定是选择最准确的描述
 */

const CAPACITY = 'capacity'
const CAPACITY_ENERGY = 'capacity_energy'
const CAPACITY_MINERAL = 'capacity_mineral'

type ResourceType = ResourceConstant | typeof CAPACITY | typeof CAPACITY_ENERGY | typeof CAPACITY_MINERAL

/**
 * 数量描述器
 * 包含了 精准数量 | 达到下界后, 再请求精准数量
 */
type AmountDescriptor = number | { lowerbound: number, request: number }

/** 解析数量描述器到统一的有上下界描述 */
function parseAmountDescriptor(amountDescriptor: AmountDescriptor): { lowerbound: number, request: number } {
    if ( typeof amountDescriptor === "number" )
        return { lowerbound: amountDescriptor, request: amountDescriptor }
    else
        return amountDescriptor
}

/**
 * 建筑资源管理
 * 不对外公开
 */
class StructureResourceManager {
    #id: Id<StorableStructure>
    /** 资源到信号量 Id 的映射 */
    #resourceDict: {[resourceType in ResourceType]?: string}
    /** 获得资源的信号量 */
    getSignal(resourceType: ResourceType) {
        if (resourceType in this.#resourceDict)
            return this.#resourceDict[resourceType]
        const value = this.getRealValue(resourceType)
        // 校验资源有效性
        assertWithMsg( value !== null, `在向 ${this.#id} 获得 ${resourceType} 信号量时, 发现其不支持 ${resourceType} 的存储` )
        return this.#resourceDict[resourceType] = Apollo.proc.signal.createSignal(value)
    }
    /** 获得资源的具体数值 */
    getValue(resourceType: ResourceType): number {
        return Apollo.proc.signal.getValue(this.getSignal(resourceType))
    }
    /** 获得资源的实际数值 */
    getRealValue(resourceType: ResourceType): number {
        const structure = Game.getObjectById(this.#id)
        if ( !structure ) return null
        // 获取资源数值
        let value: number = null
        if (resourceType === CAPACITY) {
            if ( structure instanceof StructureExtension )
                value = structure.store.getFreeCapacity(RESOURCE_ENERGY)
            else if ( structure instanceof StructureLink )
                value = structure.store.getFreeCapacity(RESOURCE_ENERGY)
            else if ( structure instanceof StructureSpawn )
                value = structure.store.getFreeCapacity(RESOURCE_ENERGY)
            else if ( structure instanceof StructureTower )
                value = structure.store.getFreeCapacity(RESOURCE_ENERGY)
            else value = structure.store.getFreeCapacity()
        } else if (resourceType === CAPACITY_ENERGY)
            value = structure.store.getFreeCapacity(RESOURCE_ENERGY)
        else if (resourceType === CAPACITY_MINERAL) {
            if (structure instanceof StructureLab) {
                // 在没有矿物的时候, 使用 H 来试探有多少容量
                value = structure.store.getFreeCapacity(structure.mineralType || RESOURCE_HYDROGEN)
            } else if (structure instanceof StructurePowerSpawn) {
                value = structure.store.getFreeCapacity(RESOURCE_POWER)
            } else if (structure instanceof StructureNuker) {
                value = structure.store.getFreeCapacity(RESOURCE_GHODIUM)
            } else
                throw new Error(`在向 ${structure} 获得 CAPACITY_MINERAL 信号量时, 发现其没有专门存储矿物的容量`)
        } else
            value = structure.store.getUsedCapacity(resourceType)
        return value
    }
    /** 在建筑消失后, 执行的消亡 */
    delete() {
        for ( const resourceType in this.#resourceDict )
            Apollo.proc.signal.destroySignal(this.#resourceDict[resourceType])
    }
    constructor(id: Id<StorableStructure>) {
        this.#id = id
        this.#resourceDict = {}

        // 初次注册, 登记所有目前已知的建筑
        const structure = Game.getObjectById(id)
        assertWithMsg( !!structure, `注册 ${id} 资源管理时, 建筑应当必定存在` )
        for ( const resourceType in structure.store )
            this.getSignal(resourceType as ResourceConstant)
        
        // 处理 Capacity
        if ( structure instanceof StructureLab || structure instanceof StructureNuker || structure instanceof StructurePowerSpawn ) {
            this.getSignal(CAPACITY_ENERGY)
            this.getSignal(CAPACITY_MINERAL)
        } else this.getSignal(CAPACITY)
    }
}

type RequestDescriptor = {
    /** 请求的包含资源的建筑 Id */
    id: Id<StorableStructure>, 
    /** 请求的资源种类 */
    resourceType: ResourceType, 
    /** 请求的数量 */
    amount: AmountDescriptor, 
}

/**
 * 资源模块 - 管理所属资源建筑
 */
class ResourceModule {
    /** 容量 - 资源常量 */
    CAPACITY: typeof CAPACITY = CAPACITY
    /** 能量容量 - 资源常量 (用于 Lab, Nuker, PowerSpawn) */
    CAPACITY_ENERGY: typeof CAPACITY_ENERGY = CAPACITY_ENERGY
    /** 矿物容量 - 资源常量 (用于 Lab, Nuker, PowerSpawn) */
    CAPACITY_MINERAL: typeof CAPACITY_MINERAL = CAPACITY_MINERAL
    /** 映射建筑 Id 到建筑资源管理 */
    #structureDict: {[id: Id<StorableStructure>]: StructureResourceManager} = {}
    /** 根据建筑 Id 获得建筑资源管理 */
    #getStructureResourceManager(id: Id<StorableStructure>) {
        if (id in this.#structureDict)
            return this.#structureDict[id]
        return this.#structureDict[id] = new StructureResourceManager(id)
    }
    describeCapacity(structure: StorableStructure, resourceType: ResourceConstant | "all") {
        if ( resourceType === "all" ) {
            assertWithMsg( !(structure instanceof StructureLab || structure instanceof StructurePowerSpawn || structure instanceof StructureNuker) )
            return CAPACITY
        }

        if ( structure instanceof StructureLab || structure instanceof StructurePowerSpawn || structure instanceof StructureNuker ) {
            if ( resourceType === RESOURCE_ENERGY ) return CAPACITY_ENERGY
            else return CAPACITY_MINERAL
        }
        
        return CAPACITY
    }
    /**
     * 请求资源
     * 可以通过包含多个同样 Id 的建筑, 但是不同资源种类来同步申请一个
     * 建筑的多种资源.
     * 
     * @atom 只能在进程流程中运行使用
     */
    request(target: RequestDescriptor | RequestDescriptor[], msg?: string): StuckableAtomicFuncReturnCode {
        /** 规整参数 */
        if (!Array.isArray(target)) target = [ target ]

        // for ( const v of target )
        //     stackLog(`${msg} 请求 ${v.id} ${JSON.stringify(parseAmountDescriptor(v.amount))} ${v.resourceType}.`)

        return Apollo.proc.signal.Swait(
            ...target.map(v => ( {
                signalId: this.#getStructureResourceManager(v.id).getSignal(v.resourceType), 
                ...parseAmountDescriptor(v.amount), 
            } ))
        )
    }
    /**
     * 通知资源发生变更
     * 
     * @atom 只能在进程流程中运行使用
     * 
     * 注意: 资源变更只能在进程中通知, 因此可以创建一些监视进程.
     */
    signal(target: Id<StorableStructure>, resourceType: ResourceType, amount: number) {
        const manager = this.#getStructureResourceManager(target)
        const signalId = manager.getSignal(resourceType)
        log(LOG_DEBUG, `${target} 获得资源 ${resourceType} (${amount})`)
        let oldAmount = Game.getObjectById(target).store[resourceType]
        if ( resourceType === 'capacity' ) oldAmount = Game.getObjectById(target).store.getFreeCapacity()
        if ( resourceType === 'capacity_energy' ) oldAmount = Game.getObjectById(target).store.getFreeCapacity(RESOURCE_ENERGY)
        if ( resourceType === 'capacity_mineral' ) oldAmount = (Game.getObjectById(target) as StructureLab).store.getFreeCapacity((Game.getObjectById(target) as StructureLab).mineralType) || LAB_MINERAL_CAPACITY
        if ( Game.getObjectById(target) && oldAmount < Apollo.proc.signal.getValue(signalId) + amount ) {
            log(LOG_ERR, `${Game.getObjectById(target)} 应有 ${Apollo.proc.signal.getValue(signalId) + amount} ${resourceType}, 但是实际上有 ${oldAmount}`)
            stackError(`${Game.time}: ${Game.getObjectById(target)} 应有 ${Apollo.proc.signal.getValue(signalId) + amount} ${resourceType}, 但是实际上有 ${oldAmount}`)
        }
        // else stackLog(`${Game.time}: ${Game.getObjectById(target)} 获得 ${amount} ${resourceType}, 应有 ${Apollo.proc.signal.getValue(signalId) + amount}, 实际上有 ${oldAmount}`)
        return Apollo.proc.signal.Ssignal({ signalId, request: amount })
    }
    /**
     * 查询资源预期状况
     */
    #queryExpected(target: Id<StorableStructure>, resourceType: ResourceType) {
        const manager = this.#getStructureResourceManager(target)
        return manager.getValue(resourceType)
    }
    /**
     * 查询资源实际状况
     */
    #queryReal(target: Id<StorableStructure>, resourceType: ResourceType) {
        const manager = this.#getStructureResourceManager(target)
        return manager.getRealValue(resourceType)
    }
    query(target: Id<StorableStructure>, resourceType: ResourceType) {
        assertWithMsg( this.#queryExpected(target, resourceType) <= this.#queryReal(target, resourceType), `${target} 应有 ${this.#queryExpected(target, resourceType)} 但是实际有 ${this.#queryReal(target, resourceType)}.` )
        return this.#queryExpected(target, resourceType)
    }
    #room2ResourceSources: { [roomName: string]: { [resourceType in ResourceConstant]?: {
        ids: Id<StorableStructure>[], 
        lastUpdatedTick: number, 
        existSignalId: string, 
    } } } = {}
    #getResourceSourcesInRoom(roomName: string, resourceType: ResourceConstant) {
        if ( !(roomName in this.#room2ResourceSources) ) this.#room2ResourceSources[roomName] = {}
        if ( !(resourceType in this.#room2ResourceSources[roomName]) ) this.#room2ResourceSources[roomName][resourceType] = { ids: [], lastUpdatedTick: Game.time, existSignalId: Apollo.proc.signal.createSignal(0) }

        if ( this.#room2ResourceSources[roomName][resourceType].lastUpdatedTick < Game.time ) {
            this.#room2ResourceSources[roomName][resourceType].ids = this.#room2ResourceSources[roomName][resourceType].ids.filter(id => !!Game.getObjectById(id))
            this.#room2ResourceSources[roomName][resourceType].lastUpdatedTick = Game.time

            if ( this.#room2ResourceSources[roomName][resourceType].ids.length === 0 && Apollo.proc.signal.getValue(this.#room2ResourceSources[roomName][resourceType].existSignalId) === 1 )
                Apollo.proc.signal.Swait({ signalId: this.#room2ResourceSources[roomName][resourceType].existSignalId, request: 1, lowerbound: 1 })
        }

        return this.#room2ResourceSources[roomName][resourceType]
    }
    /**
     * 注册房间内资源的一个来源
     */
    registerSource(roomName: string, resourceType: ResourceConstant | 'all', source: Id<StorableStructure>) {
        assertWithMsg( !!Game.getObjectById(source) )
        if ( resourceType === 'all' ) {
            for ( const resourceType of RESOURCES_ALL ) this.registerSource(roomName, resourceType, source)
        } else {
            this.#getResourceSourcesInRoom(roomName, resourceType).ids.push(source)
            if ( Apollo.proc.signal.getValue(this.#getResourceSourcesInRoom(roomName, resourceType).existSignalId) === 0 )
                Apollo.proc.signal.Ssignal({ signalId: this.#getResourceSourcesInRoom(roomName, resourceType).existSignalId, request: 1 })
        }
    }
    /**
     * 删除房间内资源的一个来源
     */
    removeSource(roomName: string, resourceType: ResourceConstant | 'all', source: Id<StorableStructure>) {
        if ( resourceType === 'all' ) {
            for ( const resourceType of RESOURCES_ALL ) this.removeSource(roomName, resourceType, source)
        } else {
            _.pull(this.#getResourceSourcesInRoom(roomName, resourceType).ids, source)
            if ( this.#getResourceSourcesInRoom(roomName, resourceType).ids.length === 0 && Apollo.proc.signal.getValue(this.#getResourceSourcesInRoom(roomName, resourceType).existSignalId) === 1 )
                Apollo.proc.signal.Swait({ signalId: this.#getResourceSourcesInRoom(roomName, resourceType).existSignalId, request: 1, lowerbound: 1 })
        }
    }
    /**
     * 请求房间内资源的一个来源
     * @param requestPos 请求资源的发起方位置 - 用于选择来源
     * @param autoWait 是否自动阻塞在房间资源信号量上
     */
    requestSource(roomName: string, resourceType: ResourceConstant, amount?: number, requestPos?: RoomPosition, autoWait: boolean = true, filter: (id: Id<StorableStructure>) => boolean = null ): { code: StuckableAtomicFuncReturnCode, id: Id<StorableStructure> | null} {
        let candidates = this.#getResourceSourcesInRoom(roomName, resourceType).ids
        if ( !!filter ) candidates = _.filter(candidates, filter)
        if ( candidates.length === 0 ) return {
            code: autoWait ? Apollo.proc.signal.Swait({ signalId: this.#getResourceSourcesInRoom(roomName, resourceType).existSignalId, lowerbound: 1, request: 0 }) : Apollo.proc.OK, 
            id: null, 
        }
        // 有数量要求时, 优先满足数量要求
        if ( !!amount ) {
            const sufficientCandidates = _.filter(candidates, c => this.query(c, resourceType) >= amount)
            if ( sufficientCandidates.length > 0 ) {
                // 有路径要求时, 选择最近的
                if ( requestPos ) {
                    return {
                        code: Apollo.proc.OK, 
                        id: _.min(sufficientCandidates, id => {
                            const res = PathFinder.search(requestPos, Game.getObjectById(id).pos)
                            if ( res.incomplete ) return 0xff
                            else return res.path.length
                        })
                    }
                // 否则, 默认选择最多的
                } else {
                    return {
                        code: Apollo.proc.OK, 
                        id: _.max(candidates, id => this.query(id, resourceType))
                    }
                }
            }
        }
        // 无数量要求时, 或无法满足数量要求时
        /** @TODO 优化路径查询 */
        if ( requestPos ) return {
            code: Apollo.proc.OK, 
            id: _.min(candidates, id => {
                const res = PathFinder.search(requestPos, Game.getObjectById(id).pos)
                if ( res.incomplete ) return 0xff
                else return res.path.length
            }), 
        }
        
        return {
            code: Apollo.proc.OK, 
            id: _.max(candidates, id => this.query(id, resourceType))
        }
    }
    print(id: Id<Structure>, resourceType: ResourceConstant)
    print(roomName: string)
    print(arg1, arg2?) {
        if ( arg2 === undefined ) {
            const roomName = arg1
            if ( !(roomName in this.#room2ResourceSources) ) return
            for ( const resouceType in this.#room2ResourceSources[roomName] ) {
                this.#room2ResourceSources[roomName][resouceType as ResourceConstant].ids.forEach(id => {
                    const structure = Game.getObjectById(id)
                    if ( !structure ) return
                    log(LOG_INFO, `${roomName} => ${resouceType}, ${structure}: ${this.#queryExpected(id, resouceType as ResourceConstant)} / ${this.#queryExpected(id, CAPACITY)}`)
                })
            }
        } else {
            const id = arg1
            const resourceType = arg2
            const structure = Game.getObjectById(id)
            if ( !structure ) return Apollo.timer.STOP
            log(LOG_INFO, `${structure}: ${this.#queryExpected(id, resourceType)} / ${this.#queryExpected(id, CAPACITY)}`)
        }
    }
    private init() {
        Apollo.timer.add(Game.time + Math.ceil(Math.random() * CREEP_LIFE_TIME), () => {
            const ids = Object.keys(this.#structureDict)
            for ( const id of ids ) {
                if ( !!Game.getObjectById(id as Id<StorableStructure>) ) continue
                this.#structureDict[id as Id<StorableStructure>].delete()
                delete this.#structureDict[id as Id<StorableStructure>]
            }
        }, [], `资源模块定期检查资源建筑消亡`, CREEP_LIFE_TIME)
    }
}

// -------------------------------------------------------------

/** 定时器模块 */
class Timer {
    /** 记录上一次调用 tick 的 Game.time 以保证每 tick 只能执行一次 tick */
    #lastTick: number = -1
    #tasks: {[tick: number]: {func: (...args) => any, params: any[], description: string, cpuCost: number, period?: number}[]} = {}
    /** 周期任务停止时的返回值 */
    STOP: string = 'STOP'
    /**
     * 添加定时任务
     */
    add(tick: number, func: (...args) => any, params: any[], description: string, period?: number) {
        assertWithMsg(tick > Game.time, `无法添加发生在当前 tick 或之前的定时任务`)
        
        if ( !(tick in this.#tasks) )
            this.#tasks[tick] = []
        
        this.#tasks[tick].push({ func, params, description, cpuCost: null, period })
    }
    /**
     * 在当前 tick 运行一次
     * 
     * 注意: 本函数每 tick 只能运行一次, 否则会报错.
     */
    tick(): typeof OK_STOP_CURRENT {
        // 检验为本 tick 第一次调用
        assertWithMsg(this.#lastTick === -1 || this.#lastTick !== Game.time, `定时器在 ${Game.time} 被重复调用 tick 函数`)

        if ( !(Game.time in this.#tasks) ) return OK_STOP_CURRENT
        log(LOG_INFO, `⏲️ 定时器内函数数量为 ${this.#tasks[Game.time].length} ...`)
        for ( const task of this.#tasks[Game.time] ) {
            const { func, params, description, period } = task
            const startCpuTime = Game.cpu.getUsed()
            const ret = func.apply(undefined, params)
            task.cpuCost = Game.cpu.getUsed() - startCpuTime
            log(LOG_PROFILE, `⏲️ 定时器内任务 [${description}] 消耗 ${task.cpuCost.toFixed(2)}`)
            // 周期任务 (再次加入到定时器队列)
            if ( ret !== this.STOP && typeof period === "number" && period > 0 )
                this.add(Game.time + period, func, params, description, period)
        }
        delete this.#tasks[Game.time]

        this.#lastTick = Game.time
        
        return OK_STOP_CURRENT
    }
}

// -------------------------------------------------------------

/**
 * Apollo 框架内核
 */
class ApolloKernel {
    /**
     * 进程模块 (主模块)
     */
    proc: ProcessModule
    /**
     * 资源模块 (偏底层)
     */
    res: ResourceModule
    /**
     * 定时器
     */
    timer: Timer
    constructor() {
        this.proc = new ProcessModule()
        this.res = new ResourceModule()
        this.timer = new Timer()

        // 第一进程: 定时器 (在每 tick 一开始第一个执行)
        this.proc.createProc([ () => this.timer.tick() ], `⏲️ 定时器`)
    }
}

export const Apollo = new ApolloKernel();
(Apollo.res as any).init()
global.A = Apollo