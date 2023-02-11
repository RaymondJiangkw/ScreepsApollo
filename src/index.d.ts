interface Memory {
    /** 内存中记录设置 Log 等级 */
    logLevel?: number
}

interface CreepMemory {
    /** 生成模块管理 —— Creep 型号 */
    spawnType: string
    /** 生成模块管理 —— Creep 所属房间名称 (管辖房间) */
    spawnRoomName: string
}