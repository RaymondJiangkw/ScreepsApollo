import { Apollo as A } from '@/framework/apollo'
import { registerCommonConstructions } from './config.construction'
import { registerProduction } from './config.production'
import { registerHarvestSource } from './modules/harvestSource'
import { registerCentralTransfer } from './modules/centralTransfer'
import { registerQuickEnergyFill } from './modules/quickEnergyFill'
import { mountAllPrototypes } from './prototypes'
import { issueClaimRoomWatcher, registerClaimRoom } from './modules/roomClaim'
import { issueForRoom, registerForRoom } from './room'
import { registerDefendRoom } from './modules/roomDefense'
import { registerFastUpgrade } from './modules/fastUpgrade'
import { registerLinkManage } from './modules/linkManage'
import { registerHarvestMineral } from './modules/harvestMineral'
import { registerPaint } from './modules/paintRampart'
import { issueHarvestDepositWatcher, registerHarvestDeposit } from './modules/harvestDeposit'

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
    /** Paint Rampart 模块 */
    registerPaint()
    /** Source Harvest 模块 */
    registerHarvestSource()
    /** Mineral Harvest 模块 */
    registerHarvestMineral()
    /** Quick Energy Filling 模块 */
    registerQuickEnergyFill()
    /** Central Transfer 模块 */
    registerCentralTransfer()
    /** Fast Upgrade 模块 */
    registerFastUpgrade()
    /** Claim Room 模块 */
    registerClaimRoom()
    issueClaimRoomWatcher()
    /** Harvest Deposit 模块 */
    registerHarvestDeposit()
    issueHarvestDepositWatcher()
    /** Defend Room 模块 */
    registerDefendRoom()
    /** Link Manage 模块 */
    registerLinkManage()
    /** 房间运行模块 */
    registerForRoom()

    /** 重置 Harvest */
    // (Memory as any)._source2structure = {}
    
    for ( const roomName in Game.rooms ) {
        const room = Game.rooms[roomName]
        if ( !room.controller || !room.controller.my || room.find(FIND_STRUCTURES, { filter: { structureType: STRUCTURE_SPAWN } }).length <= 0 ) continue
        issueForRoom(roomName)
    }

    /** Periodical Global Reset before Debugging */
    // const RESET_TICK_INTERVAL = 2000 * 2 // 2 hrs
    // A.timer.add(Game.time + RESET_TICK_INTERVAL, () => Game.cpu.halt(), [], `Reset Global`, RESET_TICK_INTERVAL)
}