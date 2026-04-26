import { registerCommonConstructions } from './config.construction'
import { registerProduction } from './config.production'
import { registerHarvestSource } from './modules/harvestSource'
import { registerCentralTransfer } from './modules/centralTransfer'
import { registerQuickEnergyFill } from './modules/quickEnergyFill'
import { mountAllPrototypes } from './prototypes'
import { issueClaimRoomWatcher, registerClaimRoom } from './modules/roomClaim'
import { issueForRoom, registerForRoom } from './room'
import { registerDefendRoom } from './modules/roomDefense'

/** AI 挂载入口 */
export function mountAll() {
    mountAllPrototypes()
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
    /** Claim Room 模块 */
    registerClaimRoom()
    issueClaimRoomWatcher()
    /** Defend Room 模块 */
    registerDefendRoom()
    /** 房间运行模块 */
    registerForRoom()

    /** 重置 Harvest */
    // (Memory as any)._source2structure = {}
    
    for ( const roomName in Game.rooms ) {
        const room = Game.rooms[roomName]
        if ( !room.controller || !room.controller.my || room.find(FIND_STRUCTURES, { filter: { structureType: STRUCTURE_SPAWN } }).length <= 0 ) continue
        issueForRoom(roomName)
    }
}