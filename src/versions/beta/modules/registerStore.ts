/**
 * 注册建筑 Store
 */

import { Apollo as A } from "@/framework/apollo"

export function registerStoreForRoom(roomName: string) {
    const room = Game.rooms[roomName]
    if ( !room ) return
    const structures = room.find(FIND_STRUCTURES)
    for ( const structure of structures ) {
        if ( !!(structure as StorableStructure).store && !(structure instanceof StructureSpawn) && !(structure instanceof StructureExtension) ) A.res.register(structure as StorableStructure)
    }
}