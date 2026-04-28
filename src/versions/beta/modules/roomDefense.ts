/**
 * 房间防御系统
 * 
 * 主要职能: 记录 hostile neighbours
 * 以及进行防御
 * 
 * 一个 attack 需要 3.5 个 Heal
 * 一个 ranged attack 需要 0.83 个 Heal
 */

import { Apollo as A } from "@/framework/apollo"
import { planModule as P } from "@/modules/plan"
import { creepModule as C } from "@/modules/creep"
import { transferModule as T } from '@/modules/transfer'
import { assertWithMsg, calcBodyEffectiveness, findDistanceTo, getFileNameAndLineNumber } from "@/utils"

export function registerDefendRoom() {
    C.design('defense_healer', {
        amount: 1, 
        body: {
            3: [ MOVE, MOVE, HEAL, HEAL ]
        }, 
        priority: C.PRIORITY_IMPORTANT
    })
    C.design('defense_attacker', {
        amount: 1, 
        body: {
            3: [ MOVE, MOVE, MOVE, MOVE, MOVE, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK ]
        }, 
        priority: C.PRIORITY_IMPORTANT
    })
}

function isDefenseNecessary(roomName: string) {
    const room = Game.rooms[roomName]
    if ( !room ) return false
    const towers = room.find(FIND_STRUCTURES, { filter: { structureType: STRUCTURE_TOWER } })
    const minimumEffectiveHitsPerTick = towers.length * 150
    const creeps = room.find(FIND_HOSTILE_CREEPS).filter(creep => _.filter(creep.body, desc => desc.type === ATTACK || desc.type === RANGED_ATTACK || desc.type === HEAL).length > 0)
    const maximumEffectiveHealPerTick = _.sum(_.map(creeps, creep => calcBodyEffectiveness(creep.body, HEAL, 'heal', 12)))
    return creeps.length > 0 && minimumEffectiveHitsPerTick <= maximumEffectiveHealPerTick
}

function issueRoomTowerDefend(roomName: string) {
    A.proc.createProc([
        () => P.exist(roomName, 'towers', 'tower'), 
        () => {
            if ( !Game.rooms[roomName] ) return [A.proc.STOP_ERR, `${roomName} 房间无视野`] as [ typeof A.proc.STOP_ERR, string ]
            const towers = Game.rooms[roomName].find<FIND_STRUCTURES, StructureTower>(FIND_STRUCTURES, { filter: { structureType: STRUCTURE_TOWER } })
            if ( towers.length === 0 ) return [A.proc.STOP_ERR, `${roomName} 房间无可用 Tower`] as [ typeof A.proc.STOP_ERR, string ]

            const hostileCreeps = Game.rooms[roomName].find(FIND_HOSTILE_CREEPS)
            if ( hostileCreeps.length > 0 ) {
                const hostileCreepsDesc = hostileCreeps.map(creep => {
                    return {creep, hasHeal: _.filter(creep.body, desc => desc.type === HEAL && desc.hits > 0).length > 0, hasAttack: _.filter(creep.body, desc => (desc.type === ATTACK || desc.type === RANGED_ATTACK) && desc.hits > 0).length > 0, range: towers[0].pos.getRangeTo(creep) }
                })

                const creepsWithHeal = hostileCreepsDesc.filter(({ hasHeal }) => hasHeal)
                const creepsWithAttack = hostileCreepsDesc.filter(({ hasAttack }) => hasAttack)

                // 第一优先: 最近 Healer
                let targetCreep = creepsWithHeal.length > 0 ? _.min(creepsWithHeal, ({range}) => range).creep : null
                // 第二优先: 最近 Attacker
                if ( !targetCreep ) targetCreep = creepsWithAttack.length > 0 ? _.min(creepsWithAttack, ({range}) => range).creep : null
                if ( !targetCreep ) targetCreep = hostileCreepsDesc[0].creep

                towers.forEach(tower => {
                    if ( A.res.query(tower.id, RESOURCE_ENERGY) >= TOWER_ENERGY_COST  ) {
                        if ( !!targetCreep ) {
                            assertWithMsg( A.res.request({ id: tower.id, resourceType: RESOURCE_ENERGY, amount: TOWER_ENERGY_COST }, 'issueTowerProc -> 396') === A.proc.OK, getFileNameAndLineNumber() )
                            A.timer.add(Game.time + 1, id => A.res.signal(id, A.res.CAPACITY_ENERGY, TOWER_ENERGY_COST), [ tower.id ], `更新塔 ${tower.id} 的容量`)
                            tower.attack(targetCreep)
                        }
                    }
                })
            }

            towers.forEach(tower => {
                if ( A.res.query(tower.id, A.res.CAPACITY_ENERGY) >= TOWER_CAPACITY / 2 ) {
                    const requestedSource = A.res.requestSource(roomName, RESOURCE_ENERGY, CARRY_CAPACITY, tower.pos, false)
                    if ( requestedSource.code === A.proc.OK && requestedSource.id ) {
                        const sourceId = requestedSource.id
                        const amount = Math.min(A.res.query(tower.id, A.res.CAPACITY_ENERGY), A.res.query(sourceId, RESOURCE_ENERGY))
                        if ( amount > 0 ) {
                            assertWithMsg( A.res.request({ id: tower.id, resourceType: A.res.CAPACITY_ENERGY, amount }) === A.proc.OK, `issueTowerProc -> 415` )
                            assertWithMsg( A.res.request({ id: sourceId, resourceType: RESOURCE_ENERGY, amount }) === A.proc.OK, `issueTowerProc -> 416` )
                            T.transfer( sourceId, tower.id, RESOURCE_ENERGY, amount, { priority: T.PRIORITY_IMPORTANT } )
                        }
                    }
                }
            })

            return A.proc.OK_STOP_CURRENT
        }
    ], `${roomName} => Tower`)
}

function issueRoomAttackHealDefend(roomName: string, safePos: RoomPosition) {
    let healerName = null
    let attackerName = null
    let healerSpawned = A.proc.signal.createSignal(0)
    let attackerSpawned = A.proc.signal.createSignal(0)

    // 不同于其余 lazy loading 模块
    // 即便不存在攻击者, 只要 healer 和 attacker 存活, 进程就一直执行
    // 目的是防止攻击者突然出现 以及 尽可能多利用 healer 和 attacker
    // 只有当 healer 和 attacker 消亡时, 再判断是否要继续维持

    const healerProcId = A.proc.createProc([
        () => C.acquire('defense_healer', roomName, name => {
            healerName = name
            A.proc.signal.Ssignal({ signalId: healerSpawned, request: 1 })
        }), 
        () => A.proc.signal.Swait({ signalId: attackerSpawned, lowerbound: 1, request: 0 }), 
        () => {
            const healer = Game.creeps[healerName]
            if ( !healer ) {
                C.cancel(healerName)
                healerName = null
                assertWithMsg( A.proc.signal.Swait({ signalId: healerSpawned, lowerbound: 1, request: 1 }) === A.proc.OK, getFileNameAndLineNumber() )

                if ( isDefenseNecessary(roomName) ) return [A.proc.STOP_ERR, `Creep 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
                else return A.proc.STOP_SLEEP
            }

            const attacker = Game.creeps[attackerName]
            if ( !attacker ) {
                // Heal Anyways
                healer.heal(healer)
            } else {
                // 选择自己 或者 Attacker 进行 Heal
                if ( attacker.hits < attacker.hitsMax && healer.hits === healer.hitsMax ) healer.heal(attacker)
                else if ( attacker.hits === attacker.hitsMax && healer.hits < healer.hitsMax ) healer.heal(healer)
                else if ( attacker.hits < attacker.hitsMax && healer.hits < healer.hitsMax ) {
                    if ( attacker.hitsMax - attacker.hits > healer.hitsMax - healer.hits ) healer.heal(attacker)
                    else healer.heal(healer)
                } else {
                    // 优先 Heal 自己
                    healer.heal(healer)
                }
            }
            
            if ( attacker ) {
                // Move Anyways
                healer.moveTo(attacker)
            } else {
                // 回到安全位置
                if ( healer.pos.getRangeTo(safePos) > 3 ) healer.moveTo(safePos)
            }
            
            return A.proc.OK_STOP_CURRENT
        }
    ], `${roomName} => Defense's Healer`, true)

    const attackerProcId = A.proc.createProc([
        () => C.acquire('defense_attacker', roomName, name => {
            attackerName = name
            A.proc.signal.Ssignal({ signalId: attackerSpawned, request: 1 })
        }), 
        () => A.proc.signal.Swait({ signalId: healerSpawned, lowerbound: 1, request: 0 }), 
        () => {
            const attacker = Game.creeps[attackerName]
            if ( !attacker ) {
                C.cancel(attackerName)
                attackerName = null
                assertWithMsg( A.proc.signal.Swait({ signalId: attackerSpawned, lowerbound: 1, request: 1 }) === A.proc.OK, getFileNameAndLineNumber() )

                if ( isDefenseNecessary(roomName) ) return [A.proc.STOP_ERR, `Creep 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
                else return A.proc.STOP_SLEEP
            }

            const healer = Game.creeps[healerName]
            if ( !healer ) {
                // 没有 Healer, 对自己进行保护
                if ( attacker.pos.getRangeTo(safePos) > 3 ) attacker.moveTo(safePos)
                return A.proc.OK_STOP_CURRENT
            }

            let hostileCreeps = attacker.room.find(FIND_HOSTILE_CREEPS).filter(creep => _.filter(creep.body, desc => desc.type === ATTACK || desc.type === RANGED_ATTACK || desc.type === HEAL).length > 0)

            if ( hostileCreeps.length === 0 ) hostileCreeps = attacker.room.find(FIND_HOSTILE_CREEPS).filter(creep => !creep.my)

            if ( hostileCreeps.length === 0 ) {
                attacker.say("🚬")
                attacker.travelTo(attacker.pos, { flee: true, ignoreCreeps: false, offRoad: true, avoidStructureTypes: [ STRUCTURE_CONTAINER, STRUCTURE_ROAD ] })
                return A.proc.OK_STOP_CURRENT
            }
            
            const hostileCreepsDesc = hostileCreeps.map(creep => {
                return {creep, hasHeal: _.filter(creep.body, desc => desc.type === HEAL && desc.hits > 0).length > 0, range: attacker.pos.getRangeTo(creep) }
            })

            // 第一优先: 有 Heal, range = 1
            let targetCreep = hostileCreepsDesc.find(({creep, hasHeal, range}) => hasHeal && range === 1)
            // 第二优先: 无 Heal, range = 1
            if ( !targetCreep ) targetCreep = hostileCreepsDesc.find(({ creep, hasHeal, range }) => range === 1)
            // 第三优先: 最近
            if ( !targetCreep ) targetCreep = _.min(hostileCreepsDesc, ({ range }) => range)
            // 攻击并移动
            attacker.attack(targetCreep.creep)
            attacker.moveTo(targetCreep.creep)

            if ( attacker.pos.getRangeTo(healer) > 1 ) {
                // 保证连接
                attacker.moveTo(healer)
            }

            return A.proc.OK_STOP_CURRENT
        }
    ], `${roomName} => Defense's Attacker`, true)

    A.proc.trigger('watch', () => {
        const condition = isDefenseNecessary(roomName)
        if ( condition && Game.rooms[roomName] && Game.rooms[roomName].energyCapacityAvailable < 600 && !Game.rooms[roomName].controller.safeMode ) {
            Game.rooms[roomName].controller.activateSafeMode()
        }
        return Game.rooms[roomName] && Game.rooms[roomName].energyAvailable >= 600 && condition
    }, [ healerProcId, attackerProcId ])
}

export function issueDefendProc(roomName: string) {
    const planInfo = P.plan(roomName, 'unit', 'centralSpawn')
    const safePos = new RoomPosition(planInfo.leftTops[0].x + 3, planInfo.leftTops[0].y, roomName)

    issueRoomAttackHealDefend(roomName, safePos)
    issueRoomTowerDefend(roomName)
}