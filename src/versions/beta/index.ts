import { Apollo as A } from '@/framework/apollo'
import { creepModule as C } from '@/modules/creep'
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

        if ( spawns.length === 0 ) return A.proc.OK_STOP_CURRENT
        const spawn = _.min(spawns, s => creep.pos.getRangeTo(s))

        /** 已经接近 Spawn */
        if ( creep.pos.roomName === roomName && creep.pos.getRangeTo(spawn) <= 1 ) {
            creep.transfer(spawn, RESOURCE_ENERGY)
            return A.proc.OK_STOP_NEXT
        }

        creep.travelTo(spawn)
        return A.proc.OK_STOP_CURRENT
    }

    return A.proc.createProc([
        () => C.acquire('worker', roomName, name => workerName = name), 
        [ 'gotoSource', () => gotoSource(workerName) ], 
        () => gotoSpawn(workerName), 
        [ 'JUMP', () => true, 'gotoSource' ]
    ], `${roomName} => Harvest`)
}

/** AI 注册入口 */
export function registerAll() {
    C.design('worker', {
        body: [ WORK, CARRY, MOVE ], 
        amount: 2, 
    })
    
    for ( const roomName in Game.rooms ) {
        issueUpgradeProc(roomName)
        issueHarvestProc(roomName)
    }
}