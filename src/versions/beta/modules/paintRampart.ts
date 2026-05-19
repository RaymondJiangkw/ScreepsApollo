import { Apollo as A } from '@/framework/apollo'
import { creepModule as C } from '@/modules/creep'
import { planModule as P } from '@/modules/plan'
import { assertWithMsg, calcBodyEffectiveness, getAvailableSurroundingPos, getFileNameAndLineNumber, log, LOG_DEBUG, LOG_INFO, stackLog } from '@/utils'
import { getEnergy } from './shared'

export function registerPaint() {
    C.design('painter', {
        body: {
            1: [ CARRY, WORK, MOVE, MOVE ], 
            3: [ CARRY, CARRY, WORK, WORK, MOVE, MOVE, MOVE, MOVE ], 
            4: [ CARRY, CARRY, CARRY, WORK, WORK, WORK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ], 
            6: [ CARRY, CARRY, CARRY, CARRY, WORK, WORK, WORK, WORK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ]
        }, 
        amount: 1, 
    })
}

export function issuePaintProc(roomName: string) {
    let workerName = null
    let repairedPos: RoomPosition = null

    function getRepairedPos() {
        const structure = _.min(Game.rooms[roomName].find(FIND_STRUCTURES, { filter: s => s.hits < s.hitsMax && (s.structureType === STRUCTURE_RAMPART) }), s => s.hits / s.hitsMax)
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
        } else creep.moveTo(repairedPos)

        return A.proc.OK_STOP_CURRENT
    }

    const gotoSource = getEnergy(roomName, () => workerName, name => workerName = name)

    const pid = A.proc.createProc([
        ['getRepairedPos', () => getRepairedPos()], 
        () => C.acquire('painter', roomName, name => workerName = name), 
        () => {
            const creep = Game.creeps[workerName]
            /** 检测到错误, 立即释放资源 */
            if ( !creep || creep.hits < creep.hitsMax ) {
                C.cancel(workerName)
                workerName = null
                return [A.proc.STOP_ERR, `Creep [${workerName}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
            }
            if ( creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 ) return [ A.proc.OK_STOP_CUSTOM, 'work' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            else return A.proc.OK
        }, 
        [ 'gotoSource', gotoSource ], 
        [ 'work', () => gotoStructure(workerName) ], 
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