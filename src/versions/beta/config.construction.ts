import { planModule as P, Unit } from '@/modules/plan'
import { getMyRooms } from '@/utils'

export function registerCommonConstructions() {
    /** @NOTICE 对于第一个房间, `centralSpawn` 的位置需要检测指定 */
    const myRooms = getMyRooms()
    if (myRooms.length === 1) {
        const pos = myRooms[0].find(FIND_MY_SPAWNS)[0].pos
        if ( !('_plan' in Memory) ) (Memory as any)._plan = {}
        if ( !(myRooms[0].name in (Memory as any)._plan) ) (Memory as any)._plan[myRooms[0].name] = {};
        (Memory as any)._plan[myRooms[0].name]['centralSpawn'] = [ new RoomPosition(pos.x - 3, pos.y - 1, pos.roomName) ]
    }

    P.register('unit', 'centralSpawn', new Unit([
        [Unit.STRUCTURE_ANY,    STRUCTURE_ROAD,                         STRUCTURE_ROAD,         STRUCTURE_ROAD,                         STRUCTURE_ROAD,         STRUCTURE_ROAD,                         Unit.STRUCTURE_ANY],
        [STRUCTURE_ROAD,        STRUCTURE_EXTENSION,                    STRUCTURE_EXTENSION,    [STRUCTURE_SPAWN, STRUCTURE_RAMPART],   STRUCTURE_EXTENSION,    STRUCTURE_EXTENSION,                    STRUCTURE_ROAD],
        [STRUCTURE_ROAD,        STRUCTURE_EXTENSION,                    Unit.STRUCTURE_ANY,     STRUCTURE_EXTENSION,                    Unit.STRUCTURE_ANY,     STRUCTURE_EXTENSION,                    STRUCTURE_ROAD],
        [STRUCTURE_ROAD,        STRUCTURE_CONTAINER,                    STRUCTURE_EXTENSION,    STRUCTURE_LINK,                         STRUCTURE_EXTENSION,    STRUCTURE_CONTAINER,                    STRUCTURE_ROAD],
        [STRUCTURE_ROAD,        [STRUCTURE_SPAWN, STRUCTURE_RAMPART],   Unit.STRUCTURE_ANY,     STRUCTURE_EXTENSION,                    Unit.STRUCTURE_ANY,     [STRUCTURE_SPAWN, STRUCTURE_RAMPART],   STRUCTURE_ROAD],
        [STRUCTURE_ROAD,        STRUCTURE_EXTENSION,                    STRUCTURE_EXTENSION,    STRUCTURE_EXTENSION,                    STRUCTURE_EXTENSION,    STRUCTURE_EXTENSION,                    STRUCTURE_ROAD],
        [Unit.STRUCTURE_ANY,    STRUCTURE_ROAD,                         STRUCTURE_ROAD,         STRUCTURE_ROAD,                         STRUCTURE_ROAD,         STRUCTURE_ROAD,                         Unit.STRUCTURE_ANY]
    ], { 
        'leftContainer': [ [3, 1] ], 
        'rightContainer': [ [3, 5] ], 
        'link': [ [3, 3] ]
    }), { distanceReferencesFrom: [ STRUCTURE_SPAWN ], distanceReferencesTo: [ STRUCTURE_CONTROLLER, 'mineral', 'sources' ], awayRelationship: [ 'sources', 'mineral', STRUCTURE_CONTROLLER ] })

    P.register('unit', 'centralTransfer', new Unit([
        [ Unit.STRUCTURE_ANY, Unit.STRUCTURE_ANY,                           Unit.STRUCTURE_ANY,                     Unit.STRUCTURE_ANY,                         Unit.STRUCTURE_ANY ], 
        [ Unit.STRUCTURE_ANY, [STRUCTURE_STORAGE, STRUCTURE_RAMPART],       [STRUCTURE_NUKER, STRUCTURE_RAMPART],   [STRUCTURE_POWER_SPAWN, STRUCTURE_RAMPART], Unit.STRUCTURE_ANY ],
        [ Unit.STRUCTURE_ANY, [STRUCTURE_TERMINAL, STRUCTURE_RAMPART],      STRUCTURE_ROAD,                         STRUCTURE_EXTENSION,                        Unit.STRUCTURE_ANY ],
        [ Unit.STRUCTURE_ANY, STRUCTURE_LINK,                               [STRUCTURE_FACTORY, STRUCTURE_RAMPART], STRUCTURE_ROAD,                             Unit.STRUCTURE_ANY ], 
        [ Unit.STRUCTURE_ANY, Unit.STRUCTURE_ANY,                           Unit.STRUCTURE_ANY,                     Unit.STRUCTURE_ANY,                         Unit.STRUCTURE_ANY ]
    ], {
        'transferStructures': [ [1, 1], [1, 2], [1, 3], [2, 1], [2, 3], [3, 1], [3, 2] ]
    }), { distanceReferencesFrom: [ STRUCTURE_STORAGE ], distanceReferencesTo: [ STRUCTURE_CONTROLLER, STRUCTURE_SPAWN ], awayRelationship: [ 'sources', 'mineral', STRUCTURE_CONTROLLER ] })

    P.register('road', 'centralSpawn => centralTransfer', 'centralSpawn', 'centralTransfer')

    P.register('unit', 'towers', new Unit([ [ [STRUCTURE_TOWER, STRUCTURE_RAMPART] ] ], { 'tower': [ [0, 0] ] }), { roadRelationship: 'along', distanceReferencesFrom: [ STRUCTURE_TOWER ], distanceReferencesTo: [ STRUCTURE_STORAGE ], amount: 6, awayRelationship: [ 'sources', 'mineral', STRUCTURE_CONTROLLER ] })

    P.register('unit', 'extensionUnit', new Unit([
        [STRUCTURE_ROAD, STRUCTURE_EXTENSION, STRUCTURE_EXTENSION, STRUCTURE_EXTENSION, STRUCTURE_ROAD],
        [STRUCTURE_EXTENSION, STRUCTURE_ROAD, STRUCTURE_EXTENSION, STRUCTURE_ROAD, STRUCTURE_EXTENSION],
        [STRUCTURE_EXTENSION, STRUCTURE_EXTENSION, STRUCTURE_ROAD, STRUCTURE_EXTENSION, STRUCTURE_EXTENSION],
        [STRUCTURE_EXTENSION, STRUCTURE_ROAD, STRUCTURE_EXTENSION, STRUCTURE_ROAD, STRUCTURE_EXTENSION],
        [STRUCTURE_ROAD, STRUCTURE_EXTENSION, STRUCTURE_EXTENSION, STRUCTURE_EXTENSION, STRUCTURE_ROAD]
    ]), { distanceReferencesFrom: [ STRUCTURE_ROAD ], distanceReferencesTo: [ STRUCTURE_SPAWN, STRUCTURE_STORAGE ], amount: 2, awayRelationship: [ 'sources', 'mineral', STRUCTURE_CONTROLLER ] })
    
    P.register('road', 'centralSpawn => extensionUnit', 'centralSpawn', 'extensionUnit')

    P.register('unit', 'extensions', new Unit([ [STRUCTURE_EXTENSION] ]), { distanceReferencesFrom: [ STRUCTURE_EXTENSION ], distanceReferencesTo: [ STRUCTURE_SPAWN, STRUCTURE_STORAGE ], roadRelationship: 'along', amount: 12, awayRelationship: [ 'sources', 'mineral', STRUCTURE_CONTROLLER ] })

    P.register('unit', 'labUnit', new Unit([
        [Unit.STRUCTURE_ANY,                    [STRUCTURE_LAB, STRUCTURE_RAMPART],     [STRUCTURE_LAB, STRUCTURE_RAMPART],     STRUCTURE_ROAD],
        [[STRUCTURE_LAB, STRUCTURE_RAMPART],    [STRUCTURE_LAB, STRUCTURE_RAMPART],     STRUCTURE_ROAD,                         [STRUCTURE_LAB, STRUCTURE_RAMPART]],
        [[STRUCTURE_LAB, STRUCTURE_RAMPART],    STRUCTURE_ROAD,                         [STRUCTURE_LAB, STRUCTURE_RAMPART],     [STRUCTURE_LAB, STRUCTURE_RAMPART]],
        [STRUCTURE_ROAD,                        [STRUCTURE_LAB, STRUCTURE_RAMPART],     [STRUCTURE_LAB, STRUCTURE_RAMPART],     Unit.STRUCTURE_ANY]
    ], {
        'coreLabs': [ [1, 1], [2, 2] ]
    }), { distanceReferencesFrom: [ STRUCTURE_ROAD ], distanceReferencesTo: [ STRUCTURE_SPAWN ], awayRelationship: [ 'sources', 'mineral', STRUCTURE_CONTROLLER ] })

    P.register('road', 'centralSpawn => labUnit', 'centralSpawn', 'labUnit')

    P.register('unit', 'observer', new Unit([ [STRUCTURE_OBSERVER] ]), { distanceReferencesFrom: [ STRUCTURE_OBSERVER ], distanceReferencesTo: [ STRUCTURE_SPAWN ], roadRelationship: 'along', awayRelationship: [ 'sources', 'mineral', STRUCTURE_CONTROLLER ] })
}