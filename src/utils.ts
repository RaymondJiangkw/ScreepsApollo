export function assertWithMsg(condition: boolean, message: string = 'Assert 时发生错误'): void {
    if ( !condition )
        throw new Error(message)
}

export function raiseNotImplementedError() {
    throw new Error('尚未实现')
}

// ----------------------------------------------------------------
/** Log Level - Profile */
export const LOG_PROFILE = 4
/** Log Level - Debug */
export const LOG_DEBUG = 3
/** Log Level - Information */
export const LOG_INFO = 2
/** Log Level - Error */
export const LOG_ERR = 1

type LOG_LEVEL = typeof LOG_PROFILE | typeof LOG_DEBUG | typeof LOG_INFO | typeof LOG_ERR

export function log(level: LOG_LEVEL, ...args): void {
    if ( typeof Memory.logLevel !== "number" || level <= Memory.logLevel ) {
        let prefix = `[${Game.time}] `
        if ( level === LOG_PROFILE ) prefix += '⌛ '
        else if ( level === LOG_DEBUG ) prefix += '🐛 '
        else if ( level === LOG_INFO ) prefix += '📝 '
        else if ( level === LOG_ERR ) prefix += '❌ '
        console.log( prefix, ...args )
    }
}

// ----------------------------------------------------------------

export const generate_random_hex = (size: number) => [...Array(size)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')

// ----------------------------------------------------------------

/**
 * 找到 array 当中小于(等于) val 的最大元素.
 * 如果没找到, 则返回 null
 * 
 * @param equalto 是否允许等于
 * @param sorted array 是否是排序过的 (用于优化)
 */
export function largest_less_than<T>(array: T[], val: T, equalto: boolean = true, sorted: boolean = false): T | null {
    let largest = null
    for (const element of array) {
        if ((element < val || (equalto && element === val)) && (largest === null || element > largest))
            largest = element
    }
    return largest
}

/** 构建数组 */
export function constructArray<T>(dimensions: number[], fillIn: T) {
    const ret = []
    const constructor = (array, index) => {
        if (index < dimensions.length - 1)
            for (let i = 0; i < dimensions[index]; i++) {
                array.push([])
                array[i] = constructor(array[i], index + 1)
            }
        else if (index === dimensions.length - 1) 
            for (let i = 0; i < dimensions[index]; i++) {
                // 特殊情况: [] (加速)
                if (Array.isArray(fillIn) && fillIn.length === 0) array.push([])
                else if (typeof fillIn === "object") array.push(JSON.parse(JSON.stringify(fillIn)))
                else array.push(fillIn)
            }
        return array
    }
    return constructor(ret, 0)
}

export function getAvailableSurroundingPos(pos: Pos): Pos[] {
    const terrain = new Room.Terrain(pos.roomName)
    const ret: Pos[] = []
    for ( let dx of [-1, 0, 1] ) {
        for ( let dy of [-1, 0, 1] ) {
            if ( dx === 0 && dy === 0 ) continue
            if ( pos.x + dx < 0 || pos.x + dx >= 50 || pos.y + dy < 0 || pos.y + dy >= 50 ) continue
            if ( terrain.get( pos.x + dx, pos.y + dy ) === TERRAIN_MASK_WALL ) continue
            ret.push({ x: pos.x + dx, y: pos.y + dy, roomName: pos.roomName })
        }
    }
    return ret
}

export function convertPosToString(pos: Pos) {
    return `[room ${pos.roomName} pos ${pos.x},${pos.y}]`
}

export function insertSortedBy<T>(arr: T[], value: T, iteratee?: string | ((element: T) => any)) {
    arr.splice(_.sortedIndex(arr, value, iteratee), 0, value)
}

export function getUsedCapacity(structure: StorableStructure) {
    if ( structure instanceof StructureExtension )
        return structure.store.getUsedCapacity(RESOURCE_ENERGY)
    else if ( structure instanceof StructureLink )
        return structure.store.getUsedCapacity(RESOURCE_ENERGY)
    else if ( structure instanceof StructureSpawn )
        return structure.store.getUsedCapacity(RESOURCE_ENERGY)
    else if ( structure instanceof StructureTower )
        return structure.store.getUsedCapacity(RESOURCE_ENERGY)
    else if ( structure instanceof StructureLab )
        return structure.store.getUsedCapacity(RESOURCE_ENERGY) + structure.store.getUsedCapacity(structure.mineralType || RESOURCE_HYDROGEN)
    else if ( structure instanceof StructurePowerSpawn )
        return structure.store.getUsedCapacity(RESOURCE_ENERGY) + structure.store.getUsedCapacity(RESOURCE_POWER)
    else if ( structure instanceof StructureNuker )
        return structure.store.getUsedCapacity(RESOURCE_ENERGY) + structure.store.getUsedCapacity(RESOURCE_GHODIUM)
    else
        return structure.store.getUsedCapacity()
}

export function getMyRooms() {
    return _.filter(Game.rooms, room => room.controller && room.controller.my)
}