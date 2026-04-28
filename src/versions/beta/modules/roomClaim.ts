/**
 * 房间扩张模块
 * Purple Flag 指示需要扩张的房间
 * 若 name 为一个符合标准的房间名字, 则指定房间援建
 * 否则, 默认使用曼哈顿距离选择一个最近符合标准的房间
 * 
 * 同一个房间最多援建 2 个房间, 但是不进行检查 (没必要, 手动控制吧)
 */

import { Apollo as A } from "@/framework/apollo"
import { planModule as P } from "@/modules/plan"
import { creepModule as C } from "@/modules/creep"
import { transferModule as T } from "@/modules/transfer"
import { assertWithMsg, getMyRooms, log, LOG_ERR, LOG_INFO, roomManhattanDistance } from "@/utils"
import { issueForRoom } from "../room"

const MIN_CONTROLLER_LEVEL = 3

export function registerClaimRoom() {
    C.design('claimer', {
        amount: 1, 
        body: {
            1: [CLAIM, MOVE]
        }
    })

    C.design('remoteWorker', {
        amount: 4, // 最多同时援建 2 个房间
        body: {
            1: [ CARRY, WORK, MOVE, MOVE ], 
            3: [ CARRY, CARRY, WORK, WORK, MOVE, MOVE, MOVE, MOVE ]
        }
    })
}

export function issueClaimRoomProc(srcRoomName: string, tarRoomName: string, getIssuedFlags: () => string[], setIssuedFlags: (arr: string[]) => void) {
    let claimerName = null
    let upgraderName = null
    let builderName = null
    let claimDone = A.proc.signal.createSignal(Game.rooms[tarRoomName] && Game.rooms[tarRoomName].controller && Game.rooms[tarRoomName].controller.my ? 1 : 0)
    let constructionSite: {
        structureType: StructureConstant;
        pos: RoomPosition;
    } = null
    let spawnDone = false

    function gotoRoom(getName: () => string, setName: (name: string) => void) {
        const creep = Game.creeps[getName()]
        if ( !creep ) {
            C.cancel(getName())
            setName(null)
            return [A.proc.STOP_ERR, `Creep [${getName()}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        }

        if ( creep.pos.roomName !== tarRoomName ) {
            creep.travelTo(new RoomPosition(25, 25, tarRoomName), { maxOps: 20000 })
            return A.proc.OK_STOP_CURRENT
        }

        /** 防止出现特殊情况, 即同一 tick, claim 成功, 唤醒 worker 进程, worker 恰好在房间内, 此时 controller.my 还没更新, 会出现 claim 成功与 controller.my 冲突, 导致进程非正常结束. 所以, 一定从下一 tick 开始 */
        creep.travelTo(new RoomPosition(25, 25, tarRoomName), { maxOps: 20000 })
        return A.proc.OK_STOP_NEXT
    }

    function claimRoom(name: string) {
        const creep = Game.creeps[name]
        if ( !creep ) {
            C.cancel(name)
            claimerName = null
            return [A.proc.STOP_ERR, `Creep [${name}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        }

        assertWithMsg( !!Game.rooms[tarRoomName] && !!Game.rooms[tarRoomName].controller, `${tarRoomName} 应当有视野, 但是并没有.` )

        const controller = Game.rooms[tarRoomName].controller
        if ( creep.pos.getRangeTo(controller) > 1 ) {
            creep.moveTo(controller)
            return A.proc.OK_STOP_CURRENT
        }

        if ( !controller.my ) {
            const returnCode = creep.claimController(controller)
            if ( returnCode === OK ) {
                C.release(name)
                claimerName = null
                A.timer.add(Game.time + 1, () => A.proc.signal.Ssignal({ signalId: claimDone, request: 1 }), [], `下一 tick 通知房间 ${tarRoomName} 可以开始升级与建造`)
            } else {
                log(LOG_ERR, `${tarRoomName} 无法 Claim, 返回值: ${returnCode}`)
                C.release(name)
                claimerName = null
                // 清理 Flags
                for (const flag of _.filter(Game.flags, flag => flag.pos.roomName === tarRoomName && flag.color === COLOR_PURPLE)) {
                    flag.remove()
                }
                setIssuedFlags(_.filter(getIssuedFlags(), roomName => roomName !== tarRoomName))
                return A.proc.OK
            }
        } else {
            C.release(name)
            claimerName = null
        }
        
        return A.proc.OK
    }

    function getEnergy(getName: () => string, setName: (name: string) => void) {
        let targetId: Id<Source> = null
        return function() {
            const name = getName()
            const creep = Game.creeps[name]
            if ( !creep ) {
                C.cancel(name)
                setName(null)
                return [A.proc.STOP_ERR, `Creep [${name}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
            }

            /** 过程中失去房间, 进程消亡 */
            if ( !Game.rooms[tarRoomName].controller.my ) {
                C.release(name)
                setName(null)
                return [A.proc.OK_STOP_CUSTOM, 'end'] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            }

            if ( creep.store.getFreeCapacity() <= 0 ) {
                targetId = null
                return A.proc.OK
            }

            if ( targetId === null ) {
                const source = creep.pos.findClosestByRange(FIND_SOURCES, { filter: s => s.energy > 0 })
                if ( source ) targetId = source.id
                else if ( creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 ) return A.proc.OK
                else return A.proc.OK_STOP_CURRENT
            }

            const target = Game.getObjectById(targetId)
            if ( creep.pos.getRangeTo(target) > 1 ) {
                creep.moveTo(target)
                return A.proc.OK_STOP_CURRENT
            }

            if ( target.energy > 0 ) creep.harvest(target)
            else targetId = null

            return A.proc.OK_STOP_CURRENT
        }
    }

    function upgradeRoom(name: string) {
        const creep = Game.creeps[name]
        if ( !creep ) {
            C.cancel(name)
            upgraderName = null
            return [A.proc.STOP_ERR, `Creep [${name}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        }

        /** 过程中失去房间, 进程消亡 */
        if ( !Game.rooms[tarRoomName].controller.my ) {
            C.release(name)
            upgraderName = null
            return [A.proc.OK_STOP_CUSTOM, 'end'] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
        }

        const controller = Game.rooms[tarRoomName].controller
        if ( creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 ) return A.proc.OK

        if ( creep.pos.getRangeTo(controller) > 3 ) {
            creep.travelTo(controller, { range: 3 })
            return A.proc.OK_STOP_CURRENT
        }

        creep.upgradeController(controller)
        return A.proc.OK_STOP_CURRENT
    }

    function isDone(name: string, setName: (name: string) => void) {
        if ( spawnDone ) {
            C.release(name)
            setName(null)
            return A.proc.OK
        } else return [ A.proc.OK_STOP_CUSTOM, 'gotoSource' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
    }

    function getConstructionSite() {
        /** 需要建造的地方不为空时, 不再重复请求 - Creep 消亡后, 进程重启时使用 */
        if ( constructionSite !== null ) return A.proc.OK

        if ( Game.rooms[tarRoomName].find(FIND_STRUCTURES, { filter: {structureType: STRUCTURE_SPAWN} }).length > 0 ) {
            spawnDone = true
            return [ A.proc.OK_STOP_CUSTOM, 'register' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
        }

        constructionSite = P.recommend( tarRoomName, false )
        if ( constructionSite === null ) {
            spawnDone = true
            return [ A.proc.OK_STOP_CUSTOM, 'register' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
        }

        log(LOG_INFO, `${tarRoomName} 规划的下一个建筑地点为 ${constructionSite.structureType} (${constructionSite.pos})`)
        /** 判断是否已经存在 */
        const target = Game.rooms[tarRoomName].lookForAt(LOOK_CONSTRUCTION_SITES, constructionSite.pos).filter(s => s.structureType === constructionSite.structureType)[0]
        if ( !target )
            assertWithMsg(Game.rooms[tarRoomName].createConstructionSite(constructionSite.pos, constructionSite.structureType) === OK, `推荐的建筑 ${constructionSite.structureType} (${constructionSite.pos}) 应当一定可建造, 但是不是`)
        return A.proc.OK_STOP_NEXT
    }

    function buildRoom(name: string) {
        const creep = Game.creeps[name]
        if ( !creep ) {
            C.cancel(name)
            builderName = null
            return [A.proc.STOP_ERR, `Creep [${name}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        }

        /** 过程中失去房间, 进程消亡 */
        if ( !Game.rooms[tarRoomName].controller.my ) {
            C.release(name)
            builderName = null
            return [A.proc.OK_STOP_CUSTOM, 'end'] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
        }

        if ( creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 ) return A.proc.OK

        if ( creep.pos.getRangeTo(constructionSite.pos) > 3 ) {
            creep.travelTo(constructionSite, { range: 3 })
            return A.proc.OK_STOP_CURRENT
        }

        const target = Game.rooms[tarRoomName].lookForAt(LOOK_CONSTRUCTION_SITES, constructionSite.pos)[0]
        if ( target ) creep.build(target)
        else {
            C.release(name)
            builderName = null
            constructionSite = null
            return [ A.proc.OK_STOP_CUSTOM, 'getConstructionSite' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
        }

        return A.proc.OK_STOP_CURRENT
    }

    function registerRoom() {
        for (const flag of _.filter(Game.flags, flag => flag.pos.roomName === tarRoomName && flag.color === COLOR_PURPLE)) {
            flag.remove()
        }
        setIssuedFlags(_.filter(getIssuedFlags(), roomName => roomName !== tarRoomName))
        issueForRoom(tarRoomName)
        return A.proc.OK
    }

    if ( A.proc.signal.getValue(claimDone) === 0 ) {
        A.proc.createProc([
            () => C.acquire('claimer', srcRoomName, name => claimerName = name), 
            () => gotoRoom(() => claimerName, name => claimerName = name), 
            () => claimRoom(claimerName)
        ], `${srcRoomName} => ${tarRoomName} Claim`)
    }

    /** Potential Risk: 如果房间 Claim 失败, 这两个进程会永远 Stuck */

    A.proc.createProc([
        () => A.proc.signal.Swait({ signalId: claimDone, lowerbound: 1, request: 0 }), 
        () => C.acquire('remoteWorker', srcRoomName, name => upgraderName = name), 
        () => gotoRoom(() => upgraderName, name => upgraderName = name), 
        ['gotoSource', getEnergy(() => upgraderName, name => upgraderName = name)], 
        () => upgradeRoom(upgraderName), 
        () => isDone(upgraderName, name => upgraderName = name), 
        ['end', () => A.proc.OK]
    ], `${srcRoomName} => ${tarRoomName} Upgrade`)

    A.proc.createProc([
        () => A.proc.signal.Swait({ signalId: claimDone, lowerbound: 1, request: 0 }), 
        ['getConstructionSite', () => getConstructionSite()], 
        () => C.acquire('remoteWorker', srcRoomName, name => builderName = name), 
        () => gotoRoom(() => builderName, name => builderName = name), 
        ['gotoSource', getEnergy(() => builderName, name => builderName = name)], 
        () => buildRoom(builderName), 
        () => isDone(builderName, name => builderName = name), 
        ['register', () => registerRoom()], 
        ['end', () => A.proc.OK]
    ], `${srcRoomName} => ${tarRoomName} Build`)
}

export function issueClaimRoomWatcher() {
    let issuedFlags = []

    const pid = A.proc.createProc([
        () => {
            const notIssuedFlags = _.filter(Game.flags, flag => flag.color === COLOR_PURPLE && !_.includes(issuedFlags, flag.pos.roomName))
            for ( const flag of notIssuedFlags ) {
                const tarRoomName = flag.pos.roomName
                if ( Game.rooms[tarRoomName] && Game.rooms[tarRoomName].controller && Game.rooms[tarRoomName].controller.my && Game.rooms[tarRoomName].find(FIND_MY_STRUCTURES, { filter: { structureType: STRUCTURE_SPAWN } }).length > 0 ) {
                    // 此时已经完成
                    flag.remove()
                    continue
                }

                // 寻找最合适的邻近房间
                let srcRoomName = null
                if ( Game.rooms[flag.name] && Game.rooms[flag.name].controller && Game.rooms[flag.name].controller.my && Game.rooms[flag.name].controller.level >= MIN_CONTROLLER_LEVEL ) srcRoomName = flag.name
                else {
                    const myRooms = getMyRooms().filter(r => r.controller.level >= MIN_CONTROLLER_LEVEL)
                    assertWithMsg( myRooms.length > 0, `必定需要至少一个 Controller 等级大于 ${MIN_CONTROLLER_LEVEL} 的房间作为母房间` )

                    // 使用 Manhattan 距离来选择最近支援房间
                    srcRoomName = _.min(myRooms, room => roomManhattanDistance(room.name, tarRoomName)).name
                }
                
                issuedFlags.push(tarRoomName)
                issueClaimRoomProc(srcRoomName, tarRoomName, () => issuedFlags, arr => issuedFlags = arr)
            }
            return A.proc.STOP_SLEEP
        }
    ], `准备 Claim Room 进程`, true)

    A.proc.trigger("watch", () => {
        return _.filter(Game.flags, flag => flag.color === COLOR_PURPLE && !_.includes(issuedFlags, flag.pos.roomName)).length > 0 && _.max(_.map(getMyRooms(), room => room.controller.level)) >= MIN_CONTROLLER_LEVEL
    }, [ pid ])
}