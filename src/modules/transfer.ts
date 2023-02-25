/**
 * 运输模块
 */

import { assertWithMsg, generate_random_hex, getUsedCapacity, insertSortedBy, log, LOG_DEBUG, raiseNotImplementedError } from "@/utils"
import { Apollo as A } from "@/framework/apollo"
import { creepModule as C } from "./creep"

type TransferResourceType = ResourceConstant | 'all'
type TransferAmount = number | 'all'

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
    resourceType    : TransferResourceType, 
    amount          : TransferAmount, 
    priority        : PriorityType, 
    afterSignalId?  : string, 
    finishWithdraw  : boolean, 
}

interface TransferOpts {
    priority?: PriorityType
    /** 当可以获取该信号量时, 才开始进行转移 (但是会提前移动到目标地) */
    afterSignalId?: string
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
            let currentTransferTasks: TransferTaskDescription[] = []
            type TargetDict = { [taskId: string]: { 
                targetId: Id<StorableStructure>, 
                targetPos: Pos, 
                resourceType: ResourceConstant, 
                amount: number
            } }
            let targetDict: TargetDict = {};
            ((workerName: string, currentTransferTasks: TransferTaskDescription[], targetDict: TargetDict) => {
                /** 先一次性取完, 再一次性送完 */
                A.proc.createProc([
                    ['start', () => A.proc.signal.Swait({ signalId: this.#getTaskQueue(roomName).lengthSignalId, lowerbound: 1, request: 1 })], 
                    () => {
                        currentTransferTasks.push(this.#getTaskQueue(roomName).queue.shift())
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
                            // 恢复任务
                            currentTransferTasks.forEach(task => {
                                if ( task.id in targetDict && typeof task.amount === 'number' ) {
                                    task.amount += targetDict[task.id].amount
                                    task.finishWithdraw = false
                                }
                                if ( !task.finishWithdraw ) {
                                    insertSortedBy(this.#getTaskQueue(roomName).queue, task, 'priority')
                                    A.proc.signal.Ssignal({ signalId: this.#getTaskQueue(roomName).lengthSignalId, request: 1 })
                                }
                            })
                            targetDict = {}
                            currentTransferTasks = []
                            return [A.proc.STOP_ERR, `Creep [${workerName}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
                        }

                        if ( currentTransferTasks.length === 0 ) {
                            C.release(workerName)
                            workerName = null
                            return [ A.proc.OK_STOP_CUSTOM, 'start' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                        }

                        /** 此时一定为第一个 */
                        const currentTransferTask = currentTransferTasks[0]
                        if ( currentTransferTask.finishWithdraw )
                            return [ A.proc.OK_STOP_CUSTOM, 'moveToTarget' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                        if ( creep.pos.roomName !== currentTransferTask.fromPos.roomName || creep.pos.getRangeTo(currentTransferTask.fromPos.x, currentTransferTask.fromPos.y) > 1 ) {
                            creep.travelTo(new RoomPosition(currentTransferTask.fromPos.x, currentTransferTask.fromPos.y, currentTransferTask.fromPos.roomName))
                            return A.proc.OK_STOP_CURRENT
                        }
                        // 检验 afterSignal
                        if ( !currentTransferTask.afterSignalId ) return [ A.proc.OK_STOP_CUSTOM, 'withdraw' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                        return A.proc.OK
                    }], 
                    () => {
                        const currentTransferTask = currentTransferTasks[0]
                        const ret = A.proc.signal.Swait({ signalId: currentTransferTask.afterSignalId, lowerbound: 1, request: 0 })
                        if ( ret === A.proc.OK ) {
                            A.proc.signal.destroySignal( currentTransferTask.afterSignalId )
                            currentTransferTask.afterSignalId = undefined
                        }
                        return ret
                    }, 
                    [ 'withdraw', () => {
                        const creep = Game.creeps[workerName]
                        /** 检测到错误, 立即释放资源 */
                        if ( !creep ) {
                            // 释放 Creep
                            C.cancel(workerName)
                            workerName = null
                            // 恢复任务
                            currentTransferTasks.forEach(task => {
                                if ( task.id in targetDict && typeof task.amount === 'number' ) {
                                    task.amount += targetDict[task.id].amount
                                    task.finishWithdraw = false
                                }
                                if ( !task.finishWithdraw ) {
                                    insertSortedBy(this.#getTaskQueue(roomName).queue, task, 'priority')
                                    A.proc.signal.Ssignal({ signalId: this.#getTaskQueue(roomName).lengthSignalId, request: 1 })
                                }
                            })
                            targetDict = {}
                            currentTransferTasks = []
                            return [A.proc.STOP_ERR, `Creep [${workerName}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
                        }

                        assertWithMsg( creep.store.getFreeCapacity() > 0 )

                        /** 此时一定为第一个 */
                        const currentTransferTask = currentTransferTasks[0]
                        assertWithMsg( !!currentTransferTask.fromId, `源 Id 未定时, 尚未实现` )
                        const source = Game.getObjectById(currentTransferTask.fromId)
                        if ( !source ) {
                            currentTransferTasks.shift()
                            return [ A.proc.OK_STOP_CUSTOM, 'moveToSource' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                        }

                        /** 确定运输的种类和数量 & 确定是否运输完成 */
                        let resourceType: ResourceConstant = null
                        let amount: number = null
                        if ( currentTransferTask.resourceType === 'all' ) {
                            if ( getUsedCapacity(source) === 0 ) {
                                // 全部运输完成
                                currentTransferTask.finishWithdraw = true
                                currentTransferTasks.shift()
                                return [ A.proc.OK_STOP_CUSTOM, 'moveToSource' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                            }
                            assertWithMsg( currentTransferTask.amount === 'all' )
                            resourceType = Object.keys(source.store)[0] as ResourceConstant
                            amount = Math.min(source.store[resourceType], creep.store.getFreeCapacity())
                            if ( Object.keys(source.store).length === 1 && amount === source.store[resourceType] )
                                currentTransferTask.finishWithdraw = true
                        } else {
                            resourceType = currentTransferTask.resourceType
                            if ( currentTransferTask.amount === 'all' ) amount = Math.min(source.store[resourceType] || 0, creep.store.getFreeCapacity())
                            else amount = Math.min(source.store[resourceType] || 0, creep.store.getFreeCapacity(), currentTransferTask.amount)

                            if ( typeof currentTransferTask.amount === 'number' )
                                currentTransferTask.amount -= amount
                            if ( (currentTransferTask.amount === 'all' && amount === (source.store[resourceType] || 0)) || (typeof currentTransferTask.amount === 'number' && currentTransferTask.amount <= 0) )
                                currentTransferTask.finishWithdraw = true
                        }

                        if ( amount === 0 ) {
                            currentTransferTasks.shift()
                            return [ A.proc.OK_STOP_CUSTOM, 'moveToSource' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                        }

                        creep.withdraw(source, resourceType, amount)
                        A.timer.add(Game.time + 1, (sourceId, capacityType, amount) => A.res.signal(sourceId, capacityType, amount), [source.id, A.res.describeCapacity(source, resourceType), amount], `取资源后, 更新源建筑的容量`)
                        targetDict[currentTransferTask.id] = { targetId: currentTransferTask.toId, targetPos: currentTransferTask.toPos, resourceType, amount }

                        if ( currentTransferTask.finishWithdraw ) currentTransferTasks.push(currentTransferTasks.shift())
                        if ( Object.keys(targetDict).length < currentTransferTasks.length && !currentTransferTasks[0].finishWithdraw && creep.store.getFreeCapacity() - amount > 0 )
                            return [ A.proc.OK_STOP_CUSTOM, 'moveToSource' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]

                        return A.proc.OK
                    } ], 
                    ['moveToTarget', () => {
                        const creep = Game.creeps[workerName]
                        /** 检测到错误, 立即释放资源 */
                        if ( !creep ) {
                            // 释放 Creep
                            C.cancel(workerName)
                            workerName = null
                            // 恢复任务
                            currentTransferTasks.forEach(task => {
                                if ( task.id in targetDict && typeof task.amount === 'number' ) {
                                    task.amount += targetDict[task.id].amount
                                    task.finishWithdraw = false
                                }
                                if ( !task.finishWithdraw ) {
                                    insertSortedBy(this.#getTaskQueue(roomName).queue, task, 'priority')
                                    A.proc.signal.Ssignal({ signalId: this.#getTaskQueue(roomName).lengthSignalId, request: 1 })
                                }
                            })
                            targetDict = {}
                            currentTransferTasks = []
                            return [A.proc.STOP_ERR, `Creep [${workerName}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
                        }

                        const taskIds = Object.keys(targetDict)
                        if ( taskIds.length > 0 ) {
                            const currentTarget = targetDict[taskIds[0]]
                            if ( creep.pos.roomName !== currentTarget.targetPos.roomName || creep.pos.getRangeTo(currentTarget.targetPos.x, currentTarget.targetPos.y) > 1) {
                                creep.travelTo(new RoomPosition(currentTarget.targetPos.x, currentTarget.targetPos.y, currentTarget.targetPos.roomName))
                                return A.proc.OK_STOP_CURRENT
                            }

                            const target = Game.getObjectById(currentTarget.targetId)
                            if ( !target ) {
                                delete targetDict[taskIds[0]]
                                return A.proc.OK_STOP_CURRENT
                            }

                            const amount = Math.min(currentTarget.amount, creep.store[currentTarget.resourceType], target.store.getFreeCapacity(currentTarget.resourceType))
                            creep.transfer(target, currentTarget.resourceType, amount)
                            A.timer.add(Game.time + 1, (targetId, resourceType, amount) => A.res.signal(targetId, resourceType, amount), [target.id, currentTarget.resourceType, amount], `转移资源后, 更新目标建筑相应资源的数量`)
                            currentTarget.amount -= amount
                            if ( currentTarget.amount === 0 )
                                delete targetDict[taskIds[0]]
                            else
                                return A.proc.OK_STOP_CURRENT
                        }

                        if ( taskIds.length > 1 ) return A.proc.OK_STOP_CURRENT
                        // 全部转移完成
                        if ( currentTransferTasks[0].finishWithdraw ) {
                            // 全部完成
                            C.release(workerName)
                            workerName = null
                            targetDict = {}
                            currentTransferTasks = []
                            return [ A.proc.OK_STOP_CUSTOM, 'start' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                        } else return [ A.proc.OK_STOP_CUSTOM, 'moveToSource' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                    }]
                ], `${roomName} => Transfer ${idx}`)
            })(workerName, currentTransferTasks, targetDict)
        }
    }
    /** 在给定确切资源种类及数量时, 会一定完成; 无法完成, 则会不断重试 */
    transfer( from: TransferTarget, to: TransferTarget, resourceType: TransferResourceType, amount: TransferAmount, opts: TransferOpts = {} ): void {
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
                    resourceType, amount, 
                    priority: opts.priority, afterSignalId: opts.afterSignalId, 
                    finishWithdraw: false, id: generate_random_hex(8), 
                }
                log(LOG_DEBUG, `运输任务 从 ${from.id} 到 ${to.id} 运输 ${resourceType} (${amount})`)
                // 判定 TakeOver
                const queueIds = Object.keys(this.#takeOverInfo).filter(key => this.#takeOverInfo[key].fromIds.includes((from as any).id) && this.#takeOverInfo[key].toIds.includes((to as any).id))
                if ( queueIds.length > 0 )
                    queueIds.forEach(queueId => {
                        insertSortedBy(this.#takeOverInfo[queueId].queue, taskDescription, 'priority')
                        A.proc.signal.Ssignal({ signalId: this.#takeOverInfo[queueId].lengthSignalId, request: 1 })
                    })
                else {
                    insertSortedBy(this.#getTaskQueue(from.pos.roomName).queue, taskDescription, 'priority')
                    A.proc.signal.Ssignal({ signalId: this.#getTaskQueue(from.pos.roomName).lengthSignalId, request: 1 })
                    // 检验房间发出运输进程
                    this.#issueForRoomName(from.pos.roomName)
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
    bindTakeOver( queueId: string, token: 'from' | 'to', structureId: Id<StorableStructure> ) {
        assertWithMsg( queueId in this.#takeOverInfo )
        if ( token === 'from' )
            this.#takeOverInfo[queueId].fromIds.push(structureId)
        else if ( token === 'to' )
            this.#takeOverInfo[queueId].toIds.push(structureId)
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