/**
 * 极速升级模块
 */

import { Apollo as A } from "@/framework/apollo"
import { planModule as P } from "@/modules/plan"
import { creepModule as C } from "@/modules/creep"
import { transferModule as T } from "@/modules/transfer"
import { assertWithMsg, calcBodyEffectiveness, getAvailableSurroundingPos, getFileNameAndLineNumber, log, LOG_ERR } from "@/utils"

/** 管理 Controller 附近的建筑 */
type ControllerRelevantStructures = {
    [ STRUCTURE_CONTAINER ]: { pos: Pos, id: Id<StructureContainer> }, 
    [ STRUCTURE_LINK ]: { pos: Pos, id: Id<StructureLink> }
}
class ControllerUnit {
    #planContainerPos(controllerId: Id<StructureController>): Pos {
        const controller = Game.getObjectById(controllerId)
        const choice = getAvailableSurroundingPos(controller.pos).filter(p => P.isAvailable(p, { onRoad: true }))[0]
        if ( !choice ) log(LOG_ERR, `无法为 ${controllerId} 找到合适的 Container 位置`)
        return choice
    }

    #planLinkPos(controllerId: Id<StructureController>, containerPos: Pos): Pos {
        if ( !containerPos ) return null
        const choice = getAvailableSurroundingPos(containerPos).filter(p => P.isAvailable(p, { offRoad: true }))[0]
        if ( !choice ) log(LOG_ERR, `无法为 ${controllerId} 找到合适的 Link 位置`)
        return choice
    }

    isControllerFit(controllerId: Id<StructureController>): boolean {
        const info = this.getController2Structure(controllerId)
        return (info[STRUCTURE_CONTAINER].pos && info[STRUCTURE_LINK].pos) ? true : false
    }

    getController2Structure(controllerId: Id<StructureController>): ControllerRelevantStructures {
        if ( !('_controller2structure' in Memory) ) (Memory as any)._controller2structure = {}
        if ( !(controllerId in (Memory as any)._controller2structure) ) {
            const containerPos = this.#planContainerPos(controllerId)
            const linkPos = this.#planLinkPos(controllerId, containerPos);
            (Memory as any)._controller2structure[controllerId] = {
                [ STRUCTURE_CONTAINER ]: { pos: containerPos, id: null }, 
                [ STRUCTURE_LINK ]: { pos: linkPos, id: null }, 
            }
        }
        return (Memory as any)._controller2structure[controllerId]
    }
}

const controllerUnit = new ControllerUnit()

function getEnergy(roomName: string, getWorkerName: () => string, setWorkerName: ( name: string ) => void) {
    let targetId: Id<Source> | Id<StorableStructure> = null
    return function() {
        const name = getWorkerName()
        const creep = Game.creeps[name]
        /** 检测到错误, 立即释放资源 */
        if ( !creep ) {
            C.cancel(name)
            setWorkerName(null)
            return [A.proc.STOP_ERR, `Creep [${name}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        }
        /** 最后几秒, 撤离 */
        if ( creep.ticksToLive < 3 ) {
            if ( creep.pos.lookFor(LOOK_STRUCTURES).filter(s => s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_ROAD).length > 0 )
                creep.travelTo( creep.pos, { flee: true, ignoreCreeps: false, range: 1, avoidStructureTypes: [ STRUCTURE_CONTAINER ] } )
            return A.proc.OK_STOP_CURRENT
        }

        /** 已经装满 Energy */
        if ( creep.store.getFreeCapacity(RESOURCE_ENERGY) < calcBodyEffectiveness(creep.body, WORK, 'harvest', HARVEST_POWER) ) {
            targetId = null
            return A.proc.OK
        }

        /** 确认房间位置 */
        if ( creep.pos.roomName !== roomName ) {
            creep.moveToRoom(roomName)
            return A.proc.OK_STOP_CURRENT
        }

        if ( targetId === null ) {
            targetId = A.res.requestSource(roomName, RESOURCE_ENERGY, CARRY_CAPACITY, creep.pos, false).id
            if ( !targetId || A.res.query(targetId, RESOURCE_ENERGY) <= 0 ) {
                // Source 旁边的空位应当 > 1
                const source = creep.pos.findClosestByRange(FIND_SOURCES, { filter: s => s.energy > 0 && getAvailableSurroundingPos(s.pos).length > 1 })
                if ( source ) targetId = source.id
                else if ( creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 ) return A.proc.OK
                else return A.proc.OK_STOP_CURRENT
            }
        }

        const target = Game.getObjectById(targetId)
        if ( creep.pos.getRangeTo(target) > 1 ) {
            creep.moveTo(target)
            return A.proc.OK_STOP_CURRENT
        }

        if ( target instanceof Source ) {
            if ( target.energy > 0 ) creep.harvest(target)
            else targetId = null
        } else {
            const amount = Math.min(A.res.query(targetId as Id<StorableStructure>, RESOURCE_ENERGY), creep.store.getFreeCapacity(RESOURCE_ENERGY))
            if ( amount > 0 ) {
                assertWithMsg( A.res.request({ id: targetId as Id<StorableStructure>, resourceType: RESOURCE_ENERGY, amount }, 'getEnergy -> 70') === OK, getFileNameAndLineNumber() )
                assertWithMsg( creep.withdraw(target, RESOURCE_ENERGY, amount) === OK, getFileNameAndLineNumber() )
                A.timer.add(Game.time + 1, (targetId, amount) => A.res.signal(targetId, A.res.CAPACITY, amount), [targetId, amount], `${targetId} 资源更新`)
            } else targetId = null
        }

        return A.proc.OK_STOP_CURRENT
    }
}

function issueUpgradeProc(roomName: string) {
    let workerName = null

    function gotoController(name: string) {
        const creep = Game.creeps[name]
        /** 检测到错误, 立即释放资源 */
        if ( !creep ) {
            C.cancel(name)
            workerName = null
            return [A.proc.STOP_ERR, `Creep [${name}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        }

        /** 最后几秒, 撤离 */
        if ( creep.ticksToLive < 3 ) {
            if ( creep.pos.lookFor(LOOK_STRUCTURES).filter(s => s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_ROAD).length > 0 )
                creep.travelTo( creep.pos, { flee: true, ignoreCreeps: false, range: 1, avoidStructureTypes: [ STRUCTURE_CONTAINER ] } )
            return A.proc.OK_STOP_CURRENT
        }

        const controller = Game.rooms[roomName].controller
        /** 已经接近 Controller */
        if ( creep.pos.roomName === roomName && creep.pos.getRangeTo(controller) <= 3 ) return A.proc.OK

        creep.travelTo(controller, { range: 3 })
        return A.proc.OK_STOP_CURRENT
    }

    function upgradeController(name: string) {
        const creep = Game.creeps[name]
        /** 检测到错误, 立即释放资源 */
        if ( !creep ) {
            C.cancel(name)
            workerName = null
            return [A.proc.STOP_ERR, `Creep [${name}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        }

        /** 最后几秒, 撤离 */
        if ( creep.ticksToLive < 3 ) {
            if ( creep.pos.lookFor(LOOK_STRUCTURES).filter(s => s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_ROAD).length > 0 )
                creep.travelTo( creep.pos, { flee: true, ignoreCreeps: false, range: 1, avoidStructureTypes: [ STRUCTURE_CONTAINER ] } )
            return A.proc.OK_STOP_CURRENT
        }

        const controller = Game.rooms[roomName].controller
        if ( creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 ) return A.proc.OK_STOP_NEXT

        creep.upgradeController(controller)
        return A.proc.OK_STOP_CURRENT
    }

    const gotoSource = getEnergy(roomName, () => workerName, name => workerName = name)

    return A.proc.createProc([
        () => C.acquire('weak_upgrader', roomName, name => workerName = name), 
        [ 'gotoSource', gotoSource ], 
        () => gotoController(workerName), 
        () => upgradeController(workerName), 
        [ 'JUMP', () => true, 'gotoSource' ]
    ], `${roomName} => Upgrade (always on)`)
}

export function registerFastUpgrade() {
    C.design('weak_upgrader', {
        body: {
            1: [ CARRY, WORK, MOVE ], 
            2: [ CARRY, CARRY, WORK, WORK, MOVE, MOVE ], 
            5: [ CARRY, CARRY, CARRY, CARRY, WORK, WORK, WORK, WORK, MOVE, MOVE, MOVE, MOVE ], 
            8: [ CARRY, WORK, MOVE ]
        }, 
        amount: 1
    })
    C.design('dedicated_upgrader', {
        body: {
            3: [ CARRY, WORK, WORK, WORK, MOVE, MOVE ], 
            4: [ CARRY, WORK, WORK, WORK, WORK, WORK, MOVE, MOVE, MOVE ]
        }, 
        amount: 2, // At most 2 due to at most 2 sources, 
        priority: C.PRIORITY_CASUAL
    })
}

function issueFastUpgradesBuildProc(roomName: string, controllerId: Id<StructureController>, pos: RoomPosition, structureType: StructureConstant) {
    const info = () => controllerUnit.getController2Structure(controllerId)
    let workerName = null
    const isBuildRequired = !Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, pos).filter(s => s.structureType === structureType)[0]
    const buildCompleteSignal = A.proc.signal.createSignal(!isBuildRequired ? 1 : 0)
    if ( !isBuildRequired ) {
        info()[structureType].id = Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, pos).filter(s => s.structureType === structureType)[0].id
        return buildCompleteSignal
    }

    function buildConstructionSite(name: string) {
        const creep = Game.creeps[name]
        /** 检测到错误, 立即释放资源 */
        if ( !creep ) {
            C.cancel(name)
            workerName = null
            return [A.proc.STOP_ERR, `Creep [${name}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        }

        /** 最后几秒, 撤离 */
        if ( creep.ticksToLive < 3 ) {
            if ( creep.pos.lookFor(LOOK_STRUCTURES).filter(s => s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_ROAD).length > 0 )
                creep.travelTo( creep.pos, { flee: true, ignoreCreeps: false, range: 1, avoidStructureTypes: [ STRUCTURE_CONTAINER ] } )
            return A.proc.OK_STOP_CURRENT
        }

        if ( creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 ) return [ A.proc.OK_STOP_CUSTOM, 'gotoSource' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]

        if ( creep.pos.roomName === roomName && creep.pos.getRangeTo(pos) <= 3 ) {
            const target = Game.rooms[roomName].lookForAt(LOOK_CONSTRUCTION_SITES, pos)[0]
            if ( target ) creep.build(target)
            else {
                const structure = Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, pos).filter(s => s.structureType === structureType)[0]
                if ( structure ) {
                    info()[structureType].id = structure.id
                    assertWithMsg( A.proc.signal.Ssignal({ signalId: buildCompleteSignal, request: 1 }) === A.proc.OK, getFileNameAndLineNumber() )
                    return A.proc.STOP_SLEEP
                } else {
                    const retCode = Game.rooms[roomName].createConstructionSite(pos, structureType)
                    if ( retCode === ERR_NOT_IN_RANGE ) creep.travelTo(pos)
                    else assertWithMsg( retCode === OK, `无法为 Controller 在 ${pos} 构建建筑 ${structureType}` )
                    return A.proc.OK_STOP_CURRENT
                }
            }
        } else creep.travelTo(pos, { range: 3 })

        return A.proc.OK_STOP_CURRENT
    }

    const gotoSource = getEnergy(roomName, () => workerName, name => workerName = name)

    const pid = A.proc.createProc([
        () => {
            if ( Game.rooms[roomName].controller.level >= 6 ) return A.proc.STOP_SLEEP
            if ( !info()[structureType].id ) {
                if ( A.proc.signal.getValue(buildCompleteSignal) === 1 ) A.proc.signal.Swait({ signalId: buildCompleteSignal, lowerbound: 1, request: 1 })
                return A.proc.OK
            }
            if ( !Game.getObjectById(info()[structureType].id) ) {
                info()[structureType].id = null
                if ( A.proc.signal.getValue(buildCompleteSignal) === 1 ) A.proc.signal.Swait({ signalId: buildCompleteSignal, lowerbound: 1, request: 1 })
                return A.proc.OK
            } else return A.proc.STOP_SLEEP
        }, 
        () => C.acquire('worker', roomName, name => workerName = name), 
        ['gotoSource', gotoSource], 
        () => buildConstructionSite(workerName)
    ], `${roomName} Fast Upgrade Build [${structureType}, ${pos}]`, true)

    A.proc.trigger('watch', () => {
        return Game.getObjectById(controllerId) && Game.getObjectById(controllerId).level >= 3 && Game.getObjectById(controllerId).level < 6 && !Game.getObjectById(info()[structureType].id)
    }, [pid])

    return buildCompleteSignal
}

function issueFastUpgradeProc(roomName: string, controllerId: Id<StructureController>, controllerPos: Pos, maximumNumOfUpgrader: number) {
    const info = () => controllerUnit.getController2Structure(controllerId)
    const buildContainerCompleteSignal = issueFastUpgradesBuildProc(roomName, controllerId, new RoomPosition(info()[STRUCTURE_CONTAINER].pos.x, info()[STRUCTURE_CONTAINER].pos.y, roomName), STRUCTURE_CONTAINER)

    function fillContainer() {
        if ( !info()[STRUCTURE_CONTAINER].id || !Game.getObjectById(info()[STRUCTURE_CONTAINER].id) ) {
            info()[STRUCTURE_CONTAINER].id = null
            if ( A.proc.signal.getValue(buildContainerCompleteSignal) === 1 ) A.proc.signal.Swait({ signalId: buildContainerCompleteSignal, lowerbound: 1, request: 1 })
            return [ A.proc.STOP_ERR, `Container 无法找到` ] as [ typeof A.proc.STOP_ERR, string ]
        }

        const container = Game.getObjectById(info()[STRUCTURE_CONTAINER].id)
        const capacity = A.res.query(container.id, A.res.CAPACITY)

        if ( capacity < CARRY_CAPACITY )
            return A.res.request({ id: container.id, resourceType: A.res.CAPACITY, amount: {lowerbound: CARRY_CAPACITY, request: 0} })

        const requestedSource = A.res.requestSource( roomName, RESOURCE_ENERGY, CARRY_CAPACITY, container.pos, true )
        if ( requestedSource.code !== A.proc.OK )
            return requestedSource.code

        const amount = A.res.query(requestedSource.id, RESOURCE_ENERGY)
        if ( amount < CARRY_CAPACITY )
            return A.res.request({ id: requestedSource.id, resourceType: RESOURCE_ENERGY, amount: { lowerbound: CARRY_CAPACITY, request: 0 } })
        
        const transferAmount = Math.min(amount, capacity)
        assertWithMsg( A.res.request({ id: container.id, resourceType: A.res.CAPACITY, amount: transferAmount }) === A.proc.OK, getFileNameAndLineNumber() )
        assertWithMsg( A.res.request({ id: requestedSource.id, resourceType: RESOURCE_ENERGY, amount: transferAmount }) === A.proc.OK, getFileNameAndLineNumber() )
        T.transfer(requestedSource.id, container.id, RESOURCE_ENERGY, transferAmount)
        return A.proc.OK_STOP_CURRENT
    }

    const containerPid = A.proc.createProc([
        () => A.proc.signal.Swait({ signalId: buildContainerCompleteSignal, lowerbound: 1, request: 0 }), 
        fillContainer
    ], `${roomName} Fast Upgrade's Container`, true)

    const upgraderPids = []
    const upgraderNames = []
    const upgraderStatus = []
    for ( let upgraderIdx = 0; upgraderIdx < maximumNumOfUpgrader; ++upgraderIdx ) {
        upgraderNames.push(null)
        upgraderStatus.push('withdraw')
        upgraderPids.push(A.proc.createProc([
            () => A.proc.signal.Swait({ signalId: buildContainerCompleteSignal, lowerbound: 1, request: 0 }), 
            () => {
                if ( !info()[STRUCTURE_CONTAINER].id || !Game.getObjectById(info()[STRUCTURE_CONTAINER].id) ) {
                    info()[STRUCTURE_CONTAINER].id = null
                    if ( A.proc.signal.getValue(buildContainerCompleteSignal) === 1 ) A.proc.signal.Swait({ signalId: buildContainerCompleteSignal, lowerbound: 1, request: 1 })
                    return [ A.proc.STOP_ERR, `Container 无法找到` ] as [ typeof A.proc.STOP_ERR, string ]
                }
                return A.res.request({ id: info()[STRUCTURE_CONTAINER].id, resourceType: RESOURCE_ENERGY, amount: {lowerbound: CARRY_CAPACITY, request: 0} })
            }, 
            () => C.acquire('dedicated_upgrader', roomName, name => upgraderNames[upgraderIdx] = name), 
            () => {
                if ( Game.rooms[roomName].controller.level >= 6 ) {
                    // 销毁 container, 腾位置给矿物采集
                    if ( info()[STRUCTURE_CONTAINER].id ) {
                        if ( Game.getObjectById(info()[STRUCTURE_CONTAINER].id) ) Game.getObjectById(info()[STRUCTURE_CONTAINER].id).destroy()
                        info()[STRUCTURE_CONTAINER].id = null
                    }
                    if ( A.proc.signal.getValue(buildContainerCompleteSignal) === 1 ) A.proc.signal.Swait({ signalId: buildContainerCompleteSignal, lowerbound: 1, request: 1 })
                    const name = upgraderNames[upgraderIdx]
                    const creep = Game.creeps[name]
                    if ( !creep ) C.cancel(name)
                    else C.release(name)
                    upgraderNames[upgraderIdx] = null
                    return A.proc.STOP_SLEEP
                }

                const name = upgraderNames[upgraderIdx]
                const creep = Game.creeps[name]
                /** 检测到错误, 立即释放资源 */
                if ( !creep ) {
                    C.cancel(name)
                    upgraderNames[upgraderIdx] = null
                    return [A.proc.STOP_ERR, `Creep [${name}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
                }

                /** 最后几秒, 撤离 */
                if ( creep.ticksToLive < 3 ) {
                    if ( creep.pos.lookFor(LOOK_STRUCTURES).filter(s => s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_ROAD).length > 0 )
                        creep.travelTo( creep.pos, { flee: true, ignoreCreeps: false, range: 1, avoidStructureTypes: [ STRUCTURE_CONTAINER ] } )
                    return A.proc.OK_STOP_CURRENT
                }

                if ( !info()[STRUCTURE_CONTAINER].id || !Game.getObjectById(info()[STRUCTURE_CONTAINER].id) ) {
                    info()[STRUCTURE_CONTAINER].id = null
                    if ( A.proc.signal.getValue(buildContainerCompleteSignal) === 1 ) A.proc.signal.Swait({ signalId: buildContainerCompleteSignal, lowerbound: 1, request: 1 })
                    return [ A.proc.STOP_ERR, `Container 无法找到` ] as [ typeof A.proc.STOP_ERR, string ]
                }

                const container = Game.getObjectById(info()[STRUCTURE_CONTAINER].id)

                if ( upgraderStatus[upgraderIdx] === 'withdraw' ) {
                    if ( creep.store.getFreeCapacity() === 0 ) upgraderStatus[upgraderIdx] = 'work'
                    else if ( creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 && A.res.query(container.id, RESOURCE_ENERGY) <= 0 ) upgraderStatus[upgraderIdx] = 'work'
                    else {
                        if ( creep.pos.getRangeTo(container) > 1 ) creep.moveTo(container)
                        else {
                            const amount = A.res.query(container.id, RESOURCE_ENERGY)
                            if ( amount <= 0 ) return A.res.request({ id: container.id, resourceType: RESOURCE_ENERGY, amount: { lowerbound: CARRY_CAPACITY, request: 0 } })
                            const withdrawAmount = Math.min(amount, creep.store.getFreeCapacity())
                            assertWithMsg( A.res.request({ id: container.id, resourceType: RESOURCE_ENERGY, amount: withdrawAmount }) === A.proc.OK, getFileNameAndLineNumber() )
                            A.timer.add(Game.time + 1, (id, a) => A.res.signal(id, A.res.CAPACITY, a), [container.id, withdrawAmount], `${container.id} 资源更新`)
                            assertWithMsg( creep.withdraw(container, RESOURCE_ENERGY, withdrawAmount) === OK, getFileNameAndLineNumber() )
                        }
                        return A.proc.OK_STOP_CURRENT
                    }
                } else {
                    if ( creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 ) {
                        upgraderStatus[upgraderIdx] = 'withdraw'
                        return A.proc.OK_STOP_CURRENT
                    }
                    if ( creep.upgradeController(Game.rooms[roomName].controller) === ERR_NOT_IN_RANGE ) creep.moveTo(Game.rooms[roomName].controller)
                    return A.proc.OK_STOP_CURRENT
                }
                return A.proc.OK_STOP_CURRENT
            }
        ], `${roomName} Fast Upgrade's Upgrader ${upgraderIdx}`, true))
    }

    A.proc.trigger('watch', () => {
        return Game.getObjectById(controllerId) && Game.getObjectById(controllerId).level >= 3 && Game.getObjectById(controllerId).level < 6
    }, [ containerPid, ...upgraderPids ])
}

export function issueFastUpgrade( roomName: string ): (() => Id<StructureLink>)[] {
    const room = Game.rooms[roomName]
    assertWithMsg( room && room.controller && room.controller.my, `无法为非自己控制的房间创建 Upgrade 方法` )
    const sources = Game.rooms[roomName].find(FIND_SOURCES) // 根据 Source 数量决定最快升级数量
    issueUpgradeProc(roomName)
    // if ( controllerUnit.isControllerFit(room.controller.id) ) {
    //     issueFastUpgradeProc(roomName, room.controller.id, room.controller.pos, sources.length)
    // } else {
    //     log(LOG_ERR, `无法为 ${roomName} 创建迅速升级方法`)
    // }
    return []
}