/** 
 * 生产规划, 默认存储在 Storage 中中转 
 * 包含两类, 维持 和 生产 X 个
 * - 维持在文件中指定
 * - 生产提供命令, 从而触发生产链
 */

export function registerProduction() {
    if ( !("_prod" in Memory) ) (Memory as any)._prod = {}
    if ( !("maintain" in (Memory as any)._prod) ) (Memory as any)._prod.maintain = {};
    
    (Memory as any)._prod.maintain[RESOURCE_ENERGY] = STORAGE_CAPACITY / 2
}

/** 维持 */
export function getMaintainAmount(resourceType: ResourceConstant) {
    return (Memory as any)._prod.maintain[resourceType] || 0
}