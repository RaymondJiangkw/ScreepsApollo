/**
 * 修复模块, 只在 Controller Level < 6 时使用
 */

import { Apollo as A } from '@/framework/apollo'
import { planModule as P } from "@/modules/plan"
import { creepModule as C } from '@/modules/creep'
import { assertWithMsg, calcBodyEffectiveness, getAvailableSurroundingPos, getFileNameAndLineNumber, log, LOG_DEBUG } from '@/utils'

function getEnergy(roomName: string, getWorkerName: () => string, setWorkerName: ( name: string ) => void) {
    let targetId: Id<Source> | Id<StorableStructure> = null
    return function() {
        const name = getWorkerName()
        const creep = Game.creeps[name]
        /** 检测到错误, 立即释放资源 */
        if ( !creep || creep.hits < creep.hitsMax ) {
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

export function issueRepairStructure(roomName: string) {
    let workerName = null
    let repairedPos: RoomPosition = null

    function getRepairedPos() {
        if ( !Game.rooms[roomName] || !Game.rooms[roomName].controller.my || Game.rooms[roomName].controller.level >= 6 ) return A.proc.STOP_SLEEP

        const structure = _.min(Game.rooms[roomName].find(FIND_STRUCTURES, { filter: s => s.hits < s.hitsMax && s.structureType !== STRUCTURE_RAMPART && s.structureType !== STRUCTURE_WALL }), s => s.hits / s.hitsMax)
        if ( !(structure instanceof Structure) ) return A.proc.STOP_SLEEP
        else {
            log(LOG_DEBUG, `发现需要修理的建筑 ${structure}`)
            repairedPos = structure.pos
        }
        return A.proc.OK
    }

    function gotoStructure(name: string) {
        const creep = Game.creeps[name]
        /** 检测到错误, 立即释放资源 */
        if ( !creep || creep.hits < creep.hitsMax ) {
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

        if ( creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 ) {
            C.release(name)
            workerName = null
            return A.proc.OK
        }
        
        if ( creep.pos.roomName === roomName && creep.pos.getRangeTo(repairedPos) <= 3 ) {
            const structure = _.min(Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, repairedPos).filter(s => s.hits < s.hitsMax && s.structureType !== STRUCTURE_RAMPART && s.structureType !== STRUCTURE_WALL), s => s.hits / s.hitsMax)
            if ( structure instanceof Structure ) creep.repair(structure)
            else {
                C.release(name)
                workerName = null
                repairedPos = null
                return [ A.proc.OK_STOP_CUSTOM, 'getRepairedPos' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            }
        } else creep.moveTo(repairedPos)

        return A.proc.OK_STOP_CURRENT
    }

    const gotoSource = getEnergy(roomName, () => workerName, name => workerName = name)

    const pid = A.proc.createProc([
        ['getRepairedPos', () => getRepairedPos()], 
        () => C.acquire('worker', roomName, name => workerName = name), 
        () => {
            const creep = Game.creeps[workerName]
            /** 检测到错误, 立即释放资源 */
            if ( !creep || creep.hits < creep.hitsMax ) {
                C.cancel(workerName)
                workerName = null
                return [A.proc.STOP_ERR, `Creep [${workerName}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
            }
            if ( creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 ) return [ A.proc.OK_STOP_CUSTOM, 'work' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            else return A.proc.OK
        }, 
        [ 'gotoSource', gotoSource ], 
        [ 'work', () => gotoStructure(workerName) ], 
        [ 'JUMP', () => true, 'getRepairedPos' ]
    ], `${roomName} => Repair`)

    let lastTriggerTick = Game.time
    /** Repair 定时触发 */
    A.proc.trigger('watch', () => {
        if ( !!Game.rooms[roomName] && !!Game.rooms[roomName].controller.my && Game.rooms[roomName].controller.level < 6 && Game.time - lastTriggerTick > RAMPART_DECAY_TIME / 2 ) {
            lastTriggerTick = Game.time
            return true
        } else return false
    }, [ pid ])

    // Tower 维修
    const towerPid = A.proc.createProc([
        () => P.exist(roomName, 'towers', 'tower'), 
        () => {
            if ( !Game.rooms[roomName] ) return [A.proc.STOP_ERR, `${roomName} 房间无视野`] as [ typeof A.proc.STOP_ERR, string ]
            if ( Game.rooms[roomName].controller.level < 6 ) return A.proc.STOP_SLEEP
            const towers = Game.rooms[roomName].find<FIND_STRUCTURES, StructureTower>(FIND_STRUCTURES, { filter: { structureType: STRUCTURE_TOWER } })
            if ( towers.length === 0 ) return [A.proc.STOP_ERR, `${roomName} 房间无可用 Tower`] as [ typeof A.proc.STOP_ERR, string ]

            const hostileCreeps = Game.rooms[roomName].find(FIND_HOSTILE_CREEPS)
            if ( hostileCreeps.length > 0 ) {
                // 有 hostileCreeps 时, 不进行维修, 休眠
                return [ A.proc.STOP_SLEEP, RAMPART_DECAY_TIME / 2 ] as [ typeof A.proc.STOP_SLEEP, number ]
            }

            const structuresNeedRepair = Game.rooms[roomName].find(FIND_STRUCTURES).filter(s => s.structureType !== STRUCTURE_RAMPART && s.structureType !== STRUCTURE_WALL && s.hits < s.hitsMax).sort((u, v) => u.hits / u.hitsMax - v.hits / v.hitsMax).map(s => { return { id: s.id, pos: s.pos, hits: s.hits, hitsMax: s.hitsMax } })
            if ( structuresNeedRepair.length === 0 ) return A.proc.STOP_SLEEP
            towers.forEach(tower => {
                if ( A.res.query(tower.id, RESOURCE_ENERGY) >= TOWER_CAPACITY / 2 ) {
                    let targetStructure = null
                    for ( const structureInfo of structuresNeedRepair ) {
                        if ( structureInfo.hits >= structureInfo.hitsMax ) continue
                        let range = Math.max(Math.abs(structureInfo.pos.x - tower.pos.x), Math.abs(structureInfo.pos.y - tower.pos.y))
                        let repairAmount = TOWER_POWER_REPAIR
                        if ( range > TOWER_OPTIMAL_RANGE ) {
                            if ( range > TOWER_FALLOFF_RANGE ) range = TOWER_FALLOFF_RANGE
                            repairAmount -= repairAmount * TOWER_FALLOFF * (range - TOWER_OPTIMAL_RANGE) / (TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE)
                        }
                        repairAmount = Math.floor(repairAmount)
                        structureInfo.hits += repairAmount
                        targetStructure = Game.getObjectById(structureInfo.id)
                        break
                    }
                    if ( !!targetStructure ) {
                        assertWithMsg( A.res.request({ id: tower.id, resourceType: RESOURCE_ENERGY, amount: TOWER_ENERGY_COST }) === A.proc.OK )
                        A.timer.add(Game.time + 1, id => A.res.signal(id, A.res.CAPACITY_ENERGY, TOWER_ENERGY_COST), [ tower.id ], `更新塔 ${tower.id} 的容量`)
                        tower.repair(targetStructure)
                    }
                }
            })

            return A.proc.OK_STOP_CURRENT
        }
    ], `${roomName} => Tower Repair`)

    let lastTowerTriggerTick = Game.time
    A.proc.trigger('watch', () => {
        if ( !!Game.rooms[roomName] && !!Game.rooms[roomName].controller.my && Game.rooms[roomName].controller.level >= 6 && Game.time - lastTowerTriggerTick > RAMPART_DECAY_TIME / 2 ) {
            lastTowerTriggerTick = Game.time
            return true
        } else return false
    }, [ towerPid ])
}