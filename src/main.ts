import { Apollo as A } from './framework/apollo'
import { errorMapper } from './modules/errorMapper'
import { mountAll, registerAll } from './versions/beta'

/** 重置日志 */
(Memory as any)._err = [];
(Memory as any)._log = []

/** 重启时重新挂载 */
mountAll()
/** 重启时重新注册 */
registerAll()

export const loop = errorMapper(() => A.proc.tick())