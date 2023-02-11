export function assertWithMsg(condition: boolean, message: string): void {
    if ( !condition )
        throw new Error(message)
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

export const generate_random_hex = size => [...Array(size)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')

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