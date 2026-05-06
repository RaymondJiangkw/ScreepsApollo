/** 
 * 生产规划, 默认存储在 Storage 中中转 
 * 包含两类, 维持 和 生产 X 个
 * - 维持在文件中指定 (最少 和 最大)
 * - 生产提供命令, 从而触发生产链
 */

export function registerProduction() {
    if ( !("_prod" in Memory) ) (Memory as any)._prod = {}
    if ( !("maintain" in (Memory as any)._prod) ) (Memory as any)._prod.maintain = {};
    if ( !("maintain_min" in (Memory as any)._prod) ) (Memory as any)._prod.maintain_min = {};
    if ( !("maintain_max" in (Memory as any)._prod) ) (Memory as any)._prod.maintain_max = {};
    
    (Memory as any)._prod.maintain_max[RESOURCE_ENERGY] = STORAGE_CAPACITY * 0.4;
    (Memory as any)._prod.maintain_max["mineral"] = STORAGE_CAPACITY * 0.2;
    (Memory as any)._prod.maintain_min[RESOURCE_ENERGY] = STORAGE_CAPACITY * 0.3;
    (Memory as any)._prod.maintain_min["mineral"] = STORAGE_CAPACITY * 0.1;

    (Memory as any)._prod.maintain["free before store"] = STORAGE_CAPACITY * 0.1;
}

/** 维持 */
export function getMaintainAmount(resourceType: ResourceConstant | "mineral" | "free before store") {
    return (Memory as any)._prod.maintain[resourceType] || 0
}

export function getMinMaintainAmount(resourceType: ResourceConstant | "mineral" | "free before store") {
    return (Memory as any)._prod.maintain_min[resourceType] || 0
}

export function getMaxMaintainAmount(resourceType: ResourceConstant | "mineral" | "free before store") {
    return (Memory as any)._prod.maintain_max[resourceType] || 0
}