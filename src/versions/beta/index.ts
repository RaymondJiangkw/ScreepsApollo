import { Apollo as A } from '@/framework/apollo'
import { creepModule as C } from '@/modules/creep'
import { planModule as P, Unit } from '@/modules/plan'
import { mountAllPrototypes } from './prototypes'

/** AI 挂载入口 */
export function mountAll() {
    mountAllPrototypes()
}

function issueUpgradeProc(roomName: string) {
    let workerName = null

    function gotoSource(name: string) {
        const creep = Game.creeps[name]
        /** 检测到错误, 立即释放资源 */
        if ( !creep ) {
            C.cancel(name)
            workerName = null
            return [A.proc.STOP_ERR, `Creep [${name}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        }

        /** 已经装满 Energy */
        if ( creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0 ) return A.proc.OK

        /** 确认房间位置 */
        if ( creep.pos.roomName !== roomName ) {
            creep.moveToRoom(roomName)
            return A.proc.OK_STOP_CURRENT
        }
        
        /** 移动到 Source 位置 */
        const source = creep.pos.findClosestByRange(FIND_SOURCES)
        if ( creep.pos.getRangeTo(source) > 1 ) {
            creep.travelTo(source)
            return A.proc.OK_STOP_CURRENT
        }

        if ( source.energy > 0 ) creep.harvest(source)
        return A.proc.OK_STOP_CURRENT
    }

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
        if ( creep.pos.roomName === roomName && creep.pos.getRangeTo(controller) <= 1 ) return A.proc.OK

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

    return A.proc.createProc([
        () => C.acquire('worker', roomName, name => workerName = name), 
        [ 'gotoSource', () => gotoSource(workerName) ], 
        () => gotoController(workerName), 
        () => upgradeController(workerName), 
        [ 'JUMP', () => true, 'gotoSource' ]
    ], `${roomName} => Upgrade`)
}

function issueHarvestProc(roomName: string) {
    let workerName = null

    function gotoSource(name: string) {
        const creep = Game.creeps[name]
        /** 检测到错误, 立即释放资源 */
        if ( !creep ) {
            C.cancel(name)
            workerName = null
            return [A.proc.STOP_ERR, `Creep [${name}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        }

        /** 已经装满 Energy */
        if ( creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0 ) return A.proc.OK

        /** 确认房间位置 */
        if ( creep.pos.roomName !== roomName ) {
            creep.moveToRoom(roomName)
            return A.proc.OK_STOP_CURRENT
        }
        
        /** 移动到 Source 位置 */
        const source = creep.pos.findClosestByRange(FIND_SOURCES)
        if ( creep.pos.getRangeTo(source) > 1 ) {
            creep.travelTo(source)
            return A.proc.OK_STOP_CURRENT
        }

        if ( source.energy > 0 ) creep.harvest(source)
        return A.proc.OK_STOP_CURRENT
    }

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

        const spawns = Game.rooms[roomName].find<FIND_STRUCTURES, StructureSpawn>(FIND_STRUCTURES, { filter: { structureType: STRUCTURE_SPAWN } }).filter(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0)

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

    const pid = A.proc.createProc([
        () => C.acquire('worker', roomName, name => workerName = name), 
        [ 'gotoSource', () => gotoSource(workerName) ], 
        () => gotoSpawn(workerName), 
        [ 'JUMP', () => true, 'gotoSource' ]
    ], `${roomName} => Harvest`, true)

    A.proc.trigger('watch', () => Game.rooms[roomName].energyAvailable < Game.rooms[roomName].energyCapacityAvailable, [ pid ])
}

/** AI 注册入口 */
export function registerAll() {
    /** 建筑规划 */
    P.register('unit', 'centralSpawn', new Unit([
        [Unit.STRUCTURE_ANY,    STRUCTURE_ROAD,                         STRUCTURE_ROAD,         STRUCTURE_ROAD,                         STRUCTURE_ROAD,         STRUCTURE_ROAD,                         Unit.STRUCTURE_ANY],
        [STRUCTURE_ROAD,        STRUCTURE_EXTENSION,                    STRUCTURE_EXTENSION,    [STRUCTURE_SPAWN, STRUCTURE_RAMPART],   STRUCTURE_EXTENSION,    STRUCTURE_EXTENSION,                    STRUCTURE_ROAD],
        [STRUCTURE_ROAD,        STRUCTURE_EXTENSION,                    Unit.STRUCTURE_ANY,     STRUCTURE_EXTENSION,                    Unit.STRUCTURE_ANY,     STRUCTURE_EXTENSION,                    STRUCTURE_ROAD],
        [STRUCTURE_ROAD,        STRUCTURE_CONTAINER,                    STRUCTURE_EXTENSION,    STRUCTURE_LINK,                         STRUCTURE_EXTENSION,    STRUCTURE_CONTAINER,                    STRUCTURE_ROAD],
        [STRUCTURE_ROAD,        [STRUCTURE_SPAWN, STRUCTURE_RAMPART],   Unit.STRUCTURE_ANY,     STRUCTURE_EXTENSION,                    Unit.STRUCTURE_ANY,     [STRUCTURE_SPAWN, STRUCTURE_RAMPART],   STRUCTURE_ROAD],
        [STRUCTURE_ROAD,        STRUCTURE_EXTENSION,                    STRUCTURE_EXTENSION,    STRUCTURE_EXTENSION,                    STRUCTURE_EXTENSION,    STRUCTURE_EXTENSION,                    STRUCTURE_ROAD],
        [Unit.STRUCTURE_ANY,    STRUCTURE_ROAD,                         STRUCTURE_ROAD,         STRUCTURE_ROAD,                         STRUCTURE_ROAD,         STRUCTURE_ROAD,                         Unit.STRUCTURE_ANY]
    ]), { distanceReferencesFrom: [ STRUCTURE_SPAWN ], distanceReferencesTo: [ STRUCTURE_CONTROLLER, 'mineral', 'sources' ] })

    P.register('unit', 'centralTransfer', new Unit([
        [[STRUCTURE_STORAGE, STRUCTURE_RAMPART],    [STRUCTURE_NUKER, STRUCTURE_RAMPART],   [STRUCTURE_POWER_SPAWN, STRUCTURE_RAMPART]],
        [[STRUCTURE_TERMINAL, STRUCTURE_RAMPART],   STRUCTURE_ROAD,                         STRUCTURE_EXTENSION],
        [STRUCTURE_LINK,                            [STRUCTURE_FACTORY, STRUCTURE_RAMPART], STRUCTURE_ROAD]
    ]), { distanceReferencesFrom: [ STRUCTURE_STORAGE ], distanceReferencesTo: [ STRUCTURE_CONTROLLER, STRUCTURE_SPAWN ] })

    P.register('road', 'centralSpawn => centralTransfer', 'centralSpawn', 'centralTransfer')

    P.register('unit', 'towers', new Unit([ [ [STRUCTURE_TOWER, STRUCTURE_RAMPART] ] ]), { roadRelationship: 'along', distanceReferencesFrom: [ STRUCTURE_TOWER ], distanceReferencesTo: [ STRUCTURE_STORAGE ], amount: 6 })

    P.register('unit', 'extensionUnit', new Unit([
        [STRUCTURE_ROAD, STRUCTURE_EXTENSION, STRUCTURE_EXTENSION, STRUCTURE_EXTENSION, STRUCTURE_ROAD],
        [STRUCTURE_EXTENSION, STRUCTURE_ROAD, STRUCTURE_EXTENSION, STRUCTURE_ROAD, STRUCTURE_EXTENSION],
        [STRUCTURE_EXTENSION, STRUCTURE_EXTENSION, STRUCTURE_ROAD, STRUCTURE_EXTENSION, STRUCTURE_EXTENSION],
        [STRUCTURE_EXTENSION, STRUCTURE_ROAD, STRUCTURE_EXTENSION, STRUCTURE_ROAD, STRUCTURE_EXTENSION],
        [STRUCTURE_ROAD, STRUCTURE_EXTENSION, STRUCTURE_EXTENSION, STRUCTURE_EXTENSION, STRUCTURE_ROAD]
    ]), { distanceReferencesFrom: [ STRUCTURE_ROAD ], distanceReferencesTo: [ STRUCTURE_SPAWN, STRUCTURE_STORAGE ], amount: 2 })
    
    P.register('road', 'centralSpawn => extensionUnit', 'centralSpawn', 'extensionUnit')

    P.register('unit', 'extensions', new Unit([ [STRUCTURE_EXTENSION] ]), { distanceReferencesFrom: [ STRUCTURE_EXTENSION ], distanceReferencesTo: [ STRUCTURE_SPAWN, STRUCTURE_STORAGE ], roadRelationship: 'along', amount: 12 })

    P.register('unit', 'labUnit', new Unit([
        [Unit.STRUCTURE_ANY,                    [STRUCTURE_LAB, STRUCTURE_RAMPART],     [STRUCTURE_LAB, STRUCTURE_RAMPART],     STRUCTURE_ROAD],
        [[STRUCTURE_LAB, STRUCTURE_RAMPART],    [STRUCTURE_LAB, STRUCTURE_RAMPART],     STRUCTURE_ROAD,                         [STRUCTURE_LAB, STRUCTURE_RAMPART]],
        [[STRUCTURE_LAB, STRUCTURE_RAMPART],    STRUCTURE_ROAD,                         [STRUCTURE_LAB, STRUCTURE_RAMPART],     [STRUCTURE_LAB, STRUCTURE_RAMPART]],
        [STRUCTURE_ROAD,                        [STRUCTURE_LAB, STRUCTURE_RAMPART],     [STRUCTURE_LAB, STRUCTURE_RAMPART],     Unit.STRUCTURE_ANY]
    ]), { distanceReferencesFrom: [ STRUCTURE_ROAD ], distanceReferencesTo: [ STRUCTURE_SPAWN ] })

    P.register('road', 'centralSpawn => labUnit', 'centralSpawn', 'labUnit')

    P.register('unit', 'observer', new Unit([ [STRUCTURE_OBSERVER] ]), { distanceReferencesFrom: [ STRUCTURE_OBSERVER ], distanceReferencesTo: [ STRUCTURE_SPAWN ], roadRelationship: 'along'})

    /** @NOTICE 对于第一个房间, `centralSpawn` 的位置需要手工指定 */
    // (Memory as any)._plan = { 'E55S2': { 'centralSpawn': [ new RoomPosition(8, 23, 'E55S2') ] } }

    C.design('worker', {
        body: [ WORK, CARRY, MOVE ], 
        amount: 2, 
    })
    
    for ( const roomName in Game.rooms ) {
        const room = Game.rooms[roomName]
        if ( !room.controller || !room.controller.my ) continue
        /** Room-specific 建筑规划 */
        P.register('road', `${roomName}: centralSpawn => Controller`, 'centralSpawn', room.controller.pos, { range: 1 })
        room.find(FIND_SOURCES).forEach(source => P.register('road', `${roomName}: centralSpawn => Source ${source.id}`, 'centralSpawn', source.pos, { range: 1 }))
        room.find(FIND_MINERALS).forEach(mineral => P.register('road', `${roomName}: centralSpawn => Mineral ${mineral.id}`, 'centralSpawn', mineral.pos, { range: 1 }))

        // 房间可视化进程
        // A.timer.add(Game.time + 1, (roomName, container) => {
        //     if ( container.cache === null )
        //         container.cache = P.visualize(roomName)
        //     else
        //         new RoomVisual(roomName).import(container.cache)
        // }, [roomName, { cache: null }], `可视化房间自动规划布局 ${roomName}`, 1)

        issueUpgradeProc(roomName)
        issueHarvestProc(roomName)
    }
}