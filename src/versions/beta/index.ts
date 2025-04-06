import { Apollo as A } from '@/framework/apollo'
import { creepModule as C } from '@/modules/creep'
import { planModule as P, Unit } from '@/modules/plan'
import { transferModule as T } from '@/modules/transfer'
import { assertWithMsg, calcBodyEffectiveness, getAvailableSurroundingPos, log, LOG_DEBUG, LOG_INFO, stackLog } from '@/utils'
import { registerCommonConstructions } from './config.construction'
import { registerProduction } from './config.production'
import { issueHarvestSource, registerHarvestSource } from './modules/harvestSource'
import { issueCentralTransfer, registerCentralTransfer } from './modules/centralTransfer'
import { isBelongingToQuickEnergyFilling, issueQuickEnergyFill, registerQuickEnergyFill } from './modules/quickEnergyFill'
import { mountAllPrototypes } from './prototypes'

/** AI 挂载入口 */
export function mountAll() {
    mountAllPrototypes()
}

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
            creep.travelTo(target)
            return A.proc.OK_STOP_CURRENT
        }

        if ( target instanceof Source ) {
            if ( target.energy > 0 ) creep.harvest(target)
            else targetId = null
        } else {
            const amount = Math.min(A.res.query(targetId as Id<StorableStructure>, RESOURCE_ENERGY), creep.store.getFreeCapacity(RESOURCE_ENERGY))
            if ( amount > 0 ) {
                assertWithMsg( A.res.request({ id: targetId as Id<StorableStructure>, resourceType: RESOURCE_ENERGY, amount }, 'getEnergy -> 70') === OK )
                assertWithMsg( creep.withdraw(target, RESOURCE_ENERGY, amount) === OK )
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

        creep.travelTo(controller)
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
        () => C.acquire('worker', roomName, name => workerName = name), 
        [ 'gotoSource', gotoSource ], 
        () => gotoController(workerName), 
        () => upgradeController(workerName), 
        [ 'JUMP', () => true, 'gotoSource' ]
    ], `${roomName} => Upgrade`)
}

function issueFillProc(roomName: string) {
    let workerName = null

    function gotoSpawn(name: string) {
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

        /** 确认房间位置 */
        if ( creep.pos.roomName !== roomName ) {
            creep.moveToRoom(roomName)
            return A.proc.OK_STOP_CURRENT
        }

        const spawns = Game.rooms[roomName].find<FIND_STRUCTURES, StructureSpawn | StructureExtension | StructureTower>(FIND_STRUCTURES, { filter: s => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && !isBelongingToQuickEnergyFilling(s.pos) })

        if ( spawns.length === 0 ) {
            /** 此时, 本进程无用, 释放资源并休眠 */
            C.release(name)
            workerName = null
            return A.proc.STOP_SLEEP
        }
        const spawn = _.min(spawns, s => creep.pos.getRangeTo(s))

        /** 已经接近 Spawn */
        if ( creep.pos.roomName === roomName && creep.pos.getRangeTo(spawn) <= 1 ) {
            creep.transfer(spawn, RESOURCE_ENERGY)
            return A.proc.OK_STOP_NEXT
        }

        creep.travelTo(spawn)
        return A.proc.OK_STOP_CURRENT
    }

    const gotoSource = getEnergy(roomName, () => workerName, name => workerName = name)

    const pid = A.proc.createProc([
        () => C.acquire('worker', roomName, name => workerName = name), 
        [ 'gotoSource', gotoSource ], 
        () => gotoSpawn(workerName), 
        [ 'JUMP', () => true, 'gotoSource' ]
    ], `${roomName} => Fill`, true)

    A.proc.trigger('watch', () => typeof Game.rooms[roomName].energyAvailable !== "number"? false : (Game.rooms[roomName].energyAvailable < Game.rooms[roomName].energyCapacityAvailable), [ pid ])
}

function issueBuildProc(roomName: string) {
    let workerName = null
    let restart = false
    let constructionSite: {
        structureType: StructureConstant;
        pos: RoomPosition;
    } = null

    function getConstructionSite() {
        /** 需要建造的地方不为空时, 不再重复请求 - Creep 消亡后, 进程重启时使用 */
        if ( constructionSite !== null ) return A.proc.OK

        constructionSite = P.recommend( roomName, restart )
        restart = false
        if ( constructionSite === null ) {
            log(LOG_INFO, `${roomName} 暂无需要建造的建筑`)
            return A.proc.STOP_SLEEP
        }

        log(LOG_INFO, `${roomName} 规划的下一个建筑地点为 ${constructionSite.structureType} (${constructionSite.pos})`)
        /** 判断是否已经存在 */
        const target = Game.rooms[roomName].lookForAt(LOOK_CONSTRUCTION_SITES, constructionSite.pos).filter(s => s.structureType === constructionSite.structureType)[0]
        if ( !target )
            assertWithMsg(Game.rooms[roomName].createConstructionSite(constructionSite.pos, constructionSite.structureType) === OK, `推荐的建筑 ${constructionSite.structureType} (${constructionSite.pos}) 应当一定可建造, 但是不是`)
        return A.proc.OK_STOP_NEXT
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

        if ( creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 ) return A.proc.OK

        if ( creep.pos.roomName === roomName && creep.pos.getRangeTo(constructionSite.pos) <= 3 ) {
            const target = Game.rooms[roomName].lookForAt(LOOK_CONSTRUCTION_SITES, constructionSite.pos)[0]
            if ( target ) creep.build(target)
            else {
                C.release(name)
                workerName = null
                constructionSite = null
                return [ A.proc.OK_STOP_CUSTOM, 'getConstructionSite' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            }
        } else creep.travelTo(constructionSite.pos)

        return A.proc.OK_STOP_CURRENT
    }

    const gotoSource = getEnergy(roomName, () => workerName, name => workerName = name)

    const pid = A.proc.createProc([
        ['getConstructionSite', () => getConstructionSite()], 
        () => C.acquire('worker', roomName, name => workerName = name), 
        ['gotoSource', gotoSource], 
        () => buildConstructionSite(workerName), 
        [ 'JUMP', () => true, 'gotoSource' ]
    ], `${roomName} => Build`)

    const controllerLevelWatcher = {
        lastValue: Game.rooms[roomName].controller.level, 
        currentValue: Game.rooms[roomName].controller.level, 
    };
    /** 在升级时触发 */
    (controllerLevelWatcher => A.proc.trigger('watch', () => {
        controllerLevelWatcher.lastValue = controllerLevelWatcher.currentValue
        controllerLevelWatcher.currentValue = Game.rooms[roomName].controller.level
        return restart = restart || controllerLevelWatcher.lastValue !== controllerLevelWatcher.currentValue
    }, [ pid ]))(controllerLevelWatcher)
    /** 在有建筑被摧毁时触发 */
    A.proc.trigger('watch', () => {
        if ( !(roomName in Game.rooms) ) return false
        if ( Game.rooms[roomName].getEventLog().filter(e => e.event === EVENT_OBJECT_DESTROYED && e.data.type !== 'creep' ).length > 0 ) {
            // 建筑被摧毁时, 重新开始规划.
            // 因为可能建筑布局一样, 然后该房间已经被注册被完整的建造完成了.
            stackLog(`${Game.time}: 发现有建筑被摧毁`)
            restart = true;
            return true;
        } else return false;
    }, [ pid ])

    let lastTriggerTick = Game.time
    let lastRampartMinHit = _.min(Game.rooms[roomName].find(FIND_STRUCTURES, { filter: { structureType: STRUCTURE_RAMPART } }).map(v => v.hits))
    /** 定时触发 Build */
    // Rampart Decay 不触发建筑被摧毁事件.
    // 有不同的方法来解决建筑生命周期追踪, 以为是否需要重建服务.
    // 但是开销相对较大, 不如定时重新触发.
    A.proc.trigger('watch', () => {
        if ( !(roomName in Game.rooms) ) return false
        if ( Game.time - lastTriggerTick > Math.max(lastRampartMinHit / RAMPART_DECAY_AMOUNT * RAMPART_DECAY_TIME, CREEP_LIFE_TIME) ) {
            lastTriggerTick = Game.time
            lastRampartMinHit = _.min(Game.rooms[roomName].find(FIND_STRUCTURES, { filter: { structureType: STRUCTURE_RAMPART } }).map(v => v.hits))
            restart = true
            return true
        } else return false
    }, [ pid ])
}

function issueRepairProc(roomName: string) {
    let workerName = null
    let repairedPos: RoomPosition = null

    function getRepairedPos() {
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
        } else creep.travelTo(repairedPos)

        return A.proc.OK_STOP_CURRENT
    }

    const gotoSource = getEnergy(roomName, () => workerName, name => workerName = name)

    const pid = A.proc.createProc([
        ['getRepairedPos', () => getRepairedPos()], 
        () => C.acquire('worker', roomName, name => workerName = name), 
        [ 'gotoSource', gotoSource ], 
        () => gotoStructure(workerName), 
        [ 'JUMP', () => true, 'getRepairedPos' ]
    ], `${roomName} => Repair`)

    let lastTriggerTick = Game.time
    /** Repair 定时触发 */
    A.proc.trigger('watch', () => {
        if ( Game.time - lastTriggerTick > RAMPART_DECAY_TIME / 2 ) {
            lastTriggerTick = Game.time
            return true
        } else return false
    }, [ pid ])
}

function issuePaintProc(roomName: string) {
    let workerName = null
    let repairedPos: RoomPosition = null

    function getRepairedPos() {
        const structure = _.min(Game.rooms[roomName].find(FIND_STRUCTURES, { filter: s => s.hits < s.hitsMax && (s.structureType === STRUCTURE_RAMPART || s.structureType === STRUCTURE_WALL) }), s => s.hits / s.hitsMax)
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

        if ( creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 ) {
            C.release(name)
            workerName = null
            return A.proc.OK
        }
        
        if ( creep.pos.roomName === roomName && creep.pos.getRangeTo(repairedPos) <= 3 ) {
            const structure = _.min(Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, repairedPos).filter(s => s.hits < s.hitsMax && (s.structureType === STRUCTURE_RAMPART || s.structureType === STRUCTURE_WALL)), s => s.hits / s.hitsMax)
            if ( structure instanceof Structure ) creep.repair(structure)
            else {
                C.release(name)
                workerName = null
                repairedPos = null
                return [ A.proc.OK_STOP_CUSTOM, 'getRepairedPos' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            }
        } else creep.travelTo(repairedPos)

        return A.proc.OK_STOP_CURRENT
    }

    const gotoSource = getEnergy(roomName, () => workerName, name => workerName = name)

    const pid = A.proc.createProc([
        ['getRepairedPos', () => getRepairedPos()], 
        () => C.acquire('worker', roomName, name => workerName = name), 
        [ 'gotoSource', gotoSource ], 
        () => gotoStructure(workerName), 
        [ 'JUMP', () => true, 'getRepairedPos' ]
    ], `${roomName} => Paint`)

    let lastTriggerTick = Game.time
    /** Repair 定时触发 */
    A.proc.trigger('watch', () => {
        if ( Game.time - lastTriggerTick > RAMPART_DECAY_TIME / 2 ) {
            lastTriggerTick = Game.time
            return true
        } else return false
    }, [ pid ])
}

function issueTowerProc(roomName: string) {
    A.proc.createProc([
        () => P.exist(roomName, 'towers', 'tower'), 
        () => {
            if ( !Game.rooms[roomName] ) return [A.proc.STOP_ERR, `${roomName} 房间无视野`] as [ typeof A.proc.STOP_ERR, string ]
            const towers = Game.rooms[roomName].find<FIND_STRUCTURES, StructureTower>(FIND_STRUCTURES, { filter: { structureType: STRUCTURE_TOWER } })
            if ( towers.length === 0 ) return [A.proc.STOP_ERR, `${roomName} 房间无可用 Tower`] as [ typeof A.proc.STOP_ERR, string ]

            const enemies = Game.rooms[roomName].find(FIND_HOSTILE_CREEPS)
            // const ramparts = Game.rooms[roomName].find(FIND_STRUCTURES, { filter: { structureType: STRUCTURE_RAMPART } }).filter(s => s.hits < 1e4)

            towers.forEach(tower => {
                if ( A.res.query(tower.id, RESOURCE_ENERGY) >= TOWER_ENERGY_COST  ) {
                    if ( enemies.length > 0 ) {
                        assertWithMsg( A.res.request({ id: tower.id, resourceType: RESOURCE_ENERGY, amount: TOWER_ENERGY_COST }, 'issueTowerProc -> 396') === A.proc.OK )
                        A.timer.add(Game.time + 1, id => A.res.signal(id, A.res.CAPACITY, TOWER_ENERGY_COST), [ tower.id ], `更新塔 ${tower.id} 的容量`)
                        tower.attack(enemies[0])
                    }
                    // } else if ( ramparts.length > 0 ) {
                    //     assertWithMsg( A.res.request({ id: tower.id, resourceType: RESOURCE_ENERGY, amount: TOWER_ENERGY_COST }) === A.proc.OK )
                    //     A.timer.add(Game.time + 1, id => A.res.signal(id, A.res.CAPACITY, TOWER_ENERGY_COST), [ tower.id ], `更新塔 ${tower.id} 的容量`)
                    //     tower.repair( _.min(ramparts, rampart => rampart.hits) )
                    // }
                }
            })

            towers.forEach(tower => {
                if ( A.res.query(tower.id, A.res.CAPACITY) >= TOWER_CAPACITY / 2 ) {
                    const requestedSource = A.res.requestSource(roomName, RESOURCE_ENERGY, CARRY_CAPACITY, tower.pos, false)
                    if ( requestedSource.code === A.proc.OK ) {
                        const sourceId = requestedSource.id
                        const amount = Math.min(A.res.query(tower.id, A.res.CAPACITY), A.res.query(sourceId, RESOURCE_ENERGY))
                        if ( amount > 0 ) {
                            assertWithMsg( A.res.request({ id: tower.id, resourceType: A.res.CAPACITY, amount }) === A.proc.OK, `issueTowerProc -> 415` )
                            assertWithMsg( A.res.request({ id: sourceId, resourceType: RESOURCE_ENERGY, amount }) === A.proc.OK, `issueTowerProc -> 416` )
                            T.transfer( sourceId, tower.id, RESOURCE_ENERGY, amount )
                        }
                    }
                }
            })

            return A.proc.OK_STOP_CURRENT
        }
    ], `${roomName} => Tower`)
}

/** AI 注册入口 */
export function registerAll() {
    /** 重置 Planning */
    // (Memory as any)._plan = {}

    /** 建筑规划 */
    registerCommonConstructions()
    /** 生产规划 */
    registerProduction()
    /** Source Harvest 模块 */
    registerHarvestSource()
    /** Quick Energy Filling 模块 */
    registerQuickEnergyFill()
    /** Central Transfer 模块 */
    registerCentralTransfer()

    C.design('worker', {
        body: {
            1: [ CARRY, WORK, MOVE ], 
            3: [ CARRY, CARRY, WORK, WORK, MOVE, MOVE ]
        }, 
        amount: 5, 
    });

    /** 重置 Harvest */
    // (Memory as any)._source2structure = {}
    
    for ( const roomName in Game.rooms ) {
        const room = Game.rooms[roomName]
        if ( !room.controller || !room.controller.my ) continue
        /** 建筑规划 */
        P.register('road', `${roomName}: centralSpawn => Controller`, 'centralSpawn', room.controller.pos, { range: 1 })
        room.find(FIND_SOURCES).forEach(source => P.register('road', `${roomName}: centralSpawn => Source ${source.id}`, 'centralSpawn', source.pos, { range: 1 }))
        room.find(FIND_MINERALS).forEach(mineral => {
            P.register('road', `${roomName}: centralSpawn => Mineral ${mineral.id}`, 'centralSpawn', mineral.pos, { range: 1 })
            P.register('unit', `${roomName}: extractor`, new Unit([ [STRUCTURE_EXTRACTOR] ], { 'extractor': [ [0, 0] ] }), { on: mineral.pos, freeFromProtect: true })
            P.register('unit', `${roomName}: mineral's container`, new Unit([ [STRUCTURE_CONTAINER] ], { 'container': [ [0, 0] ] }), { aroundRelationship: mineral.pos, freeFromProtect: true })
        })

        // 房间可视化进程
        A.timer.add(Game.time + 1, (roomName, container) => {
            if ( container.cache === null )
                container.cache = P.visualize(roomName)
            else
                new RoomVisual(roomName).import(container.cache)
        }, [roomName, { cache: null }], `可视化房间自动规划布局 ${roomName}`, 1)

        /** 资源状态输出 */
        // A.timer.add(Game.time + 1, roomName => A.res.print(roomName), [roomName], `输出房间 ${roomName} 资源状态`, 1)

        issueUpgradeProc(roomName)
        issueFillProc(roomName)
        issueBuildProc(roomName)
        issueRepairProc(roomName)
        issuePaintProc(roomName)
        issueTowerProc(roomName)

        /** Source Harvest 模块 */
        const targetLinkLists: Id<StructureLink>[] = [] // Source 处 Link 传递能量目标 Link 列表 & 信号量
        const hasTargetLinkSignal = A.proc.signal.createSignal(0)
        issueHarvestSource(roomName, () => targetLinkLists, hasTargetLinkSignal)
        /** Quick Energy Filling 模块 */
        issueQuickEnergyFill(roomName, () => targetLinkLists, hasTargetLinkSignal)
        /** Central Transfer 模块 */
        issueCentralTransfer(roomName, () => targetLinkLists, hasTargetLinkSignal)

        /** 监测 TombStone */
        // ...
    }
}