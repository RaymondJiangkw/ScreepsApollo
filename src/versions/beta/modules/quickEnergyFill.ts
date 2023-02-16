/**
 * 快速填充 Spawn 及附近的 Extension 模块
 */

import { Apollo as A } from "@/framework/apollo"
import { creepModule as C } from "@/modules/creep"
import { planModule as P } from "@/modules/plan"

export function registerQuickEnergyFill() {
    C.design('quickFiller', {
        body: {
            1: [ CARRY, MOVE ], 
            7: [ CARRY, CARRY, MOVE ], 
            8: [ CARRY, CARRY, CARRY, CARRY, MOVE ]
        }, 
        /** 最大值 */
        amount: 4, 
        priority: C.PRIORITY_IMPORTANT
    })
}

export function issueQuickEnergyFill(roomName: string) {

}