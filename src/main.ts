import { Apollo as A } from './framework/apollo'
import { errorMapper } from './modules/errorMapper'
import { mountAll } from './mount'

/** 重启时重新挂载 */
mountAll()

export const loop = errorMapper(A.proc.tick)