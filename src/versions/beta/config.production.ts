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
            "mineral": STORAGE_CAPACITY * 0.1, 
            "deposit": 0, 
            [RESOURCE_HYDROGEN]: 6000, 
            [RESOURCE_OXYGEN]: 6000, 
            [RESOURCE_UTRIUM]: 6000, 
            [RESOURCE_LEMERGIUM]: 6000, 
            [RESOURCE_KEANIUM]: 6000, 
            [RESOURCE_ZYNTHIUM]: 6000, 
            [RESOURCE_CATALYST]: 6000, 
        }, 
        maintain_max: {
            [RESOURCE_ENERGY]: STORAGE_CAPACITY * 0.4, 
            "mineral": STORAGE_CAPACITY * 0.2, 
            "deposit": STORAGE_CAPACITY * 0.2, 
            [RESOURCE_HYDROGEN]: 12000, 
            [RESOURCE_OXYGEN]: 12000, 
            [RESOURCE_UTRIUM]: 12000, 
            [RESOURCE_LEMERGIUM]: 12000, 
            [RESOURCE_KEANIUM]: 12000, 
            [RESOURCE_ZYNTHIUM]: 12000, 
            [RESOURCE_CATALYST]: 12000, 
        }, 
        maintain: {
            "free before store": STORAGE_CAPACITY * 0.1
        }, 
        // 使用 Terminal 作为 Buffer 来缓存需要 Maintain 的资源
        // 默认不包含本房间的 mineral
        // 默认不 respect maintain_min (因为 Terminal 不是中转站)
        withdrawFromTerminal: [
            RESOURCE_HYDROGEN, RESOURCE_OXYGEN, RESOURCE_UTRIUM, RESOURCE_LEMERGIUM, 
            RESOURCE_KEANIUM, RESOURCE_ZYNTHIUM, RESOURCE_CATALYST
        ]
    };

    (Memory as any)._prod.terminal = {
        maintain_min: {
            [RESOURCE_ENERGY]: 10000, 
            "mineral": 10000, 
            [RESOURCE_HYDROGEN]: 3000, 
            [RESOURCE_OXYGEN]: 3000, 
            [RESOURCE_UTRIUM]: 3000, 
            [RESOURCE_LEMERGIUM]: 3000, 
            [RESOURCE_KEANIUM]: 3000, 
            [RESOURCE_ZYNTHIUM]: 3000, 
            [RESOURCE_CATALYST]: 3000, 
        }, 
        maintain_max: {
            [RESOURCE_ENERGY]: 50000, 
            "mineral": 50000, 
            [RESOURCE_HYDROGEN]: 6000, 
            [RESOURCE_OXYGEN]: 6000, 
            [RESOURCE_UTRIUM]: 6000, 
            [RESOURCE_LEMERGIUM]: 6000, 
            [RESOURCE_KEANIUM]: 6000, 
            [RESOURCE_ZYNTHIUM]: 6000, 
            [RESOURCE_CATALYST]: 6000, 
        }, 
        maintain: {
            "free before store": 10000
        }, 
        /** 序列, 内资源自动售出全部 */
        sell: [  ], 
        // 使用 Storage 作为 Buffer 来缓存需要 Maintain 的资源
        // 默认 respect maintain_min (因为 Storage 是中转站)
        withdrawFromStorage: [
            RESOURCE_ENERGY, "mineral"
        ]
    };

    /** 按照优先级排序, 每次从头开始扫描, 判断生产哪个 */
    (Memory as any)._prod.lab = [
        // G
        [ RESOURCE_GHODIUM, {min: 6000, max: 12000} ], 
        // XKHO_2: Ranged Attack
        [ RESOURCE_CATALYZED_KEANIUM_ALKALIDE, { min: 6000, max: 12000 } ], 
        // XLHO_2: Heal
        [ RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE, { min: 6000, max: 12000 } ], 
        // XZHO_2: Move
        [ RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE, { min: 6000, max: 12000 } ], 
        // XZH2_O: Dismental
        [ RESOURCE_CATALYZED_ZYNTHIUM_ACID, { min: 6000, max: 12000 } ], 
        // XUH2_O: Attack
        [ RESOURCE_CATALYZED_UTRIUM_ACID, { min: 6000, max: 12000 } ], 
        // XGHO_2: Tough
        [ RESOURCE_CATALYZED_GHODIUM_ALKALIDE, { min: 6000, max: 12000 } ], 
        // XKH2_O: Carry
        [ RESOURCE_CATALYZED_KEANIUM_ACID, { min: 3000, max: 6000 } ], 
        // XUHO_2: Harvest
        [ RESOURCE_CATALYZED_UTRIUM_ALKALIDE, { min: 3000, max: 6000 } ], 
        // XGH2_O: Upgrade
        // [ RESOURCE_CATALYZED_GHODIUM_ACID, { min: 6000, max: 12000 } ], 
        // XLH2_O: Repair / Build
        [ RESOURCE_CATALYZED_LEMERGIUM_ACID, { min: 6000, max: 12000 } ]
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

export function getStorageMaintainFromTerminalList(): ResourceConstant[] {
    return (Memory as any)._prod.storage.withdrawFromTerminal
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
    const ret = {}
    const types = getTerminalMaintainTypes()
    for ( const type of types ) {
        if ( _.includes(getTerminalMaintainFromStorageList(), type) ) continue
        ret[type] = { min: getTerminalMinMaintainAmount(type), max: getTerminalMaxMaintainAmount(type) }
    }
    return ret
}

export function getTerminalMaintainFromStorageList(): ResourceConstant[] {
    return (Memory as any)._prod.terminal.withdrawFromStorage
}