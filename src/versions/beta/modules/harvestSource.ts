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
            2: [ CARRY, WORK, WORK, MOVE ], 
            3: [ CARRY, WORK, WORK, WORK, MOVE ], 
            4: [ CARRY, WORK, WORK, WORK, WORK, WORK, MOVE ]
        }
    })
}

function issueHarvestSourceProc(roomName: string, sourceId: Id<Source>, sourcePos: RoomPosition, getDestinationLinks: () => Id<StructureLink>[], destinationLinksReadySignalId: string) {
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
        if ( creep.ticksToLive < 3 ) {
            creep.travelTo( source, { flee: true, ignoreCreeps: false, range: 1, avoidStructureTypes: [ STRUCTURE_CONTAINER ] } )
            return A.proc.OK_STOP_CURRENT
        }
        
        if ( source.energy === 0 ) {
            // 无能量时, 离开工作位置, 同样睡眠
            if ( creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 ) {
                // creep.travelTo( source, { flee: true, ignoreCreeps: false, avoidStructureTypes: [ STRUCTURE_CONTAINER ] } )
                return A.proc.STOP_SLEEP
            } else return A.proc.OK_STOP_NEXT
        }

        /** 移动到 Container 的位置 */
        if ( creep.pos.getRangeTo(info()[STRUCTURE_CONTAINER].pos.x, info()[STRUCTURE_CONTAINER].pos.y) > 0 ) {
            creep.travelTo(new RoomPosition(info()[STRUCTURE_CONTAINER].pos.x, info()[STRUCTURE_CONTAINER].pos.y, roomName))
            return A.proc.OK_STOP_CURRENT
        }

        /** 采集满 或 无可采集 或 采集溢出 */
        if ( creep.store.getFreeCapacity(RESOURCE_ENERGY) < calcBodyEffectiveness(creep.body, WORK, 'harvest', HARVEST_POWER) || source.energy === 0 ) return A.proc.OK

        creep.harvest(source)

        return A.proc.OK_STOP_CURRENT
    }

    let buildPos: RoomPosition = null
    let repairPos: RoomPosition = null
    const linkSignalId = A.proc.signal.createSignal(info()[STRUCTURE_LINK].id ? 1 : 0)
    const linkHasEnergySignalId = A.proc.signal.createSignal(info()[STRUCTURE_LINK].id && Game.getObjectById(info()[STRUCTURE_LINK].id) && Game.getObjectById(info()[STRUCTURE_LINK].id).store.getUsedCapacity(RESOURCE_ENERGY) > 0 ? 1 : 0)

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
            if ( A.proc.signal.getValue(linkSignalId) === 1 )
                A.proc.signal.Swait({ signalId: linkSignalId, lowerbound: 1, request: 1 })
            
            if ( A.proc.signal.getValue(linkHasEnergySignalId) === 1 )
                A.proc.signal.Swait({ signalId: linkHasEnergySignalId, lowerbound: 1, request: 1 })
        }
        // -> 建造 Link
        if ( !info()[STRUCTURE_LINK].id && Game.rooms[roomName].controller.level >= 6 ) {
            const structure = Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, linkPos).filter(s => s.structureType === STRUCTURE_LINK)[0]
            if ( structure ) {
                info()[STRUCTURE_LINK].id = structure.id as Id<StructureLink>
                A.proc.signal.Ssignal({ signalId: linkSignalId, request: 1 })
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
                if ( link.cooldown > 0 ) return [ A.proc.STOP_SLEEP, link.cooldown ] as [ typeof A.proc.STOP_SLEEP, number ]
                else return A.proc.OK_STOP_CURRENT
            } else {
                if ( link.store.getUsedCapacity(RESOURCE_ENERGY) === 0 )
                    A.timer.add(Game.time + 1, signalId => A.proc.signal.Ssignal({ signalId, request: 1 }), [ linkHasEnergySignalId ], `更新 ${link} 包含能量信号量`)

                creep.transfer(link, RESOURCE_ENERGY)
                return [ A.proc.OK_STOP_CUSTOM, 'gotoSource' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            }
        }

        // Link 无法满足的情况下, 建造 Container
        const containerPos = new RoomPosition(info()[STRUCTURE_CONTAINER].pos.x, info()[STRUCTURE_CONTAINER].pos.y, roomName)

        /** 即将消亡, 则逃离原位置 */
        if ( creep.ticksToLive < 3 || creep.hits < creep.hitsMax ) {
            creep.travelTo( containerPos, { flee: true, ignoreCreeps: false, range: 1, avoidStructureTypes: [ STRUCTURE_CONTAINER ] } )
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

        // 触发能量贮存
        if ( A.res.query(info()[STRUCTURE_CONTAINER].id, RESOURCE_ENERGY) > CONTAINER_CAPACITY / 2 && Game.rooms[roomName].storage && A.res.query(Game.rooms[roomName].storage.id, A.res.CAPACITY) > CONTAINER_CAPACITY / 4 && A.res.query(Game.rooms[roomName].storage.id, RESOURCE_ENERGY) < getMaintainAmount(RESOURCE_ENERGY) ) {
            const amount = CONTAINER_CAPACITY / 4
            assertWithMsg( A.res.request({ id: info()[STRUCTURE_CONTAINER].id, resourceType: RESOURCE_ENERGY, amount }) === A.proc.OK )
            assertWithMsg( A.res.request({ id: Game.rooms[roomName].storage.id, resourceType: A.res.CAPACITY, amount }) === A.proc.OK )
            T.transfer( Game.getObjectById(info()[STRUCTURE_CONTAINER].id), Game.rooms[roomName].storage, RESOURCE_ENERGY, amount, { priority: T.PRIORITY_CASUAL } )
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
        if ( creep.ticksToLive < 3 ) {
            creep.travelTo( repairPos, { flee: true, ignoreCreeps: false, range: 1, avoidStructureTypes: [ STRUCTURE_CONTAINER ] } )
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
        if ( creep.ticksToLive < 3 ) {
            creep.travelTo( repairPos, { flee: true, ignoreCreeps: false, range: 1, avoidStructureTypes: [ STRUCTURE_CONTAINER ] } )
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
    /** 能量生出后触发 */
    A.proc.trigger('watch', () => {
        const source = Game.getObjectById(sourceId)
        if ( source ) return source.energy > 0
        else return false
    }, [ pid ])

    /** Link 行为 */
    function runLink() {
        const linkId = info()[STRUCTURE_LINK].id
        if ( !linkId || !Game.getObjectById(linkId) ) {
            if ( A.proc.signal.getValue(linkSignalId) === 1 )
                A.proc.signal.Swait({ signalId: linkSignalId, lowerbound: 1, request: 1 })
            return [A.proc.STOP_ERR, `Link [${linkId}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        }
        const link = Game.getObjectById(linkId)
        if ( link.cooldown > 0 ) return [A.proc.STOP_SLEEP, link.cooldown ] as [ typeof A.proc.STOP_SLEEP, number ]
        if ( link.store.getUsedCapacity(RESOURCE_ENERGY) === 0 ) {
            assertWithMsg( A.proc.signal.Swait({ signalId: linkHasEnergySignalId, lowerbound: 1, request: 1 }) === A.proc.OK, `运行 Source [${sourceId}] 的 Link ${linkId} 时, 发现无能源可用, 则应当更新信号量成功` )
            return [ A.proc.OK_STOP_CUSTOM, 'Swait' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
        }

        if ( getDestinationLinks().filter(id => !!Game.getObjectById(id)).length === 0 ) {
            return [A.proc.STOP_ERR, `Link [${linkId}] 无法找到目标 Link`] as [ typeof A.proc.STOP_ERR, string ]
        }
        const destinationLinkIds = getDestinationLinks().filter(id => !!Game.getObjectById(id) && A.res.query(id, A.res.CAPACITY) > 0)
        
        if ( destinationLinkIds.length > 0 ) {
            const choice = _.min( destinationLinkIds, id => A.res.query(id, RESOURCE_ENERGY) )
            const amount = Math.max(Math.min(Math.floor(link.store.getUsedCapacity(RESOURCE_ENERGY) / (1 + LINK_LOSS_RATIO)), A.res.query(choice, A.res.CAPACITY)), 1) // 未验证为 1 的情况下的行为
            assertWithMsg(A.res.request({ id: choice, resourceType: A.res.CAPACITY, amount }, `issueHarvestSourceProc -> 313`) === A.proc.OK, `无法申请 ${choice} ${amount} 容量.`)
            assertWithMsg(link.transferEnergy(Game.getObjectById(choice), amount) === OK, `${link} 无法传输 ${amount} 能量到 ${choice}.`)
            A.timer.add(Game.time + 1, (id, amount) => A.res.signal(id, RESOURCE_ENERGY, amount), [choice, amount], `Link ${linkId} -> Link ${choice} 后能量更新`)
            return A.proc.OK_STOP_CURRENT
        } else return A.proc.OK_STOP_CURRENT // [ A.proc.OK_STOP_CUSTOM, 'CapacitySwait' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
    }

    A.proc.createProc([
        ['Swait', () => A.proc.signal.Swait({ signalId: linkSignalId, lowerbound: 1, request: 0 }, { signalId: destinationLinksReadySignalId, lowerbound: 1, request: 0 }, { signalId: linkHasEnergySignalId, lowerbound: 1, request: 0 })], 
        // 与关系信号量 无法实现 存在某一有空余容量的 Link 即继续的条件
        // ['CapacitySwait', () => getDestinationLinks().filter(id => !!Game.getObjectById(id)).length === 0 ? [A.proc.STOP_ERR, `Link [${info()[STRUCTURE_LINK].id}] 无法找到目标 Link`] as [ typeof A.proc.STOP_ERR, string ] : A.res.request(getDestinationLinks().filter(id => !!Game.getObjectById(id)).map(id => ({ id, resourceType: A.res.CAPACITY, amount: { lowerbound: 1, request: 0 } })))], 
        () => runLink()
    ], `${sourceId} => Link`)
}

export function issueHarvestSource( roomName: string, getDestinationLinks: () => Id<StructureLink>[], destinationLinksReadySignalId: string) {
    const room = Game.rooms[roomName]
    assertWithMsg( room && room.controller && room.controller.my, `无法为非自己控制的房间创建 Harvest Source 方法` )
    const sources = Game.rooms[roomName].find(FIND_SOURCES)
    
    for ( const source of sources )
        if ( sourceUnit.isSourceFit(source.id) )
            issueHarvestSourceProc(roomName, source.id, source.pos, getDestinationLinks,  destinationLinksReadySignalId)
        else
            log(LOG_ERR, `无法为 ${source} 创建采集方法`)
}