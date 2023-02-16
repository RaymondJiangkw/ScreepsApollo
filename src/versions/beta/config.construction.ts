import { planModule as P, Unit } from '@/modules/plan'

export function registerCommonConstructions() {
    P.register('unit', 'centralSpawn', new Unit([
        [Unit.STRUCTURE_ANY,    STRUCTURE_ROAD,                         STRUCTURE_ROAD,         STRUCTURE_ROAD,                         STRUCTURE_ROAD,         STRUCTURE_ROAD,                         Unit.STRUCTURE_ANY],
        [STRUCTURE_ROAD,        STRUCTURE_EXTENSION,                    STRUCTURE_EXTENSION,    [STRUCTURE_SPAWN, STRUCTURE_RAMPART],   STRUCTURE_EXTENSION,    STRUCTURE_EXTENSION,                    STRUCTURE_ROAD],
        [STRUCTURE_ROAD,        STRUCTURE_EXTENSION,                    Unit.STRUCTURE_ANY,     STRUCTURE_EXTENSION,                    Unit.STRUCTURE_ANY,     STRUCTURE_EXTENSION,                    STRUCTURE_ROAD],
        [STRUCTURE_ROAD,        STRUCTURE_CONTAINER,                    STRUCTURE_EXTENSION,    STRUCTURE_LINK,                         STRUCTURE_EXTENSION,    STRUCTURE_CONTAINER,                    STRUCTURE_ROAD],
        [STRUCTURE_ROAD,        [STRUCTURE_SPAWN, STRUCTURE_RAMPART],   Unit.STRUCTURE_ANY,     STRUCTURE_EXTENSION,                    Unit.STRUCTURE_ANY,     [STRUCTURE_SPAWN, STRUCTURE_RAMPART],   STRUCTURE_ROAD],
        [STRUCTURE_ROAD,        STRUCTURE_EXTENSION,                    STRUCTURE_EXTENSION,    STRUCTURE_EXTENSION,                    STRUCTURE_EXTENSION,    STRUCTURE_EXTENSION,                    STRUCTURE_ROAD],
        [Unit.STRUCTURE_ANY,    STRUCTURE_ROAD,                         STRUCTURE_ROAD,         STRUCTURE_ROAD,                         STRUCTURE_ROAD,         STRUCTURE_ROAD,                         Unit.STRUCTURE_ANY]
    ]), { distanceReferencesFrom: [ STRUCTURE_SPAWN ], distanceReferencesTo: [ STRUCTURE_CONTROLLER, 'mineral', 'sources' ] })

    P.register('unit', 'centralTransfer', new Unit([
        [ Unit.STRUCTURE_ANY, Unit.STRUCTURE_ANY,                           Unit.STRUCTURE_ANY,                     Unit.STRUCTURE_ANY,                         Unit.STRUCTURE_ANY ], 
        [ Unit.STRUCTURE_ANY, [STRUCTURE_STORAGE, STRUCTURE_RAMPART],       [STRUCTURE_NUKER, STRUCTURE_RAMPART],   [STRUCTURE_POWER_SPAWN, STRUCTURE_RAMPART], Unit.STRUCTURE_ANY ],
        [ Unit.STRUCTURE_ANY, [STRUCTURE_TERMINAL, STRUCTURE_RAMPART],      STRUCTURE_ROAD,                         STRUCTURE_EXTENSION,                        Unit.STRUCTURE_ANY ],
        [ Unit.STRUCTURE_ANY, STRUCTURE_LINK,                               [STRUCTURE_FACTORY, STRUCTURE_RAMPART], STRUCTURE_ROAD,                             Unit.STRUCTURE_ANY ], 
        [ Unit.STRUCTURE_ANY, Unit.STRUCTURE_ANY,                           Unit.STRUCTURE_ANY,                     Unit.STRUCTURE_ANY,                         Unit.STRUCTURE_ANY ]
    ]), { distanceReferencesFrom: [ STRUCTURE_STORAGE ], distanceReferencesTo: [ STRUCTURE_CONTROLLER, STRUCTURE_SPAWN ] })

    P.register('road', 'centralSpawn => centralTransfer', 'centralSpawn', 'centralTransfer')

    P.register('unit', 'towers', new Unit([ [ [STRUCTURE_TOWER, STRUCTURE_RAMPART] ] ]), { roadRelationship: 'along', distanceReferencesFrom: [ STRUCTURE_TOWER ], distanceReferencesTo: [ STRUCTURE_STORAGE ], amount: 6 })

    P.register('unit', 'extensionUnit', new Unit([
        [STRUCTURE_ROAD, STRUCTURE_EXTENSION, STRUCTURE_EXTENSION, STRUCTURE_EXTENSION, STRUCTURE_ROAD],
        [STRUCTURE_EXTENSION, STRUCTURE_ROAD, STRUCTURE_EXTENSION, STRUCTURE_ROAD, STRUCTURE_EXTENSION],
        [STRUCTURE_EXTENSION, STRUCTURE_EXTENSION, STRUCTURE_ROAD, STRUCTURE_EXTENSION, STRUCTURE_EXTENSION],
        [STRUCTURE_EXTENSION, STRUCTURE_ROAD, STRUCTURE_EXTENSION, STRUCTURE_ROAD, STRUCTURE_EXTENSION],
        [STRUCTURE_ROAD, STRUCTURE_EXTENSION, STRUCTURE_EXTENSION, STRUCTURE_EXTENSION, STRUCTURE_ROAD]
    ]), { distanceReferencesFrom: [ STRUCTURE_ROAD ], distanceReferencesTo: [ STRUCTURE_SPAWN, STRUCTURE_STORAGE ], amount: 2 })
    
    P.register('road', 'centralSpawn => extensionUnit', 'centralSpawn', 'extensionUnit')

    P.register('unit', 'extensions', new Unit([ [STRUCTURE_EXTENSION] ]), { distanceReferencesFrom: [ STRUCTURE_EXTENSION ], distanceReferencesTo: [ STRUCTURE_SPAWN, STRUCTURE_STORAGE ], roadRelationship: 'along', amount: 12 })

    P.register('unit', 'labUnit', new Unit([
        [Unit.STRUCTURE_ANY,                    [STRUCTURE_LAB, STRUCTURE_RAMPART],     [STRUCTURE_LAB, STRUCTURE_RAMPART],     STRUCTURE_ROAD],
        [[STRUCTURE_LAB, STRUCTURE_RAMPART],    [STRUCTURE_LAB, STRUCTURE_RAMPART],     STRUCTURE_ROAD,                         [STRUCTURE_LAB, STRUCTURE_RAMPART]],
        [[STRUCTURE_LAB, STRUCTURE_RAMPART],    STRUCTURE_ROAD,                         [STRUCTURE_LAB, STRUCTURE_RAMPART],     [STRUCTURE_LAB, STRUCTURE_RAMPART]],
        [STRUCTURE_ROAD,                        [STRUCTURE_LAB, STRUCTURE_RAMPART],     [STRUCTURE_LAB, STRUCTURE_RAMPART],     Unit.STRUCTURE_ANY]
    ]), { distanceReferencesFrom: [ STRUCTURE_ROAD ], distanceReferencesTo: [ STRUCTURE_SPAWN ] })

    P.register('road', 'centralSpawn => labUnit', 'centralSpawn', 'labUnit')

    P.register('unit', 'observer', new Unit([ [STRUCTURE_OBSERVER] ]), { distanceReferencesFrom: [ STRUCTURE_OBSERVER ], distanceReferencesTo: [ STRUCTURE_SPAWN ], roadRelationship: 'along'})

    /** @NOTICE 对于第一个房间, `centralSpawn` 的位置需要手工指定 */
    // (Memory as any)._plan = { 'E55S2': { 'centralSpawn': [ new RoomPosition(8, 23, 'E55S2') ] } }
}