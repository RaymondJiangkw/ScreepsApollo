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
import { transferModule as T } from "@/modules/transfer"
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

const PRODUCTION_UNIT = 3000

function recommendNextProduction(roomName: string): [ MineralCompoundConstant, number ] {
    if( !Game.rooms[roomName] || !Game.rooms[roomName].storage ) return null
    const availableCapacity = A.res.query(Game.rooms[roomName].storage.id, A.res.CAPACITY)
    if ( availableCapacity <= 0 ) return null
    const labs = Game.rooms[roomName].find(FIND_STRUCTURES, { filter: { structureType: STRUCTURE_LAB } }) as StructureLab[]
    const productionInfo = _.filter(getLabInfo(), item => A.res.query(Game.rooms[roomName].storage.id, item[0]) + _.sum(_.map(labs, l => A.res.query(l.id, item[0]))) < item[1].min)
    // 每次推荐时, 以 某一个单位 为单位生产
    // 比如: 先生产 A, B, C, ... 3000 个, 再生产 A, B, C, ... 3000 个
    const maxMaintainAmount = _.max(_.map(productionInfo, item => item[1].max))
    for ( let maintainRoundIdx = 0; maintainRoundIdx < Math.ceil(maxMaintainAmount / PRODUCTION_UNIT); ++maintainRoundIdx ) {
        const currentRoundThreshold = (maintainRoundIdx + 1) * PRODUCTION_UNIT
        for ( const item of _.filter(productionInfo, item => A.res.query(Game.rooms[roomName].storage.id, item[0]) + _.sum(_.map(labs, l => A.res.query(l.id, item[0]))) < currentRoundThreshold) ) {
            const availableAmount = A.res.query(Game.rooms[roomName].storage.id, item[0]) + _.sum(_.map(labs, l => A.res.query(l.id, item[0])))
            const gap = Math.min(Math.min(item[1].max, currentRoundThreshold) - availableAmount, PRODUCTION_UNIT)
            const Q: [ [ MineralCompoundConstant, number ] ] = [ [ item[0], gap ] ]
            let ptr = 0
            while ( ptr < Q.length ) {
                const front = Q[ptr]
                if ( !(front[0] in RECIPES) ) {
                    ptr++
                    continue
                }
                const availableComponentUAmount = A.res.query(Game.rooms[roomName].storage.id, RECIPES[front[0]][0]) + _.sum(_.map(labs, l => A.res.query(l.id, RECIPES[front[0]][0])))
                const availableComponentVAmount = A.res.query(Game.rooms[roomName].storage.id, RECIPES[front[0]][1]) + _.sum(_.map(labs, l => A.res.query(l.id, RECIPES[front[0]][1])))
                // 此时原材料已充足, 可以合成了
                if ( Math.min(availableComponentUAmount, availableComponentVAmount, front[1]) >= 5 ) {
                    return [ front[0], floorTo5X(Math.min(front[1], availableComponentUAmount, availableComponentVAmount, availableCapacity, LAB_MINERAL_CAPACITY)) ]
                }
                const componentU = [ RECIPES[front[0]][0], front[1] - availableComponentUAmount ]
                const componentV = [ RECIPES[front[0]][1], front[1] - availableComponentVAmount ]
                
                if ( componentU[1] > 0 && !_.includes(BASE_ALL, componentU[0]) ) {
                    Q.push([ componentU[0], componentU[1] ])
                }
                if ( componentV[1] > 0 && !_.includes(BASE_ALL, componentV[0]) ) {
                    Q.push([ componentV[0], componentV[1] ])
                }
                ptr++
            }
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

type LabNames = 'coreLab0' | 'coreLab1' | 'subLab0' | 'subLab1' | 'subLab2' | 'subLab3' | 'subLab4' | 'subLab5' | 'subLab6' | 'subLab7'

class Labs {
    roomName: string
    labPoses: { [labName in LabNames]: { x: number, y: number } }
    mineral2lab: { [mineralType in MineralBoostConstant]? : LabNames }
    lab2Mineral: { [labName in LabNames]?: MineralBoostConstant }
    mineral2amount: { [mineralType in MineralBoostConstant]?  : string }
    hasFreeLab: string
    productSignal: { [labName in LabNames]: string }
    boostSignal: { [labName in LabNames]: string }
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
        this.mineral2lab = {}
        this.lab2Mineral = {}
        this.mineral2amount = {}
        this.hasFreeLab = A.proc.signal.createSignal(0)
        this.productSignal = {
            'coreLab0': A.proc.signal.createSignal(1), 
            'coreLab1': A.proc.signal.createSignal(1), 
            'subLab0': A.proc.signal.createSignal(1), 
            'subLab1': A.proc.signal.createSignal(1), 
            'subLab2': A.proc.signal.createSignal(1), 
            'subLab3': A.proc.signal.createSignal(1), 
            'subLab4': A.proc.signal.createSignal(1), 
            'subLab5': A.proc.signal.createSignal(1), 
            'subLab6': A.proc.signal.createSignal(1), 
            'subLab7': A.proc.signal.createSignal(1), 
        }
        this.boostSignal = {
            'coreLab0': A.proc.signal.createSignal(0), 
            'coreLab1': A.proc.signal.createSignal(0), 
            'subLab0': A.proc.signal.createSignal(0), 
            'subLab1': A.proc.signal.createSignal(0), 
            'subLab2': A.proc.signal.createSignal(0), 
            'subLab3': A.proc.signal.createSignal(0), 
            'subLab4': A.proc.signal.createSignal(0), 
            'subLab5': A.proc.signal.createSignal(0), 
            'subLab6': A.proc.signal.createSignal(0), 
            'subLab7': A.proc.signal.createSignal(0), 
        }
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
        this.labPoses = labPoses

        const getLabAtPos: (pos: Pos | { x: number, y: number }) => StructureLab = pos => !!Game.rooms[roomName] ? Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, new RoomPosition(pos.x, pos.y, roomName)).filter(s => s.structureType === STRUCTURE_LAB)[0] as StructureLab || null : null

        /** 指挥生产进程 */
        A.proc.createProc([
            () => P.exist(roomName, 'centralTransfer', 'storage'), 
            () => P.exist(roomName, 'labUnit', 'coreLab0'), 
            () => P.exist(roomName, 'labUnit', 'coreLab1'), 
            () => P.exist(roomName, 'labUnit', 'subLabs'), 
            () => A.proc.signal.Swait({ signalId: this.productCurrent.haveReactAmountSignal, lowerbound: this.productCurrent.totalAmount, request: 0 }), 
            () => {
                assertWithMsg( A.proc.signal.getValue(this.productCurrent.haveReactAmountSignal) === this.productCurrent.totalAmount, `进行下一次生产规划时, 上一次生产应该完成! 0 ${A.proc.signal.getValue(this.productCurrent.haveReactAmountSignal)}, ${this.productCurrent.totalAmount}` )
                assertWithMsg( A.proc.signal.getValue(this.productCurrent.remainingAmountSignal) === 0, `进行下一次生产规划时, 上一次生产应该完成! 1 ${A.proc.signal.getValue(this.productCurrent.remainingAmountSignal)}` )
                
                resetProductCurrent()
                const nextProductInfo = recommendNextProduction(roomName)
                if ( !nextProductInfo ) return [ A.proc.STOP_SLEEP, CREEP_LIFE_TIME ] as [ typeof A.proc.STOP_SLEEP, number ]

                this.productCurrent.resourceType = nextProductInfo[0]
                this.productCurrent.totalAmount = nextProductInfo[1]
                assertWithMsg( A.proc.signal.Ssignal({ signalId: this.productCurrent.remainingAmountSignal, request: nextProductInfo[1] }) === A.proc.OK, getFileNameAndLineNumber() )
                const [ recipe0, recipe1 ] = RECIPES[nextProductInfo[0]]
                this.productCurrent.assignedResourceForCoreLab0 = recipe0
                this.productCurrent.assignedResourceForCoreLab1 = recipe1

                // console.log(this.productCurrent.resourceType, this.productCurrent.totalAmount, A.proc.signal.getValue(this.productCurrent.remainingAmountSignal), A.proc.signal.getValue(this.productCurrent.haveReactAmountSignal))

                return A.proc.signal.Swait({ signalId: this.productCurrent.haveReactAmountSignal, lowerbound: this.productCurrent.totalAmount, request: 0 })
            }
        ], `指挥 ${roomName} Lab 生产`)
        
        let coreLab0Id: Id<StructureLab> = null
        let coreLab1Id: Id<StructureLab> = null
        let cleanUpSignal0: string = A.proc.signal.createSignal(0)
        let cleanUpSignal1: string = A.proc.signal.createSignal(0)
        let transferDoneSignal0: string = A.proc.signal.createSignal(1)
        let transferDoneSignal1: string = A.proc.signal.createSignal(1)
        let mineralCleanUpSignal0: string = A.proc.signal.createSignal(0)
        let mineralCleanUpSignal1: string = A.proc.signal.createSignal(0)
        let mineralTransferDoneSignal0: string = A.proc.signal.createSignal(1)
        let mineralTransferDoneSignal1: string = A.proc.signal.createSignal(1)
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

                if ( A.res.query(coreLab0Id, A.res.CAPACITY_ENERGY) <= 0 ) return A.res.request({ id: coreLab0Id, resourceType: A.res.CAPACITY_ENERGY, amount: { lowerbound: 1, request: 0} })

                const capacity = A.res.query(coreLab0Id, A.res.CAPACITY_ENERGY)
                const ret = A.res.requestSource(roomName, RESOURCE_ENERGY, capacity)
                if ( !ret.id ) return ret.code
                const available = A.res.query(ret.id, RESOURCE_ENERGY)
                if ( available <= 0 ) return A.res.request({ id: ret.id, resourceType: RESOURCE_ENERGY, amount: { lowerbound: 1, request: 0 } })
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

                if ( A.res.query(coreLab1Id, A.res.CAPACITY_ENERGY) <= 0 ) return A.res.request({ id: coreLab1Id, resourceType: A.res.CAPACITY_ENERGY, amount: { lowerbound: 1, request: 0} })

                const capacity = A.res.query(coreLab1Id, A.res.CAPACITY_ENERGY)
                const ret = A.res.requestSource(roomName, RESOURCE_ENERGY, capacity)
                if ( !ret.id ) return ret.code
                const available = A.res.query(ret.id, RESOURCE_ENERGY)
                if ( available <= 0 ) return A.res.request({ id: ret.id, resourceType: RESOURCE_ENERGY, amount: { lowerbound: 1, request: 0 } })
                const amount = Math.min(capacity, available)
                assertWithMsg( A.res.request({ id: coreLab1Id, resourceType: A.res.CAPACITY_ENERGY, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                assertWithMsg( A.res.request({ id: ret.id, resourceType: RESOURCE_ENERGY, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                T.transfer(ret.id, coreLab1Id, RESOURCE_ENERGY, amount)

                return A.proc.OK_STOP_CURRENT
            }
        ], `${roomName} => coreLab1: Fill Energy`)

        A.proc.createProc([
            () => P.exist(roomName, 'centralTransfer', 'storage'), 
            () => P.exist(roomName, 'labUnit', `coreLab0`), 
            ['waitForBoost', () => A.proc.signal.Swait({ signalId: this.boostSignal[`coreLab0`], lowerbound: 1, request: 0 })], 
            ['clean', () => {
                // 先清理
                if ( !coreLab0Id ) {
                    const lab = getLabAtPos(labPoses[`coreLab0`])
                    if ( !lab ) return [ A.proc.STOP_ERR, `无法找到 Core Lab 0 ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                    coreLab0Id = lab.id
                }

                if ( !Game.getObjectById(coreLab0Id) ) {
                    coreLab0Id = null
                    return [ A.proc.STOP_ERR, `无法找到 Core Lab 0 ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                }

                const lab = Game.getObjectById(coreLab0Id)
                if ( !!lab.mineralType && A.res.query(lab.id, lab.mineralType) > 0 ) {
                    const storage = Game.rooms[roomName].storage
                    if ( !storage ) return [ A.proc.STOP_ERR, `无法找到 Storage ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                    const amount = A.res.query(lab.id, lab.mineralType)
                    const capacity = A.res.query(storage.id, A.res.CAPACITY)
                    if ( capacity < amount ) return A.res.request({ id: storage.id, resourceType: A.res.CAPACITY, amount: { lowerbound: amount, request: 0 } })
                    assertWithMsg( A.res.request({ id: storage.id, resourceType: A.res.CAPACITY, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                    assertWithMsg( A.res.request({ id: lab.id, resourceType: lab.mineralType, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                    T.transfer(lab.id, storage.id, lab.mineralType, amount, {
                        callback: () => A.proc.signal.Ssignal({ signalId: mineralCleanUpSignal0, request: 1 })
                    })
                } else if ( !!lab.mineralType && lab.store[lab.mineralType] > 0 ) {
                    // 此时正在被别的清理
                    return A.res.request({ id: lab.id, resourceType: A.res.CAPACITY_MINERAL, amount: { lowerbound: LAB_MINERAL_CAPACITY, request: 0 } })
                } else if ( !lab.mineralType || lab.store[lab.mineralType] <= 0 ) {
                    A.proc.signal.Ssignal({ signalId: mineralCleanUpSignal0, request: 1 })
                }
                return A.proc.OK
            }], 
            () => A.proc.signal.Swait({ signalId: mineralCleanUpSignal0, lowerbound: 1, request: 0 }), 
            ['refill', () => {
                if ( !(`coreLab0` in this.lab2Mineral) || !this.mineral2amount[this.lab2Mineral[`coreLab0`]] ) return [ A.proc.OK_STOP_CUSTOM, 'waitForBoost' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                
                if ( !coreLab0Id ) {
                    const lab = getLabAtPos(labPoses[`coreLab0`])
                    if ( !lab ) return [ A.proc.STOP_ERR, `无法找到 Core Lab 0 ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                    coreLab0Id = lab.id
                }

                if ( !Game.getObjectById(coreLab0Id) ) {
                    coreLab0Id = null
                    return [ A.proc.STOP_ERR, `无法找到 Core Lab 0 ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                }

                const lab = Game.getObjectById(coreLab0Id)

                const storage = Game.rooms[roomName].storage
                const amount = A.proc.signal.getValue(this.mineral2amount[this.lab2Mineral[`coreLab0`]])
                const capacity = A.res.query(lab.id, A.res.CAPACITY_MINERAL)
                if ( amount <= 0 ) return A.proc.signal.Swait({ signalId: this.mineral2amount[this.lab2Mineral[`coreLab0`]], lowerbound: 1, request: 0 })
                if ( capacity <= 0 ) return A.res.request({ id: lab.id, resourceType: A.res.CAPACITY_MINERAL, amount: { lowerbound: 1, request: 0 } })
                const transferAmount = Math.min(amount, capacity)
                assertWithMsg( A.res.request({ id: lab.id, resourceType: A.res.CAPACITY_MINERAL, amount: transferAmount }) === A.proc.OK, getFileNameAndLineNumber() )
                // 已经预约过
                // assertWithMsg( A.res.request({ id: storage.id, resourceType: this.lab2Mineral[`coreLab0`], amount: transferAmount }) === A.proc.OK, getFileNameAndLineNumber() )
                assertWithMsg( A.proc.signal.Swait({ signalId: mineralTransferDoneSignal0, lowerbound: 1, request: 1 }) === A.proc.OK, getFileNameAndLineNumber() )
                T.transfer(storage.id, lab.id, this.lab2Mineral[`coreLab0`], transferAmount, { callback: () => {
                    assertWithMsg( A.proc.signal.Swait({ signalId: this.mineral2amount[this.lab2Mineral[`coreLab0`]], lowerbound: transferAmount, request: transferAmount }) === A.proc.OK, getFileNameAndLineNumber() )
                    assertWithMsg( A.proc.signal.Ssignal({ signalId: mineralTransferDoneSignal0, request: 1 }) === A.proc.OK, getFileNameAndLineNumber() )
                } })
                return A.proc.OK
            }], 
            () => A.proc.signal.Swait({ signalId: mineralTransferDoneSignal0, lowerbound: 1, request: 0 }), 
            () => {
                return [ A.proc.OK_STOP_CUSTOM, `refill` ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            }
        ], `${roomName} Core Lab 0: Fill Mineral`)

        A.proc.createProc([
            () => P.exist(roomName, 'centralTransfer', 'storage'), 
            () => P.exist(roomName, 'labUnit', `coreLab1`), 
            ['waitForBoost', () => A.proc.signal.Swait({ signalId: this.boostSignal[`coreLab1`], lowerbound: 1, request: 0 })], 
            ['clean', () => {
                // 先清理
                if ( !coreLab1Id ) {
                    const lab = getLabAtPos(labPoses[`coreLab1`])
                    if ( !lab ) return [ A.proc.STOP_ERR, `无法找到 Core Lab 1 ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                    coreLab1Id = lab.id
                }

                if ( !Game.getObjectById(coreLab1Id) ) {
                    coreLab1Id = null
                    return [ A.proc.STOP_ERR, `无法找到 Core Lab 1 ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                }

                const lab = Game.getObjectById(coreLab1Id)
                if ( !!lab.mineralType && A.res.query(lab.id, lab.mineralType) > 0 ) {
                    const storage = Game.rooms[roomName].storage
                    if ( !storage ) return [ A.proc.STOP_ERR, `无法找到 Storage ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                    const amount = A.res.query(lab.id, lab.mineralType)
                    const capacity = A.res.query(storage.id, A.res.CAPACITY)
                    if ( capacity < amount ) return A.res.request({ id: storage.id, resourceType: A.res.CAPACITY, amount: { lowerbound: amount, request: 0 } })
                    assertWithMsg( A.res.request({ id: storage.id, resourceType: A.res.CAPACITY, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                    assertWithMsg( A.res.request({ id: lab.id, resourceType: lab.mineralType, amount }) === A.proc.OK, getFileNameAndLineNumber() )
                    T.transfer(lab.id, storage.id, lab.mineralType, amount, {
                        callback: () => A.proc.signal.Ssignal({ signalId: mineralCleanUpSignal1, request: 1 })
                    })
                } else if ( !!lab.mineralType && lab.store[lab.mineralType] > 0 ) {
                    // 此时正在被别的清理
                    return A.res.request({ id: lab.id, resourceType: A.res.CAPACITY_MINERAL, amount: { lowerbound: LAB_MINERAL_CAPACITY, request: 0 } })
                } else if ( !lab.mineralType || lab.store[lab.mineralType] <= 0 ) {
                    A.proc.signal.Ssignal({ signalId: mineralCleanUpSignal1, request: 1 })
                }
                return A.proc.OK
            }], 
            () => A.proc.signal.Swait({ signalId: mineralCleanUpSignal1, lowerbound: 1, request: 0 }), 
            ['refill', () => {
                if ( !(`coreLab1` in this.lab2Mineral) || !this.mineral2amount[this.lab2Mineral[`coreLab1`]] ) return [ A.proc.OK_STOP_CUSTOM, 'waitForBoost' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                
                if ( !coreLab1Id ) {
                    const lab = getLabAtPos(labPoses[`coreLab1`])
                    if ( !lab ) return [ A.proc.STOP_ERR, `无法找到 Core Lab 1 ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                    coreLab1Id = lab.id
                }

                if ( !Game.getObjectById(coreLab1Id) ) {
                    coreLab1Id = null
                    return [ A.proc.STOP_ERR, `无法找到 Core Lab 1 ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                }

                const lab = Game.getObjectById(coreLab1Id)

                const storage = Game.rooms[roomName].storage
                const amount = A.proc.signal.getValue(this.mineral2amount[this.lab2Mineral[`coreLab1`]])
                const capacity = A.res.query(lab.id, A.res.CAPACITY_MINERAL)
                if ( amount <= 0 ) return A.proc.signal.Swait({ signalId: this.mineral2amount[this.lab2Mineral[`coreLab1`]], lowerbound: 1, request: 0 })
                if ( capacity <= 0 ) return A.res.request({ id: lab.id, resourceType: A.res.CAPACITY_MINERAL, amount: { lowerbound: 1, request: 0 } })
                const transferAmount = Math.min(amount, capacity)
                assertWithMsg( A.res.request({ id: lab.id, resourceType: A.res.CAPACITY_MINERAL, amount: transferAmount }) === A.proc.OK, getFileNameAndLineNumber() )
                // 已经预约过
                // assertWithMsg( A.res.request({ id: storage.id, resourceType: this.lab2Mineral[`coreLab1`], amount: transferAmount }) === A.proc.OK, getFileNameAndLineNumber() )
                assertWithMsg( A.proc.signal.Swait({ signalId: mineralTransferDoneSignal1, lowerbound: 1, request: 1 }) === A.proc.OK, getFileNameAndLineNumber() )
                T.transfer(storage.id, lab.id, this.lab2Mineral[`coreLab1`], transferAmount, { callback: () => {
                    assertWithMsg( A.proc.signal.Swait({ signalId: this.mineral2amount[this.lab2Mineral[`coreLab1`]], lowerbound: transferAmount, request: transferAmount }) === A.proc.OK, getFileNameAndLineNumber() )
                    assertWithMsg( A.proc.signal.Ssignal({ signalId: mineralTransferDoneSignal1, request: 1 }) === A.proc.OK, getFileNameAndLineNumber() )
                } })
                return A.proc.OK
            }], 
            () => A.proc.signal.Swait({ signalId: mineralTransferDoneSignal1, lowerbound: 1, request: 0 }), 
            () => {
                return [ A.proc.OK_STOP_CUSTOM, `refill` ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            }
        ], `${roomName} Core Lab 1: Fill Mineral`)

        A.proc.createProc([
            () => P.exist(roomName, 'centralTransfer', 'storage'), 
            () => P.exist(roomName, 'labUnit', 'coreLab0'), 
            () => P.exist(roomName, 'labUnit', 'coreLab1'), 
            () => P.exist(roomName, 'labUnit', 'subLabs'), 
            ['waitForProduction', () => A.proc.signal.Swait({ signalId: this.productSignal['coreLab0'], lowerbound: 1, request: 0 }, { signalId: this.productSignal['coreLab1'], lowerbound: 1, request: 0 })], 
            () => {
                if ( A.proc.signal.getValue(this.productSignal[`coreLab0`]) === 1 && A.proc.signal.getValue(this.hasFreeLab) === 0 ) A.proc.signal.Ssignal({ signalId: this.hasFreeLab, request: 1 })
                if ( A.proc.signal.getValue(this.productSignal[`coreLab1`]) === 1 && A.proc.signal.getValue(this.hasFreeLab) === 0 ) A.proc.signal.Ssignal({ signalId: this.hasFreeLab, request: 1 })
                return A.proc.OK
            }, 
            ['restart', () => A.proc.signal.Swait({ signalId: this.productCurrent.remainingAmountSignal, lowerbound: 5, request: 0 })],
            () => {
                if ( A.proc.signal.getValue(this.productSignal[`coreLab0`]) === 0 || A.proc.signal.getValue(this.productSignal[`coreLab1`]) === 0 ) {
                    return [ A.proc.OK_STOP_CUSTOM, 'waitForProduction' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                }
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
                if ( A.proc.signal.getValue(this.productSignal[`coreLab0`]) === 0 || A.proc.signal.getValue(this.productSignal[`coreLab1`]) === 0 ) {
                    return [ A.proc.OK_STOP_CUSTOM, 'waitForProduction' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                }

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
                if ( amount0 <= 0 && amount1 <= 0 ) {
                    // 此时不需要任何补充了, 数量已经足够了
                    return A.proc.signal.Swait({ signalId: this.productCurrent.haveReactAmountSignal, lowerbound: this.productCurrent.totalAmount, request: 0 })
                }

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
            () => {
                if ( A.proc.signal.getValue(this.productSignal[`coreLab0`]) === 0 || A.proc.signal.getValue(this.productSignal[`coreLab1`]) === 0 ) {
                    return [ A.proc.OK_STOP_CUSTOM, 'waitForProduction' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                }

                if ( !Game.getObjectById(coreLab0Id) || !Game.getObjectById(coreLab1Id) ) {
                    coreLab0Id = null
                    coreLab1Id = null
                    return [ A.proc.STOP_ERR, `无法找到 Core Labs ${roomName}` ] as [ typeof A.proc.STOP_ERR, string ]
                }
                const lab0 = Game.getObjectById(coreLab0Id)
                const lab1 = Game.getObjectById(coreLab1Id)

                if ( A.res.query(lab0.id, A.res.CAPACITY_MINERAL) < LAB_MINERAL_CAPACITY / 2 && A.res.query(lab1.id, A.res.CAPACITY_MINERAL) < LAB_MINERAL_CAPACITY / 2 ) return A.res.request([{ id: lab0.id, resourceType: A.res.CAPACITY_MINERAL, amount: { lowerbound: LAB_MINERAL_CAPACITY / 2, request: 0 } }, { id: lab1.id, resourceType: A.res.CAPACITY_MINERAL, amount: { lowerbound: LAB_MINERAL_CAPACITY / 2, request: 0 } }])

                return [ A.proc.OK_STOP_CUSTOM, 'fill' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            }
        ], `${roomName} Lab 生产: Core Labs`)
        
        for ( let subLabIdx = 0; subLabIdx < 8; ++subLabIdx ) {
            let subLabId: Id<StructureLab> = null
            let cleanUpSignal: string = A.proc.signal.createSignal(0)
            let mineralCleanUpSignal: string = A.proc.signal.createSignal(0)

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

                    if ( A.res.query(subLabId, A.res.CAPACITY_ENERGY) <= 0 ) return A.res.request({ id: subLabId, resourceType: A.res.CAPACITY_ENERGY, amount: { lowerbound: 1, request: 0} })

                    const capacity = A.res.query(subLabId, A.res.CAPACITY_ENERGY)
                    const ret = A.res.requestSource(roomName, RESOURCE_ENERGY, capacity)
                    if ( !ret.id ) return ret.code
                    const available = A.res.query(ret.id, RESOURCE_ENERGY)
                    if ( available <= 0 ) return A.res.request({ id: ret.id, resourceType: RESOURCE_ENERGY, amount: { lowerbound: 1, request: 0 } })
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
                ['waitForProduction', () => A.proc.signal.Swait({ signalId: this.productSignal[`subLab${subLabIdx}`], lowerbound: 1, request: 0 })], 
                () => {
                    if ( A.proc.signal.getValue(this.productSignal[`subLab${subLabIdx}`]) === 1 && A.proc.signal.getValue(this.hasFreeLab) === 0 ) A.proc.signal.Ssignal({ signalId: this.hasFreeLab, request: 1 })
                    return A.proc.OK
                }, 
                ['restart', () => {
                    if ( A.proc.signal.getValue(this.productSignal[`subLab${subLabIdx}`]) === 0 ) {
                        return [ A.proc.OK_STOP_CUSTOM, 'waitForProduction' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                    }
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
                    if ( A.proc.signal.getValue(this.productSignal[`subLab${subLabIdx}`]) === 0 ) {
                        return [ A.proc.OK_STOP_CUSTOM, 'waitForProduction' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                    }

                    const remainingAmount = A.proc.signal.getValue(this.productCurrent.remainingAmountSignal)
                    if ( remainingAmount <= 0 ) {
                        assertWithMsg( A.proc.signal.Swait({ signalId: cleanUpSignal, lowerbound: 1, request: 1 }) === A.proc.OK, `${roomName}: Sub Lab ${subLabIdx} Restart Cleanup` )
                        return [ A.proc.OK_STOP_CUSTOM, 'restart' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                    }
                    const subLab = Game.getObjectById(subLabId)
                    if ( !subLab ) {
                        subLabId = null
                        assertWithMsg( A.proc.signal.Swait({ signalId: cleanUpSignal, lowerbound: 1, request: 1 }) === A.proc.OK, `${roomName}: Sub Lab ${subLabIdx} Restart` )
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
                        assertWithMsg( A.proc.signal.Swait({ signalId: cleanUpSignal, lowerbound: 1, request: 1 }) === A.proc.OK, `${roomName}: Sub Lab ${subLabIdx} Restart` )
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

            let oneTimeMineralFillingDone = A.proc.signal.createSignal(1)

            A.proc.createProc([
                () => P.exist(roomName, 'centralTransfer', 'storage'), 
                () => P.exist(roomName, 'labUnit', `subLab${subLabIdx}`), 
                ['waitForBoost', () => A.proc.signal.Swait({ signalId: this.boostSignal[`subLab${subLabIdx}`], lowerbound: 1, request: 0 })], 
                ['clean', () => {
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
                            callback: () => A.proc.signal.Ssignal({ signalId: mineralCleanUpSignal, request: 1 })
                        })
                    } else if ( !!lab.mineralType && lab.store[lab.mineralType] > 0 ) {
                        // 此时正在被别的清理
                        return A.res.request({ id: lab.id, resourceType: A.res.CAPACITY_MINERAL, amount: { lowerbound: LAB_MINERAL_CAPACITY, request: 0 } })
                    } else if ( !lab.mineralType || lab.store[lab.mineralType] <= 0 ) {
                        A.proc.signal.Ssignal({ signalId: mineralCleanUpSignal, request: 1 })
                    }
                    return A.proc.OK
                }], 
                () => A.proc.signal.Swait({ signalId: mineralCleanUpSignal, lowerbound: 1, request: 0 }), 
                ['refill', () => {
                    if ( !(`subLab${subLabIdx}` in this.lab2Mineral) || !this.mineral2amount[this.lab2Mineral[`subLab${subLabIdx}`]] ) return [ A.proc.OK_STOP_CUSTOM, 'waitForBoost' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                    
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

                    const storage = Game.rooms[roomName].storage
                    const amount = A.proc.signal.getValue(this.mineral2amount[this.lab2Mineral[`subLab${subLabIdx}`]])
                    const capacity = A.res.query(lab.id, A.res.CAPACITY_MINERAL)
                    if ( amount <= 0 ) return A.proc.signal.Swait({ signalId: this.mineral2amount[this.lab2Mineral[`subLab${subLabIdx}`]], lowerbound: 1, request: 0 })
                    if ( capacity <= 0 ) return A.res.request({ id: lab.id, resourceType: A.res.CAPACITY_MINERAL, amount: { lowerbound: 1, request: 0 } })
                    const transferAmount = Math.min(amount, capacity)
                    assertWithMsg( A.res.request({ id: lab.id, resourceType: A.res.CAPACITY_MINERAL, amount: transferAmount }) === A.proc.OK, getFileNameAndLineNumber() )
                    // 已经预约过
                    // assertWithMsg( A.res.request({ id: storage.id, resourceType: this.lab2Mineral[`subLab${subLabIdx}`], amount: transferAmount }) === A.proc.OK, getFileNameAndLineNumber() )
                    assertWithMsg( A.proc.signal.Swait({ signalId: oneTimeMineralFillingDone, lowerbound: 1, request: 1 }) === A.proc.OK, getFileNameAndLineNumber() )
                    T.transfer(storage.id, lab.id, this.lab2Mineral[`subLab${subLabIdx}`], transferAmount, { callback: () => {
                        assertWithMsg( A.proc.signal.Swait({ signalId: this.mineral2amount[this.lab2Mineral[`subLab${subLabIdx}`]], lowerbound: transferAmount, request: transferAmount }) === A.proc.OK, getFileNameAndLineNumber() )
                        assertWithMsg( A.proc.signal.Ssignal({ signalId: oneTimeMineralFillingDone, request: 1 }) === A.proc.OK, getFileNameAndLineNumber() )
                    } })
                    return A.proc.OK
                }], 
                () => A.proc.signal.Swait({ signalId: oneTimeMineralFillingDone, lowerbound: 1, request: 0 }), 
                () => {
                    return [ A.proc.OK_STOP_CUSTOM, `refill` ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
                }
            ], `${roomName} Sub Lab ${subLabIdx}: Fill Mineral`)
        }
    }
}

const labRepo: { [roomName: string]: Labs } = {}

function getLabs(roomName: string) {
    if ( !(roomName in labRepo) ) labRepo[roomName] = new Labs(roomName)
    return labRepo[roomName]
}

type BoostDescriptor = { resourceType: MineralBoostConstant, getBodyPartsCount: () => number }

class LabModule {
    #icon(key) {
        return `<img src="https://static.screeps.com/upload/mineral-icons/${key}.png" alt="${key}">`;
    }
    /** 
     * 预约 Lab 中放置的资源. 按照 amount 数量填充, 必须精确计算 (所以 Creep 设计必须 strict; 或者先获得 Creep 然后 Boost, 但是这样会有 Delay) 并且一次按照一个 Creep 量进行申请.
     * 无填充且无未完成的运输数量, 则自动切换回生产状态
     * @param forceSuccess 是否强制要求 Compound 必须全部满足数量需求. 默认为真, 否则根据库存尽力而为 (只有满足全部数量要求的 Compound 才会被考虑).
     */
    reserve(roomName: string, compoundInfo: BoostDescriptor, forceSuccess: boolean = true): [ () => [ string, Id<StructureLab>, MineralBoostConstant, number ], (() => (typeof A.proc.OK) | "stop_stuck")[] ] {
        let targetLabId: Id<StructureLab> = null
        let bodyPartsCount: number = null
        const labPoses = getLabs(roomName).labPoses

        const getLabAtPos: (pos: Pos | { x: number, y: number }) => StructureLab = pos => !!Game.rooms[roomName] ? Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, new RoomPosition(pos.x, pos.y, roomName)).filter(s => s.structureType === STRUCTURE_LAB)[0] as StructureLab || null : null
        return [() => [ roomName, targetLabId, compoundInfo.resourceType, bodyPartsCount ], [
            () => {
                if ( !Game.rooms[roomName] || !Game.rooms[roomName].storage ) return A.proc.OK
                bodyPartsCount = compoundInfo.getBodyPartsCount()
                if ( bodyPartsCount <= 0 ) return A.proc.OK
                
                const available = A.res.query(Game.rooms[roomName].storage.id, compoundInfo.resourceType)
                if ( available < bodyPartsCount * 30 ) {
                    if ( forceSuccess ) return A.res.request({ id: Game.rooms[roomName].storage.id, resourceType: compoundInfo.resourceType, amount: { lowerbound: bodyPartsCount * 30, request: 0 } })
                    return A.proc.OK
                }

                const labRepo = getLabs(roomName)
                
                if ( compoundInfo.resourceType in labRepo.mineral2lab ) {
                    // 已经有了继续使用
                    assertWithMsg( A.res.request({ id: Game.rooms[roomName].storage.id, resourceType: compoundInfo.resourceType, amount: bodyPartsCount * 30 }) === A.proc.OK, getFileNameAndLineNumber() )
                    A.proc.signal.Ssignal({ signalId: labRepo.mineral2amount[compoundInfo.resourceType], request: bodyPartsCount * 30 })
                } else {
                    if ( A.proc.signal.getValue(labRepo.hasFreeLab) === 0 ) {
                        if ( forceSuccess ) return A.proc.signal.Swait({ signalId: labRepo.hasFreeLab, lowerbound: 1, request: 0 })
                        else return A.proc.OK
                    }
                    let reservedLab = null
                    // 没有, 寻找第一个可预约的 Lab
                    for ( let labIdx = 0; labIdx < 8; ++labIdx ) {
                        if ( !(P.isExisted(roomName, 'labUnit', `subLab${labIdx}`)) ) continue
                        // 已经被预约了
                        if ( A.proc.signal.getValue(labRepo.productSignal[`subLab${labIdx}`]) === 0 ) continue
                        reservedLab = `subLab${labIdx}`
                        break
                    }
                    if ( !reservedLab && P.isExisted(roomName, 'labUnit', 'coreLab0') && A.proc.signal.getValue(labRepo.productSignal[`coreLab0`]) === 1 ) reservedLab = 'coreLab0'
                    if ( !reservedLab && P.isExisted(roomName, 'labUnit', 'coreLab1') && A.proc.signal.getValue(labRepo.productSignal[`coreLab1`]) === 1 ) reservedLab = 'coreLab1'
                    assertWithMsg( !!reservedLab, `hasFreeLab 信号量为 1 时, 应当一定存在空闲可预约的 Lab` )
                    assertWithMsg( A.proc.signal.Swait({ signalId: labRepo.productSignal[reservedLab], lowerbound: 1, request: 1 }) === A.proc.OK, getFileNameAndLineNumber() )
                    A.proc.signal.Ssignal({ signalId: labRepo.boostSignal[reservedLab], request: 1 })
                    labRepo.mineral2amount[compoundInfo.resourceType] = A.proc.signal.createSignal(bodyPartsCount * 30)
                    labRepo.mineral2lab[compoundInfo.resourceType] = reservedLab
                    labRepo.lab2Mineral[reservedLab] = compoundInfo.resourceType

                    // 更新 hasFreeLab
                    let allReserved = true
                    for ( let labIdx = 0; labIdx < 8; ++labIdx ) {
                        if ( !(P.isExisted(roomName, 'labUnit', `subLab${labIdx}`)) ) continue
                        // 已经被预约了
                        if ( A.proc.signal.getValue(labRepo.productSignal[`subLab${labIdx}`]) === 0 ) continue
                        allReserved = false
                        break
                    }
                    if ( allReserved && P.isExisted(roomName, 'labUnit', 'coreLab0') && A.proc.signal.getValue(labRepo.productSignal[`coreLab0`]) === 1 ) allReserved = false
                    if ( allReserved && P.isExisted(roomName, 'labUnit', 'coreLab1') && A.proc.signal.getValue(labRepo.productSignal[`coreLab1`]) === 1 ) allReserved = false
                    if ( allReserved ) A.proc.signal.Swait({ signalId: labRepo.hasFreeLab, lowerbound: 1, request: 1 })
                }
                const lab = getLabAtPos(labPoses[labRepo.mineral2lab[compoundInfo.resourceType]])
                assertWithMsg( !!lab, getFileNameAndLineNumber() )
                targetLabId = lab.id
                return A.proc.OK
            }, 
            () => {
                if ( !targetLabId ) return A.proc.OK
                // 提前使用资源
                else return A.res.request([{ id: targetLabId, resourceType: compoundInfo.resourceType, amount: bodyPartsCount * 30 }, { id: targetLabId, resourceType: RESOURCE_ENERGY, amount: bodyPartsCount * 20 }])
            }
        ]]
    }
    boost(handler: () => [string, Id<StructureLab>, MineralBoostConstant, number], getCreepName: () => string, setCreepName: (name: string) => void) {
        const creep = Game.creeps[getCreepName()]
        if ( !creep ) {
            setCreepName(null)
            return [ A.proc.STOP_ERR, `无法找到 Creep ${getCreepName()}` ] as [ typeof A.proc.STOP_ERR, string ]
        }
        const roomName = handler()[0]
        const labId = handler()[1]
        const compound = handler()[2]
        const bodyPartsCount = handler()[3]
        // 此时对应 forceSuccess == false
        if ( !labId ) return A.proc.OK
        const labRepo = getLabs(roomName)
        
        let lab = Game.getObjectById(labId)
        if ( !lab ) {
            log(LOG_ERR, `无法找到 ${roomName} 中 Boost ${compound} 的 Lab ${labRepo.mineral2lab[compound]}`)
            A.proc.signal.destroySignal(labRepo.mineral2amount[compound])
            delete labRepo.mineral2amount[compound]
            delete labRepo.mineral2lab[compound]
            delete labRepo.lab2Mineral[labRepo.mineral2lab[compound]]
            assertWithMsg( A.proc.signal.Swait({ signalId: labRepo.boostSignal[labRepo.mineral2lab[compound]], lowerbound: 1, request: 1 }) === A.proc.OK, getFileNameAndLineNumber() )
            A.proc.signal.Ssignal({ signalId: labRepo.productSignal[labRepo.mineral2lab[compound]], request: 1 })
            return A.proc.OK
        }

        if ( creep.pos.getRangeTo(lab) > 1 ) {
            creep.moveTo(lab)
            return A.proc.OK_STOP_CURRENT
        }

        assertWithMsg( lab.boostCreep(creep, bodyPartsCount) === OK, getFileNameAndLineNumber() )
        A.timer.add(Game.time + 1, (compound, labName, labId, bodyPartsCount) => {
            assertWithMsg( A.res.signal(labId, A.res.CAPACITY_MINERAL, bodyPartsCount * 30) === OK, getFileNameAndLineNumber() )
            assertWithMsg( A.res.signal(labId, A.res.CAPACITY_ENERGY, bodyPartsCount * 20) === OK, getFileNameAndLineNumber() )
            // 检查是否已经完成了所有的 Boost
            const labRepo = getLabs(roomName)
            if ( A.proc.signal.getValue(labRepo.mineral2amount[compound]) === 0 && A.res.query(labId, compound) === 0 && !!Game.getObjectById(labId) && (Game.getObjectById(labId) as StructureLab).store[compound] <= 0 ) {
                A.proc.signal.destroySignal(labRepo.mineral2amount[compound])
                delete labRepo.mineral2amount[compound]
                delete labRepo.mineral2lab[compound]
                delete labRepo.lab2Mineral[labName]
                if ( A.proc.signal.getValue(labRepo.hasFreeLab) === 0 ) A.proc.signal.Ssignal({signalId: labRepo.hasFreeLab, request: 1})
                assertWithMsg( A.proc.signal.Swait({ signalId: labRepo.boostSignal[labName], lowerbound: 1, request: 1 }) === A.proc.OK, getFileNameAndLineNumber() )
                A.proc.signal.Ssignal({ signalId: labRepo.productSignal[labName], request: 1 })
            }
        }, [ compound, labRepo.mineral2lab[compound], lab.id, bodyPartsCount ], `更新 ${lab.id} 资源状态`)
        return A.proc.OK
    }
    // 输出当前状态
    print(roomName: string) {
        if ( !(roomName in labRepo) ) return
        const status = getLabs(roomName)
        if ( !status.productCurrent.resourceType ) console.logUnsafe(`${roomName} 暂未进行任何化合物合成.`)
        else console.logUnsafe(`${roomName} 配方: ${this.#icon(status.productCurrent.assignedResourceForCoreLab0)} + ${this.#icon(status.productCurrent.assignedResourceForCoreLab1)} => ${this.#icon(status.productCurrent.resourceType)} (总生产数量: ${status.productCurrent.totalAmount}, 已生产: ${A.proc.signal.getValue(status.productCurrent.haveReactAmountSignal)}).`)
        const recommendedInfo = recommendNextProduction(roomName)
        if ( !recommendedInfo ) console.logUnsafe(`${roomName} 不推荐任何化合物合成.`)
        else console.logUnsafe(`${roomName} 推荐生产 ${recommendedInfo[1]} ${this.#icon(recommendedInfo[0])}`)

        console.log("是否有空闲可预约的 Lab?:", A.proc.signal.getValue(status.hasFreeLab))

        const getLabAtPos: (pos: Pos | { x: number, y: number }) => StructureLab = pos => !!Game.rooms[roomName] ? Game.rooms[roomName].lookForAt(LOOK_STRUCTURES, new RoomPosition(pos.x, pos.y, roomName)).filter(s => s.structureType === STRUCTURE_LAB)[0] as StructureLab || null : null

        for ( const labName of ['coreLab0', 'coreLab1', 'subLab0', 'subLab1', 'subLab2', 'subLab3', 'subLab4', 'subLab5', 'subLab6', 'subLab7', 'subLab8'] ) {
            if ( !P.isExisted(roomName, 'labUnit', labName) ) continue
            const lab = getLabAtPos(status.labPoses[labName])
            if ( A.proc.signal.getValue(status.productSignal[labName]) === 1 ) {
                console.log(`\t${labName}: 生产状态`)
            } else {
                const mineral = status.lab2Mineral[labName]
                const remainingAmount = A.proc.signal.getValue(status.mineral2amount[mineral])
                console.logUnsafe(`\t${labName}: 预约状态 (${this.#icon(mineral)}); 剩余填充数量: ${remainingAmount}, 可用数量: ${A.res.query(lab.id, mineral)}, 实际数量: ${lab.store[mineral] || 0}`)
            }
        }
    }
    constructor() {

    }
}

export const labModule = new LabModule()
global.L = labModule

export function issueLabProc(roomName: string) {
    getLabs(roomName)
}