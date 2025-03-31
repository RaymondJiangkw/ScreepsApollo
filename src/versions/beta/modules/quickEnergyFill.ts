/**
 * 快速填充 Spawn 及附近的 Extension 模块
 */

import { Apollo as A } from "@/framework/apollo"
import { creepModule as C } from "@/modules/creep"
import { planModule as P } from "@/modules/plan"
import { transferModule as T } from "@/modules/transfer"
import { assertWithMsg, convertPosToString, log, LOG_DEBUG } from "@/utils"

const unitName = 'centralSpawn'
const tagLeftContainer = 'leftContainer'
const tagRightContainer = 'rightContainer'
const tagLink = 'link'

export function registerQuickEnergyFill() {
    for ( let i = 0; i < 4; ++i )
        C.design(`quickFiller${i}`, {
            body: {
                1: [ CARRY, MOVE ], 
                7: [ CARRY, CARRY, MOVE ], 
                8: [ CARRY, CARRY, CARRY, CARRY, MOVE ]
            }, 
            priority: C.PRIORITY_IMPORTANT, 
        })
}

type TransferTaskDescriptor = { 
    fromId: Id<StructureContainer | StructureLink>, 
    toId: Id<StructureContainer | StructureSpawn | StructureExtension>, 
    remainingAmount: number, 
    currentAmount: number
}

/** 用于判定 Extension 是否属于本模块填充 */
export function isBelongingToQuickEnergyFilling(pos: RoomPosition) {
    const planInfo = P.plan(pos.roomName, 'unit', unitName)
    /** 如果无法完成规划, 则一定不属于 */
    if ( planInfo === null )
        return false
    const leftTopPos = planInfo.leftTops[0]
    if ( P.isExisted(pos.roomName, unitName, tagLeftContainer) || P.isExisted(pos.roomName, unitName, tagRightContainer) ) {
        // 只有当 Container 存在时, 才判定是否属于
        return pos.x >= leftTopPos.x + 1 && pos.y >= leftTopPos.y + 1 && pos.x <= leftTopPos.x + 5 && pos.y <= leftTopPos.y + 5
    } else return false
}

function issueQuickEnergyFillProc(roomName: string, leftTopPos: Pos, getLinkBuffer: () => Id<StructureLink>[], linkBufferSignal: string) {
    const posLeftContainer: Pos     = { x: leftTopPos.x + 1, y: leftTopPos.y + 3, roomName: leftTopPos.roomName }
    const posRightContainer: Pos    = { x: leftTopPos.x + 5, y: leftTopPos.y + 3, roomName: leftTopPos.roomName }
    const posLink: Pos              = { x: leftTopPos.x + 3, y: leftTopPos.y + 3, roomName: leftTopPos.roomName }

    const posLeftTopWorker: Pos     = { x: leftTopPos.x + 2, y: leftTopPos.y + 2, roomName: leftTopPos.roomName }
    const posLeftBottomWorker: Pos  = { x: leftTopPos.x + 2, y: leftTopPos.y + 4, roomName: leftTopPos.roomName }
    const posRightTopWorker: Pos    = { x: leftTopPos.x + 4, y: leftTopPos.y + 2, roomName: leftTopPos.roomName }
    const posRightBottomWorker: Pos = { x: leftTopPos.x + 4, y: leftTopPos.y + 4, roomName: leftTopPos.roomName }

    const inLeftTop = (pos: Pos) => pos.x >= leftTopPos.x + 1 && pos.y >= leftTopPos.y + 1 && pos.x <= leftTopPos.x + 3 && pos.y <= leftTopPos.y + 3
    const inLeftBottom = (pos: Pos) => pos.x >= leftTopPos.x + 1 && pos.y >= leftTopPos.y + 3 && pos.x <= leftTopPos.x + 3 && pos.y <= leftTopPos.y + 5
    const inRightTop = (pos: Pos) => pos.x >= leftTopPos.x + 3 && pos.y >= leftTopPos.y + 1 && pos.x <= leftTopPos.x + 5 && pos.y <= leftTopPos.y + 3
    const inRightBottom = (pos: Pos) => pos.x >= leftTopPos.x + 3 && pos.y >= leftTopPos.y + 3 && pos.x <= leftTopPos.x + 5 && pos.y <= leftTopPos.y + 5

    let idLink: Id<StructureLink> = null
    function checkLinkId( pos: Pos ) {
        if ( idLink !== null && Game.getObjectById( idLink ) ) return A.proc.STOP_SLEEP
        else if ( idLink !== null ) {
            const prevLength = getLinkBuffer().length
            _.remove( getLinkBuffer(), e => e[0] === idLink )
            if ( prevLength > 0 && getLinkBuffer().length === 0 )
                assertWithMsg( A.proc.signal.Swait({ signalId: linkBufferSignal, lowerbound: 1, request: 1 }) === A.proc.OK, `quickEnergyFill -> 70` )
            idLink = null
            return [A.proc.STOP_ERR, `${roomName} 的快速填充的 Link 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        } else {
            if ( !Game.rooms[pos.roomName] ) return [A.proc.STOP_ERR, `${roomName} 的快速填充没有房间视野`] as [ typeof A.proc.STOP_ERR, string ]
            const link: StructureLink = Game.rooms[pos.roomName].lookForAt(LOOK_STRUCTURES, pos.x, pos.y).filter(s => s.structureType === STRUCTURE_LINK)[0] as StructureLink
            if ( !link ) return [A.proc.STOP_ERR, `${roomName} 的快速填充的 Link 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
            idLink = link.id as Id<StructureLink>

            const prevLength = getLinkBuffer().length
            getLinkBuffer().push( idLink )
            if ( prevLength === 0 )
                A.proc.signal.Ssignal({ signalId: linkBufferSignal, request: 1 })
            return A.proc.STOP_SLEEP
        }
    }

    const pidLink = A.proc.createProc([
        () => P.exist(roomName, unitName, tagLink), 
        ['check', () => checkLinkId( posLink )], 
    ], `${roomName} => Link Filling`)

    A.proc.trigger('watch', () => {
        if ( idLink !== null && !Game.getObjectById( idLink ) ) {
            const prevLength = getLinkBuffer().length
            _.remove( getLinkBuffer(), e => e[0] === idLink )
            if ( prevLength > 0 && getLinkBuffer().length === 0 )
                assertWithMsg( A.proc.signal.Swait({ signalId: linkBufferSignal, lowerbound: 1, request: 1 }) === A.proc.OK, `quickEnergyFill -> 97` )
            idLink = null
            return true
        }
        return false
    }, [ pidLink ])

    let idLeftContainer: Id<StructureContainer> = null
    let idRightContainer: Id<StructureContainer> = null

    /** 假定 Container 存在时的校验 */
    function checkContainerId( pos: Pos, getContainerId: () => Id<StructureContainer>, setContainerId: (id: Id<StructureContainer>) => void ) {
        if ( getContainerId() !== null && Game.getObjectById( getContainerId() ) ) return A.proc.OK
        else if ( getContainerId() !== null ) {
            setContainerId(null)
            return [A.proc.STOP_ERR, `${roomName} 的快速填充的 Container 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        } else {
            if ( !Game.rooms[pos.roomName] ) return [A.proc.STOP_ERR, `${roomName} 的快速填充没有房间视野`] as [ typeof A.proc.STOP_ERR, string ]
            const container = Game.rooms[pos.roomName].lookForAt(LOOK_STRUCTURES, pos.x, pos.y).filter(s => s.structureType === STRUCTURE_CONTAINER)[0]
            if ( !container ) return [A.proc.STOP_ERR, `${roomName} 的快速填充的 Container 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
            setContainerId(container.id as Id<StructureContainer>)
            A.timer.add(Game.time + 1, id => A.res.print(id, RESOURCE_ENERGY), [container.id], `输出 [Container ${container.id}] 资源状态`, 1)
            return A.proc.OK
        }
    }

    const LeftContainerEnergyGap: number[] = []
    const RightContainerEnergyGap: number[] = []

    const LeftContainerEnergyGapSignal = A.proc.signal.createSignal(0)
    const RightContainerEnergyGapSignal = A.proc.signal.createSignal(0)

    function initContainerFilling( containerId: Id<StructureContainer>, containerEnergyGap: number[], containerEnergyGapSignal: string ) {
        if ( !Game.getObjectById(containerId) )
            return [ A.proc.OK_STOP_CUSTOM, 'check' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
        const amount = Game.getObjectById(containerId).store.getFreeCapacity()
        if ( amount > 0 ) {
            containerEnergyGap.push(amount)
            A.proc.signal.Ssignal({ signalId: containerEnergyGapSignal, request: 1 })
        }
        return A.proc.OK
    }

    function fillContainer( containerId: Id<StructureContainer>, containerEnergyGap: number[], containerEnergyGapSignal: string, TopPool: TransferTaskDescriptor[], BottomPool: TransferTaskDescriptor[], TopSignal: string, BottomSignal: string ) {
        if ( !Game.getObjectById(containerId) ) {
            containerEnergyGap.length = 0
            A.proc.signal.Swait({ signalId: containerEnergyGapSignal, request: A.proc.signal.getValue(containerEnergyGapSignal), lowerbound: A.proc.signal.getValue(containerEnergyGapSignal) })
            return [ A.proc.OK_STOP_CUSTOM, 'check' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
        }
        assertWithMsg( containerEnergyGap.length > 0, `quickEnergyFill -> 146` )
        /** 尝试获得能量来源 */
        let amount = 0
        let requestedSource = null
        if ( idLink !== null && Game.getObjectById( idLink ) ) {
            /** === 有 Link 时 === */
            amount = A.res.query(idLink, RESOURCE_ENERGY)
            if ( amount === 0 )
                return A.res.request({ id: idLink, resourceType: RESOURCE_ENERGY, amount: {lowerbound: Math.min(CARRY_CAPACITY, containerEnergyGap[0]), request: 0} })
        } else {
            /** === 无 Link 时 === */
            requestedSource = A.res.requestSource( roomName, RESOURCE_ENERGY )
            if ( requestedSource.code !== A.proc.OK )
                return requestedSource.code
            amount = A.res.query(requestedSource.id, RESOURCE_ENERGY)
            if ( amount === 0 )
                return A.res.request({ id: requestedSource.id, resourceType: RESOURCE_ENERGY, amount: {lowerbound: Math.min(CARRY_CAPACITY, containerEnergyGap[0]), request: 0} })
        }

        const capacity = A.res.query(containerId, A.res.CAPACITY)
        if ( capacity === 0 )
            return A.res.request({ id: containerId, resourceType: A.res.CAPACITY, amount: {lowerbound: Math.min(CARRY_CAPACITY, containerEnergyGap[0]), request: 0} })
        // 尝试尽可能多的转移能量
        let energyGap = 0
        while ( true ) {
            const currentPlus = Math.min(amount - energyGap, capacity - energyGap, containerEnergyGap[0])
            energyGap += currentPlus
            containerEnergyGap[0] -= currentPlus
            if ( containerEnergyGap[0] > 0 ) break
            else {
                containerEnergyGap.shift()
                if ( containerEnergyGap.length === 0 ) break
                else assertWithMsg( A.proc.signal.Swait( { signalId: containerEnergyGapSignal, lowerbound: 1, request: 1 } ) === A.proc.OK, `quickEnergyFill -> 178` )
            }
        }
        assertWithMsg( energyGap > 0, `quickEnergyFill -> 181` )
        assertWithMsg( A.res.request({ id: containerId, resourceType: A.res.CAPACITY, amount: energyGap }, `issueQuickEnergyFillProc -> 182`) === A.proc.OK, `quickEnergyFill -> 182` )
        if ( idLink !== null && Game.getObjectById( idLink ) ) {
            assertWithMsg( A.res.request({ id: idLink, resourceType: RESOURCE_ENERGY, amount: energyGap }, `issueQuickEnergyFillProc -> 184`) === A.proc.OK, `quickEnergyFill -> 184` )
            if ( A.proc.signal.getValue( TopSignal ) < A.proc.signal.getValue( BottomSignal ) ) {
                TopPool.push( { fromId: idLink, toId: containerId, remainingAmount: energyGap, currentAmount: 0 } )
                A.proc.signal.Ssignal({ signalId: TopSignal, request: 1 })
            } else {
                BottomPool.push( { fromId: idLink, toId: containerId, remainingAmount: energyGap, currentAmount: 0 } )
                A.proc.signal.Ssignal({ signalId: BottomSignal, request: 1 })
            }
        } else {
            assertWithMsg( A.res.request({id: requestedSource.id, resourceType: RESOURCE_ENERGY, amount: energyGap}, `issueQuickEnergyFillProc -> 193`) === A.proc.OK, `quickEnergyFill -> 193` )
            T.transfer(requestedSource.id, containerId, RESOURCE_ENERGY, energyGap, { loseCallback: (amount, resourceType) => {
                containerEnergyGap.push(amount)
                A.proc.signal.Ssignal({ signalId: containerEnergyGapSignal, request: 1 })
            } })
        }

        if ( containerEnergyGap.length === 0 )
            return [ A.proc.OK_STOP_CUSTOM, 'wait' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
        else
            return A.proc.OK_STOP_CURRENT
    }

    A.proc.createProc([
        () => P.exist(roomName, unitName, tagLeftContainer), 
        ['check', () => checkContainerId( posLeftContainer, () => idLeftContainer, id => idLeftContainer = id )], 
        () => initContainerFilling( idLeftContainer, LeftContainerEnergyGap, LeftContainerEnergyGapSignal ), 
        ['wait', () => A.proc.signal.Swait({ signalId: LeftContainerEnergyGapSignal, lowerbound: 1, request: 1 })], 
        () => fillContainer( idLeftContainer, LeftContainerEnergyGap, LeftContainerEnergyGapSignal, LeftTopPool, LeftBottomPool, LeftTopPoolSignal, LeftBottomPoolSignal ), 
    ], `${roomName} => Container Filling (Left)`)

    A.proc.createProc([
        () => P.exist(roomName, unitName, tagRightContainer), 
        ['check', () => checkContainerId( posRightContainer, () => idRightContainer, id => idRightContainer = id )], 
        () => initContainerFilling( idRightContainer, RightContainerEnergyGap, RightContainerEnergyGapSignal ), 
        ['wait', () => A.proc.signal.Swait({ signalId: RightContainerEnergyGapSignal, lowerbound: 1, request: 1 })], 
        () => fillContainer( idRightContainer, RightContainerEnergyGap, RightContainerEnergyGapSignal, RightTopPool, RightBottomPool, RightTopPoolSignal, RightBottomPoolSignal ), 
    ], `${roomName} => Container Filling (Right)`)

    const LeftTopPool: TransferTaskDescriptor[]     = []
    const LeftBottomPool: TransferTaskDescriptor[]  = []
    const RightTopPool: TransferTaskDescriptor[]    = []
    const RightBottomPool: TransferTaskDescriptor[] = []

    const LeftTopPoolSignal = A.proc.signal.createSignal(0)
    const LeftBottomPoolSignal = A.proc.signal.createSignal(0)
    const RightTopPoolSignal = A.proc.signal.createSignal(0)
    const RightBottomPoolSignal = A.proc.signal.createSignal(0)

    // 注意: 有 energy 会变无; 但不会不受控制的 无 energy 变有
    const issuedTransferFor: { [pos: string]: number } = {}

    function runContainer(top: number, left: number, bottom: number, right: number, containerId: Id<StructureContainer>, inTop: (pos: Pos) => boolean, inBottom: (pos: Pos) => boolean, TopPool: TransferTaskDescriptor[], BottomPool: TransferTaskDescriptor[], TopSignal: string, BottomSignal: string, energyGapPool: number[], energyGapSignal: string) {
        if ( !Game.getObjectById(containerId) )
            return [ A.proc.OK_STOP_CUSTOM, 'check' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]

        const structures = Game.rooms[roomName]
            .lookForAtArea(LOOK_STRUCTURES, top, left, bottom, right, true)
            .map(s => s.structure)
            .filter((s: StorableStructure) => (s.structureType === STRUCTURE_EXTENSION || s.structureType === STRUCTURE_SPAWN) && s.store.getFreeCapacity(RESOURCE_ENERGY) > (issuedTransferFor[convertPosToString(s.pos)] || 0) )
            .sort((u: StorableStructure, v: StorableStructure) => (u.store.getFreeCapacity(RESOURCE_ENERGY) - (issuedTransferFor[convertPosToString(u.pos)] || 0)) - (v.store.getFreeCapacity(RESOURCE_ENERGY) - (issuedTransferFor[convertPosToString(v.pos)] || 0))) as (StructureSpawn | StructureExtension)[]
        log(LOG_DEBUG, `${roomName} => 需要快速填充的建筑: ${structures}; Top Pool [${A.proc.signal.getValue(TopSignal)}]: ${JSON.stringify(TopPool)}; Bottom Pool [${A.proc.signal.getValue(BottomSignal)}]: ${JSON.stringify(BottomPool)}`)
        /** 强制唤醒 Creep 填充进程 */
        assertWithMsg( A.proc.signal.Ssignal( { signalId: TopSignal, request: 0 }, { signalId: BottomSignal, request: 0 } ) === A.proc.OK )
        /** 暂无 Structure 需要填充能量 */
        if ( structures.length === 0 ) return A.proc.STOP_SLEEP
        for ( const structure of structures ) {
            let amount = structure.store.getFreeCapacity(RESOURCE_ENERGY) - (issuedTransferFor[convertPosToString(structure.pos)] || 0)
            log(LOG_DEBUG, `${structure} 能量缺口 ${structure.store.getFreeCapacity(RESOURCE_ENERGY)}, 已计划填充 ${issuedTransferFor[convertPosToString(structure.pos)] || 0}`)
            if ( A.res.query(containerId, RESOURCE_ENERGY) <= 0 ) {
                log(LOG_DEBUG, `${containerId} 需求 ${structure} ${amount} 数量的能量, 但只有 ${A.res.query(containerId, RESOURCE_ENERGY)}`)
                return A.res.request({ id: containerId, resourceType: RESOURCE_ENERGY, amount: { lowerbound: CARRY_CAPACITY, request: 0 } })
            } else amount = Math.min(amount, A.res.query(containerId, RESOURCE_ENERGY))
            
            assertWithMsg(A.res.request({ id: containerId, resourceType: RESOURCE_ENERGY, amount }, `issueQuickEnergyFillProc -> 255`) === OK, `quickEnergyFill -> 255`)
            energyGapPool.push(amount)
            A.proc.signal.Ssignal({ signalId: energyGapSignal, request: 1 })
            if ( !(convertPosToString(structure.pos) in issuedTransferFor) ) issuedTransferFor[convertPosToString(structure.pos)] = amount
            else issuedTransferFor[convertPosToString(structure.pos)] += amount
            if ( inTop(structure.pos) ) {
                TopPool.push( { fromId: containerId, toId: structure.id, remainingAmount: amount, currentAmount: 0 } )
                A.proc.signal.Ssignal({ signalId: TopSignal, request: 1 })
            } else {
                BottomPool.push( { fromId: containerId, toId: structure.id, remainingAmount: amount, currentAmount: 0 } )
                A.proc.signal.Ssignal({ signalId: BottomSignal, request: 1 })
            }
        }
        /** 此时所有 Structure 都完成, 自然休眠 */
        log(LOG_DEBUG, `${containerId} 发现无需填充, 休眠`)
        return A.proc.STOP_SLEEP
    }

    const pidLeftContainer = A.proc.createProc([
        () => P.exist(roomName, unitName, tagLeftContainer), 
        ['check', () => checkContainerId( posLeftContainer, () => idLeftContainer, id => idLeftContainer = id )], 
        () => runContainer(leftTopPos.y + 1, leftTopPos.x + 1, leftTopPos.y + 5, leftTopPos.x + 3, idLeftContainer, inLeftTop, inLeftBottom, LeftTopPool, LeftBottomPool, LeftTopPoolSignal, LeftBottomPoolSignal, LeftContainerEnergyGap, LeftContainerEnergyGapSignal)
    ], `${roomName} => Quick Filling (Left)`)

    const pidRightContainer = A.proc.createProc([
        () => P.exist(roomName, unitName, tagRightContainer), 
        ['check', () => checkContainerId( posRightContainer, () => idRightContainer, id => idRightContainer = id )], 
        () => runContainer(leftTopPos.y + 1, leftTopPos.x + 3, leftTopPos.y + 5, leftTopPos.x + 5, idRightContainer, inRightTop, inRightBottom, RightTopPool, RightBottomPool, RightTopPoolSignal, RightBottomPoolSignal, RightContainerEnergyGap, RightContainerEnergyGapSignal)
    ], `${roomName} => Quick Filling (Right)`)

    A.proc.trigger('after', Spawn.prototype, 'spawnCreep', (returnValue, spawn: StructureSpawn, ...args) => {
        if ( returnValue === OK && spawn.pos.roomName === roomName )
            return [ pidLeftContainer, pidRightContainer ]
        return []
    })

    let leftTopFillerName = null
    let leftBottomFillerName = null
    let rightTopFillerName = null
    let rightBottomFillerName = null

    let leftTopFillerCurrentTask = null
    let leftBottomFillerCurrentTask = null
    let rightTopFillerCurrentTask = null
    let rightBottomFillerCurrentTask = null

    function runCreepDrop( getFillerName: () => string, setFillerName: (name: string) => void ) {
        const creep = Game.creeps[getFillerName()]
        /** 检测到错误, 立即释放资源 */
        if ( !creep ) {
            C.cancel(getFillerName())
            setFillerName(null)
            return [A.proc.STOP_ERR, `Creep 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        }
        creep.drop(RESOURCE_ENERGY)
        return A.proc.OK
    }

    function runCreepMoveTo( getFillerName: () => string, setFillerName: (name: string) => void, workerPos: Pos ) {
        const creep = Game.creeps[getFillerName()]
        /** 检测到错误, 立即释放资源 */
        if ( !creep ) {
            C.cancel(getFillerName())
            setFillerName(null)
            return [A.proc.STOP_ERR, `Creep 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        }

        /** 移动到工作位置 */
        if ( creep.pos.roomName !== workerPos.roomName || creep.pos.getRangeTo(workerPos.x, workerPos.y) > 0 ) {
            creep.travelTo(new RoomPosition(workerPos.x, workerPos.y, workerPos.roomName))
            return A.proc.OK_STOP_CURRENT
        }

        return A.proc.OK
    }

    function runCreepWithdraw( getFillerName: () => string, setFillerName: (name: string) => void, workerPos: Pos, pool: TransferTaskDescriptor[], poolSignal: string, getCurrentTask: () => TransferTaskDescriptor, setCurrentTask: ( task: TransferTaskDescriptor ) => void ) {
        if ( !getCurrentTask() ) {
            assertWithMsg( pool.length > 0, `quickEnergyFill -> 333` )
            setCurrentTask( pool.shift() )
        }
        
        const creep = Game.creeps[getFillerName()]
        /** 检测到错误, 立即释放资源 */
        if ( !creep ) {
            C.cancel(getFillerName())
            setFillerName(null)
            if ( getCurrentTask() !== null ) {
                pool.unshift(getCurrentTask())
                setCurrentTask(null)
                A.proc.signal.Ssignal({ signalId: poolSignal, request: 1 })
            }
            return [A.proc.STOP_ERR, `Creep 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        }

        if ( creep.ticksToLive <= 3 )
            return A.proc.OK_STOP_CURRENT

        /** 移动到工作位置 */
        if ( creep.pos.roomName !== workerPos.roomName || creep.pos.getRangeTo(workerPos.x, workerPos.y) > 0 ) {
            creep.travelTo(new RoomPosition(workerPos.x, workerPos.y, workerPos.roomName))
            return A.proc.OK_STOP_CURRENT
        }

        const task = getCurrentTask()
        const fromTarget = Game.getObjectById(task.fromId)
        if ( !fromTarget || fromTarget.store[RESOURCE_ENERGY] === 0 ) {
            setCurrentTask(null)
            if ( Game.getObjectById(task.toId) )
                issuedTransferFor[convertPosToString(Game.getObjectById(task.toId).pos)] -= (task.remainingAmount)
            return [A.proc.OK_STOP_CUSTOM, 'wait'] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
        }

        const amount = Math.min(creep.store.getFreeCapacity(), task.remainingAmount, fromTarget.store[RESOURCE_ENERGY])
        assertWithMsg( amount > 0, `${creep.store.getFreeCapacity()}, ${task.remainingAmount}, ${fromTarget.store[RESOURCE_ENERGY]}` )
        creep.withdraw(fromTarget, RESOURCE_ENERGY, amount)
        if ( fromTarget instanceof StructureContainer || fromTarget instanceof StructureLink )
            A.timer.add(Game.time + 1, (id, amount) => A.res.signal(id, A.res.CAPACITY, amount), [task.fromId, amount], `${task.fromId} 容量更新`)
        task.remainingAmount -= amount
        task.currentAmount = amount
        return A.proc.OK_STOP_NEXT
    }

    function runCreepTransfer( getFillerName: () => string, setFillerName: (name: string) => void, workerPos: Pos, pool: TransferTaskDescriptor[], poolSignal: string, getCurrentTask: () => TransferTaskDescriptor, setCurrentTask: ( task: TransferTaskDescriptor ) => void ) {
        const creep = Game.creeps[getFillerName()]
        /** 检测到错误, 立即释放资源 */
        if ( !creep ) {
            C.cancel(getFillerName())
            setFillerName(null)
            if ( Game.getObjectById(getCurrentTask().toId) )
                issuedTransferFor[convertPosToString(Game.getObjectById(getCurrentTask().toId).pos)] -= getCurrentTask().currentAmount
            
            if ( getCurrentTask().remainingAmount > 0 ) {
                getCurrentTask().currentAmount = 0
                pool.unshift(getCurrentTask())
                A.proc.signal.Ssignal({ signalId: poolSignal, request: 1 })
            }
            setCurrentTask(null)
            return [A.proc.STOP_ERR, `Creep 无法找到`] as [ typeof A.proc.STOP_ERR, string ]
        }
        /** 移动到工作位置 */
        if ( creep.pos.roomName !== workerPos.roomName || creep.pos.getRangeTo(workerPos.x, workerPos.y) > 0 ) {
            creep.travelTo(new RoomPosition(workerPos.x, workerPos.y, workerPos.roomName))
            return A.proc.OK_STOP_CURRENT
        }

        const task = getCurrentTask()
        const toTarget = Game.getObjectById(task.toId)
        if ( !toTarget ) {
            /** 清除 store */
            creep.drop(RESOURCE_ENERGY)
            setCurrentTask(null)
            return [A.proc.OK_STOP_CUSTOM, 'wait'] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
        }

        if ( toTarget.store.getFreeCapacity(RESOURCE_ENERGY) > 0 ) {
            const amount = Math.min(task.currentAmount, toTarget.store.getFreeCapacity(RESOURCE_ENERGY))
            assertWithMsg( creep.transfer(toTarget, RESOURCE_ENERGY, amount) === OK, `quickEnergyFill -> 412` )
            if ( toTarget instanceof StructureContainer )
                A.timer.add(Game.time + 1, (id, amount) => A.res.signal(id, RESOURCE_ENERGY, amount), [task.toId, amount], `${task.toId} 能量资源更新`)
            else
                A.timer.add(Game.time + 1, (pos, amount) => issuedTransferFor[convertPosToString(pos)] -= amount, [toTarget.pos, amount], `更新快速能量填充 Extension 计划转移的能量数量`)
            task.currentAmount -= amount
            if ( task.currentAmount > 0 )
                return A.proc.OK_STOP_CURRENT
        } else {
            creep.drop(RESOURCE_ENERGY)
            if ( !(toTarget instanceof StructureContainer) )
                issuedTransferFor[convertPosToString(toTarget.pos)] = 0
            task.remainingAmount = 0
            task.currentAmount = 0
        }

        log(LOG_DEBUG, `${roomName} 快速填充计划填充状况: ${JSON.stringify(issuedTransferFor)}`)

        if ( task.remainingAmount > 0 )
            return [ A.proc.OK_STOP_CUSTOM, 'withdraw' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
        else {
            setCurrentTask(null)
            return [ A.proc.OK_STOP_CUSTOM, 'wait' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
        }
    }

    A.proc.createProc([
        () => P.exist(roomName, unitName, tagLeftContainer), 
        () => C.acquire('quickFiller0', roomName, name => leftTopFillerName = name, new RoomPosition(posLeftTopWorker.x, posLeftTopWorker.y, posLeftTopWorker.roomName)), 
        () => runCreepDrop( () => leftTopFillerName, name => leftTopFillerName = name ), 
        () => runCreepMoveTo( () => leftTopFillerName, name => leftTopFillerName = name, posLeftTopWorker ), 
        ['wait', () => A.proc.signal.Swait({ signalId: LeftTopPoolSignal, lowerbound: 1, request: 1 })], 
        ['withdraw', () => runCreepWithdraw( () => leftTopFillerName, name => leftTopFillerName = name, posLeftTopWorker, LeftTopPool, LeftTopPoolSignal, () => leftTopFillerCurrentTask, task => leftTopFillerCurrentTask = task )], 
        () => runCreepTransfer( () => leftTopFillerName, name => leftTopFillerName = name, posLeftTopWorker, LeftTopPool, LeftTopPoolSignal, () => leftTopFillerCurrentTask, task => leftTopFillerCurrentTask = task )
    ], `${roomName} => Quick Filler (Left Top)`)

    A.proc.createProc([
        () => P.exist(roomName, unitName, tagLeftContainer), 
        () => C.acquire('quickFiller1', roomName, name => leftBottomFillerName = name, new RoomPosition(posLeftBottomWorker.x, posLeftBottomWorker.y, posLeftBottomWorker.roomName)), 
        () => runCreepDrop( () => leftBottomFillerName, name => leftBottomFillerName = name ), 
        () => runCreepMoveTo( () => leftBottomFillerName, name => leftBottomFillerName = name, posLeftBottomWorker ), 
        ['wait', () => A.proc.signal.Swait({ signalId: LeftBottomPoolSignal, lowerbound: 1, request: 1 })], 
        ['withdraw', () => runCreepWithdraw( () => leftBottomFillerName, name => leftBottomFillerName = name, posLeftBottomWorker, LeftBottomPool, LeftBottomPoolSignal, () => leftBottomFillerCurrentTask, task => leftBottomFillerCurrentTask = task )], 
        () => runCreepTransfer( () => leftBottomFillerName, name => leftBottomFillerName = name, posLeftBottomWorker, LeftBottomPool, LeftBottomPoolSignal, () => leftBottomFillerCurrentTask, task => leftBottomFillerCurrentTask = task )
    ], `${roomName} => Quick Filler (Left Bottom)`)

    A.proc.createProc([
        () => P.exist(roomName, unitName, tagRightContainer), 
        () => C.acquire('quickFiller2', roomName, name => rightTopFillerName = name, new RoomPosition(posRightTopWorker.x, posRightTopWorker.y, posRightTopWorker.roomName)), 
        () => runCreepDrop( () => rightTopFillerName, name => rightTopFillerName = name ), 
        () => runCreepMoveTo( () => rightTopFillerName, name => rightTopFillerName = name, posRightTopWorker ), 
        ['wait', () => A.proc.signal.Swait({ signalId: RightTopPoolSignal, lowerbound: 1, request: 1 })], 
        ['withdraw', () => runCreepWithdraw( () => rightTopFillerName, name => rightTopFillerName = name, posRightTopWorker, RightTopPool, RightTopPoolSignal, () => rightTopFillerCurrentTask, task => rightTopFillerCurrentTask = task )], 
        () => runCreepTransfer( () => rightTopFillerName, name => rightTopFillerName = name, posRightTopWorker, RightTopPool, RightTopPoolSignal, () => rightTopFillerCurrentTask, task => rightTopFillerCurrentTask = task )
    ], `${roomName} => Quick Filler (Right Top)`)

    A.proc.createProc([
        () => P.exist(roomName, unitName, tagRightContainer), 
        () => C.acquire('quickFiller3', roomName, name => rightBottomFillerName = name, new RoomPosition(posRightBottomWorker.x, posRightBottomWorker.y, posRightBottomWorker.roomName)), 
        () => runCreepDrop( () => rightBottomFillerName, name => rightBottomFillerName = name ), 
        () => runCreepMoveTo( () => rightBottomFillerName, name => rightBottomFillerName = name, posRightBottomWorker ), 
        ['wait', () => A.proc.signal.Swait({ signalId: RightBottomPoolSignal, lowerbound: 1, request: 1 })], 
        ['withdraw', () => runCreepWithdraw( () => rightBottomFillerName, name => rightBottomFillerName = name, posRightBottomWorker, RightBottomPool, RightBottomPoolSignal, () => rightBottomFillerCurrentTask, task => rightBottomFillerCurrentTask = task )], 
        () => runCreepTransfer( () => rightBottomFillerName, name => rightBottomFillerName = name, posRightBottomWorker, RightBottomPool, RightBottomPoolSignal, () => rightBottomFillerCurrentTask, task => rightBottomFillerCurrentTask = task )
    ], `${roomName} => Quick Filler (Right Bottom)`)
}

export function issueQuickEnergyFill(roomName: string, getLinkBuffer: () => Id<StructureLink>[], linkBufferSignal: string) {
    const planInfo = P.plan(roomName, 'unit', unitName)
    assertWithMsg( planInfo !== null, `运行快速能量填充模块的房间, 一定需要是可规划完成的` )
    const leftTopPos = planInfo.leftTops[0]
    issueQuickEnergyFillProc(roomName, leftTopPos, getLinkBuffer, linkBufferSignal)
}