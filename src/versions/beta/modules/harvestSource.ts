/**
 * 构建指定房间的 Source 采集模块
 */

import { Apollo as A } from "@/framework/apollo"
import { planModule as P } from "@/modules/plan"
import { creepModule as C } from "@/modules/creep"
import { transferModule as T } from "@/modules/transfer"
import { assertWithMsg, calcBodyEffectiveness, getAvailableSurroundingPos, log, LOG_DEBUG, LOG_ERR, LOG_INFO } from "@/utils"
import { getMaintainAmount } from "../config.production"

/** 管理 Source 附近的建筑 */
type SourceRelevantStructures = {
    [ STRUCTURE_CONTAINER ]: { pos: Pos, id: Id<StructureContainer> }, 
    [ STRUCTURE_LINK ]: { pos: Pos, id: Id<StructureLink> }
}
class SourceUnit {
    #planContainerPos(sourceId: Id<Source>): Pos {
        const source = Game.getObjectById(sourceId)
        const choice = getAvailableSurroundingPos(source.pos).filter(p => P.isAvailable(p, { onRoad: true }))[0]
        if ( !choice ) log(LOG_ERR, `无法为 ${sourceId} 找到合适的 Container 位置`)
        return choice
    }

    #planLinkPos(sourceId: Id<Source>, containerPos: Pos): Pos {
        if ( !containerPos ) return null
        const choice = getAvailableSurroundingPos(containerPos).filter(p => P.isAvailable(p, { offRoad: true }))[0]
        if ( !choice ) log(LOG_ERR, `无法为 ${sourceId} 找到合适的 Link 位置`)
        return choice
    }

    isSourceFit(sourceId: Id<Source>): boolean {
        const info = this.getSource2Structure(sourceId)
        return (info[STRUCTURE_CONTAINER].pos && info[STRUCTURE_LINK].pos) ? true : false
    }

    getSource2Structure(sourceId: Id<Source>): SourceRelevantStructures {
        if ( !('_source2structure' in Memory) ) (Memory as any)._source2structure = {}
        if ( !(sourceId in (Memory as any)._source2structure) ) {
            const containerPos = this.#planContainerPos(sourceId)
            const linkPos = this.#planLinkPos(sourceId, containerPos);
            (Memory as any)._source2structure[sourceId] = {
                [ STRUCTURE_CONTAINER ]: { pos: containerPos, id: null }, 
                [ STRUCTURE_LINK ]: { pos: linkPos, id: null }, 
            }
        }
        return (Memory as any)._source2structure[sourceId]
    }
}

const sourceUnit = new SourceUnit()

export function registerHarvestSource() {
    C.design('harvester', {
        /** 最大的 Source 数量 */
        amount: 2, 
        body: {
            1: [ CARRY, WORK, MOVE ], 
            2: [ CARRY, WORK, WORK, WORK, MOVE ], 
            3: [ CARRY, WORK, WORK, WORK, WORK, WORK, MOVE ], 
            4: [ CARRY, WORK, WORK, WORK, WORK, WORK, WORK, WORK, MOVE, MOVE ]
        }
    })
}

function issueHarvestSourceProc(roomName: string, sourceId: Id<Source>, sourcePos: RoomPosition) {
    const info = () => sourceUnit.getSource2Structure(sourceId)
    let harvesterName = null

    // 初始化时注册 Container
    if ( info()[STRUCTURE_CONTAINER].id && Game.getObjectById(info()[STRUCTURE_CONTAINER].id) && !info()[STRUCTURE_LINK].id )
        A.res.registerSource(roomName, RESOURCE_ENERGY, info()[STRUCTURE_CONTAINER].id )

    function gotoSource( name: string ) {
        const creep = Game.creeps[name]
        /** 检测到错误, 立即释放资源 */
        if ( !creep ) {
            C.cancel(name)
            harvesterName = null
            return [A.proc.STOP_ERR, `Creep [${name}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        }

        const source = Game.getObjectById(sourceId)
        if ( !source ) {
            /** 找不到 Source 时, 睡眠 */
            log(LOG_ERR, `无法找到 Source ${sourceId} 以采集`)
            return A.proc.STOP_SLEEP
        }
        
        /** 即将消亡, 则逃离原位置 */
        if ( creep.ticksToLive < 5 ) {
            creep.travelTo( source, { flee: true, ignoreCreeps: false, range: 2, avoidStructureTypes: [ STRUCTURE_CONTAINER ] } )
            return A.proc.OK_STOP_CURRENT
        }
        
        if ( source.energy === 0 ) {
            // 无能量时, 离开工作位置, 同样睡眠
            if ( creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 ) {
                // creep.travelTo( source, { flee: true, ignoreCreeps: false, avoidStructureTypes: [ STRUCTURE_CONTAINER ] } )
                C.release(name)
                harvesterName = null
                return [ A.proc.STOP_SLEEP, (source.ticksToRegeneration || 0) + 1 ] as [ typeof A.proc.STOP_SLEEP, number ]
            } else return A.proc.OK_STOP_NEXT
        }

        /** 移动到 Container 的位置 */
        if ( creep.pos.getRangeTo(info()[STRUCTURE_CONTAINER].pos.x, info()[STRUCTURE_CONTAINER].pos.y) > 0 ) {
            creep.moveTo(new RoomPosition(info()[STRUCTURE_CONTAINER].pos.x, info()[STRUCTURE_CONTAINER].pos.y, roomName))
            return A.proc.OK_STOP_CURRENT
        }

        /** 采集满 或 无可采集 或 采集溢出 */
        if ( creep.store.getFreeCapacity(RESOURCE_ENERGY) < calcBodyEffectiveness(creep.body, WORK, 'harvest', HARVEST_POWER) || source.energy === 0 ) return A.proc.OK

        creep.harvest(source)

        return A.proc.OK_STOP_CURRENT
    }

    let buildPos: RoomPosition = null
    let repairPos: RoomPosition = null

    function buildRepairOrTransfer(name: string) {
        const creep = Game.creeps[name]
        /** 检测到错误, 立即释放资源 */
        if ( !creep ) {
            C.cancel(name)
            harvesterName = null
            return [A.proc.STOP_ERR, `Creep [${name}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        }

        // 优先判定 Link
        const linkPos = new RoomPosition(info()[STRUCTURE_LINK].pos.x, info()[STRUCTURE_LINK].pos.y, roomName)
        if ( info()[STRUCTURE_LINK].id && !Game.getObjectById(info()[STRUCTURE_LINK].id) ) {
            info()[STRUCTURE_LINK].id = null
        }
        // -> 建造 Link
        if ( !info()[STRUCTURE_LINK].id && Game.rooms[roomName].controller.level >= 6 ) {
            const structure = Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, linkPos).filter(s => s.structureType === STRUCTURE_LINK)[0]
            if ( structure ) {
                info()[STRUCTURE_LINK].id = structure.id as Id<StructureLink>
                A.res.removeSource(roomName, RESOURCE_ENERGY, info()[STRUCTURE_CONTAINER].id)
            } else {
                const constructionSite = Game.rooms[roomName].lookForAt(LOOK_CONSTRUCTION_SITES, linkPos)[0]
                if ( constructionSite && constructionSite.structureType === STRUCTURE_LINK ) {
                    buildPos = linkPos
                    return [ A.proc.OK_STOP_CUSTOM, 'buildLinkOrContainer' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                }

                // 判定可不可以建造 link
                const structures = Game.rooms[roomName].find(FIND_STRUCTURES, { filter: { structureType: STRUCTURE_LINK } })
                const constructionSites = Game.rooms[roomName].find(FIND_CONSTRUCTION_SITES, { filter: { structureType: STRUCTURE_LINK } })
                if ( !constructionSite && structures.length + constructionSites.length < CONTROLLER_STRUCTURES[STRUCTURE_LINK][Game.rooms[roomName].controller.level] ) {
                    Game.rooms[roomName].createConstructionSite( linkPos, STRUCTURE_LINK )
                    buildPos = linkPos
                    // 此时 harvestor 不再将能量放入 container, 所以需要 remove
                    A.res.removeSource(roomName, RESOURCE_ENERGY, info()[STRUCTURE_CONTAINER].id)
                    return [ A.proc.OK_STOP_CUSTOM, 'buildLinkOrContainer' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                }
            }
        }
        // -> 维修 Link
        if ( info()[STRUCTURE_LINK].id && Game.getObjectById(info()[STRUCTURE_LINK].id).hits < Game.getObjectById(info()[STRUCTURE_LINK].id).hitsMax ) {
            repairPos = linkPos
            return [ A.proc.OK_STOP_CUSTOM, 'repairLinkOrContainer' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
        }
        // -> Transfer 给 Link
        if ( info()[STRUCTURE_LINK].id ) {
            const link = Game.getObjectById(info()[STRUCTURE_LINK].id)
            if ( link.store.getFreeCapacity(RESOURCE_ENERGY) === 0 ) {
                if ( link.cooldown > 0 ) return [ A.proc.STOP_SLEEP, link.cooldown + 1 ] as [ typeof A.proc.STOP_SLEEP, number ]
                else return A.proc.OK_STOP_CURRENT
            } else {
                creep.transfer(link, RESOURCE_ENERGY)
                return [ A.proc.OK_STOP_CUSTOM, 'gotoSource' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            }
        }

        // Link 无法满足的情况下, 建造 Container
        const containerPos = new RoomPosition(info()[STRUCTURE_CONTAINER].pos.x, info()[STRUCTURE_CONTAINER].pos.y, roomName)

        /** 即将消亡, 则逃离原位置 */
        if ( creep.ticksToLive < 5 || creep.hits < creep.hitsMax ) {
            creep.travelTo( Game.getObjectById(sourceId), { flee: true, ignoreCreeps: false, range: 2, avoidStructureTypes: [ STRUCTURE_CONTAINER ] } )
            return A.proc.OK_STOP_CURRENT
        }

        if ( info()[STRUCTURE_CONTAINER].id && !Game.getObjectById(info()[STRUCTURE_CONTAINER].id) ) {
            A.res.removeSource(roomName, RESOURCE_ENERGY, info()[STRUCTURE_CONTAINER].id)
            info()[STRUCTURE_CONTAINER].id = null
        }
        // -> 建造 Container
        if ( !info()[STRUCTURE_CONTAINER].id ) {
            const structure = Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, containerPos).filter(s => s.structureType === STRUCTURE_CONTAINER)[0]
            if ( structure ) {
                info()[STRUCTURE_CONTAINER].id = structure.id as Id<StructureContainer>
                A.res.registerSource(roomName, RESOURCE_ENERGY, info()[STRUCTURE_CONTAINER].id )
            } else {
                const constructionSite = Game.rooms[roomName].lookForAt(LOOK_CONSTRUCTION_SITES, containerPos)[0]
                if ( !constructionSite ) Game.rooms[roomName].createConstructionSite( containerPos, STRUCTURE_CONTAINER )
                
                if ( !constructionSite || constructionSite.structureType === STRUCTURE_CONTAINER ) {
                    buildPos = containerPos
                    return [ A.proc.OK_STOP_CUSTOM, 'buildLinkOrContainer' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                }
            }
        }

        // -> 修理 Container
        if ( info()[STRUCTURE_CONTAINER].id && Game.getObjectById(info()[STRUCTURE_CONTAINER].id).hits < Game.getObjectById(info()[STRUCTURE_CONTAINER].id).hitsMax ) {
            repairPos = containerPos
            return [ A.proc.OK_STOP_CUSTOM, 'repairLinkOrContainer' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
        }

        // -> Transfer 到 Container 中
        if ( A.res.query(info()[STRUCTURE_CONTAINER].id, A.res.CAPACITY) > 0 ) {
            const amount = Math.min(A.res.query(info()[STRUCTURE_CONTAINER].id, A.res.CAPACITY), creep.store.getUsedCapacity(RESOURCE_ENERGY))
            assertWithMsg( A.res.request({ id: info()[STRUCTURE_CONTAINER].id, resourceType: A.res.CAPACITY, amount }, `issueHarvestSourceProc -> 219`) === A.proc.OK, `无法申请 ${info()[STRUCTURE_CONTAINER].id} ${amount} 容量.` )
            assertWithMsg( creep.transfer(Game.getObjectById(info()[STRUCTURE_CONTAINER].id), RESOURCE_ENERGY, amount) === OK, `${creep} 无法传输 ${amount} 能量 到 ${info()[STRUCTURE_CONTAINER].id}` )
            log(LOG_DEBUG, `${info()[STRUCTURE_CONTAINER].id} 实有 ${Game.getObjectById(info()[STRUCTURE_CONTAINER].id).store[RESOURCE_ENERGY]}, 应有 ${A.res.query(info()[STRUCTURE_CONTAINER].id, RESOURCE_ENERGY)}.`)
            A.timer.add(Game.time + 1, (id, amount) => A.res.signal(id, RESOURCE_ENERGY, amount), [info()[STRUCTURE_CONTAINER].id, amount], `更新 ${info()[STRUCTURE_CONTAINER].id} 的 energy 数量`)
            return A.proc.OK_STOP_NEXT
        } else return A.proc.OK_STOP_CURRENT // 不能阻塞在容量上, 因为可能要修理 Container
    }

    function buildLinkOrContainer(name: string) {
        const creep = Game.creeps[name]
        /** 检测到错误, 立即释放资源 */
        if ( !creep ) {
            C.cancel(name)
            harvesterName = null
            return [A.proc.STOP_ERR, `Creep [${name}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        }

        /** 即将消亡, 则逃离原位置 */
        if ( creep.ticksToLive < 5 ) {
            creep.travelTo( Game.getObjectById(sourceId), { flee: true, ignoreCreeps: false, range: 2, avoidStructureTypes: [ STRUCTURE_CONTAINER ] } )
            return A.proc.OK_STOP_CURRENT
        }

        const constructionSite = Game.rooms[roomName].lookForAt(LOOK_CONSTRUCTION_SITES, buildPos)[0]

        if ( creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 && constructionSite ) {
            creep.build(constructionSite)
            return A.proc.OK_STOP_CURRENT
        }
        
        buildPos = null
        return A.proc.OK
    }

    function repairLinkOrContainer(name: string) {
        const creep = Game.creeps[name]
        /** 检测到错误, 立即释放资源 */
        if ( !creep ) {
            C.cancel(name)
            harvesterName = null
            return [A.proc.STOP_ERR, `Creep [${name}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        }

        /** 即将消亡, 则逃离原位置 */
        if ( creep.ticksToLive < 5 ) {
            creep.travelTo( Game.getObjectById(sourceId), { flee: true, ignoreCreeps: false, range: 2, avoidStructureTypes: [ STRUCTURE_CONTAINER ] } )
            return A.proc.OK_STOP_CURRENT
        }

        const structure = _.min(Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, repairPos).filter(s => s.hits < s.hitsMax), s => s.hits / s.hitsMax)

        if ( creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 && structure instanceof Structure ) {
            creep.repair(structure)
            return A.proc.OK_STOP_CURRENT
        }

        repairPos = null
        return A.proc.OK
    }

    const pid = A.proc.createProc([
        ['start', () => C.acquire( 'harvester', roomName, name => harvesterName = name, sourcePos )], 
        ['gotoSource', () => gotoSource( harvesterName )], 
        () => buildRepairOrTransfer( harvesterName ), 
        ['JUMP', () => true, 'gotoSource'], 
        ['buildLinkOrContainer', () => buildLinkOrContainer( harvesterName )], 
        ['JUMP', () => true, 'gotoSource'], 
        ['repairLinkOrContainer', () => repairLinkOrContainer( harvesterName )], 
        ['JUMP', () => true, 'gotoSource'], 
    ], `${sourceId} => Harvest`)

    return () => info()[STRUCTURE_LINK].id
}

export function issueHarvestSource( roomName: string ): (() => Id<StructureLink>)[] {
    const room = Game.rooms[roomName]
    assertWithMsg( room && room.controller && room.controller.my, `无法为非自己控制的房间创建 Harvest Source 方法` )
    const sources = Game.rooms[roomName].find(FIND_SOURCES)

    const senders = []
    
    for ( const source of sources )
        if ( sourceUnit.isSourceFit(source.id) )
            senders.push(issueHarvestSourceProc(roomName, source.id, source.pos))
        else
            log(LOG_ERR, `无法为 ${source} 创建采集方法`)
    return senders
}