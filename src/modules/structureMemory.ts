interface StructureMemory {
    pos: Pos, 
    unitName: string, 
    tag: string[]
}

export function getStructureMemory(structureId: Id<Structure>): StructureMemory {
    if ( !Memory.structures ) Memory.structures = {}
    if ( !(structureId in Memory.structures) ) Memory.structures[structureId] = {}
    return Memory.structures[structureId]
}

export function deleteStructureMemory(structureId: Id<Structure>) {
    if ( !Memory.structures ) Memory.structures = {}
    if ( structureId in Memory.structures ) delete Memory.structures[structureId]
}