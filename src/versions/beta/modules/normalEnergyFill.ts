/**
 * 填充非 quick energy filling 部分的 extensions
 */

import { Apollo as A } from '@/framework/apollo'
import { creepModule as C } from '@/modules/creep'
import { planModule as P } from '@/modules/plan'
import { getEnergy } from './shared'
import { isBelongingToQuickEnergyFilling } from './quickEnergyFill'
import { assertWithMsg, getFileNameAndLineNumber } from '@/utils'

function withdrawEnergy(roomName: string, getWorkerName: () => string, setWorkerName: ( name: string ) => void) {
    let targetId: Id<StorableStructure> = null
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
        if ( creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0 ) {
            targetId = null
            return A.proc.OK
        }

        /** 确认房间位置 */
        if ( creep.pos.roomName !== roomName ) {
            creep.moveToRoom(roomName)
            return A.proc.OK_STOP_CURRENT
        }

        if ( targetId === null ) {
            const source = A.res.requestSource(roomName, RESOURCE_ENERGY, CARRY_CAPACITY, creep.pos)
            if ( source.code !== A.proc.OK ) return source.code
            targetId = source.id
        }

        const target = Game.getObjectById(targetId)
        if ( creep.pos.getRangeTo(target) > 1 ) {
            creep.moveTo(target)
            return A.proc.OK_STOP_CURRENT
        }

        const amount = Math.min(A.res.query(targetId, RESOURCE_ENERGY), creep.store.getFreeCapacity(RESOURCE_ENERGY))
        if ( amount > 0 ) {
            assertWithMsg( A.res.request({ id: targetId, resourceType: RESOURCE_ENERGY, amount }, 'withdrawEnergy -> 56') === OK, getFileNameAndLineNumber() )
            assertWithMsg( creep.withdraw(target, RESOURCE_ENERGY, amount) === OK, getFileNameAndLineNumber() )
            A.timer.add(Game.time + 1, (targetId, amount) => A.res.signal(targetId, A.res.CAPACITY, amount), [targetId, amount], `${targetId} 资源更新`)
        } else targetId = null

        return A.proc.OK_STOP_CURRENT
    }
}

export function issueFillProc(roomName: string) {
    let workerName = null
    let transfererName = null

    function gotoSpawn(getWorkerName: () => string, setWorkerName: ( name: string ) => void) {
        const creep = Game.creeps[getWorkerName()]
        /** 检测到错误, 立即释放资源 */
        if ( !creep || creep.hits < creep.hitsMax ) {
            C.cancel(getWorkerName())
            setWorkerName(null)
            return [A.proc.STOP_ERR, `Creep [${getWorkerName()}] 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        }

        /** 最后几秒, 撤离 */
        if ( creep.ticksToLive < 3 ) {
            if ( creep.pos.lookFor(LOOK_STRUCTURES).filter(s => s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_ROAD).length > 0 )
                creep.travelTo( creep.pos, { flee: true, ignoreCreeps: false, range: 1, avoidStructureTypes: [ STRUCTURE_CONTAINER ] } )
            return A.proc.OK_STOP_CURRENT
        }

        const spawns = Game.rooms[roomName].find<FIND_STRUCTURES, StructureSpawn | StructureExtension | StructureTower>(FIND_STRUCTURES, { filter: s => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && !isBelongingToQuickEnergyFilling(s.pos) }).sort((u, v) => u.pos.getRangeTo(creep) - v.pos.getRangeTo(creep))

        if ( spawns.length === 0 ) {
            /** 此时, 本进程无用, 释放资源并休眠 */
            C.release(getWorkerName())
            setWorkerName(null)
            return A.proc.STOP_SLEEP
        }

        if ( creep.store.getUsedCapacity(RESOURCE_ENERGY) <= 0 ) return A.proc.OK

        const spawn = spawns[0]

        /** 已经接近 Spawn */
        if ( creep.pos.roomName === roomName && creep.pos.getRangeTo(spawn) <= 1 ) {
            const transferAmount = Math.min(spawn.store.getFreeCapacity(RESOURCE_ENERGY), creep.store[RESOURCE_ENERGY])
            creep.transfer(spawn, RESOURCE_ENERGY, transferAmount)
            if ( spawns.length > 1 && transferAmount < creep.store[RESOURCE_ENERGY] ) {
                creep.moveTo(spawns[1])
                return A.proc.OK_STOP_CURRENT
            } else if ( spawns.length > 1 && transferAmount === creep.store[RESOURCE_ENERGY] ) return A.proc.OK
            else if ( spawns.length === 1 ) {
                if ( transferAmount === spawn.store.getFreeCapacity(RESOURCE_ENERGY) ) {
                    /** 此时, 本进程无用, 释放资源并休眠 */
                    C.release(getWorkerName())
                    setWorkerName(null)
                    return A.proc.STOP_SLEEP
                } else return A.proc.OK
            }
        }

        creep.moveTo(spawn)
        return A.proc.OK_STOP_CURRENT
    }

    const gotoSource = getEnergy(roomName, () => workerName, name => workerName = name)

    const harvestAndFillPid = A.proc.createProc([
        () => {
            if ( !!Game.rooms[roomName] && Game.rooms[roomName].energyAvailable < Game.rooms[roomName].energyCapacityAvailable && Game.rooms[roomName].controller.level < 6 ) {
                const spawns = Game.rooms[roomName].find<FIND_STRUCTURES, StructureSpawn | StructureExtension | StructureTower>(FIND_STRUCTURES, { filter: s => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && !isBelongingToQuickEnergyFilling(s.pos) })
                if ( spawns.length > 0 ) return A.proc.OK
                else return A.proc.STOP_SLEEP
            } else return A.proc.STOP_SLEEP
        }, 
        () => C.acquire('worker', roomName, name => workerName = name), 
        [ 'gotoSource', gotoSource ], 
        () => gotoSpawn(() => workerName, name => workerName = name), 
        [ 'JUMP', () => true, 'gotoSource' ]
    ], `${roomName} => Fill (harvest)`)

    const withdrawSource = withdrawEnergy(roomName, () => transfererName, name => transfererName = name)

    const withdrawAndFillPid = A.proc.createProc([
        () => {
            if ( !!Game.rooms[roomName] && Game.rooms[roomName].energyAvailable < Game.rooms[roomName].energyCapacityAvailable && Game.rooms[roomName].controller.level >= 6 ) {
                const spawns = Game.rooms[roomName].find<FIND_STRUCTURES, StructureSpawn | StructureExtension | StructureTower>(FIND_STRUCTURES, { filter: s => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && !isBelongingToQuickEnergyFilling(s.pos) })
                if ( spawns.length > 0 ) return A.proc.OK
                else return A.proc.STOP_SLEEP
            } else return A.proc.STOP_SLEEP
        }, 
        () => C.acquire('transferer', roomName, name => transfererName = name), 
        [ 'withdrawSource', withdrawSource ], 
        () => gotoSpawn(() => transfererName, name => transfererName = name), 
        [ 'JUMP', () => true, 'withdrawSource' ]
    ], `${roomName} => Fill (withdraw)`)

    A.proc.trigger('after', Spawn.prototype, 'spawnCreep', (returnValue, spawn: StructureSpawn, ...args) => {
        if ( returnValue === OK && spawn.pos.roomName === roomName ) {
            if ( Game.rooms[roomName].controller.level < 6 ) return [ harvestAndFillPid ]
            else return [ withdrawAndFillPid ]
        }
        return []
    })
}