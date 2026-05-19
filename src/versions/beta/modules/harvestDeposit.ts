/**
 * 采集商品原料
 * 使用黄色 Flag
 */

import { Apollo as A } from "@/framework/apollo"
import { planModule as P } from "@/modules/plan"
import { creepModule as C } from "@/modules/creep"
import { transferModule as T } from "@/modules/transfer"
import { assertWithMsg, getFileNameAndLineNumber, getMyRooms, roomManhattanDistance } from "@/utils"
import { getStorageMaintainAmount, getStorageMaxMaintainAmount } from "../config.production"

const MAX_TOLERANCE_COOLDOWN = 20
const BACK_HOME_TIME_COST_COEFF = 1.2

export function registerHarvestDeposit() {
    C.design('deposit_harvestor', {
        amount: 2, 
        body: {
            4: [ MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, CARRY, CARRY, CARRY, CARRY, WORK, WORK, WORK, WORK ], 
            6: [ MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK ]
        }, 
        strict: true, 
        priority: C.PRIORITY_CASUAL
    })
}

function issueHarvestDepositProc(srcRoomName: string, tarPos: Pos, flagName: string, getIssuedFlags: () => string[], setIssuedFlags: (arr: string[]) => void) {
    let harvestorName: string = null
    let depositId: Id<Deposit> = null
    let depositType: DepositConstant = null
    let shouldEnd = false

    A.proc.createProc([
        () => P.exist(srcRoomName, 'centralTransfer', 'storage'),
        () => {
            const storage = Game.rooms[srcRoomName].storage
            if ( !storage ) {
                return [ A.proc.STOP_ERR, `Storage [${srcRoomName}] 无法找到` ] as [ typeof A.proc.STOP_ERR, string ]
            }
            if ( A.res.query(storage.id, A.res.CAPACITY) <= getStorageMaintainAmount("free before store") ) return A.res.request({ id: storage.id, resourceType: A.res.CAPACITY, amount: { lowerbound: getStorageMaintainAmount("free before store"), request: 0 } })
            /** 此时已经够够的了 */
            if ( Math.max(A.res.query(storage.id, RESOURCE_SILICON), A.res.query(storage.id, RESOURCE_METAL), A.res.query(storage.id, RESOURCE_BIOMASS), A.res.query(storage.id, RESOURCE_MIST)) >= getStorageMaxMaintainAmount("deposit") ) return [ A.proc.OK_STOP_CUSTOM, 'end' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            return A.proc.OK
        }, 
        () => C.acquire('deposit_harvestor', srcRoomName, name => harvestorName = name), 
        () => {
            const creep = Game.creeps[harvestorName]
            if ( !creep ) {
                C.cancel(harvestorName)
                harvestorName = null
                return [ A.proc.STOP_ERR, `Creep [${harvestorName}] 无法找到` ] as [ typeof A.proc.STOP_ERR, string ]
            }

            if ( creep.hits < creep.hitsMax ) {
                // 说明遇到了危险
                C.cancel(harvestorName)
                harvestorName = null
                if ( flagName in Game.flags ) Game.flags[flagName].remove()
                setIssuedFlags(_.filter(getIssuedFlags(), name => name !== flagName))
                return [ A.proc.OK_STOP_CUSTOM, 'end' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            }

            if ( !(creep.memory as any).startTime ) (creep.memory as any).startTime = Game.time
            return A.proc.OK
        }, 
        ['gotoRoom', () => {
            const creep = Game.creeps[harvestorName]
            if ( !creep ) {
                C.cancel(harvestorName)
                harvestorName = null
                return [ A.proc.STOP_ERR, `Creep [${harvestorName}] 无法找到` ] as [ typeof A.proc.STOP_ERR, string ]
            }

            if ( creep.hits < creep.hitsMax ) {
                // 说明遇到了危险
                C.cancel(harvestorName)
                harvestorName = null
                if ( flagName in Game.flags ) Game.flags[flagName].remove()
                setIssuedFlags(_.filter(getIssuedFlags(), name => name !== flagName))
                return [ A.proc.OK_STOP_CUSTOM, 'end' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            }

            if ( creep.pos.roomName !== tarPos.roomName ) {
                creep.moveTo(new RoomPosition(tarPos.x, tarPos.y, tarPos.roomName))
                return A.proc.OK_STOP_CURRENT
            }

            if ( !!depositId && !Game.getObjectById(depositId) ) {
                // Deposit 消亡
                C.release(harvestorName)
                harvestorName = null
                depositId = null
                depositType = null
                if ( flagName in Game.flags ) Game.flags[flagName].remove()
                setIssuedFlags(_.filter(getIssuedFlags(), name => name !== flagName))
                return [ A.proc.OK_STOP_CUSTOM, 'end' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            }

            if ( !depositId ) {
                const deposit = Game.rooms[tarPos.roomName].lookForAt(LOOK_DEPOSITS, tarPos.x, tarPos.y)[0]
                if ( !deposit || deposit.lastCooldown > MAX_TOLERANCE_COOLDOWN ) {
                    // Deposit 消亡
                    C.release(harvestorName)
                    harvestorName = null
                    depositId = null
                    depositType = null
                    if ( flagName in Game.flags ) Game.flags[flagName].remove()
                    setIssuedFlags(_.filter(getIssuedFlags(), name => name !== flagName))
                    return [ A.proc.OK_STOP_CUSTOM, 'end' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                }
                depositId = deposit.id
                depositType = deposit.depositType
            }

            return A.proc.OK
        }], 
        () => {
            const creep = Game.creeps[harvestorName]
            if ( !creep ) {
                C.cancel(harvestorName)
                harvestorName = null
                return [ A.proc.STOP_ERR, `Creep [${harvestorName}] 无法找到` ] as [ typeof A.proc.STOP_ERR, string ]
            }

            if ( creep.hits < creep.hitsMax ) {
                // 说明遇到了危险
                C.cancel(harvestorName)
                harvestorName = null
                if ( flagName in Game.flags ) Game.flags[flagName].remove()
                setIssuedFlags(_.filter(getIssuedFlags(), name => name !== flagName))
                return [ A.proc.OK_STOP_CUSTOM, 'end' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            }

            const deposit = Game.getObjectById(depositId)
            if ( !deposit || deposit.lastCooldown > MAX_TOLERANCE_COOLDOWN ) {
                if ( creep.store.getUsedCapacity() <= 0 ) {
                    C.release(harvestorName)
                    harvestorName = null
                    depositId = null
                    depositType = null
                    if ( flagName in Game.flags ) Game.flags[flagName].remove()
                    setIssuedFlags(_.filter(getIssuedFlags(), name => name !== flagName))
                    return [ A.proc.OK_STOP_CUSTOM, 'end' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                } else {
                    shouldEnd = true
                    return A.proc.OK
                }
            }

            if ( creep.pos.getRangeTo(deposit) > 1 ) {
                creep.moveTo(deposit)
                return A.proc.OK_STOP_CURRENT
            }

            if ( !(creep.memory as any).workTime ) {
                (creep.memory as any).workTime = Game.time
                if ( ((creep.memory as any).workTime - (creep.memory as any).startTime) * (1 + BACK_HOME_TIME_COST_COEFF) > CREEP_LIFE_TIME / 2 ) {
                    // 一次性花费时间太长
                    C.release(harvestorName)
                    harvestorName = null
                    depositId = null
                    depositType = null
                    if ( flagName in Game.flags ) Game.flags[flagName].remove()
                    setIssuedFlags(_.filter(getIssuedFlags(), name => name !== flagName))
                    return [ A.proc.OK_STOP_CUSTOM, 'end' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                }
            }
            if ( creep.ticksToLive < ((creep.memory as any).workTime - (creep.memory as any).startTime) * BACK_HOME_TIME_COST_COEFF ) return A.proc.OK
            if ( creep.store.getFreeCapacity() <= 0 ) return A.proc.OK
            if ( deposit.cooldown > 0 ) return A.proc.OK_STOP_CURRENT
            creep.harvest(deposit)
            return A.proc.OK_STOP_CURRENT
        }, 
        () => {
            const creep = Game.creeps[harvestorName]
            if ( !creep ) {
                C.cancel(harvestorName)
                harvestorName = null
                return [ A.proc.STOP_ERR, `Creep [${harvestorName}] 无法找到` ] as [ typeof A.proc.STOP_ERR, string ]
            }

            if ( creep.hits < creep.hitsMax ) {
                // 说明遇到了危险
                C.cancel(harvestorName)
                harvestorName = null
                if ( flagName in Game.flags ) Game.flags[flagName].remove()
                setIssuedFlags(_.filter(getIssuedFlags(), name => name !== flagName))
                return [ A.proc.OK_STOP_CUSTOM, 'end' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            }

            const storage = Game.rooms[srcRoomName].storage
            if ( !storage ) {
                // 无法存储
                C.release(harvestorName)
                harvestorName = null
                depositId = null
                depositType = null
                if ( flagName in Game.flags ) Game.flags[flagName].remove()
                setIssuedFlags(_.filter(getIssuedFlags(), name => name !== flagName))
                return [ A.proc.STOP_ERR, `Storage [${srcRoomName}] 无法找到` ] as [ typeof A.proc.STOP_ERR, string ]
            }

            if ( creep.pos.roomName !== srcRoomName || creep.pos.getRangeTo(storage) > 1 ) {
                creep.moveTo(storage)
                return A.proc.OK_STOP_CURRENT
            }

            if ( !(creep.memory as any).transferTime ) (creep.memory as any).transferTime = Game.time

            for ( const resourceType in creep.store ) {
                if ( A.res.query(storage.id, A.res.CAPACITY) >= creep.store[resourceType] ) {
                    assertWithMsg( A.res.request({ id: storage.id, resourceType: A.res.CAPACITY, amount: creep.store[resourceType] }) === A.proc.OK, getFileNameAndLineNumber() )
                    assertWithMsg( creep.transfer(storage, resourceType as ResourceConstant) === OK, getFileNameAndLineNumber() )
                    A.timer.add(Game.time + 1, (id, resourceType, amount) => A.res.signal(id, resourceType, amount), [ storage.id, resourceType, creep.store[resourceType] ], `更新 Storage 资源`)
                    return A.proc.OK_STOP_CURRENT
                } else {
                    // Drop 在 Container 上会影响资源计算
                    if ( creep.pos.lookFor(LOOK_STRUCTURES).filter(v => v.structureType === STRUCTURE_CONTAINER).length > 0 ) {
                        creep.travelTo( storage.pos, { flee: true, ignoreCreeps: false, range: 1, avoidStructureTypes: [ STRUCTURE_CONTAINER ] } )
                        return A.proc.OK_STOP_CURRENT
                    }
                    // 不 Drop 等待有 Capacity
                    // creep.drop(resourceType as ResourceConstant)
                    return A.res.request({ id: storage.id, resourceType: A.res.CAPACITY, amount: {lowerbound: creep.store[resourceType], request: 0} })
                }
            }

            // 此时一定传输完
            // 如果无法完成一个来回
            if ( creep.ticksToLive < ((creep.memory as any).transferTime - (creep.memory as any).startTime + 5) ) {
                const timeDifference = ((creep.memory as any).transferTime - (creep.memory as any).startTime + 5)
                creep.suicide()
                C.cancel(harvestorName)
                harvestorName = null
                if ( timeDifference > CREEP_LIFE_TIME / 2 ) {
                    depositId = null
                    depositType = null
                    if ( flagName in Game.flags ) Game.flags[flagName].remove()
                    setIssuedFlags(_.filter(getIssuedFlags(), name => name !== flagName))
                    return A.proc.OK
                } else return [ A.proc.STOP_ERR, `Creep [${harvestorName}] 无法找到` ] as [ typeof A.proc.STOP_ERR, string ]
            }

            // 不然回去
            if ( !shouldEnd )
                return [ A.proc.OK_STOP_CUSTOM, 'gotoRoom' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            else {
                // 已经无效了
                C.release(harvestorName)
                harvestorName = null
                depositId = null
                depositType = null
                if ( flagName in Game.flags ) Game.flags[flagName].remove()
                setIssuedFlags(_.filter(getIssuedFlags(), name => name !== flagName))
                return A.proc.OK
            }
        }, 
        ['end', () => A.proc.OK]
    ], `${srcRoomName} => 采集 (${tarPos.x}, ${tarPos.y}) 位于 ${tarPos.roomName} 的 Deposit`)
}

export function issueHarvestDepositWatcher() {
    let issuedFlags = []

    const pid = A.proc.createProc([
        () => {
            const notIssuedFlags = _.filter(Game.flags, flag => flag.color === COLOR_YELLOW && !_.includes(issuedFlags, flag.name))
            if ( notIssuedFlags.length === 0 ) return A.proc.STOP_SLEEP
            for ( const flag of notIssuedFlags ) {
                const pos = flag.pos
                if ( !!Game.rooms[pos.roomName] && (!Game.rooms[pos.roomName].lookForAt(LOOK_DEPOSITS, pos.x, pos.y)[0] || Game.rooms[pos.roomName].lookForAt(LOOK_DEPOSITS, pos.x, pos.y)[0].lastCooldown > MAX_TOLERANCE_COOLDOWN) ) {
                    flag.remove()
                    continue
                }

                let srcRoomName = null
                if ( Game.rooms[flag.name] && Game.rooms[flag.name].controller && Game.rooms[flag.name].controller.my && !!Game.rooms[flag.name].storage ) srcRoomName = flag.name
                else {
                    const myRooms = getMyRooms().filter(r => !!r.storage && A.res.query(r.storage.id, A.res.CAPACITY) > getStorageMaintainAmount("free before store") && Math.max(A.res.query(r.storage.id, RESOURCE_SILICON), A.res.query(r.storage.id, RESOURCE_METAL), A.res.query(r.storage.id, RESOURCE_BIOMASS), A.res.query(r.storage.id, RESOURCE_MIST)) < getStorageMaxMaintainAmount("deposit"))
                    // 等待有可存放的房间
                    // 无法阻塞? 因为随时可能有新房间, 新 storage
                    if ( myRooms.length <= 0 ) return A.proc.OK_STOP_CURRENT

                    // 使用 Manhattan 距离来选择最近支援房间
                    srcRoomName = _.min(myRooms, room => roomManhattanDistance(room.name, pos.roomName)).name
                }

                issuedFlags.push(flag.name)
                issueHarvestDepositProc(srcRoomName, pos, flag.name, () => issuedFlags, arr => issuedFlags = arr)
            }
            return A.proc.STOP_SLEEP
        }
    ], `准备 Harvest Deposit 进程`, true)

    A.proc.trigger("watch", () => {
        return _.filter(Game.flags, flag => flag.color === COLOR_YELLOW && !_.includes(issuedFlags, flag.name)).length > 0 && _.filter(getMyRooms(), room => !!room.storage).length > 0
    }, [ pid ])
}