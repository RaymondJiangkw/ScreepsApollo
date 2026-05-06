import { Apollo as A } from "@/framework/apollo"
import { planModule as P } from "@/modules/plan"
import { creepModule as C } from "@/modules/creep"
import { assertWithMsg, calcBodyEffectiveness, getFileNameAndLineNumber } from '@/utils'

export function registerHarvestMineral() {
    C.design('mineral_harvester', {
        amount: 1, 
        body: {
            6: [ CARRY, WORK, WORK, WORK, WORK, WORK, MOVE, MOVE, MOVE ], 
            7: [ CARRY, CARRY, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ], 
        }
    })
}

export function issueHarvestMineral(roomName: string) {
    const extractorPlan = P.plan(roomName, "unit", `${roomName}: extractor`)
    const containerPlan = P.plan(roomName, "unit", `${roomName}: mineral's container`)
    assertWithMsg( !!extractorPlan && !!containerPlan, getFileNameAndLineNumber() )
    const extractorPos = extractorPlan.structures[STRUCTURE_EXTRACTOR][0].pos
    const containerPos = containerPlan.structures[STRUCTURE_CONTAINER][0].pos
    const mineralId = Game.rooms[roomName].find(FIND_MINERALS)[0].id
    let extractorId: Id<StructureExtractor> = null
    let containerId: Id<StructureContainer> = null

    let workerName = null

    A.proc.createProc([
        () => P.exist(roomName, `${roomName}: mineral's container`, 'container'), 
        () => P.exist(roomName, `${roomName}: extractor`, `extractor`), 
        () => C.acquire('mineral_harvester', roomName, name => workerName = name), 
        ['gotoMineral', () => {
            const creep = Game.creeps[workerName]
            /** 检测到错误, 立即释放资源 */
            if ( !creep || creep.hits < creep.hitsMax ) {
                C.cancel(workerName)
                workerName = null
                return [A.proc.STOP_ERR, `Creep [${workerName}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
            }

            const mineral = Game.getObjectById(mineralId)

            /** 即将消亡, 则逃离原位置 */
            if ( creep.ticksToLive < 5 ) {
                creep.travelTo( mineral, { flee: true, ignoreCreeps: false, range: 2, avoidStructureTypes: [ STRUCTURE_CONTAINER ] } )
                return A.proc.OK_STOP_CURRENT
            }

            if ( extractorId && !Game.getObjectById(extractorId) ) {
                extractorId = null
                return [A.proc.STOP_ERR, `Mineral's Extractor 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
            }

            if ( !extractorId ) {
                const structure = Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, extractorPos).filter(s => s.structureType === STRUCTURE_EXTRACTOR)[0] as StructureExtractor
                if ( structure ) extractorId = structure.id
                else return [A.proc.STOP_ERR, `Mineral's Extractor 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
            }

            if ( creep.pos.getRangeTo(containerPos) > 0 ) {
                creep.moveTo(containerPos)
                return A.proc.OK_STOP_CURRENT
            }

            if ( mineral.mineralAmount === 0 ) {
                if ( creep.store.getUsedCapacity(mineral.mineralType) === 0 ) {
                    C.release(workerName)
                    workerName = null
                    return [ A.proc.STOP_SLEEP, (mineral.ticksToRegeneration || 0) + 1 ] as [ typeof A.proc.STOP_SLEEP, number ]
                } else return A.proc.OK
            }

            /** 采集满 或 无可采集 或 采集溢出 */
            if ( creep.store.getFreeCapacity(mineral.mineralType) < calcBodyEffectiveness(creep.body, WORK, 'harvest', HARVEST_MINERAL_POWER) ) return A.proc.OK

            creep.harvest(mineral)

            return A.proc.OK_STOP_CURRENT
        }], 
        () => {
            const creep = Game.creeps[workerName]
            /** 检测到错误, 立即释放资源 */
            if ( !creep || creep.hits < creep.hitsMax ) {
                C.cancel(workerName)
                workerName = null
                return [A.proc.STOP_ERR, `Creep [${workerName}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
            }

            const mineral = Game.getObjectById(mineralId)

            /** 即将消亡, 则逃离原位置 */
            if ( creep.ticksToLive < 5 ) {
                creep.travelTo( mineral, { flee: true, ignoreCreeps: false, range: 2, avoidStructureTypes: [ STRUCTURE_CONTAINER ] } )
                return A.proc.OK_STOP_CURRENT
            }

            if ( containerId && !Game.getObjectById(containerId) ) {
                A.res.removeSource(roomName, mineral.mineralType, containerId)
                containerId = null
                return [A.proc.STOP_ERR, `Mineral's Container 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
            }

            if ( !containerId ) {
                const structure = Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, containerPos).filter(s => s.structureType === STRUCTURE_CONTAINER)[0] as StructureContainer
                if ( structure ) {
                    containerId = structure.id
                    A.res.registerSource(roomName, mineral.mineralType, containerId)
                } else return [A.proc.STOP_ERR, `Mineral's Container 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
            }

            const container = Game.getObjectById(containerId)

            if ( A.res.query(containerId, A.res.CAPACITY) > 0 ) {
                const amount = Math.min(A.res.query(containerId, A.res.CAPACITY), creep.store.getUsedCapacity(mineral.mineralType))
                assertWithMsg( A.res.request({ id: containerId, resourceType: A.res.CAPACITY, amount }) === A.proc.OK, `无法申请 ${containerId} ${amount} 容量` )
                assertWithMsg( creep.transfer(container, mineral.mineralType, amount) === OK, `${creep} 无法传输 ${amount} ${mineral.mineralType} 到 ${containerId}` )
                A.timer.add(Game.time + 1, (id, type, amount) => A.res.signal(id, type, amount), [containerId, mineral.mineralType, amount], `更新 ${containerId} 的 ${mineral.mineralType} 数量`)
                return [A.proc.OK_STOP_CUSTOM, `gotoMineral`] as [ typeof A.proc.OK_STOP_CUSTOM, `gotoMineral` ]
            } else return A.proc.OK_STOP_CURRENT
        }
    ], `${roomName} => Harvest Mineral`)
}