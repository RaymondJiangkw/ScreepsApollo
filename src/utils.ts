export function assertWithMsg(condition: boolean, message: string): void {
    if ( !condition )
        throw message
}

/** Log Level - Debug */
export const LOG_DEBUG = 3
/** Log Level - Information */
export const LOG_INFO = 2
/** Log Level - Error */
export const LOG_ERR = 1

type LOG_LEVEL = typeof LOG_DEBUG | typeof LOG_INFO | typeof LOG_ERR

export function log(level: LOG_LEVEL, ...args): void {
    if ( typeof Memory.logLevel !== "number" || level <= Memory.logLevel ) {
        let prefix = `[${Game.time}] `
        if ( level === LOG_DEBUG ) prefix += '🐛 '
        else if ( level === LOG_INFO ) prefix += '📝 '
        else if ( level === LOG_ERR ) prefix += '❌ '
        console.log( prefix, ...args )
    }
}

export const generate_random_hex = size => [...Array(size)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')