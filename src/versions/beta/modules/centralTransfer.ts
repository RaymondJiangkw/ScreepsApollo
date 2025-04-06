/**
 * 核心转移模块
 */

import { Apollo as A } from "@/framework/apollo"
import { creepModule as C } from "@/modules/creep"
import { planModule as P } from "@/modules/plan"
import { transferModule as T } from "@/modules/transfer"
import { assertWithMsg, convertPosToString, insertSortedBy, log, LOG_DEBUG } from "@/utils"

const unitName = 'centralTransfer'
const tagName = 'transferStructures'

export function registerCentralTransfer() {
    C.design(`centralTransferer`, {
        body: {
            4: [ CARRY, CARRY, MOVE ], 
            6: [ CARRY, CARRY, CARRY, CARRY, CARRY, MOVE ], 
            8: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE ]
        }, 
        priority: C.PRIORITY_IMPORTANT, 
        amount: 1
    })
}

function issueCentralTransferProc(roomName: string, leftTopPos: Pos, getLinkBuffer: () => Id<StructureLink>[], linkBufferSignal: string) {
    const posStorage = new RoomPosition(leftTopPos.x + 1, leftTopPos.y + 1, leftTopPos.roomName)
    const posNuker = new RoomPosition(leftTopPos.x + 1, leftTopPos.y + 2, leftTopPos.roomName)
    const posPowerSpawn = new RoomPosition(leftTopPos.x + 1, leftTopPos.y + 3, leftTopPos.roomName)
    const posTerminal = new RoomPosition(leftTopPos.x + 2, leftTopPos.y + 1, leftTopPos.roomName)
    const posWork = new RoomPosition(leftTopPos.x + 2, leftTopPos.y + 2, leftTopPos.roomName)
    const posExtension = new RoomPosition(leftTopPos.x + 2, leftTopPos.y + 3, leftTopPos.roomName)
    const posLink = new RoomPosition(leftTopPos.x + 3, leftTopPos.y + 1, leftTopPos.roomName)
    const posFactory = new RoomPosition(leftTopPos.x + 3, leftTopPos.y + 2, leftTopPos.roomName)

    const takeOverQueue = T.createTakeOver()

    let idStorage: Id<StructureStorage> = null
    let idNuker: Id<StructureNuker> = null
    let idPowerSpawn: Id<StructurePowerSpawn> = null
    let idTerminal: Id<StructureTerminal> = null
    let idExtension: Id<StructureExtension> = null
    let idLink: Id<StructureLink> = null
    let idFactory: Id<StructureFactory> = null

    function checkStructures() {
        // 注销既有
        if ( !idStorage || !Game.getObjectById(idStorage) ) {
            if ( idStorage !== null ) {
                T.removeTakeOver(takeOverQueue.queueId, "all", idStorage)
                A.res.removeSource(roomName, 'all', idStorage)
            }
            idStorage = null
        }
        if ( !idNuker || !Game.getObjectById(idNuker) ) {
            if ( idNuker !== null ) {
                T.removeTakeOver(takeOverQueue.queueId, "all", idNuker)
            }
            idNuker = null
        }
        if ( !idPowerSpawn || !Game.getObjectById(idPowerSpawn) ) {
            if ( idPowerSpawn !== null ) {
                T.removeTakeOver(takeOverQueue.queueId, "all", idPowerSpawn)
            }
            idPowerSpawn = null
        }
        if ( !idTerminal || !Game.getObjectById(idTerminal) ) {
            if ( idTerminal !== null ) {
                T.removeTakeOver(takeOverQueue.queueId, "all", idTerminal)
            }
            idTerminal = null
        }
        if ( !idExtension || !Game.getObjectById(idExtension) ) {
            if ( idExtension !== null ) {
                T.removeTakeOver(takeOverQueue.queueId, "all", idExtension)
            }
            idExtension = null
        }
        if ( !idLink || !Game.getObjectById(idLink) ) {
            if ( idLink !== null ) {
                T.removeTakeOver(takeOverQueue.queueId, "all", idLink)
                const prevLength = getLinkBuffer().length
                _.remove(getLinkBuffer(), e => e === idLink)
                if ( prevLength > 0 && getLinkBuffer().length === 0 )
                    assertWithMsg( A.proc.signal.Swait({ signalId: linkBufferSignal, lowerbound: 1, request: 1 }) === A.proc.OK )
            }
            idLink = null
        }
        if ( !idFactory || !Game.getObjectById(idFactory) ) {
            if ( idFactory !== null ) {
                T.removeTakeOver(takeOverQueue.queueId, "all", idFactory)
            }
            idFactory = null
        }
        // 注册现有
        const structureStorage = Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, posStorage).filter(s => s.structureType === STRUCTURE_STORAGE)[0] as StructureStorage
        const structureNuker = Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, posNuker).filter(s => s.structureType === STRUCTURE_NUKER)[0] as StructureNuker
        const structurePowerSpawn = Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, posPowerSpawn).filter(s => s.structureType === STRUCTURE_POWER_SPAWN)[0] as StructurePowerSpawn
        const structureTerminal = Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, posTerminal).filter(s => s.structureType === STRUCTURE_TERMINAL)[0] as StructureTerminal
        const structureExtension = Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, posExtension).filter(s => s.structureType === STRUCTURE_EXTENSION)[0] as StructureExtension
        const structureLink = Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, posLink).filter(s => s.structureType === STRUCTURE_LINK)[0] as StructureLink
        const structureFactory = Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, posFactory).filter(s => s.structureType === STRUCTURE_FACTORY)[0] as StructureFactory
        if ( !idStorage && !!structureStorage ) {
            idStorage = structureStorage.id
            T.bindTakeOver(takeOverQueue.queueId, "all", idStorage)
            A.res.registerSource(roomName, "all", idStorage)
        }
        if ( !idNuker && !!structureNuker ) {
            idNuker = structureNuker.id
            T.bindTakeOver(takeOverQueue.queueId, "all", idNuker)
        }
        if ( !idPowerSpawn && !!structurePowerSpawn ) {
            idPowerSpawn = structurePowerSpawn.id
            T.bindTakeOver(takeOverQueue.queueId, "all", idPowerSpawn)
        }
        if ( !idTerminal && !!structureTerminal ) {
            idTerminal = structureTerminal.id
            T.bindTakeOver(takeOverQueue.queueId, "all", idTerminal)
        }
        if ( !idExtension && !!structureExtension ) {
            idExtension = structureExtension.id
            T.bindTakeOver(takeOverQueue.queueId, "all", idExtension)
        }
        if ( !idLink && !!structureLink ) {
            idLink = structureLink.id
            T.bindTakeOver(takeOverQueue.queueId, "all", idLink)
            const prevLength = getLinkBuffer().length
            getLinkBuffer().push( idLink )
            if ( prevLength === 0 )
                assertWithMsg( A.proc.signal.Ssignal({ signalId: linkBufferSignal, request: 1 }) === A.proc.OK )
        }
        if ( !idFactory && !!structureFactory ) {
            idFactory = structureFactory.id
            T.bindTakeOver(takeOverQueue.queueId, "all", idFactory)
        }
        return A.proc.STOP_SLEEP
    }

    const pid = A.proc.createProc([
        () => P.exist(roomName, unitName, tagName), 
        () => checkStructures()
    ], `${roomName} => CentralTransfer 建筑注册注销`)

    let structureAmount: number = 0
    A.proc.trigger('watch', () => {
        const amount = P.existNum(roomName, unitName, tagName)
        if ( structureAmount === amount ) return false
        else {
            structureAmount = amount
            return true
        }
    }, [ pid ])

    let workerName = null
    let currentTransferTask: typeof takeOverQueue.queue[number] = null
    let targetDict: { [resourceType in ResourceConstant]?: number } = {}

    A.proc.createProc([
        () => P.exist(roomName, unitName, tagName, 2), 
        [ "start", () => A.proc.signal.Swait({ signalId: takeOverQueue.lengthSignalId, lowerbound: 1, request: 1 }) ], 
        () => {
            currentTransferTask = takeOverQueue.queue.shift()
            assertWithMsg( !currentTransferTask.afterSignalId, `CentralTransfer 区域传输任务不支持 afterSignal` )
            return A.proc.OK
        }, 
        () => C.acquire('centralTransferer', roomName, name => workerName = name, posWork), 
        () => {
            const creep = Game.creeps[workerName]
            if ( !creep ) {
                C.cancel(workerName)
                workerName = null
                return [A.proc.STOP_ERR, `Creep [${workerName}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
            }
            if ( creep.pos.roomName !== posWork.roomName || creep.pos.x !== posWork.x || creep.pos.y !== posWork.y ) {
                creep.travelTo( posWork )
                return A.proc.OK_STOP_CURRENT
            }
            if ( creep.store.getUsedCapacity() === 0 ) return A.proc.OK
            for ( const resourceType in creep.store ) {
                creep.drop(resourceType as ResourceConstant)
                return A.proc.OK_STOP_CURRENT
            }
        }, 
        [ 'withdraw', () => {
            const creep = Game.creeps[workerName]
            /** 检测到错误, 立即释放资源 */
            if ( !creep || creep.ticksToLive < 3 ) {
                if ( creep ) creep.suicide()
                // 释放 Creep
                C.cancel(workerName)
                workerName = null
                // 恢复任务
                assertWithMsg( Object.keys(targetDict).length === 0, `centralTransfer 传输任务应当无丢失!` )
                if ( !currentTransferTask.finishWithdraw ) {
                    insertSortedBy(takeOverQueue.queue, currentTransferTask, 'priority')
                    A.proc.signal.Ssignal({ signalId: takeOverQueue.lengthSignalId, request: 1 })
                }
                
                targetDict = {}
                currentTransferTask = null
                return [A.proc.STOP_ERR, `Creep [${workerName}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
            }

            assertWithMsg( creep.store.getFreeCapacity() > 0 )
            assertWithMsg( !!currentTransferTask.fromId )

            const source = Game.getObjectById(currentTransferTask.fromId)
            if ( !source ) {
                const to = Game.getObjectById(currentTransferTask.toId)
                if ( !!to ) {
                    for ( const { resourceType, amount } of currentTransferTask.content )
                        assertWithMsg( A.res.signal(currentTransferTask.toId, A.res.describeCapacity(to, resourceType), amount) === A.proc.OK )
                    if ( Object.keys(targetDict).length > 0 )
                        return [ A.proc.OK_STOP_CUSTOM, 'moveToTarget' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                }
                targetDict = {}
                currentTransferTask = null
                return [ A.proc.OK_STOP_CUSTOM, 'start' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            }

            /** 确定运输的种类和数量 & 确定是否运输完成 */
            let resourceType = currentTransferTask.content[0].resourceType
            let amount = Math.min(creep.store.getFreeCapacity(), currentTransferTask.content[0].amount)
            assertWithMsg( amount >= 0 && amount <= (source.store[resourceType] || 0), `取资源时, ${source} 应至少有 ${amount} ${resourceType} 但只有 ${source.store[resourceType] || 0}.` )
            assertWithMsg( creep.withdraw(source, resourceType, amount) === OK )
            A.timer.add(Game.time + 1, (sourceId, capacityType, amount) => A.res.signal(sourceId, capacityType, amount), [source.id, A.res.describeCapacity(source, resourceType), amount], `取资源后, 更新源建筑的容量`)

            currentTransferTask.content[0].amount -= amount
            targetDict[resourceType] = amount
            if ( currentTransferTask.content[0].amount === 0 ) {
                currentTransferTask.content.shift()
                currentTransferTask.finishWithdraw = currentTransferTask.content.length === 0
            }

            if ( currentTransferTask.finishWithdraw || creep.store.getFreeCapacity() === amount || creep.ticksToLive === 3 || creep.ticksToLive <= Object.keys(targetDict).length + 1 ) return A.proc.OK_STOP_NEXT
            else return A.proc.OK_STOP_CURRENT
        } ], 
        ['transfer', () => {
            const creep = Game.creeps[workerName]
            /** 检测到错误, 立即释放资源 */
            if ( !creep ) {
                // 释放 Creep
                C.cancel(workerName)
                workerName = null
                // 恢复任务
                assertWithMsg( Object.keys(targetDict).length === 0, `centralTransfer 传输任务应当无丢失!` )
                if ( !currentTransferTask.finishWithdraw ) {
                    insertSortedBy(takeOverQueue.queue, currentTransferTask, 'priority')
                    A.proc.signal.Ssignal({ signalId: takeOverQueue.lengthSignalId, request: 1 })
                }
                
                targetDict = {}
                currentTransferTask = null
                return [A.proc.STOP_ERR, `Creep [${workerName}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
            }

            const target = Game.getObjectById(currentTransferTask.toId)
            if ( !target ) {
                const source = Game.getObjectById(currentTransferTask.fromId)
                if ( !!source ) {
                    for ( const { resourceType, amount } of currentTransferTask.content )
                        assertWithMsg( A.res.signal(currentTransferTask.fromId, resourceType, amount) === A.proc.OK )
                }
                targetDict = {}
                currentTransferTask = null
                return [ A.proc.OK_STOP_CUSTOM, 'start' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            }

            const resourceType = Object.keys(targetDict)[0] as ResourceConstant
            const amount = targetDict[resourceType]
            assertWithMsg( amount <= creep.store[resourceType] && amount <= target.store.getFreeCapacity(resourceType), `transfer -> 242 ${amount}}` )
            assertWithMsg( creep.transfer(target, resourceType, amount) === OK )
            A.timer.add(Game.time + 1, (targetId, resourceType, amount) => A.res.signal(targetId, resourceType, amount), [target.id, resourceType, amount], `转移资源后, 更新目标建筑相应资源的数量`)
            delete targetDict[resourceType]

            if ( Object.keys(targetDict).length > 0 ) return A.proc.OK_STOP_CURRENT
            
            // 全部转移完成
            if ( currentTransferTask.finishWithdraw ) {
                // 全部完成
                C.release(workerName)
                workerName = null
                targetDict = {}
                currentTransferTask = null
                return [ A.proc.OK_STOP_CUSTOM, 'start' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            } else return [ A.proc.OK_STOP_CUSTOM, 'withdraw' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
        }]
    ], `${roomName} => CentralTransfer`)
}

export function issueCentralTransfer(roomName: string, getLinkBuffer: () => Id<StructureLink>[], linkBufferSignal: string) {
    const planInfo = P.plan(roomName, 'unit', unitName)
    assertWithMsg( planInfo !== null, `运行核心转移模块的房间, 一定需要是可规划完成的` )
    const leftTopPos = planInfo.leftTops[0]
    issueCentralTransferProc(roomName, leftTopPos, getLinkBuffer, linkBufferSignal)
}