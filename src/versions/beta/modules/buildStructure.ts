/**
 * 建造 (额外) 建筑模块
 */

import { Apollo as A } from "@/framework/apollo"
import { planModule as P } from "@/modules/plan"
import { creepModule as C } from "@/modules/creep"
import { transferModule as T } from "@/modules/transfer"
import { assertWithMsg, calcBodyEffectiveness, getAvailableSurroundingPos, getFileNameAndLineNumber, log, LOG_INFO, stackLog } from "@/utils"

function getEnergy(roomName: string, getWorkerName: () => string, setWorkerName: ( name: string ) => void) {
    let targetId: Id<Source> | Id<StorableStructure> = null
    return function() {
        const name = getWorkerName()
        const creep = Game.creeps[name]
        /** 检测到错误, 立即释放资源 */
        if ( !creep || creep.hits < creep.hitsMax ) {
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
            creep.moveTo(target)
            return A.proc.OK_STOP_CURRENT
        }

        if ( target instanceof Source ) {
            if ( target.energy > 0 ) creep.harvest(target)
            else targetId = null
        } else {
            const amount = Math.min(A.res.query(targetId as Id<StorableStructure>, RESOURCE_ENERGY), creep.store.getFreeCapacity(RESOURCE_ENERGY))
            if ( amount > 0 ) {
                assertWithMsg( A.res.request({ id: targetId as Id<StorableStructure>, resourceType: RESOURCE_ENERGY, amount }, 'getEnergy -> 70') === OK, getFileNameAndLineNumber() )
                assertWithMsg( creep.withdraw(target, RESOURCE_ENERGY, amount) === OK, getFileNameAndLineNumber() )
                A.timer.add(Game.time + 1, (targetId, amount) => A.res.signal(targetId, A.res.CAPACITY, amount), [targetId, amount], `${targetId} 资源更新`)
            } else targetId = null
        }

        return A.proc.OK_STOP_CURRENT
    }
}

/** 构造建筑进程 */
export function issueBuildStructureProc(roomName: string, structureType: StructureConstant, getInfo: () => { id: Id<Structure>, pos: Pos }, completeSignalId: string = null, sleep: boolean = true) {
    let workerName = null
    assertWithMsg( !!getInfo().pos, `在 ${roomName} 建造 ${structureType} 需要已知 pos, 但是无法找到!` )
    const getPos = () => new RoomPosition(getInfo().pos.x, getInfo().pos.y, getInfo().pos.roomName)

    function buildConstructionSite(name: string) {
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

        if ( creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 ) return [ A.proc.OK_STOP_CUSTOM, 'gotoSource' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]

        if ( creep.pos.roomName === roomName && creep.pos.getRangeTo(getPos()) <= 3 ) {
            const target = Game.rooms[roomName].lookForAt(LOOK_CONSTRUCTION_SITES, getPos())[0]
            if ( target ) creep.build(target)
            else {
                const structure = Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, getPos()).filter(s => s.structureType === structureType)[0]
                if ( structure ) {
                    getInfo().id = structure.id
                    if ( !!completeSignalId )
                        assertWithMsg( A.proc.signal.Ssignal({ signalId: completeSignalId, request: 1 }) === A.proc.OK, getFileNameAndLineNumber() )
                    return A.proc.STOP_SLEEP
                } else {
                    const retCode = Game.rooms[roomName].createConstructionSite(getPos(), structureType)
                    if ( retCode === ERR_NOT_IN_RANGE ) creep.travelTo(getPos())
                    else assertWithMsg( retCode === OK, `无法为 Controller 在 ${getPos()} 构建建筑 ${structureType}` )
                    return A.proc.OK_STOP_CURRENT
                }
            }
        } else creep.travelTo(getPos(), { range: 3 })

        return A.proc.OK_STOP_CURRENT
    }

    const gotoSource = getEnergy(roomName, () => workerName, name => workerName = name)

    const pid = A.proc.createProc([
        () => {
            if ( !getInfo().id ) {
                if ( !!completeSignalId && A.proc.signal.getValue(completeSignalId) === 1 ) A.proc.signal.Swait({ signalId: completeSignalId, lowerbound: 1, request: 1 })
                return A.proc.OK
            }
            if ( !Game.getObjectById(getInfo().id) ) {
                getInfo().id = null
                if ( !!completeSignalId && A.proc.signal.getValue(completeSignalId) === 1 ) A.proc.signal.Swait({ signalId: completeSignalId, lowerbound: 1, request: 1 })
                return A.proc.OK
            } else return A.proc.STOP_SLEEP
        }, 
        () => C.acquire('worker', roomName, name => workerName = name), 
        ['gotoSource', gotoSource], 
        () => buildConstructionSite(workerName)
    ], `${roomName} 建造 ${structureType} (${getPos()})`, sleep)

    return pid
}

/** 通用建筑进程 */
export function issueBuildProc(roomName: string) {
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
        } else creep.travelTo(constructionSite.pos, { range: 3 })

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