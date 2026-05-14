/**
 * 🧪 Lab 模块
 * 
 * 主要是两个模式: 生产 和 Boost
 * 生产 时, 按照维持数量, 自动构建生产列表
 * Boost 时, 根据需要的矿物, 自动预约 Lab
 * 
 * 一次 runReaction 消耗原材料各 5 个, 然后合成 5 个
 */

import { Apollo as A } from '@/framework/apollo'
import { planModule as P } from '@/modules/plan'
import { getTransferUnit, transferModule as T } from "@/modules/transfer"
import { assertWithMsg, floorTo5X, getFileNameAndLineNumber, log, LOG_DEBUG, LOG_ERR } from "@/utils"
import { getCentralTransferUnit } from './centralTransfer'
import { getLabInfo, getStorageMinMaintainAmount, getTerminalBuyInfo, getTerminalMaintainAmount, getTerminalMaintainTypes, getTerminalMaxMaintainAmount, getTerminalMinMaintainAmount, getTerminalSellList } from '../config.production'

const MINERAL_ALL = [
    RESOURCE_HYDROGEN, 
    RESOURCE_OXYGEN, 
    RESOURCE_UTRIUM, 
    RESOURCE_LEMERGIUM, 
    RESOURCE_KEANIUM, 
    RESOURCE_ZYNTHIUM, 
    RESOURCE_CATALYST, 
    RESOURCE_GHODIUM
]

const BASE_ALL = [ ...MINERAL_ALL, RESOURCE_ENERGY ]

const RECIPES = {}
for ( const resourceU in REACTIONS ) {
    for ( const resourceV in REACTIONS[resourceU] )
        RECIPES[REACTIONS[resourceU][resourceV]] = [ resourceU, resourceV ]
}

function recommendNextProduction(roomName: string): [ MineralCompoundConstant, number ] {
    if( !Game.rooms[roomName] || !Game.rooms[roomName].storage ) return null
    const availableCapacity = A.res.query(Game.rooms[roomName].storage.id, A.res.CAPACITY)
    if ( availableCapacity <= 0 ) return null
    const labs = Game.rooms[roomName].find(FIND_STRUCTURES, { filter: { structureType: STRUCTURE_LAB } }) as StructureLab[]
    const productionInfo = getLabInfo()
    for ( const item of productionInfo ) {
        const availableAmount = A.res.query(Game.rooms[roomName].storage.id, item[0]) + _.sum(_.map(labs, l => A.res.query(l.id, item[0])))
        if ( availableAmount >= item[1].min ) continue
        const gap = item[1].max - availableAmount
        const Q: [ [ MineralCompoundConstant, number ] ] = [ [ item[0], gap ] ]
        let ptr = 0
        while ( ptr < Q.length ) {
            const front = Q[ptr]
            if ( !(front[0] in RECIPES) ) break
            const componentU = [ RECIPES[front[0]][0], front[1] - A.res.query(Game.rooms[roomName].storage.id, RECIPES[front[0]][0]) - _.sum(_.map(labs, l => A.res.query(l.id, RECIPES[front[0]][0]))) ]
            const componentV = [ RECIPES[front[0]][1], front[1] - A.res.query(Game.rooms[roomName].storage.id, RECIPES[front[0]][1]) - _.sum(_.map(labs, l => A.res.query(l.id, RECIPES[front[0]][1]))) ]
            // 此时原材料已充足, 可以合成了
            if ( componentU[1] <= 0 && componentV[1] <= 0 ) {
                return [ front[0], floorTo5X(Math.min(front[1], availableCapacity, LAB_MINERAL_CAPACITY)) ]
            }
            if ( componentU[1] > 0 ) {
                // 缺乏基础材料, 跳过了
                if ( _.includes(BASE_ALL, componentU[0]) ) break
                Q.push([ componentU[0], componentU[1] ])
            }
            if ( componentV[1] > 0 ) {
                // 缺乏基础材料, 跳过了
                if ( _.includes(BASE_ALL, componentV[0]) ) break
                Q.push([ componentV[0], componentV[1] ])
            }
            ptr++
        }
    }
    return null
}

/** 单个 Core Lab (核心两个) 的状态 */
class CoreLabStatus {
    productionSignal: string
    constructor() {

    }
}

/** 单个 Sub Lab (非核心两个) 的状态 */
class SubLabStatus {
    productionSignal: string
    product: MineralCompoundConstant
    constructor() {

    }
}

class Labs {
    roomName: string
    productSignal: string
    productCurrent: {
        resourceType: MineralCompoundConstant
        totalAmount: number
        remainingAmountSignal: string
        haveReactAmountSignal: string
        assignedResourceForCoreLab0: MineralCompoundConstant | MineralConstant
        assignedResourceForCoreLab1: MineralCompoundConstant | MineralConstant
    }
    constructor(roomName: string) {
        this.roomName = roomName
        this.productSignal = A.proc.signal.createSignal(1)
        this.productCurrent = {
            resourceType: null, totalAmount: 0, remainingAmountSignal: A.proc.signal.createSignal(0), haveReactAmountSignal: A.proc.signal.createSignal(0), 
            assignedResourceForCoreLab0: null, assignedResourceForCoreLab1: null
        }
        const resetProductCurrent = () => {
            A.proc.signal.destroySignal(this.productCurrent.remainingAmountSignal)
            A.proc.signal.destroySignal(this.productCurrent.haveReactAmountSignal)
            this.productCurrent = {
                resourceType: null, totalAmount: 0, remainingAmountSignal: A.proc.signal.createSignal(0), haveReactAmountSignal: A.proc.signal.createSignal(0), 
                assignedResourceForCoreLab0: null, assignedResourceForCoreLab1: null
            }
        }
        const planInfo = P.plan(roomName, "unit", "labUnit")
        assertWithMsg( !!planInfo, `为 ${roomName} 创建 Lab 管理模块, Lab 必须可被规划` )
        const leftTop = planInfo.leftTops[0]
        const labPoses = {
            'subLab0': { x: leftTop.x + 1, y: leftTop.y + 0 }, 
            'subLab1': { x: leftTop.x + 2, y: leftTop.y + 0 }, 
            'subLab2': { x: leftTop.x + 0, y: leftTop.y + 1 }, 
            'subLab3': { x: leftTop.x + 0, y: leftTop.y + 2 }, 
            'subLab4': { x: leftTop.x + 3, y: leftTop.y + 1 }, 
            'subLab5': { x: leftTop.x + 3, y: leftTop.y + 2 }, 
            'subLab6': { x: leftTop.x + 1, y: leftTop.y + 3 }, 
            'subLab7': { x: leftTop.x + 2, y: leftTop.y + 3 }, 
            'coreLab0': { x: leftTop.x + 1, y: leftTop.y + 1 }, 
            'coreLab1': { x: leftTop.x + 2, y: leftTop.y + 2 }
        }

        const getLabAtPos: (pos: Pos | { x: number, y: number }) => StructureLab = pos => !!Game.rooms[roomName] ? Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, new RoomPosition(pos.x, pos.y, roomName)).filter(s => s.structureType === STRUCTURE_LAB)[0] as StructureLab || null : null

        /** 指挥生产进程 */
        A.proc.createProc([
            () => P.exist(roomName, 'centralTransfer', 'storage'), 
            () => P.exist(roomName, 'labUnit', 'coreLab0'), 
            () => P.exist(roomName, 'labUnit', 'coreLab1'), 
            () => P.exist(roomName, 'labUnit', 'subLabs'), 
            () => A.proc.signal.Swait({ signalId: this.productCurrent.haveReactAmountSignal, lowerbound: this.productCurrent.totalAmount, request: 0 }), 
            () => {
                assertWithMsg( A.proc.signal.getValue(this.productCurrent.haveReactAmountSignal) === this.productCurrent.totalAmount, `进行下一次生产规划时, 上一次生产应该完成! 0` )
                assertWithMsg( A.proc.signal.getValue(this.productCurrent.remainingAmountSignal) === 0, `进行下一次生产规划时, 上一次生产应该完成! 1` )
                
                resetProductCurrent()
                const nextProductInfo = recommendNextProduction(roomName)
                if ( !nextProductInfo ) return [ A.proc.STOP_SLEEP, CREEP_LIFE_TIME ] as [ typeof A.proc.STOP_SLEEP, number ]

                this.productCurrent.resourceType = nextProductInfo[0]
                this.productCurrent.totalAmount = nextProductInfo[1]
                assertWithMsg( A.proc.signal.Ssignal({ signalId: this.productCurrent.remainingAmountSignal, request: nextProductInfo[1] }) === A.proc.OK, getFileNameAndLineNumber() )
                const [ recipe0, recipe1 ] = RECIPES[nextProductInfo[0]]
                this.productCurrent.assignedResourceForCoreLab0 = recipe0
                this.productCurrent.assignedResourceForCoreLab1 = recipe1

                return A.proc.signal.Swait({ signalId: this.productCurrent.haveReactAmountSignal, lowerbound: this.productCurrent.totalAmount, request: 0 })
            }
        ], `指挥 ${roomName} Lab 生产`)
        
        let coreLab0Id: Id<StructureLab> = null
        let coreLab1Id: Id<StructureLab> = null
        let cleanUpSignal0: string = A.proc.signal.createSignal(0)
        let cleanUpSignal1: string = A.proc.signal.createSignal(0)
        let transferDoneSignal0: string = A.proc.signal.createSignal(1)
        let transferDoneSignal1: string = A.proc.signal.createSignal(1)
        A.proc.createProc([
            () => P.exist(roomName, 'centralTransfer', 'storage'), 
            () => P.exist(roomName, 'labUnit', 'coreLab0'), 
            () => {
                if ( !coreLab0Id ) {
                    const lab = getLabAtPos(labPoses[`coreLab0`])
                    if ( !lab ) return [ A.proc.STOP_ERR, `无法找到 Core Lab 0 ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                    coreLab0Id = lab.id
                }

                if ( !Game.getObjectById(coreLab0Id) ) {
                    coreLab0Id = null
                    return [ A.proc.STOP_ERR, `无法找到 Core Lab 0 ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                }

                if ( A.res.query(coreLab0Id, A.res.CAPACITY_ENERGY) < LAB_ENERGY_CAPACITY / 2 ) return A.res.request({ id: coreLab0Id, resourceType: A.res.CAPACITY_ENERGY, amount: { lowerbound: LAB_ENERGY_CAPACITY / 2, request: 0} })

                const capacity = A.res.query(coreLab0Id, A.res.CAPACITY_ENERGY)
                const ret = A.res.requestSource(roomName, RESOURCE_ENERGY, capacity)
                if ( !ret.id ) return ret.code
                const available = A.res.query(ret.id, RESOURCE_ENERGY)
                if ( available < capacity && available < getTransferUnit(Game.rooms[roomName].controller.level) ) return A.res.request({ id: ret.id, resourceType: RESOURCE_ENERGY, amount: { lowerbound: getTransferUnit(Game.rooms[roomName].controller.level), request: 0 } })
                const amount = Math.min(capacity, available)
                assertWithMsg( A.res.request({ id: coreLab0Id, resourceType: A.res.CAPACITY_ENERGY, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                assertWithMsg( A.res.request({ id: ret.id, resourceType: RESOURCE_ENERGY, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                T.transfer(ret.id, coreLab0Id, RESOURCE_ENERGY, amount)

                return A.proc.OK_STOP_CURRENT
            }
        ], `${roomName} => coreLab0: Fill Energy`)

        A.proc.createProc([
            () => P.exist(roomName, 'centralTransfer', 'storage'), 
            () => P.exist(roomName, 'labUnit', 'coreLab1'), 
            () => {
                if ( !coreLab1Id ) {
                    const lab = getLabAtPos(labPoses[`coreLab1`])
                    if ( !lab ) return [ A.proc.STOP_ERR, `无法找到 Core Lab 0 ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                    coreLab1Id = lab.id
                }

                if ( !Game.getObjectById(coreLab1Id) ) {
                    coreLab1Id = null
                    return [ A.proc.STOP_ERR, `无法找到 Core Lab 0 ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                }

                if ( A.res.query(coreLab1Id, A.res.CAPACITY_ENERGY) < LAB_ENERGY_CAPACITY / 2 ) return A.res.request({ id: coreLab1Id, resourceType: A.res.CAPACITY_ENERGY, amount: { lowerbound: LAB_ENERGY_CAPACITY / 2, request: 0} })

                const capacity = A.res.query(coreLab1Id, A.res.CAPACITY_ENERGY)
                const ret = A.res.requestSource(roomName, RESOURCE_ENERGY, capacity)
                if ( !ret.id ) return ret.code
                const available = A.res.query(ret.id, RESOURCE_ENERGY)
                if ( available < capacity && available < getTransferUnit(Game.rooms[roomName].controller.level) ) return A.res.request({ id: ret.id, resourceType: RESOURCE_ENERGY, amount: { lowerbound: getTransferUnit(Game.rooms[roomName].controller.level), request: 0 } })
                const amount = Math.min(capacity, available)
                assertWithMsg( A.res.request({ id: coreLab1Id, resourceType: A.res.CAPACITY_ENERGY, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                assertWithMsg( A.res.request({ id: ret.id, resourceType: RESOURCE_ENERGY, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                T.transfer(ret.id, coreLab1Id, RESOURCE_ENERGY, amount)

                return A.proc.OK_STOP_CURRENT
            }
        ], `${roomName} => coreLab1: Fill Energy`)

        A.proc.createProc([
            () => P.exist(roomName, 'centralTransfer', 'storage'), 
            () => P.exist(roomName, 'labUnit', 'coreLab0'), 
            () => P.exist(roomName, 'labUnit', 'coreLab1'), 
            () => P.exist(roomName, 'labUnit', 'subLabs'), 
            ['restart', () => A.proc.signal.Swait({ signalId: this.productCurrent.remainingAmountSignal, lowerbound: 5, request: 0 })],
            () => {
                // 先清理
                if ( !coreLab0Id ) {
                    const lab = getLabAtPos(labPoses[`coreLab0`])
                    if ( !lab ) return [ A.proc.STOP_ERR, `无法找到 Core Lab 0 ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                    coreLab0Id = lab.id
                }
                if ( !coreLab1Id ) {
                    const lab = getLabAtPos(labPoses[`coreLab1`])
                    if ( !lab ) return [ A.proc.STOP_ERR, `无法找到 Core Lab 1 ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                    coreLab1Id = lab.id
                }
                if ( !Game.getObjectById(coreLab0Id) || !Game.getObjectById(coreLab1Id) ) {
                    coreLab0Id = null
                    coreLab1Id = null
                    return [ A.proc.STOP_ERR, `无法找到 Core Lab 0/1 ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                }
                const lab0 = Game.getObjectById(coreLab0Id)
                if ( !!lab0.mineralType && lab0.mineralType !== this.productCurrent[`assignedResourceForCoreLab0`] && A.res.query(lab0.id, lab0.mineralType) > 0 ) {
                    const storage = Game.rooms[roomName].storage
                    if ( !storage ) return [ A.proc.STOP_ERR, `无法找到 Storage ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                    const amount = A.res.query(lab0.id, lab0.mineralType)
                    const capacity = A.res.query(storage.id, A.res.CAPACITY)
                    if ( capacity < amount ) return A.res.request({ id: storage.id, resourceType: A.res.CAPACITY, amount: { lowerbound: amount, request: 0 } })
                    assertWithMsg( A.res.request({ id: storage.id, resourceType: A.res.CAPACITY, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                    assertWithMsg( A.res.request({ id: lab0.id, resourceType: lab0.mineralType, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                    T.transfer(lab0.id, storage.id, lab0.mineralType, amount, {
                        callback: () => A.proc.signal.Ssignal({ signalId: cleanUpSignal0, request: 1 })
                    })
                } else if ( !!lab0.mineralType && lab0.mineralType === this.productCurrent[`assignedResourceForCoreLab0`] && A.res.query(lab0.id, lab0.mineralType) > A.proc.signal.getValue(this.productCurrent.remainingAmountSignal) ) {
                    const storage = Game.rooms[roomName].storage
                    if ( !storage ) return [ A.proc.STOP_ERR, `无法找到 Storage ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                    const amount = A.res.query(lab0.id, lab0.mineralType) - A.proc.signal.getValue(this.productCurrent.remainingAmountSignal)
                    const capacity = A.res.query(storage.id, A.res.CAPACITY)
                    if ( capacity < amount ) return A.res.request({ id: storage.id, resourceType: A.res.CAPACITY, amount: { lowerbound: amount, request: 0 } })
                    assertWithMsg( A.res.request({ id: storage.id, resourceType: A.res.CAPACITY, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                    assertWithMsg( A.res.request({ id: lab0.id, resourceType: lab0.mineralType, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                    T.transfer(lab0.id, storage.id, lab0.mineralType, amount, {
                        callback: () => A.proc.signal.Ssignal({ signalId: cleanUpSignal0, request: 1 })
                    })
                } else A.proc.signal.Ssignal({ signalId: cleanUpSignal0, request: 1 })
                const lab1 = Game.getObjectById(coreLab1Id)
                if ( !!lab1.mineralType && lab1.mineralType !== this.productCurrent[`assignedResourceForCoreLab1`] && A.res.query(lab1.id, lab1.mineralType) > 0 ) {
                    const storage = Game.rooms[roomName].storage
                    if ( !storage ) return [ A.proc.STOP_ERR, `无法找到 Storage ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                    const amount = A.res.query(lab1.id, lab1.mineralType)
                    const capacity = A.res.query(storage.id, A.res.CAPACITY)
                    if ( capacity < amount ) return A.res.request({ id: storage.id, resourceType: A.res.CAPACITY, amount: { lowerbound: amount, request: 0 } })
                    assertWithMsg( A.res.request({ id: storage.id, resourceType: A.res.CAPACITY, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                    assertWithMsg( A.res.request({ id: lab1.id, resourceType: lab1.mineralType, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                    T.transfer(lab1.id, storage.id, lab1.mineralType, amount, {
                        callback: () => A.proc.signal.Ssignal({ signalId: cleanUpSignal1, request: 1 })
                    })
                } else if ( !!lab1.mineralType && lab1.mineralType === this.productCurrent[`assignedResourceForCoreLab1`] && A.res.query(lab1.id, lab1.mineralType) > A.proc.signal.getValue(this.productCurrent.remainingAmountSignal) ) {
                    const storage = Game.rooms[roomName].storage
                    if ( !storage ) return [ A.proc.STOP_ERR, `无法找到 Storage ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                    const amount = A.res.query(lab1.id, lab1.mineralType) - A.proc.signal.getValue(this.productCurrent.remainingAmountSignal)
                    const capacity = A.res.query(storage.id, A.res.CAPACITY)
                    if ( capacity < amount ) return A.res.request({ id: storage.id, resourceType: A.res.CAPACITY, amount: { lowerbound: amount, request: 0 } })
                    assertWithMsg( A.res.request({ id: storage.id, resourceType: A.res.CAPACITY, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                    assertWithMsg( A.res.request({ id: lab1.id, resourceType: lab1.mineralType, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                    T.transfer(lab1.id, storage.id, lab1.mineralType, amount, {
                        callback: () => A.proc.signal.Ssignal({ signalId: cleanUpSignal1, request: 1 })
                    })
                } else A.proc.signal.Ssignal({ signalId: cleanUpSignal1, request: 1 })
                return A.proc.OK
            }, 
            () => A.proc.signal.Swait({ signalId: cleanUpSignal0, lowerbound: 1, request: 0 }), 
            () => A.proc.signal.Swait({ signalId: cleanUpSignal1, lowerbound: 1, request: 0 }), 
            ['fill', () => {
                const remainingAmount = A.proc.signal.getValue(this.productCurrent.remainingAmountSignal)
                if ( remainingAmount <= 0 ) {
                    assertWithMsg( A.proc.signal.Swait({ signalId: cleanUpSignal0, lowerbound: 1, request: 1 }) === A.proc.OK, `${roomName}: Lab 0 Restart Cleanup` )
                    assertWithMsg( A.proc.signal.Swait({ signalId: cleanUpSignal1, lowerbound: 1, request: 1 }) === A.proc.OK, `${roomName}: Lab 1 Restart Cleanup` )
                    return [ A.proc.OK_STOP_CUSTOM, 'restart' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                }
                const storage = Game.rooms[roomName].storage
                if ( !storage || !Game.getObjectById(coreLab0Id) || !Game.getObjectById(coreLab1Id) ) {
                    coreLab0Id = null
                    coreLab1Id = null
                    return [ A.proc.STOP_ERR, `无法找到 Core Labs ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                }
                const lab0 = Game.getObjectById(coreLab0Id)
                const resourceType0 = this.productCurrent[`assignedResourceForCoreLab0`]
                const lab1 = Game.getObjectById(coreLab1Id)
                const resourceType1 = this.productCurrent[`assignedResourceForCoreLab1`]

                if ( !resourceType0 || !resourceType1 ) {
                    resetProductCurrent()
                    return [ A.proc.STOP_ERR, `${roomName}: 无有效 recipe` ] as [ typeof A.proc.STOP_ERR, string ]
                }

                const amount0 = Math.min(A.res.query(lab0.id, A.res.CAPACITY_MINERAL), remainingAmount - A.res.query(lab0.id, resourceType0))
                const amount1 = Math.min(A.res.query(lab1.id, A.res.CAPACITY_MINERAL), remainingAmount - A.res.query(lab1.id, resourceType1))
                if ( A.res.query(storage.id, resourceType0) < amount0 || A.res.query(storage.id, resourceType1) < amount1 ) {
                    resetProductCurrent()
                    return [ A.proc.STOP_ERR, `${roomName}: 无有效资源` ] as [ typeof A.proc.STOP_ERR, string ]
                }
                
                if ( amount0 > 0 ) {
                    assertWithMsg( A.res.request({ id: storage.id, resourceType: resourceType0, amount: amount0 }) === A.proc.OK, getFileNameAndLineNumber() )
                    assertWithMsg( A.res.request({ id: lab0.id, resourceType: A.res.CAPACITY_MINERAL, amount: amount0 }) === A.proc.OK, getFileNameAndLineNumber() )
                    assertWithMsg( A.proc.signal.Swait({ signalId: transferDoneSignal0, lowerbound: 1, request: 1 }) === A.proc.OK, getFileNameAndLineNumber() )
                    T.transfer(storage.id, lab0.id, resourceType0, amount0, {
                        callback: () => A.proc.signal.Ssignal({ signalId: transferDoneSignal0, request: 1 })
                    })
                }
                
                if ( amount1 > 0 ) {
                    assertWithMsg( A.res.request({ id: storage.id, resourceType: resourceType1, amount: amount1 }) === A.proc.OK, getFileNameAndLineNumber() )
                    assertWithMsg( A.res.request({ id: lab1.id, resourceType: A.res.CAPACITY_MINERAL, amount: amount1 }) === A.proc.OK, getFileNameAndLineNumber() )
                    assertWithMsg( A.proc.signal.Swait({ signalId: transferDoneSignal1, lowerbound: 1, request: 1 }) === A.proc.OK, getFileNameAndLineNumber() )
                    T.transfer(storage.id, lab1.id, resourceType1, amount1, {
                        callback: () => A.proc.signal.Ssignal({ signalId: transferDoneSignal1, request: 1 })
                    })
                }

                return A.proc.OK
            }], 
            () => A.proc.signal.Swait({ signalId: transferDoneSignal0, lowerbound: 1, request: 0 }), 
            () => A.proc.signal.Swait({ signalId: transferDoneSignal1, lowerbound: 1, request: 0 }), 
            ['JUMP', () => true, 'fill']
        ], `${roomName} Lab 生产: Core Labs`)
        
        for ( let subLabIdx = 0; subLabIdx < 8; ++subLabIdx ) {
            let subLabId: Id<StructureLab> = null
            let cleanUpSignal: string = A.proc.signal.createSignal(0)

            A.proc.createProc([
                () => P.exist(roomName, 'centralTransfer', 'storage'), 
                () => P.exist(roomName, 'labUnit', `subLab${subLabIdx}`), 
                () => {
                    if ( !subLabId ) {
                        const lab = getLabAtPos(labPoses[`subLab${subLabIdx}`])
                        if ( !lab ) return [ A.proc.STOP_ERR, `无法找到 Sub Lab ${subLabIdx} ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                        subLabId = lab.id
                    }

                    if ( !Game.getObjectById(subLabId) ) {
                        subLabId = null
                        return [ A.proc.STOP_ERR, `无法找到 Sub Lab ${subLabIdx} ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                    }

                    if ( A.res.query(subLabId, A.res.CAPACITY_ENERGY) < LAB_ENERGY_CAPACITY / 2 ) return A.res.request({ id: subLabId, resourceType: A.res.CAPACITY_ENERGY, amount: { lowerbound: LAB_ENERGY_CAPACITY / 2, request: 0} })

                    const capacity = A.res.query(subLabId, A.res.CAPACITY_ENERGY)
                    const ret = A.res.requestSource(roomName, RESOURCE_ENERGY, capacity)
                    if ( !ret.id ) return ret.code
                    const available = A.res.query(ret.id, RESOURCE_ENERGY)
                    if ( available < capacity && available < getTransferUnit(Game.rooms[roomName].controller.level) ) return A.res.request({ id: ret.id, resourceType: RESOURCE_ENERGY, amount: { lowerbound: getTransferUnit(Game.rooms[roomName].controller.level), request: 0 } })
                    const amount = Math.min(capacity, available)
                    assertWithMsg( A.res.request({ id: subLabId, resourceType: A.res.CAPACITY_ENERGY, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                    assertWithMsg( A.res.request({ id: ret.id, resourceType: RESOURCE_ENERGY, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                    T.transfer(ret.id, subLabId, RESOURCE_ENERGY, amount)

                    return A.proc.OK_STOP_CURRENT
                }
            ], `${roomName} => Sub Lab ${subLabIdx}: Fill Energy`)

            A.proc.createProc([
                () => P.exist(roomName, 'centralTransfer', 'storage'), 
                () => P.exist(roomName, 'labUnit', 'coreLab0'), 
                () => P.exist(roomName, 'labUnit', 'coreLab1'), 
                () => P.exist(roomName, 'labUnit', `subLab${subLabIdx}`), 
                ['restart', () => {
                    // 先清理
                    if ( !subLabId ) {
                        const lab = getLabAtPos(labPoses[`subLab${subLabIdx}`])
                        if ( !lab ) return [ A.proc.STOP_ERR, `无法找到 Sub Lab ${subLabIdx} ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                        subLabId = lab.id
                    }

                    if ( !Game.getObjectById(subLabId) ) {
                        subLabId = null
                        return [ A.proc.STOP_ERR, `无法找到 Sub Lab ${subLabIdx} ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                    }

                    const lab = Game.getObjectById(subLabId)
                    if ( !!lab.mineralType && A.res.query(lab.id, lab.mineralType) > 0 ) {
                        const storage = Game.rooms[roomName].storage
                        if ( !storage ) return [ A.proc.STOP_ERR, `无法找到 Storage ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                        const amount = A.res.query(lab.id, lab.mineralType)
                        const capacity = A.res.query(storage.id, A.res.CAPACITY)
                        if ( capacity < amount ) return A.res.request({ id: storage.id, resourceType: A.res.CAPACITY, amount: { lowerbound: amount, request: 0 } })
                        assertWithMsg( A.res.request({ id: storage.id, resourceType: A.res.CAPACITY, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                        assertWithMsg( A.res.request({ id: lab.id, resourceType: lab.mineralType, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                        T.transfer(lab.id, storage.id, lab.mineralType, amount, {
                            callback: () => A.proc.signal.Ssignal({ signalId: cleanUpSignal, request: 1 })
                        })
                    } else A.proc.signal.Ssignal({ signalId: cleanUpSignal, request: 1 })
                    return A.proc.OK
                }], 
                () => A.proc.signal.Swait({ signalId: cleanUpSignal, lowerbound: 1, request: 0 }), 
                () => A.proc.signal.Swait({ signalId: this.productCurrent.remainingAmountSignal, lowerbound: 5, request: 0 }), 
                () => {
                    const remainingAmount = A.proc.signal.getValue(this.productCurrent.remainingAmountSignal)
                    if ( remainingAmount <= 0 ) {
                        assertWithMsg( A.proc.signal.Swait({ signalId: cleanUpSignal, lowerbound: 1, request: 1 }) === A.proc.OK, `${roomName}: Sub Lab ${subLabIdx} Restart Cleanup` )
                        return [ A.proc.OK_STOP_CUSTOM, 'restart' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                    }
                    const subLab = Game.getObjectById(subLabId)
                    if ( !subLab ) {
                        subLabId = null
                        return [ A.proc.STOP_ERR, `无法找到 Sub Lab ${subLabIdx} ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                    }
                    // 触发储存
                    if ( A.res.query(subLab.id, this.productCurrent.resourceType) >= LAB_MINERAL_CAPACITY / 2 ) {
                        const storage = Game.rooms[roomName].storage
                        if ( !!storage ) {
                            const available = Math.min(A.res.query(subLab.id, this.productCurrent.resourceType), A.res.query(storage.id, A.res.CAPACITY))
                            if ( available > 0 ) {
                                assertWithMsg( A.res.request({ id: subLab.id, resourceType: this.productCurrent.resourceType, amount: available }) === A.proc.OK, getFileNameAndLineNumber() )
                                assertWithMsg( A.res.request({ id: storage.id, resourceType: A.res.CAPACITY, amount: available }) === A.proc.OK, getFileNameAndLineNumber() )
                                T.transfer(subLab.id, storage.id, this.productCurrent.resourceType, available)
                            }
                        }
                    }
                    if ( subLab.cooldown > 0 ) return [ A.proc.STOP_SLEEP, subLab.cooldown ] as [ typeof A.proc.STOP_SLEEP, number ]
                    if ( A.res.query(subLab.id, A.res.CAPACITY_MINERAL) < LAB_REACTION_AMOUNT ) return A.res.request({ id: subLab.id, resourceType: A.res.CAPACITY_MINERAL, amount: { lowerbound: LAB_REACTION_AMOUNT, request: 0 } })

                    const coreLab0 = getLabAtPos(labPoses['coreLab0'])
                    const coreLab1 = getLabAtPos(labPoses['coreLab1'])
                    if ( !coreLab0 || !coreLab1 ) {
                        subLabId = null
                        return [ A.proc.STOP_ERR, `无法找到 Core Labs ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                    }
                    if ( A.res.query(coreLab0.id, this.productCurrent.assignedResourceForCoreLab0) < LAB_REACTION_AMOUNT ) return A.res.request({ id: coreLab0.id, resourceType: this.productCurrent.assignedResourceForCoreLab0, amount: { lowerbound: LAB_REACTION_AMOUNT, request: 0 } })
                    if ( A.res.query(coreLab1.id, this.productCurrent.assignedResourceForCoreLab1) < LAB_REACTION_AMOUNT ) return A.res.request({ id: coreLab1.id, resourceType: this.productCurrent.assignedResourceForCoreLab1, amount: { lowerbound: LAB_REACTION_AMOUNT, request: 0 } })
                    
                    assertWithMsg( A.res.request({ id: subLab.id, resourceType: A.res.CAPACITY_MINERAL, amount: LAB_REACTION_AMOUNT }) === A.proc.OK, getFileNameAndLineNumber() )
                    assertWithMsg( A.res.request({ id: coreLab0.id, resourceType: this.productCurrent.assignedResourceForCoreLab0, amount: LAB_REACTION_AMOUNT }) === A.proc.OK, getFileNameAndLineNumber() )
                    assertWithMsg( A.res.request({ id: coreLab1.id, resourceType: this.productCurrent.assignedResourceForCoreLab1, amount: LAB_REACTION_AMOUNT }) === A.proc.OK, getFileNameAndLineNumber() )
                    assertWithMsg( subLab.runReaction(coreLab0, coreLab1) === OK, getFileNameAndLineNumber() )
                    assertWithMsg( A.proc.signal.Swait({ signalId: this.productCurrent.remainingAmountSignal, lowerbound: LAB_REACTION_AMOUNT, request: LAB_REACTION_AMOUNT }) === A.proc.OK, getFileNameAndLineNumber() )
                    A.timer.add(Game.time + 1, (subLabId, coreLab0Id, coreLab1Id) => {
                        A.res.signal(subLabId, this.productCurrent.resourceType, LAB_REACTION_AMOUNT)
                        A.res.signal(coreLab0Id, A.res.CAPACITY_MINERAL, LAB_REACTION_AMOUNT)
                        A.res.signal(coreLab1Id, A.res.CAPACITY_MINERAL, LAB_REACTION_AMOUNT)
                        A.proc.signal.Ssignal({ signalId: this.productCurrent.haveReactAmountSignal, request: LAB_REACTION_AMOUNT })
                    }, [ subLab.id, coreLab0.id, coreLab1.id ], `${roomName}: Sub Lab ${subLabIdx} 反应更新事件`)
                    return A.proc.OK_STOP_CURRENT
                }
            ], `${roomName} Lab 生产: Sub Lab ${subLabIdx}`)
        }
    }
}

const labRepo: { [roomName: string]: Labs } = {}

function getLabs(roomName: string) {
    if ( !(roomName in labRepo) ) labRepo[roomName] = new Labs(roomName)
    return labRepo[roomName]
}

class LabModule {
    reserve(roomName: string, compound: MineralBoostConstant, amount?: string) {

    }
    release(roomName: string, compound: MineralBoostConstant) {

    }
    boost(roomName: string, compound: MineralBoostConstant, getCreepName: () => string, setCreepName: (name: string) => void) {

    }
    constructor() {

    }
}

const labModule = new LabModule()
global.L = labModule

export function issueLabProc(roomName: string) {
    getLabs(roomName)
}