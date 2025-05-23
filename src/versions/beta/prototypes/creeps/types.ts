/** Traveller */

type Coord = {x: number, y: number};
type HasPos = {pos: RoomPosition}

interface PathfinderReturn {
    path: RoomPosition[];
    ops: number;
    cost: number;
    incomplete: boolean;
}

interface TravelToReturnData {
    nextPos?: RoomPosition;
    pathfinderReturn?: PathfinderReturn;
    state?: TravelState;
    path?: string;
}

interface TravelToOptions {
    ignoreRoads?: boolean;
    ignoreCreeps?: boolean;
    ignoreStructures?: boolean;
    preferHighway?: boolean;
    highwayBias?: number;
    allowHostile?: boolean;
    allowSK?: boolean;
    range?: number;
    obstacles?: {pos: RoomPosition}[];
    roomCallback?: (roomName: string, matrix: CostMatrix) => CostMatrix | boolean;
    routeCallback?: (roomName: string) => number;
    returnData?: TravelToReturnData;
    restrictDistance?: number;
    useFindRoute?: boolean;
    maxOps?: number;
    movingTarget?: boolean;
    freshMatrix?: boolean;
    offRoad?: boolean;
    stuckValue?: number;
    maxRooms?: number;
    repath?: number;
    route?: {[roomName: string]: boolean};
    ensurePath?: boolean;
    flee?: boolean;
    avoidStructureTypes?: StructureConstant[];
}

interface TravelData {
    state: any[];
    path: string;
    flee: boolean;
}

interface TravelState {
    stuckCount: number;
    lastCoord: Coord;
    destination: RoomPosition;
    cpu: number;
}

interface Creep {
    travelTo(destination: HasPos | RoomPosition, ops?: TravelToOptions): CreepMoveReturnCode | ERR_INVALID_ARGS | ERR_NO_PATH
}

interface PowerCreep {
    travelTo(destination: HasPos | RoomPosition, ops?: TravelToOptions): CreepMoveReturnCode | ERR_INVALID_ARGS | ERR_NO_PATH
}