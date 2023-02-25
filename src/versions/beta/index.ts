import { Apollo as A } from '@/framework/apollo'
import { creepModule as C } from '@/modules/creep'
import { planModule as P, Unit } from '@/modules/plan'
import { assertWithMsg, getAvailableSurroundingPos, log, LOG_DEBUG, LOG_INFO } from '@/utils'
import { registerCommonConstructions } from './config.construction'
import { issueHarvestSource, registerHarvestSource } from './modules/harvestSource'
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
        assertWithMsg( typeof name === 'string' )
        const creep = Game.creeps[name]
        /** 检测到错误, 立即释放资源 */
        if ( !creep ) {
            C.cancel(name)
            setWorkerName(null)
            return [A.proc.STOP_ERR, `Creep [${name}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        }

        /** 已经装满 Energy */
        if ( creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0 ) {
            targetId = null
            return A.proc.OK
        }

        /** 确认房间位置 */
        if ( creep.pos.roomName !== roomName ) {
            creep.moveToRoom(roomName)
            return A.proc.OK_STOP_CURRENT
        }

        if ( targetId === null ) {
            targetId = A.res.requestSource(roomName, RESOURCE_ENERGY, creep.pos).id
            if ( !targetId || A.res.qeury(targetId, RESOURCE_ENERGY) <= 0 ) {
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
            const amount = Math.min(A.res.qeury(targetId as Id<StorableStructure>, RESOURCE_ENERGY), creep.store.getFreeCapacity(RESOURCE_ENERGY))
            if ( amount > 0 ) {
                assertWithMsg( A.res.request({ id: targetId as Id<StorableStructure>, resourceType: RESOURCE_ENERGY, amount }) === OK )
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

function issueHarvestProc(roomName: string) {
    let workerName = null

    function gotoSpawn(name: string) {
        const creep = Game.creeps[name]
        /** 检测到错误, 立即释放资源 */
        if ( !creep ) {
            C.cancel(name)
            workerName = null
            return [A.proc.STOP_ERR, `Creep [${name}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        }

        /** 确认房间位置 */
        if ( creep.pos.roomName !== roomName ) {
            creep.moveToRoom(roomName)
            return A.proc.OK_STOP_CURRENT
        }

        const spawns = Game.rooms[roomName].find<FIND_STRUCTURES, StructureSpawn | StructureExtension | StructureTower>(FIND_STRUCTURES, { filter: s => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION || s.structureType === STRUCTURE_TOWER) && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && !isBelongingToQuickEnergyFilling(s.pos) })

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
    ], `${roomName} => Harvest`, true)

    A.proc.trigger('watch', () => Game.rooms[roomName].energyAvailable < Game.rooms[roomName].energyCapacityAvailable, [ pid ])
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
        return Game.rooms[roomName].getEventLog().filter(e => e.event === EVENT_OBJECT_DESTROYED && e.data.type !== 'creep' ).length > 0
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

    function getPaintedPos() {
        const structure = _.min(Game.rooms[roomName].find(FIND_STRUCTURES, { filter: s => s.hits < s.hitsMax && (s.structureType === STRUCTURE_RAMPART || s.structureType === STRUCTURE_WALL) }), s => s.hits / s.hitsMax)
        if ( !(structure instanceof Structure) ) return A.proc.STOP_SLEEP
        else log(LOG_DEBUG, `发现需要刷墙的建筑 ${structure}`)
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

        if ( creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 ) {
            C.release(name)
            workerName = null
            return A.proc.OK
        }

        const structure = _.min(Game.rooms[roomName].find(FIND_STRUCTURES, { filter: s => s.hits < s.hitsMax && (s.structureType === STRUCTURE_RAMPART || s.structureType === STRUCTURE_WALL) }), s => s.hits / s.hitsMax)

        if ( !(structure instanceof Structure) ) {
            C.release(name)
            workerName = null
            return [ A.proc.OK_STOP_CUSTOM, 'getPaintedPos' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
        }
        
        if ( creep.pos.roomName === roomName && creep.pos.getRangeTo(structure) <= 3 ) creep.repair(structure)
        else creep.travelTo(structure)

        return A.proc.OK_STOP_CURRENT
    }

    const gotoSource = getEnergy(roomName, () => workerName, name => workerName = name)

    const pid = A.proc.createProc([
        ['getPaintedPos', () => getPaintedPos()], 
        () => C.acquire('worker', roomName, name => workerName = name), 
        [ 'gotoSource', gotoSource ], 
        () => gotoStructure(workerName), 
        [ 'JUMP', () => true, 'getPaintedPos' ]
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
            const towers = Game.rooms[roomName].find<FIND_STRUCTURES, StructureTower>(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER })
            if ( towers.length === 0 ) return [A.proc.STOP_ERR, `${roomName} 房间无可用 Tower`] as [ typeof A.proc.STOP_ERR, string ]
            
            for ( const creep of Game.rooms[roomName].find(FIND_HOSTILE_CREEPS) )
                towers.forEach(t => t.attack(creep))
            
            for ( const creep of Game.rooms[roomName].find(FIND_MY_CREEPS) )
                if ( creep.hits < creep.hitsMax )
                    towers.forEach(t => t.heal(creep))
            
            return A.proc.OK_STOP_CURRENT
        }
    ], `${roomName} => Tower`)
}

/** AI 注册入口 */
export function registerAll() {
    /** 建筑规划 */
    registerCommonConstructions()
    /** Source Harvest 模块 */
    registerHarvestSource()
    /** Quick Energy Filling 模块 */
    registerQuickEnergyFill()

    C.design('worker', {
        body: [ WORK, CARRY, MOVE ], 
        amount: 5, 
    })
    
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
        A.timer.add(Game.time + 1, roomName => A.res.print(roomName), [roomName], `输出房间 ${roomName} 资源状态`, 1)

        issueUpgradeProc(roomName)
        issueHarvestProc(roomName)
        issueBuildProc(roomName)
        issueRepairProc(roomName)
        issuePaintProc(roomName)
        issueTowerProc(roomName)
        
        /** Source Harvest 模块 */
        issueHarvestSource(roomName, A.proc.signal.createSignal(0), () => [])
        /** Quick Energy Filling 模块 */
        issueQuickEnergyFill(roomName)
    }
}