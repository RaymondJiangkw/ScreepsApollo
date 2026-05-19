interface Memory {
    /** 内存中记录设置 Log 等级 */
    logLevel?: number
    /** 存放建筑的 Memory */
    structures: {}
}

interface CreepMemory {
    /** 生成模块管理 —— Creep 型号 */
    spawnType: string
    /** 生成模块管理 —— Creep 所属房间名称 (管辖房间) */
    spawnRoomName: string
    /** 生成模块管理 —— 预期的工作位置 */
    workPos?: RoomPosition
    /** 出生时间 */
    spawnTime: number
}

/** 可存取的建筑, 并不包含 Ruin 和 TombStone */
interface StorableStructure extends Structure {
    /**
     * A Store object that contains cargo of this structure.
     */
    store: StoreDefinition |
            Store<RESOURCE_ENERGY, false> | // Spawn, Extension
            Store<RESOURCE_ENERGY | RESOURCE_POWER, false> | // PowerSpawn
            Store<RESOURCE_ENERGY | MineralConstant | MineralCompoundConstant, false> | // Lab
            Store<RESOURCE_ENERGY | RESOURCE_GHODIUM, false> // Nuker
}

/** 存储在内存中的位置形式 */
type Pos = { x: number, y: number, roomName: string }

interface Console {
    logUnsafe(...data: any[]): void
}