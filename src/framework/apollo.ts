import { assertWithMsg, generate_random_hex, log, LOG_ERR } from "@/utils"

// -------------------------------------------------------------

/**
 * 原子函数相关
 */

const STOP_STUCK = "stop_stuck"
const STOP_ERR = "stop_err"
const OK_STOP_CURRENT = "ok_stop_current"
const OK_STOP_NEXT = "ok_stop_next"
const OK_STOP_CUSTOM = "ok_stop_custom"

/** 普通原子函数返回值 */
type AtomicFuncReturnCode = OK | typeof OK_STOP_CURRENT | typeof OK_STOP_NEXT | [typeof OK_STOP_CUSTOM, string] | [typeof STOP_ERR, string]
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
}

/**
 * 进程相关
 */

export type ProcId = number
const MAX_PROC_ID = 36767

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
    state: typeof PROCESS_STATE_READY | typeof PROCESS_STATE_STUCK | typeof PROCESS_STATE_RUNNING

    constructor(
        pid: ProcId, 
        description: string, 
        descriptor: AtomicFuncDescriptor
    ) {
        this.pid = pid
        this.description = description
        this.descriptor = descriptor

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

    /**
     * 辅助变量与函数定义
     */
    /** 当前正在运行的进程 Id, 用于内部阻塞原子函数识别进程 */
    #currentProcId: ProcId = -1
    /** 就绪进程 Id 队列 */
    #processIdReadyQueue: ProcId[] = []
    /** 阻塞进程 Id 队列 */
    #processIdStuckQueue: ProcId[] = []
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
        assertWithMsg( this.#idLinkList.length === 0, `无可用进程 Id` )
        // 返回进程 Id 链表中第一个可用 Id
        return this.#idLinkList.shift()
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
     * @returns 进程 Id
     */
    createProc(descriptor: AtomicFuncDescriptor, description: string): ProcId {
        const id = this.#getProcId()
        const proc = new Process(id, description, descriptor)

        // 将进程注册到映射表中
        this.#procDict[id] = proc
        // 将新创建的进程加入到就绪队列当中
        this.#processIdReadyQueue.push(id)

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
        // 校验当前没有正在运行的进程
        assertWithMsg(this.#currentProcId === -1, `进程模块在 tick 开始时, 发现已有正在运行的进程 Id ${this.#currentProcId}`)
        // 创建临时就绪进程 Id 队列
        const processIdReadyQueue = []

        while ( this.#processIdReadyQueue.length !== 0 ) {
            // 从就绪队列 Id 中出队头 Id
            const id = this.#processIdReadyQueue.shift()
            const proc = this.#procDict[id]

            // 修改状态
            this.#currentProcId = id
            proc.state = PROCESS_STATE_RUNNING

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

                    const returnCode = atomicFunc()
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
        }

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
        assertWithMsg( pid !== -1, `在获得锁 ${lockId} 时, 无法找到正在运行的进程` )

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
        assertWithMsg( pid !== -1, `在释放锁 ${lockId} 时, 无法找到正在运行的进程` )
        
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
    #signalDict: {[id: string]: Signal} = {}
    /** 实例上的信号量模块 */
    signal: SignalModule

    #signalCreateSignal(value: number) {
        const id = getSignalId()
        this.#signalDict[id] = new Signal(id, value)
        return id
    }

    #signalDestroySignal(signalId: string) {
        assertWithMsg( signalId in this.#signalDict, `无法找到信号量 ${signalId} 以销毁` )
        
        const signal = this.#signalDict[signalId]
        // 当信号量销毁时, 会唤醒所有阻塞的进程
        for (const [pid, lb] of signal.stuckList)
            this.#wakeUpProc(pid)
        signal.stuckList = []
        
        delete this.#signalDict[signalId]
    }

    #signalSwait(...signals: {signalId: string, lowerbound: number, request: number}[]): StuckableAtomicFuncReturnCode {
        const pid = this.#currentProcId
        // 正在运行的进程不存在
        assertWithMsg( pid !== -1, `在获得信号集 ${signals.map(o => o.signalId)} 时, 无法找到正在运行的进程` )
        
        for (const signalDescriptor of signals) {
            const signal = this.#signalDict[signalDescriptor.signalId]
            // 找不到信号量 (可能已经销毁)
            if (!signal) continue
            if (signal.value < signalDescriptor.lowerbound) {
                assertWithMsg(!signal.stuckList.map(arr => arr[0]).includes(pid), `信号量 ${signal.signalId} 的阻塞列表中包含 ${this.#procDict[pid]}, 该进程却又想获得信号量`)
                signal.stuckList.push([pid, signalDescriptor.lowerbound])
                return this.#STOP_STUCK
            }
        }

        for (const signalDescriptor of signals) {
            const signal = this.#signalDict[signalDescriptor.signalId]
            // 找不到信号量 (可能已经销毁)
            if (!signal) continue
            signal.value -= signalDescriptor.request
        }
        return this.OK
    }

    #signalSsignal(...signals: {signalId: string, request: number}[]): StuckableAtomicFuncReturnCode {
        const pid = this.#currentProcId
        // 正在运行的进程不存在
        assertWithMsg( pid !== -1, `在激活信号集 ${signals.map(o => o.signalId)} 时, 无法找到正在运行的进程` )
        
        for (const signalDescriptor of signals) {
            const signal = this.#signalDict[signalDescriptor.signalId]
            // 找不到信号量 (可能已经销毁)
            if (!signal) continue
            signal.value += signalDescriptor.request
            for (const [pid, lb] of signal.stuckList)
                if ( signal.value >= lb )
                    this.#wakeUpProc(pid)
            signal.stuckList = []
        }
        
        return this.OK
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
            Ssignal: (...signals: {signalId: string, request: number}[]) => this.#signalSsignal(...signals)
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

/** 可存取的建筑, 并不包含 Ruin 和 TombStone */
interface StorableStructure extends OwnedStructure {
    /**
     * A Store object that contains cargo of this structure.
     */
    store: StoreDefinition |
            Store<RESOURCE_ENERGY, false> | // Spawn, Extension
            Store<RESOURCE_ENERGY | RESOURCE_POWER, false> | // PowerSpawn
            Store<RESOURCE_ENERGY | MineralConstant | MineralCompoundConstant, false> | // Lab
            Store<RESOURCE_ENERGY | RESOURCE_GHODIUM, false> // Nuker
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
        /** 创建信号量 */
        const structure = Game.getObjectById(this.#id)
        // 获取资源数值
        let value: number = null
        if (resourceType === CAPACITY)
            value = structure.store.getFreeCapacity()
        else if (resourceType === CAPACITY_ENERGY)
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
                throw `在向 ${structure} 获得 CAPACITY_MINERAL 信号量时, 发现其没有专门存储矿物的容量`
        } else
            value = structure.store.getUsedCapacity(resourceType)
        // 校验资源有效性
        if (value === null)
            throw `在向 ${structure} 获得 ${resourceType} 信号量时, 发现其不支持 ${resourceType} 的存储`
        return this.#resourceDict[resourceType] = Apollo.proc.signal.createSignal(value)
    }
    /** 获得资源的具体数值 */
    getValue(resourceType: ResourceType): number {
        return Apollo.proc['#signalDict'][this.getSignal(resourceType)].value
    }
    constructor(id: Id<StorableStructure>) {
        this.#id = id
        this.#resourceDict = {}
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
 * 资源模块
 */
class ResourceModule {
    /** 容量 - 资源常量 */
    CAPACITY: typeof CAPACITY = CAPACITY
    /** 能量容量 - 资源常量 */
    CAPACITY_ENERGY: typeof CAPACITY_ENERGY = CAPACITY_ENERGY
    /** 矿物容量 - 资源常量 */
    CAPACITY_MINERAL: typeof CAPACITY_MINERAL = CAPACITY_MINERAL
    /** 映射建筑 Id 到建筑资源管理 */
    #structureDict: {[id: Id<StorableStructure>]: StructureResourceManager} = {}
    /** 根据建筑 Id 获得建筑资源管理 */
    #getStructureResourceManager(id: Id<StorableStructure>) {
        if (id in this.#structureDict)
            return this.#structureDict[id]
        return this.#structureDict[id] = new StructureResourceManager(id)
    }
    /**
     * 请求资源
     * 可以通过包含多个同样 Id 的建筑, 但是不同资源种类来同步申请一个
     * 建筑的多种资源.
     * 
     * @atom 只能在进程流程中运行使用
     */
    request(target: RequestDescriptor | RequestDescriptor[]): StuckableAtomicFuncReturnCode {
        /** 规整参数 */
        if (!Array.isArray(target)) target = [ target ]

        return Apollo.proc.signal.Swait(
            ...target.map(v => { return {
                signalId: this.#getStructureResourceManager(v.id).getSignal(v.resourceType), 
                ...parseAmountDescriptor(v.amount), 
            } })
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
        return Apollo.proc.signal.Ssignal({ signalId, request: amount })
    }
    /**
     * 查询资源预期状况
     */
    qeury(target: Id<StorableStructure>, resourceType: ResourceType) {
        const manager = this.#getStructureResourceManager(target)
        return manager.getValue(resourceType)
    }
}

// -------------------------------------------------------------

/** 定时器模块 */
class Timer {
    /** 记录上一次调用 tick 的 Game.time 以保证每 tick 只能执行一次 tick */
    #lastTick: number = -1
    #tasks: {[tick: number]: {func: (...args) => any, params: any[]}[]} = {}
    /**
     * 添加定时任务
     */
    add(tick: number, func: (...args) => any, params: any[]) {
        assertWithMsg(tick > Game.time, `无法添加发生在当前 tick 或之前的定时任务`)

        if ( !(tick in this.#tasks) )
            this.#tasks[tick] = []
        
        this.#tasks[tick].push({ func, params })
    }
    /**
     * 在当前 tick 运行一次
     * 
     * 注意: 本函数每 tick 只能运行一次, 否则会报错.
     */
    tick(): typeof OK_STOP_CURRENT {
        // 检验为本 tick 第一次调用
        assertWithMsg(this.#lastTick === -1 || this.#lastTick !== Game.time, `定时器在 ${Game.time} 被重复调用 tick 函数`)

        if ( !(Game.time in this.#tasks) ) return
        for ( const { func, params } of this.#tasks[Game.time] )
            func.apply(undefined, params)
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
        this.proc.createProc([ this.timer.tick ], `⏲️ 定时器`)
    }
}

export const Apollo = new ApolloKernel()