/**
 * Link 管理模块
 */

import { Apollo as A } from "@/framework/apollo"
import { creepModule as C } from "@/modules/creep"
import { assertWithMsg, getFileNameAndLineNumber } from "@/utils"

interface TransitLinkInfo {
    getId: () => Id<StructureLink>
    existSignalId: string
    receivableAmount: () => number
    sendableAmount: () => number
    receive: (amount: number, callback: () => void) => void
    send: (amount: number, target: Id<StructureLink>, callback: () => void) => void
}

const MIN_SEND_AMOUNT = 700

export function registerLinkManage() {
    C.design('cleaner', {
        amount: 1, 
        body: {
            1: [ CARRY, MOVE ]
        }
    })
}

export function issueLinkManage( roomName: string, senderLinkIdGetters: (() => Id<StructureLink>)[], receiverLinkIdGetters: (() => Id<StructureLink>)[], transitLinkInfo: TransitLinkInfo ) {
    let transitLinkStatus = 'idle'
    let cleanerName = null
    A.proc.createProc([
        () => A.proc.signal.Swait({ signalId: transitLinkInfo.existSignalId, lowerbound: 1, request: 0 }), 
        () => {
            // 清理残留 energy
            const transitLink = Game.getObjectById(transitLinkInfo.getId())
            if ( !transitLink ) return [ A.proc.STOP_ERR, `TransitLink 无法找到!` ] as [ typeof A.proc.STOP_ERR, string ]
            if ( transitLink.store.getUsedCapacity(RESOURCE_ENERGY) === 0 ) return [ A.proc.OK_STOP_CUSTOM, 'work' ] as [ typeof A.proc.OK_STOP_CUSTOM, string ]
            return A.proc.OK
        }, 
        () => C.acquire('cleaner', roomName, name => cleanerName = name), 
        () => {
            const creep = Game.creeps[cleanerName]
            if ( !creep ) {
                C.cancel(cleanerName)
                cleanerName = null
                return [ A.proc.STOP_ERR, `Creep ${cleanerName} 无法找到` ] as [ typeof A.proc.STOP_ERR, string ]
            }
            const transitLink = Game.getObjectById(transitLinkInfo.getId())
            if ( !transitLink ) return [ A.proc.STOP_ERR, `TransitLink 无法找到!` ] as [ typeof A.proc.STOP_ERR, string ]
            if ( creep.pos.getRangeTo(transitLink) > 1 ) {
                creep.travelTo(transitLink, { range: 1, avoidStructureTypes: [ STRUCTURE_CONTAINER ], ignoreCreeps: false })
                return A.proc.OK_STOP_CURRENT
            }

            if ( creep.store.getUsedCapacity() > 0 ) {
                creep.drop(RESOURCE_ENERGY)
                return A.proc.OK_STOP_CURRENT
            }

            if ( transitLink.store.getUsedCapacity(RESOURCE_ENERGY) > 0 ) {
                const amount = Math.min(transitLink.store.getUsedCapacity(RESOURCE_ENERGY), creep.store.getFreeCapacity())
                assertWithMsg( A.res.request({id: transitLink.id, resourceType: RESOURCE_ENERGY, amount}) === A.proc.OK, `linkManage -> L63` )
                assertWithMsg( creep.withdraw(transitLink, RESOURCE_ENERGY) === OK, `linkManage -> L64` )
                A.timer.add(Game.time + 1, id => A.res.signal(id, A.res.CAPACITY_ENERGY, amount), [transitLink.id], `${transitLink} 资源更新`)
                return A.proc.OK_STOP_CURRENT
            }

            // 此时完成清理
            C.release(cleanerName)
            cleanerName = null
            return A.proc.OK
        }, 
        ['work', () => {
            const transitLink = Game.getObjectById(transitLinkInfo.getId())
            if ( !transitLink ) return [ A.proc.STOP_ERR, `TransitLink 无法找到!` ] as [ typeof A.proc.STOP_ERR, string ]
            // console.log(transitLink, transitLinkStatus)
            // 检查状态
            if ( transitLinkStatus !== 'idle' ) return A.proc.OK_STOP_CURRENT

            /** 优先发送 */
            const sendableAmount = transitLinkInfo.sendableAmount()
            // console.log(sendableAmount, transitLink.cooldown)
            if ( sendableAmount > 0 && transitLink.cooldown <= 0 ) {
                for ( const receiverLinkIdGetter of receiverLinkIdGetters ) {
                    const receiverLink = Game.getObjectById(receiverLinkIdGetter())
                    if ( !receiverLink || receiverLink.cooldown > 0 || A.res.query(receiverLink.id, A.res.CAPACITY_ENERGY) <= 0 ) continue
                    const receivableAmount = A.res.query(receiverLink.id, A.res.CAPACITY_ENERGY)
                    const sendAmount = Math.min(Math.ceil(receivableAmount / (1 - LINK_LOSS_RATIO)), sendableAmount)
                    const receiveAmount = sendAmount - Math.ceil(LINK_LOSS_RATIO * sendAmount)
                    assertWithMsg( receiveAmount <= receivableAmount, getFileNameAndLineNumber() )
                    transitLinkStatus = 'busy'
                    transitLinkInfo.send(sendAmount, receiverLink.id, () => transitLinkStatus = 'idle')
                    return A.proc.OK_STOP_CURRENT
                }
            }

            /** 其次接收 */
            const receivableAmount = transitLinkInfo.receivableAmount()
            // console.log(receivableAmount)
            if ( receivableAmount > 0 ) {
                for ( const senderLinkIdGetter of senderLinkIdGetters ) {
                    const senderLink = Game.getObjectById(senderLinkIdGetter())
                    // 当且仅当快满的时候发送
                    if ( !senderLink || senderLink.cooldown > 0 || senderLink.store.getUsedCapacity(RESOURCE_ENERGY) < MIN_SEND_AMOUNT ) continue
                    const sendAmount = Math.min(Math.ceil(receivableAmount / (1 - LINK_LOSS_RATIO)), senderLink.store.getUsedCapacity(RESOURCE_ENERGY))
                    const receiveAmount = sendAmount - Math.ceil(LINK_LOSS_RATIO * sendAmount)
                    assertWithMsg( receiveAmount <= receivableAmount, getFileNameAndLineNumber() )
                    assertWithMsg( senderLink.transferEnergy(Game.getObjectById(transitLinkInfo.getId()), sendAmount) === OK, getFileNameAndLineNumber() )
                    transitLinkStatus = 'busy'
                    transitLinkInfo.receive(receiveAmount, () => transitLinkStatus = 'idle')
                    return A.proc.OK_STOP_CURRENT
                }
            }

            return A.proc.OK_STOP_CURRENT
        }]
    ], `${roomName} => Link 管理`)
}