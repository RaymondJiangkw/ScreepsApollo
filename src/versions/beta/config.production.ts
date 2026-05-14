/** 
 * 生产规划, 默认存储在 Storage 中中转 
 * 包含两类, 维持 和 生产 X 个
 * - 维持在文件中指定 (最少 和 最大)
 * - 生产提供命令, 从而触发生产链
 */

export function registerProduction() {
    if ( !("_prod" in Memory) ) (Memory as any)._prod = {}
    if ( !("storage" in (Memory as any)._prod) ) (Memory as any)._prod.storage = {};
    if ( !("terminal" in (Memory as any)._prod) ) (Memory as any)._prod.terminal = {};
    if ( !("lab" in (Memory as any)._prod) ) (Memory as any)._prod.lab = {};

    (Memory as any)._prod.storage = {
        maintain_min: {
            [RESOURCE_ENERGY]: STORAGE_CAPACITY * 0.3, 
            "mineral": STORAGE_CAPACITY * 0.1
        }, 
        maintain_max: {
            [RESOURCE_ENERGY]: STORAGE_CAPACITY * 0.4, 
            "mineral": STORAGE_CAPACITY * 0.2, 
            "deposit": STORAGE_CAPACITY * 0.2
        }, 
        maintain: {
            "free before store": STORAGE_CAPACITY * 0.1
        }
    };

    (Memory as any)._prod.terminal = {
        maintain_min: {
            [RESOURCE_ENERGY]: 10000, 
            "mineral": 10000
        }, 
        maintain_max: {
            [RESOURCE_ENERGY]: 50000, 
            "mineral": 50000
        }, 
        maintain: {
            "free before store": 10000
        }, 
        /** 序列, 内资源达到 `maintain_max` 自动售出到 `maintain_min` (留一定冗余) */
        sell: [  ], 
        buy: {
            [RESOURCE_HYDROGEN]: {min: 3000, max: 6000}, 
            [RESOURCE_OXYGEN]: {min: 3000, max: 6000}, 
            [RESOURCE_UTRIUM]: {min: 3000, max: 6000}, 
            [RESOURCE_LEMERGIUM]: {min: 3000, max: 6000}, 
            [RESOURCE_KEANIUM]: {min: 3000, max: 6000}, 
            [RESOURCE_ZYNTHIUM]: {min: 3000, max: 6000}, 
            [RESOURCE_CATALYST]: {min: 3000, max: 6000}
        }
    };

    /** 按照优先级排序, 每次从头开始扫描, 判断生产哪个 */
    (Memory as any)._prod.lab = [
        // G
        [ RESOURCE_GHODIUM, {min: 3000, max: 6000} ], 
        // XKHO_2: Ranged Attack
        [ RESOURCE_CATALYZED_KEANIUM_ALKALIDE, { min: 3000, max: 6000 } ], 
        // XLHO_2: Heal
        [ RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE, { min: 3000, max: 6000 } ], 
        // XZHO_2: Move
        [ RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE, { min: 3000, max: 6000 } ], 
        // XGHO_2: Tough
        [ RESOURCE_CATALYZED_GHODIUM_ALKALIDE, { min: 3000, max: 6000 } ], 
        // XUH2_O: Attack
        [ RESOURCE_CATALYZED_UTRIUM_ACID, { min: 3000, max: 6000 } ], 
        // XKH2_O: Carry
        [ RESOURCE_CATALYZED_KEANIUM_ACID, { min: 3000, max: 6000 } ], 
        // XZH2_O: Dismental
        [ RESOURCE_CATALYZED_ZYNTHIUM_ACID, { min: 3000, max: 6000 } ], 
        // XUHO_2: Harvest
        [ RESOURCE_CATALYZED_UTRIUM_ALKALIDE, { min: 3000, max: 6000 } ], 
        // XGH2_O: Upgrade
        [ RESOURCE_CATALYZED_GHODIUM_ACID, { min: 3000, max: 6000 } ], 
        // XLH2_O: Repair / Build
        [ RESOURCE_CATALYZED_LEMERGIUM_ACID, { min: 3000, max: 6000 } ]
    ]
}

/** Lab */
export function getLabInfo(): [ MineralCompoundConstant, { min: number, max: number } ][] {
    return (Memory as any)._prod.lab
}

/** Storage */
export function getStorageMaintainAmount(resourceType: ResourceConstant | "mineral" | "deposit" | "free before store") {
    return (Memory as any)._prod.storage.maintain[resourceType] || 0
}

export function getStorageMinMaintainAmount(resourceType: ResourceConstant | "mineral" | "deposit" | "free before store") {
    return (Memory as any)._prod.storage.maintain_min[resourceType] || 0
}

export function getStorageMaxMaintainAmount(resourceType: ResourceConstant | "mineral" | "deposit" | "free before store") {
    return (Memory as any)._prod.storage.maintain_max[resourceType] || 0
}

/** Terminal */
export function getTerminalMinMaintainAmount(resourceType: ResourceConstant | "mineral" | "free before store") {
    return (Memory as any)._prod.terminal.maintain_min[resourceType] || 0
}

export function getTerminalMaxMaintainAmount(resourceType: ResourceConstant | "mineral" | "free before store") {
    return (Memory as any)._prod.terminal.maintain_max[resourceType] || 0
}

export function getTerminalMaintainAmount(resourceType: ResourceConstant | "mineral" | "free before store") {
    return (Memory as any)._prod.terminal.maintain[resourceType] || 0
}

export function getTerminalMaintainTypes(): ResourceConstant[] {
    return Object.keys((Memory as any)._prod.terminal.maintain_max).filter(t => t !== 'mineral') as ResourceConstant[]
}

export function getTerminalSellList(): ResourceConstant[] {
    return (Memory as any)._prod.terminal.sell
}

export function getTerminalBuyInfo(): { [resourceType in ResourceConstant]?: { min: number, max: number } } {
    return (Memory as any)._prod.terminal.buy
}