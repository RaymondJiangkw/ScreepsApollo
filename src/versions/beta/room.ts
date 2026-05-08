/** 发出进程以维护房间 */
import { Apollo as A } from '@/framework/apollo'
import { creepModule as C } from '@/modules/creep'
import { planModule as P } from '@/modules/plan'
import { marketModule as M } from './modules/market'
import { assertWithMsg, getFileNameAndLineNumber } from '@/utils'
import { isBelongingToQuickEnergyFilling, issueQuickEnergyFill } from './modules/quickEnergyFill'
import { registerCustomConstructions } from './config.construction'
import { issueHarvestSource } from './modules/harvestSource'
import { issueCentralTransfer } from './modules/centralTransfer'
import { issueDefendProc } from './modules/roomDefense'
import { issueFastUpgrade } from './modules/fastUpgrade'
import { issueLinkManage } from './modules/linkManage'
import { registerStoreForRoom } from './modules/registerStore'
import { issueHarvestMineral } from './modules/harvestMineral'
import { issueRepairStructure } from './modules/repairStructure'
import { issueBuildProc } from './modules/buildStructure'
import { issuePaintProc } from './modules/paintRampart'
import { getEnergy } from './modules/shared'

function issueFillProc(roomName: string) {
    let workerName = null

    function gotoSpawn(name: string) {
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

        const spawns = Game.rooms[roomName].find<FIND_STRUCTURES, StructureSpawn | StructureExtension | StructureTower>(FIND_STRUCTURES, { filter: s => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && !isBelongingToQuickEnergyFilling(s.pos) })

        if ( spawns.length === 0 ) {
            /** 此时, 本进程无用, 释放资源并休眠 */
            C.release(name)
            workerName = null
            return A.proc.STOP_SLEEP
        }

        if ( creep.store.getUsedCapacity(RESOURCE_ENERGY) <= 0 ) return A.proc.OK

        const spawn = _.min(spawns, s => creep.pos.getRangeTo(s))

        /** 已经接近 Spawn */
        if ( creep.pos.roomName === roomName && creep.pos.getRangeTo(spawn) <= 1 ) {
            creep.transfer(spawn, RESOURCE_ENERGY)
            return A.proc.OK_STOP_CURRENT
        }

        creep.moveTo(spawn)
        return A.proc.OK_STOP_CURRENT
    }

    const gotoSource = getEnergy(roomName, () => workerName, name => workerName = name)

    const pid = A.proc.createProc([
        () => {
            if ( !!Game.rooms[roomName] && Game.rooms[roomName].energyAvailable < Game.rooms[roomName].energyCapacityAvailable ) return A.proc.OK
            else return A.proc.STOP_SLEEP
        }, 
        () => C.acquire('worker', roomName, name => workerName = name), 
        [ 'gotoSource', gotoSource ], 
        () => gotoSpawn(workerName), 
        [ 'JUMP', () => true, 'gotoSource' ]
    ], `${roomName} => Fill`)

    A.proc.trigger('after', Spawn.prototype, 'spawnCreep', (returnValue, spawn: StructureSpawn, ...args) => {
        if ( returnValue === OK && spawn.pos.roomName === roomName )
            return [ pid ]
        return []
    })
}

export function registerForRoom() {
    C.design('worker', {
        body: {
            1: [ CARRY, WORK, MOVE ], 
            3: [ CARRY, CARRY, WORK, WORK, MOVE, MOVE ], 
            5: [ CARRY, CARRY, CARRY, WORK, WORK, WORK, MOVE, MOVE, MOVE ]
        }, 
        amount: 5, 
    })
}

export function issueForRoom(roomName: string) {
    /** @NOTICE 需要房间视野 */
    const room = Game.rooms[roomName]

    assertWithMsg( !!room, getFileNameAndLineNumber() )

    /** 建筑规划 */
    registerCustomConstructions(roomName)
    /** 注册现有建筑 */
    registerStoreForRoom(roomName)

    // 房间可视化进程
    A.timer.add(Game.time + 1, (roomName, container) => {
        if ( container.cache === null )
            container.cache = P.visualize(roomName)
        else if ( !(Memory as any).notViz )
            new RoomVisual(roomName).import(container.cache)
    }, [roomName, { cache: null }], `可视化房间自动规划布局 ${roomName}`, 1)

    /** 资源状态输出 */
    // A.timer.add(Game.time + 1, roomName => A.res.print(roomName), [roomName], `输出房间 ${roomName} 资源状态`, 1)

    issueDefendProc(roomName)
    issueFillProc(roomName)
    issueBuildProc(roomName)
    issuePaintProc(roomName)
    
    issueHarvestMineral(roomName)
    issueRepairStructure(roomName)

    /** Central Transfer 模块 */
    const transitLink = issueCentralTransfer(roomName)
    /** Source Harvest 模块 */
    const harvestSourceLinks = issueHarvestSource(roomName)
    /** Quick Energy Filling 模块 */
    const quickEnergyFillLinks = issueQuickEnergyFill(roomName)
    /** Fast Upgrade 模块 */
    const fastUpgradeLinks = issueFastUpgrade(roomName)
    /** Link Manage 模块 */
    issueLinkManage(roomName, [ ...harvestSourceLinks ], [ ...quickEnergyFillLinks, ...fastUpgradeLinks ], transitLink)

    /** Market 模块 */
    M.issue(roomName)

    /** 监测 TombStone */
    // ...
}