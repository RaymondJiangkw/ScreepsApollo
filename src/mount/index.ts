/**
 * 挂载入口
 */

import { mountWatcher } from "@/modules/watcher";

export function mountAll() {
    mountWatcher()
}