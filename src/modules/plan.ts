/**
 * 🛠️ 自动规划模块
 */

import { assertWithMsg, constructArray, log, LOG_DEBUG, LOG_ERR, LOG_INFO } from "@/utils"

const ROOM_HEIGHT = 50
const ROOM_WIDTH = 50

const STRUCTURE_ANY     = "any"
/** 指示当前位置的建筑 */
type StructureIndicator = StructureConstant | typeof STRUCTURE_ANY
/** 建筑模式 (必须为方形) */
type StructurePattern = (StructureIndicator | StructureIndicator[])[][]
type _StructurePattern = StructureIndicator[][][]

type Pos = { x: number, y: number, roomName: string }

/** 基础建筑单元 (出于效率考虑, 不允许建筑单元之间重叠) */
export class Unit {
    /** 任何建筑 (出于效率考虑, 不允许 TerrainWall) */
    static readonly STRUCTURE_ANY: typeof STRUCTURE_ANY = STRUCTURE_ANY
    #pattern: _StructurePattern
    #structure2Pos: { [ structureType in StructureConstant ]?: {x: number, y: number}[] } = {}
    /** 建筑单元高度 */
    height: number
    /** 建筑单元长度 */
    width: number
    /** 获得相对于给定左上角位置, 特定建筑类型的位置 - 用于抉择位置时, 提供参照目标的位置 */
    getStructurePositions(structureType: StructureConstant, leftTop: Pos): Pos[] {
        if ( !(structureType in this.#structure2Pos) ) return []
        return this.#structure2Pos[structureType].map( ({x, y}) => ({x: x + leftTop.x, y: y + leftTop.y, roomName: leftTop.roomName}) )
    }
    getPositionStructures(x: number, y: number): StructureConstant[] {
        return this.#pattern[y][x].filter(v => v !== Unit.STRUCTURE_ANY) as StructureConstant[]
    }
    get structureTypes(): StructureConstant[] {
        return Object.keys(this.#structure2Pos) as StructureConstant[]
    }
    constructor(pattern: StructurePattern) {
        // 规整 `pattern`
        for ( let j = 0; j < pattern.length; ++j )
            for ( let i = 0; i < pattern[j].length; ++i )
                if ( !Array.isArray(pattern[j][i]) )
                    pattern[j][i] = [ pattern[j][i] as any ]
        this.#pattern = pattern as _StructurePattern

        this.width = this.#pattern[0].length
        this.height = this.#pattern.length

        // 编译 `pattern`
        for ( let j = 0; j < this.height; ++j )
            for ( let i = 0; i < this.width; ++i ) {
                assertWithMsg( this.#pattern[j][i].length === 1 || ( !_.includes(this.#pattern[j][i], Unit.STRUCTURE_ANY) ), `建筑单元在模式 (${j}, ${i}) 处有非法建筑设计 ${this.#pattern[j][i]}` )
                // 注册建筑位置
                _.forEach( this.#pattern[j][i], indicator => {
                    if ( indicator === Unit.STRUCTURE_ANY ) return
                    if ( !(indicator in this.#structure2Pos) ) this.#structure2Pos[indicator] = []
                    this.#structure2Pos[indicator].push({ x: i, y: j })
                } )
            }
    }
}

interface PlanModuleRegisterUnitOpts {
    /** 指定根据距离判定选址位置的参照对象 (到) */
    distanceReferencesTo? : ( StructureConstant | 'sources' | 'mineral' )[]
    /** 指定根据距离判定选址位置的参照对象 (从) */
    distanceReferencesFrom? : StructureConstant[]
    /** 与路径的位置关系 - 沿着路径 */
    roadRelationship? : 'along'
    /** 规划的本建筑单元数量 */
    amount? : number
}

interface RoadRegisterOpts {
    /** 到目的地的距离设定 */
    range?: number
}

/** 自动规划模块 */
class PlanModule {
    /** 特殊规划单元 - 保护墙 */
    static readonly PROTECT_UNIT: string = 'protect'
    /** 存储规划内容 */
    #unitDict: { [name: string]: {
        unit: Unit, 
        opts: PlanModuleRegisterUnitOpts
    } } = {}
    #roadDict: { [name: string]: {
        unitNameUorPosU: string | RoomPosition, 
        unitNameVorPosV: string | RoomPosition, 
        /** 是否为跨房间路径 */
        cross: boolean, 
        opts: RoadRegisterOpts, 
    } } = {}
    /** 房间内规划次序 (房间之间的规划默认是优先级低于房间内, 并且之间平级) */
    #planOrder: { token: 'unit' | 'road', name: string, specializedToRoom: string }[] = []
    #getCacheDict() {
        if ( !('_plan' in Memory) ) (Memory as any)._plan = {}
        return (Memory as any)._plan
    }
    /** 删除之前自动规划的结果 (主要用于调试阶段) */
    refresh(roomNameOrRoadName: string): void {
        const cacheDict = this.#getCacheDict()
        if ( roomNameOrRoadName in cacheDict ) delete cacheDict[roomNameOrRoadName]
        _.remove(this.#getMismatchRoom(), roomName => roomName === roomNameOrRoadName)
        _.remove(this.#getImpossibleRoad(), roadName => roadName === roomNameOrRoadName)
    }
    #getUnitPos(roomName: string, unitName: string): Pos[] | null {
        assertWithMsg( unitName in this.#unitDict, `获取未注册建筑单元 ${unitName} 失败` )
        const cacheDict = this.#getCacheDict()
        if ( !(roomName in cacheDict) || !(unitName in cacheDict[roomName]) ) return null
        return cacheDict[roomName][unitName]
    }
    #protectRectangles: { [roomName: string]: Rectangle[] } = {}
    #getProtectRectangles(roomName: string) {
        if ( !(roomName in this.#protectRectangles) ) this.#protectRectangles[roomName] = []
        return this.#protectRectangles[roomName]
    }
    #setUnitPos(roomName: string, unitName: string, leftTop: Pos[], registerOnly: boolean = false) {
        assertWithMsg( unitName in this.#unitDict, `设置未注册建筑单元 ${unitName} 失败` )
        const cacheDict = this.#getCacheDict()
        if ( !(roomName in cacheDict) ) cacheDict[roomName] = {}
        if ( !(unitName in cacheDict[roomName]) ) cacheDict[roomName][unitName] = []
        const unit = this.#unitDict[unitName].unit
        if ( !registerOnly )
            cacheDict[roomName][unitName].push(...leftTop)
        for ( const pos of leftTop ) {
            // 更新用过的位置
            for ( let x = pos.x; x < pos.x + unit.width; ++x )
                for ( let y = pos.y; y < pos.y + unit.height; ++y )
                    // 路径/护罩与建筑重叠的情况下, 优先考虑建筑
                    if ( _.filter(unit.getPositionStructures(x - pos.x, y - pos.y), s => s !== STRUCTURE_ROAD && s !== STRUCTURE_RAMPART).length > 0 )
                        this.#getUsedRoomPos(roomName)[x][y] = 'occupied'
                    else if ( _.includes(unit.getPositionStructures(x - pos.x, y - pos.y), STRUCTURE_ROAD) )
                        this.#getUsedRoomPos(roomName)[x][y] = 'road'
            
            // 更新建筑位置
            for ( const structureType of unit.structureTypes )
                this.#getRoomStructure2Pos(roomName, structureType).push(...unit.getStructurePositions(structureType, pos))
            
            // 更新保护区域
            if ( unitName !== PlanModule.PROTECT_UNIT ) {
                log(LOG_DEBUG, `为房间 ${roomName} 注册需要保护的区域 (${unitName}): (${pos.x}, ${pos.y}, ${pos.x + unit.width - 1}, ${pos.y + unit.height - 1})`)
                this.#getProtectRectangles(roomName).push( {x1: pos.x, y1: pos.y, x2: pos.x + unit.width - 1, y2: pos.y + unit.height - 1} )
            }
        }
    }
    /** 获取房间内路径规划 */
    #getRoads(roomName: string, roadName: string): Pos[] | null
    /** 获取房间间路径规划 */
    #getRoads(roadName: string): Pos[] | null
    #getRoads(arg1: string, arg2?: string): Pos[] | null {
        const cacheDict = this.#getCacheDict()
        if ( typeof arg2 === "string" ) {
            assertWithMsg( arg2 in this.#roadDict, `获得未注册路径 ${arg2} 失败` )
            const { cross } = this.#roadDict[arg2]
            assertWithMsg( !cross, `请求获取房间 ${arg1} 内路径 ${arg2} 时, 发现该路径为跨房间路径` )
            if ( !(arg1 in cacheDict) || !(arg2 in cacheDict[arg1]) ) return null
            return cacheDict[arg1][arg2]
        } else {
            assertWithMsg( arg1 in this.#roadDict, `获得未注册路径 ${arg1} 失败` )
            const { cross } = this.#roadDict[arg1]
            assertWithMsg( cross, `请求跨房间路径 ${arg1} 时, 发现该路径为房间内路径` )
            if ( !(arg1 in cacheDict) ) return null
            return cacheDict[arg1]
        }
    }
    /** 设置房间内路径规划 */
    #setRoads(roomName: string, roadName: string, roads: Pos[], registerOnly?: boolean)
    /** 设置房间间路径规划 */
    #setRoads(roadName: string, roads: Pos[], registerOnly?: boolean)
    #setRoads(arg1, arg2, arg3?, arg4?) {
        const cacheDict = this.#getCacheDict()
        if ( arg3 !== undefined && typeof arg3 !== 'boolean' ) {
            assertWithMsg( arg2 in this.#roadDict, `设置未注册路径 ${arg2} 失败` )
            const { cross } = this.#roadDict[arg2]
            assertWithMsg( !cross, `设置房间 ${arg1} 内路径 ${arg2} 时, 发现该路径为跨房间路径` )
            if ( !(arg1 in cacheDict) ) cacheDict[arg1] = {}
            if ( !(arg2 in cacheDict[arg1]) ) cacheDict[arg1][arg2] = []
            if ( !arg4 )
                cacheDict[arg1][arg2].push(...arg3)
            // log(LOG_INFO, `注册起始点为 ${new RoomPosition(arg3[0].x, arg3[0].y, arg1)}, 终点为 ${new RoomPosition(arg3[arg3.length - 1].x, arg3[arg3.length - 1].y, arg1)} 的路径 ${arg2}`)
            // 设置房间中用过的位置
            arg3.forEach(pos => this.#getUsedRoomPos(arg1)[pos.x][pos.y] = 'road')
            // 设置房间中建筑位置
            this.#getRoomStructure2Pos(arg1, STRUCTURE_ROAD).push(...arg3)
        } else {
            assertWithMsg( arg1 in this.#roadDict, `设置未注册路径 ${arg1} 失败` )
            const { cross } = this.#roadDict[arg1]
            assertWithMsg( cross, `设置跨房间路径 ${arg1} 时, 发现该路径为房间内路径` )
            if ( !(arg1 in cacheDict) ) cacheDict[arg1] = []
            if ( !arg3 )
                cacheDict[arg1].push(...arg2)
        }
    }
    /** 注册建筑单元 - 按照注册顺序进行规划 */
    register(token: 'unit', unitName: string, unit: Unit, opts?: PlanModuleRegisterUnitOpts)
    /** 连接建筑单元 (房间内) - 按照注册顺序进行规划 */
    register(token: 'road', roadName: string, unitNameU: string, unitNameV: string, opts?: RoadRegisterOpts)
    /** 连接建筑单元和位置 (房间内) - 按照注册顺序进行规划 */
    register(token: 'road', roadName: string, unitName: string, pos: RoomPosition, opts?: RoadRegisterOpts)
    /** 连接位置 (房间内或房间外) - 按照注册顺序进行规划 */
    register(token: 'road', roadName: string, posU: RoomPosition, posV: RoomPosition, opts?: RoadRegisterOpts)
    register(token, arg1, arg2, arg3?, arg4?) {
        assertWithMsg( !(arg1 in this.#roadDict) && !(arg1 in this.#unitDict), `注册的规划名称 ${arg1} 已经被使用过` )
        if ( token === 'unit' ) {
            if ( arg3 === undefined ) arg3 = {}
            _.defaults( arg3, { distanceReferencesTo: [], distanceReferencesFrom: [], amount: 1 } )
            this.#unitDict[ arg1 ] = { unit: arg2, opts: arg3 }
            if ( arg1 !== PlanModule.PROTECT_UNIT )
                this.#planOrder.push({ token: 'unit', name: arg1, specializedToRoom: null })
        } else if ( token === 'road' ) {
            if ( arg4 === undefined ) arg4 = {}
            _.defaults( arg4, { range: 0 } )
            let cross = false
            if ( !(arg2 instanceof RoomPosition) && !(arg3 instanceof RoomPosition) ) {
                // 同房间内连接
                assertWithMsg( arg2 in this.#unitDict && arg3 in this.#unitDict, `注册路径连接建筑单元 ${arg2} 和 ${arg3}, 但是其中有未注册的建筑单元` )
                this.#planOrder.push({ token: 'road', name: arg1, specializedToRoom: null })
            } else if ( !(arg2 instanceof RoomPosition) && arg3 instanceof RoomPosition ) {
                // 同房间内连接
                assertWithMsg( arg2 in this.#unitDict, `注册路径连接建筑单元 ${arg2} 和 ${arg3}, 但是该建筑单元未注册` )
                this.#planOrder.push({ token: 'road', name: arg1, specializedToRoom: arg3.roomName })
            } else if ( arg2 instanceof RoomPosition && arg3 instanceof RoomPosition ) {
                if ( arg2.roomName === arg3.roomName )
                    // 同房间内连接
                    this.#planOrder.push({ token: 'road', name: arg1, specializedToRoom: arg3.roomName })
                else
                    // 跨房间连接
                    cross = true
            }
            this.#roadDict[ arg1 ] = { unitNameUorPosU: arg2, unitNameVorPosV: arg3, cross, opts: arg4 }
        }
    }
    /** 位置 (0, 0) 到 (x, y) 的空位置数量 */
    #emptySpaceCache: { [roomName: string]: number[][] } = {}
    #getEmptySpace(roomName: string, x1: number, y1: number, x2: number, y2: number): number {
        const get = (x, y) => {
            if ( y < 0 || y >= ROOM_HEIGHT || x < 0 || x >= ROOM_WIDTH) return 0
            return this.#emptySpaceCache[roomName][x][y]
        }

        if ( !(roomName in this.#emptySpaceCache) ) {
            this.#emptySpaceCache[roomName] = constructArray([ ROOM_WIDTH, ROOM_HEIGHT ], 0)
            const terrain = new Room.Terrain(roomName)
            for ( let y = 0; y < ROOM_HEIGHT; ++y )
                for ( let x = 0; x < ROOM_WIDTH; ++x )
                    this.#emptySpaceCache[roomName][x][y] = get(x - 1, y) + get(x, y - 1) - get(x - 1, y - 1) + ( terrain.get(x, y) === TERRAIN_MASK_WALL? 0 : 1 )
        }
        
        return get(x2, y2) - get(x1 - 1, y2) - get(x2, y1 - 1) + get(x1 - 1, y1 - 1)
    }
    #usedRoomPos: { [roomName: string]: ('free' | 'occupied' | 'road')[][] } = {}
    #getUsedRoomPos(roomName: string) {
        if ( !(roomName in this.#usedRoomPos) ) this.#usedRoomPos[roomName] = constructArray([ROOM_WIDTH, ROOM_HEIGHT], 'free')
        return this.#usedRoomPos[roomName]
    }
    /** 可能有重复 - 特别是路径搜索时, 会有路径的复用 */
    #roomStructure2Pos: { [roomName: string]: { [structureType in StructureConstant]?: Pos[]} } = {}
    #getRoomStructure2Pos(roomName: string, structureType: StructureConstant) {
        if ( !(roomName in this.#roomStructure2Pos) ) this.#roomStructure2Pos[roomName] = {}
        if ( !(structureType in this.#roomStructure2Pos[roomName]) ) this.#roomStructure2Pos[roomName][structureType] = []
        return this.#roomStructure2Pos[roomName][structureType]
    }
    /** 根据规划的路径和建筑单元等计算 CostMatrix */
    #getRoomCostCallback(roomName: string): CostMatrix {
        const terrain = new Room.Terrain(roomName)
        const costMatrix = new PathFinder.CostMatrix()
        const used = this.#getUsedRoomPos(roomName)
        for (let x = 0; x < ROOM_WIDTH; ++x)
            for (let y = 0; y < ROOM_HEIGHT; ++y) {
                if ( terrain.get(x, y) === TERRAIN_MASK_WALL ) costMatrix.set(x, y, 0xff)
                else costMatrix.set(x, y, 2)

                if ( used[x][y] === 'occupied' ) costMatrix.set(x, y, 0xff)
                else if ( used[x][y] === 'road' ) costMatrix.set(x, y, 1)
            }
        return costMatrix
    }
    #searchRoomRoad(posU: RoomPosition, posV: RoomPosition, opts: RoadRegisterOpts): RoomPosition[] | null {
        if ( posU.roomName === posV.roomName ) {
            const costMatrix = this.#getRoomCostCallback(posU.roomName)
            const ret = PathFinder.search(posU, { pos: posV, range: opts.range }, {
                roomCallback: () => costMatrix, 
                maxOps: 2000, 
                maxRooms: 1, 
            })

            if ( ret.incomplete ) {
                log(LOG_ERR, `无法找到 ${posU} => ${posV} (range: ${opts.range}) 的路径`)
                return null
            }

            const path = ret.path
            path.unshift(posU)
            return path
        } else {
            const ret = PathFinder.search(posU, { pos: posV, range: opts.range }, {
                maxOps : 500000, 
                maxRooms: 64, 
                plainCost: 1, 
                swampCost: 5, 
                roomCallback: (roomName) => {
                    if ( !Game.rooms[roomName] ) return
                    // 省略他人房间
                    if ( Game.rooms[roomName].controller && !Game.rooms[roomName].controller.my && Game.rooms[roomName].controller.owner.username && Game.rooms[roomName].controller.owner.username.length > 0 ) return false
                    if ( Game.rooms[roomName].controller && Game.rooms[roomName].controller.my ) {
                        this.#planRoom(roomName)
                        return this.#getRoomCostCallback(roomName)
                    }

                    return
                }
            })

            if ( ret.incomplete ) return null

            const path = ret.path
            path.unshift(posU)
            return path
        }
    }
    #room2DistanceFromCenter: { [roomName: string]: number[][] } = {}
    /** 根据 BFS, 以 Spawn 为中心, 只考虑地形估计距离 */
    #estimateInRoomDistance(posU: Pos, posV: Pos) {
        assertWithMsg( posU.roomName === posV.roomName, `使用房间内距离估计函数计算 ${posU} 到 ${posV} 距离时, 发现房间不相同` )
        // 尝试计算距离矩阵
        if ( !(posU.roomName in this.#room2DistanceFromCenter) ) {
            // 当且仅当 Spawn 存在时, 再计算
            if ( Game.rooms[posU.roomName] ) {
                const spawns = Game.rooms[posU.roomName].find<FIND_STRUCTURES, StructureSpawn>(FIND_STRUCTURES, { filter: { structureType: STRUCTURE_SPAWN } })
                if ( spawns.length > 0 ) {
                    const centerPos = spawns[0].pos
                    const terrain = new Room.Terrain(posU.roomName)
                    this.#room2DistanceFromCenter[posU.roomName] = constructArray([50, 50], -1)
                    const dx = [-1, -1, -1, 0, 0, 1, 1, 1]
                    const dy = [-1, 0, 1, -1, 1, -1, 0, 1]
                    const dlen = dx.length
                    const Q: { x: number, y: number, dist: number }[] = []
                    Q.push({ x: centerPos.x, y: centerPos.y, dist: 0 })
                    this.#room2DistanceFromCenter[posU.roomName][centerPos.x][centerPos.y] = 0
                    while ( Q.length > 0 ) {
                        const front = Q.shift()
                        for ( let i = 0; i < dlen; ++i ) {
                            if ( front.x + dx[i] < 0 || front.x + dx[i] >= ROOM_WIDTH || front.y + dy[i] < 0 || front.y + dy[i] >= ROOM_HEIGHT ) continue
                            if ( this.#room2DistanceFromCenter[posU.roomName][front.x + dx[i]][front.y + dy[i]] !== -1 ) continue

                            if ( terrain.get(front.x + dx[i], front.y + dy[i]) !== TERRAIN_MASK_WALL ) {
                                this.#room2DistanceFromCenter[posU.roomName][front.x + dx[i]][front.y + dy[i]] = front.dist + 1
                                Q.push({ x: front.x + dx[i], y: front.y + dy[i], dist: front.dist + 1 })
                            }
                        }
                    }
                } else log(LOG_DEBUG, `估算房间 ${posU.roomName} 内两点距离时, 发现不存在 Spawn`)
            }
        }

        if ( !(posU.roomName in this.#room2DistanceFromCenter) ) return new RoomPosition(posU.x, posU.y, posU.roomName).getRangeTo(posV.x, posV.y)
        else {
            const distU = this.#room2DistanceFromCenter[posU.roomName][posU.x][posU.y]
            const distV = this.#room2DistanceFromCenter[posV.roomName][posV.x][posV.y]
            return ( distU < 0 ? Infinity : distU ) + ( distV < 0 ? Infinity : distV )
        }
    }
    /** 规划的位置离边界的距离 */
    static readonly #MARGIN: number = 5
    /** 获得空间无法完成规划的房间列表 */
    #getMismatchRoom(): string[] {
        if ( !('_mismatchRoom' in Memory) ) (Memory as any)._mismatchRoom = []
        return (Memory as any)._mismatchRoom
    }
    /** 获得无法完成规划的跨房间路径名称列表 */
    #getImpossibleRoad(): string[] {
        if ( !('_impossibleRoad' in Memory) ) (Memory as any)._impossibleRoad = []
        return (Memory as any)._impossibleRoad
    }
    #havePlannedRoom: string[] = []
    /** 规划房间 - 连接房间的路径应假定房间已经规划完成 @returns 是否规划成功 */
    #planRoom(roomName: string): boolean {
        if ( _.includes(this.#getMismatchRoom(), roomName) ) return false
        if ( _.includes(this.#havePlannedRoom, roomName) ) return true

        // 快速路径 (校验已经完成所有的规划)
        let flag = true
        for ( const { token, name, specializedToRoom } of this.#planOrder ) {
            if ( typeof specializedToRoom === 'string' && specializedToRoom !== roomName ) continue
            if ( (token === 'unit' && this.#getUnitPos(roomName, name) !== null) ||
                (token === 'road' && this.#getRoads(roomName, name) !== null) ) continue
            else {
                flag = false
                break
            }
        }
        if ( flag ) {
            this.#havePlannedRoom.push(roomName)
            return true
        }

        // 注册已经完成的部分
        for ( const { token, name, specializedToRoom } of this.#planOrder ) {
            if ( typeof specializedToRoom === 'string' && specializedToRoom !== roomName ) continue
            if ( (token === 'unit' && this.#getUnitPos(roomName, name) !== null) ||
                 (token === 'road' && this.#getRoads(roomName, name) !== null) ) {
                if ( token === 'unit' ) this.#setUnitPos(roomName, name, this.#getUnitPos(roomName, name), true)
                else if ( token === 'road' ) this.#setRoads(roomName, name, this.#getRoads(roomName, name), true)
            }
        }

        for ( const { token, name, specializedToRoom } of this.#planOrder ) {
            if ( typeof specializedToRoom === 'string' && specializedToRoom !== roomName ) continue
            if ( (token === 'unit' && this.#getUnitPos(roomName, name) !== null) ||
                 (token === 'road' && this.#getRoads(roomName, name) !== null) ) continue
            
            if ( token === 'unit' ) {
                const { unit, opts } = this.#unitDict[name]
                log(LOG_INFO, `正在为房间 ${roomName} 规划建筑单元 ${name} ...`)
                let candidatePos: Pos[] = []
                // 枚举左上位置
                for (let x = 0 + PlanModule.#MARGIN; x < ROOM_WIDTH - PlanModule.#MARGIN - unit.width; ++x)
                    for (let y = 0 + PlanModule.#MARGIN; y < ROOM_HEIGHT - PlanModule.#MARGIN - unit.height; ++y) {
                        // 满足空间要求
                        const freeArea = this.#getEmptySpace(roomName, x, y, x + unit.width - 1, y + unit.height - 1)
                        if ( freeArea !== unit.width * unit.height ) continue

                        // 此地未占用
                        let flag = false
                        for (let dx = 0; dx < unit.width; ++dx) {
                            for (let dy = 0; dy < unit.height; ++dy) {
                                if ( this.#getUsedRoomPos(roomName)[x + dx][y + dy] !== 'free' ) {
                                    flag = true
                                    break
                                }
                            }
                            if ( flag ) break
                        }
                        if ( flag ) continue

                        // 沿着道路
                        if ( opts.roadRelationship === 'along' ) {
                            let flag = false
                            // 找周围的规划位置
                            for (let dx of [-1, 0, 1]) {
                                for (let dy of [-1, 0, 1]) {
                                    if ( dx === 0 && dy === 0 ) continue
                                    const xx = x + dx
                                    const yy = y + dy
                                    if ( xx < 0 || yy < 0 || xx >= ROOM_WIDTH || yy >= ROOM_HEIGHT ) continue
                                    
                                    if ( this.#getUsedRoomPos(roomName)[xx][yy] === "road" ) {
                                        flag = true
                                        break
                                    }
                                }
                                if ( flag ) break
                            }
                            if ( !flag ) continue
                        }

                        candidatePos.push({ x, y, roomName })
                    }
                
                // 根据距离计算权重
                if ( opts.distanceReferencesFrom.length > 0 && opts.distanceReferencesTo.length > 0 ) {
                    candidatePos = _.map(candidatePos, pos => {
                        const fromPos: Pos[] = []
                        opts.distanceReferencesFrom.forEach(structureType => fromPos.push(...unit.getStructurePositions(structureType, pos)))
                        const toPos: Pos[] = []
                        for ( const type of opts.distanceReferencesTo ) {
                            if ( type === "sources" ) toPos.push(...Game.rooms[roomName].find(FIND_SOURCES).map(s => s.pos))
                            else if ( type === "mineral" ) toPos.push(...Game.rooms[roomName].find(FIND_MINERALS).map(m => m.pos))
                            else if ( type === STRUCTURE_CONTROLLER || type === STRUCTURE_EXTRACTOR ) toPos.push(...Game.rooms[roomName].find(FIND_STRUCTURES, { filter: { structureType: type } }).map(s => s.pos))
                            else toPos.push(...this.#getRoomStructure2Pos(roomName, type))
                        }

                        let cost = 0
                        for (const posU of fromPos)
                            for (const posV of toPos)
                                cost += this.#estimateInRoomDistance(posU, posV)
                        return { pos, cost }
                    }).sort( (u, v) => u.cost - v.cost ).map(e => e.pos)
                }

                for ( let amountIdx = 0; amountIdx < opts.amount; ++amountIdx ) {
                    if ( candidatePos.length === 0 ) {
                        this.#getMismatchRoom().push(roomName)
                        log(LOG_ERR, `无法为房间 ${roomName} 规划足够数量 [${opts.amount}] 的建筑单元 ${name}`)
                        return false
                    }
                    this.#setUnitPos(roomName, name, [ candidatePos.shift() ])
                    // 筛选掉不满足的位置
                    // 只考虑 此地占用问题
                    candidatePos = _.filter(candidatePos, ({ x, y }) => {
                        let flag = false
                        for (let dx = 0; dx < unit.width; ++dx) {
                            for (let dy = 0; dy < unit.height; ++dy) {
                                if ( this.#getUsedRoomPos(roomName)[x + dx][y + dy] !== 'free' ) {
                                    flag = true
                                    break
                                }
                            }
                            if ( flag ) break
                        }
                        if ( flag ) return false
                        return true
                    })
                }
            } else if ( token === 'road' ) {
                const { unitNameUorPosU, unitNameVorPosV, opts } = this.#roadDict[name]
                log(LOG_INFO, `正在为房间 ${roomName} 规划路径 ${name} ...`)
                const fromPos_s: Pos[][] = []
                const toPos_s: Pos[][] = []
                if ( unitNameUorPosU instanceof RoomPosition ) fromPos_s.push([ unitNameUorPosU ])
                else {
                    const unit = this.#unitDict[unitNameUorPosU].unit
                    const unitPos = this.#getUnitPos(roomName, unitNameUorPosU)
                    assertWithMsg( unitPos !== null, `连接路径时, 建筑单元 ${unitNameUorPosU} 尚未确定` )
                    unitPos.forEach(p => {
                        const connectionNodes = unit.getStructurePositions(STRUCTURE_ROAD, p)
                        assertWithMsg( connectionNodes.length > 0, `建筑单元 ${unitNameUorPosU} 被连接路径时, 必须包含路径以被连接` )
                        fromPos_s.push(connectionNodes)
                    })
                }

                if ( unitNameVorPosV instanceof RoomPosition ) toPos_s.push([ unitNameVorPosV ])
                else {
                    const unit = this.#unitDict[unitNameVorPosV].unit
                    const unitPos = this.#getUnitPos(roomName, unitNameVorPosV)
                    assertWithMsg( unitPos !== null, `连接路径时, 建筑单元 ${unitNameVorPosV} 尚未确定` )
                    unitPos.forEach(p => {
                        const connectionNodes = unit.getStructurePositions(STRUCTURE_ROAD, p)
                        assertWithMsg( connectionNodes.length > 0, `建筑单元 ${unitNameVorPosV} 被连接路径时, 必须包含路径以被连接` )
                        toPos_s.push(connectionNodes)
                    })
                }

                // 计算路径时, 是对于 fromPos_s 中的每一个位置集合, 对于 toPos_s 中的每一个位置集合, 分别选择一个位置连接
                const paths: Pos[] = []

                for ( const fromPos of fromPos_s )
                    for ( const toPos of toPos_s ) {
                        // 从位置集合 fromPos 和 位置集合 toPos 中选取距离最近的一组
                        const candidates: {posU: Pos, posV: Pos, path: Pos[]}[] = []
                        for (const posU of fromPos)
                            for (const posV of toPos) {
                                const path = this.#searchRoomRoad(new RoomPosition(posU.x, posU.y, posU.roomName), new RoomPosition(posV.x, posV.y, posV.roomName), opts)
                                if (path !== null) candidates.push({ posU, posV, path: path })
                            }
                        
                        if ( candidates.length === 0 ) {
                            this.#getMismatchRoom().push(roomName)
                            log(LOG_ERR, `无法为房间 ${roomName} 规划路径 ${name}`)
                            return false
                        }
                        const minimumChoice = _.min(candidates, e => e.path.length)
                        paths.push(...minimumChoice.path)
                    }

                this.#setRoads(roomName, name, paths)
            }
        }
        // 特殊情况: 保护墙规划
        const extend = (rect: Rectangle, range = 3) => {
            rect.x1 = Math.max(1, rect.x1 - range);
            rect.y1 = Math.max(1, rect.y1 - range);
            rect.x2 = Math.min(48, rect.x2 + range);
            rect.y2 = Math.min(48, rect.y2 + range);
            return rect
        }

        const ramparts = getCutTiles(roomName, _.uniq(this.#getProtectRectangles(roomName), e => `${e.x1},${e.y1},${e.x2},${e.y2}`).map(r => extend(r)), true, Infinity, false)

        this.#setUnitPos(roomName, PlanModule.PROTECT_UNIT, ramparts)
        this.#havePlannedRoom.push(roomName)
        return true
    }
    /** 规划某房间的建筑单位或连接路径 */
    plan(roomName: string, token: 'unit', name: string): { structures: { [structureType in StructureConstant]? : RoomPosition[] }, leftTops: RoomPosition[] } | null
    plan(roomName: string, token: 'road', name: string): { [STRUCTURE_ROAD]: RoomPosition[] } | null
    plan(roadName: string): { [STRUCTURE_ROAD]: RoomPosition[] } | null
    plan(arg1, arg2?, arg3?) {
        if ( arg2 !== undefined && arg3 !== undefined ) {
            const roomName: string = arg1
            const token: 'unit' | 'road' = arg2
            const name: string = arg3

            if ( token === 'unit' ) {
                if ( this.#getUnitPos(roomName, name) === null )
                    if ( !this.#planRoom(roomName) )
                        return null
                const unit = this.#unitDict[name].unit
                const unitPos = this.#getUnitPos(roomName, name)
                const ret: { [structureType in StructureConstant]? : RoomPosition[] } = {}
                unitPos.forEach(pos => {
                    for ( const structureType of unit.structureTypes ) {
                        if ( !(structureType in ret) ) ret[structureType] = []
                        ret[structureType].push(...unit.getStructurePositions(structureType, pos).map(p => new RoomPosition(p.x, p.y, p.roomName)))
                    }
                })
                return { structures: ret, leftTops: unitPos.map(p => new RoomPosition(p.x, p.y, p.roomName)) }
            } else if ( token === 'road' ) {
                if ( this.#getRoads(roomName, name) === null )
                    if ( !this.#planRoom(roomName) )
                        return null
                return { [STRUCTURE_ROAD]: this.#getRoads(roomName, name).map(p => new RoomPosition(p.x, p.y, p.roomName)) }
            }
        } else {
            const roadName: string = arg1
            if ( _.includes(this.#getImpossibleRoad(), roadName) ) return null

            const { unitNameUorPosU, unitNameVorPosV, cross, opts } = this.#roadDict[roadName]
            assertWithMsg( cross, `只有当连接不同房间内两个具体位置的路径时, 才可以直接用路径名称进行指定规划, 但是路径 ${roadName} 并不满足要求` )
            
            if ( this.#getRoads(roadName) === null ) {
                // 该路径规划应在房间规划之后
                const roomNameU = (unitNameUorPosU as RoomPosition).roomName
                const roomNameV = (unitNameVorPosV as RoomPosition).roomName
                if (Game.rooms[roomNameU] && Game.rooms[roomNameU].controller && Game.rooms[roomNameU].controller.my) this.#planRoom(roomNameU)
                if (Game.rooms[roomNameV] && Game.rooms[roomNameV].controller && Game.rooms[roomNameV].controller.my) this.#planRoom(roomNameV)

                const path = this.#searchRoomRoad(unitNameUorPosU as RoomPosition, unitNameVorPosV as RoomPosition, opts)
                if ( path === null ) {
                    this.#getImpossibleRoad().push(roadName)
                    return null
                }
                
                this.#setRoads(roadName, path)
            }

            return { [STRUCTURE_ROAD]: this.#getRoads(roadName).map(p => new RoomPosition(p.x, p.y, p.roomName)) }
        }
    }
    /** 判定位置是否 已有/规划 了建筑 (允许道路) - 可用于一些不利用自动规划模块的建筑规划 */
    isAvailable(pos: RoomPosition): boolean {
        return this.#getUsedRoomPos(pos.roomName)[pos.x][pos.y] !== 'occupied'
    }
    /** 可视化 - 会自动完成规划 */
    visualize(roomName: string) {
        this.#planRoom(roomName)
        if ( !(roomName in this.#roomStructure2Pos) ) return
        const visual = new RoomVisual(roomName)
        for ( const structureType in this.#roomStructure2Pos[roomName] ) {
            const pos = this.#roomStructure2Pos[roomName][structureType] as Pos[]
            let visFunc = (p: Pos) => null
            if ( structureType === STRUCTURE_SPAWN ) {
                visFunc = (p: Pos) => visual.circle(p.x, p.y, {
                    stroke: 'yellow', 
                    fill: 'transparent', 
                    radius: 0.3, 
                    opacity: 1.0, 
                })
            } else if ( structureType === STRUCTURE_EXTENSION ) {
                visFunc = (p: Pos) => visual.text('🟡', p.x, p.y)
            } else if ( structureType === STRUCTURE_ROAD ) {
                visFunc = (p: Pos) => visual.circle(p.x, p.y, {
                    fill: 'gray', 
                    radius: 0.5, 
                    opacity: 0.5, 
                })
            } else if ( structureType === STRUCTURE_WALL ) {
                visFunc = (p: Pos) => visual.text('🧱', p.x, p.y)
            } else if ( structureType === STRUCTURE_RAMPART ) {
                visFunc = (p: Pos) => visual.circle(p.x, p.y, {
                    fill: 'green', 
                    opacity: 0.5, 
                    radius: 0.5, 
                })
            } else if ( structureType === STRUCTURE_LINK ) {
                visFunc = (p: Pos) => visual.text('🔸', p.x, p.y)
            } else if ( structureType === STRUCTURE_STORAGE ) {
                visFunc = (p: Pos) => visual.text('🧳', p.x, p.y)
            } else if ( structureType === STRUCTURE_TOWER ) {
                visFunc = (p: Pos) => visual.text('⛫', p.x, p.y)
            } else if ( structureType === STRUCTURE_OBSERVER ) {
                visFunc = (p: Pos) => visual.text('👁️', p.x, p.y)
            } else if ( structureType === STRUCTURE_POWER_SPAWN ) {
                visFunc = (p: Pos) => visual.circle(p.x, p.y, {
                    stroke: 'red', 
                    fill: 'transparent', 
                    radius: 0.3, 
                    opacity: 1.0, 
                })
            } else if ( structureType === STRUCTURE_LAB ) {
                visFunc = (p: Pos) => visual.text('🧪', p.x, p.y)
            } else if ( structureType === STRUCTURE_FACTORY ) {
                visFunc = (p: Pos) => visual.text('🏭', p.x, p.y)
            } else if ( structureType === STRUCTURE_TERMINAL ) {
                visFunc = (p: Pos) => visual.text('🖥️', p.x, p.y)
            } else if ( structureType === STRUCTURE_CONTAINER ) {
                visFunc = (p: Pos) => visual.text('📦', p.x, p.y)
            } else if ( structureType === STRUCTURE_NUKER ) {
                visFunc = (p: Pos) => visual.text('💣', p.x, p.y)
            } else {
                log(LOG_ERR, `在可视化房间 ${roomName} 的建筑规划时, 发现未识别建筑类型 ${structureType}`)
            }
            pos.forEach(visFunc)
        }
        return visual.export()
    }
    constructor() {
        this.register('unit', PlanModule.PROTECT_UNIT, new Unit([ [STRUCTURE_RAMPART] ]))
    }
}

export const planModule = new PlanModule()


/** 
 * =============================================================================================
 * Min-cut Algorithm for Protecting rectangle regions 
 * From Overmind: https://github.com/bencbartlett/Overmind/blob/master/src/algorithms/minCut.ts
 * =============================================================================================
 */

const UNWALKABLE = -10;
const RANGE_MODIFIER = 1; // this parameter sets the scaling of weights to prefer walls closer protection bounds
const RANGE_PADDING = 3; // max range to reduce weighting; RANGE_MODIFIER * RANGE_PADDING must be < PROTECTED
const NORMAL = 0;
const PROTECTED = 10;
const CANNOT_BUILD = 20;
const EXIT = 30;

/**
 * @property {number} capacity - The flow capacity of this edge
 * @property {number} flow - The current flow of this edge
 * @property {number} resEdge -
 * @property {number} to - where this edge leads to
 */
interface Edge {
	capacity: number;
	flow: number;
	resEdge: number;
	to: number;
}

/**
 * @property {number} x1 - Top left corner
 * @property {number} x1 - Top left corner
 * @property {number} x2 - Bottom right corner
 * @property {number} y2 - Bottom right corner
 */
interface Rectangle {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

class Graph {
	totalVertices: number;
	level: number[];
	edges: { [from: number]: Edge[] };

	constructor(totalVertices: number) {
		this.totalVertices = totalVertices;
		this.level = Array(totalVertices);
		// An array of edges for each vertex
		this.edges = Array(totalVertices).fill(0).map((x) => []);
	}

	/**
	 * Create a new edge in the graph as well as a corresponding reverse edge on the residual graph
	 * @param from - vertex edge starts at
	 * @param to - vertex edge leads to
	 * @param capacity - max flow capacity for this edge
	 */
	newEdge(from: number, to: number, capacity: number) {
		// Normal forward Edge
		this.edges[from].push({to, resEdge: this.edges[to].length, capacity, flow: 0});
		// reverse Edge for Residual Graph
		this.edges[to].push({to: from, resEdge: this.edges[from].length - 1, capacity: 0, flow: 0});
	}

	/**
	 * Uses Breadth First Search to see if a path exists to the vertex 'to' and generate the level graph
	 * @param from - vertex to start from
	 * @param to - vertex to try and reach
	 */
	createLevelGraph(from: number, to: number) {
		if (to >= this.totalVertices) {
			return false;
		}
		this.level.fill(-1); // reset old levels
		this.level[from] = 0;
		const q = []; // queue with s as starting point
		q.push(from);
		let u = 0;
		let edge = null;
		while (q.length) {
			u = q.shift()!;
			for (edge of this.edges[u]) {
				if (this.level[edge.to] < 0 && edge.flow < edge.capacity) {
					this.level[edge.to] = this.level[u] + 1;
					q.push(edge.to);
				}
			}
		}
		return this.level[to] >= 0; // return if theres a path, no level, no path!
	}

	/**
	 * Depth First Search-like: send flow at along path from from->to recursively while increasing the level of the
	 * visited vertices by one
	 * @param start - the vertex to start at
	 * @param end - the vertex to try and reach
	 * @param targetFlow - the amount of flow to try and achieve
	 * @param count - keep track of which vertices have been visited so we don't include them twice
	 */
	calcFlow(start: number, end: number, targetFlow: number, count: number[]) {
		if (start === end) { // Sink reached , abort recursion
			return targetFlow;
		}
		let edge: Edge;
		let flowTillHere = 0;
		let flowToT = 0;
		while (count[start] < this.edges[start].length) { // Visit all edges of the vertex one after the other
			edge = this.edges[start][count[start]];
			if (this.level[edge.to] === this.level[start] + 1 && edge.flow < edge.capacity) {
				// Edge leads to Vertex with a level one higher, and has flow left
				flowTillHere = Math.min(targetFlow, edge.capacity - edge.flow);
				flowToT = this.calcFlow(edge.to, end, flowTillHere, count);
				if (flowToT > 0) {
					edge.flow += flowToT; // Add Flow to current edge
					// subtract from reverse Edge -> Residual Graph neg. Flow to use backward direction of BFS/DFS
					this.edges[edge.to][edge.resEdge].flow -= flowToT;
					return flowToT;
				}
			}
			count[start]++;
		}
		return 0;
	}

	/**
	 * Uses Breadth First Search to find the vertices in the minCut for the graph
	 * - Must call calcMinCut first to prepare the graph
	 * @param from - the vertex to start from
	 */
	getMinCut(from: number) {
		const eInCut = [];
		this.level.fill(-1);
		this.level[from] = 1;
		const q = [];
		q.push(from);
		let u = 0;
		let edge: Edge;
		while (q.length) {
			u = q.shift()!;
			for (edge of this.edges[u]) {
				if (edge.flow < edge.capacity) {
					if (this.level[edge.to] < 1) {
						this.level[edge.to] = 1;
						q.push(edge.to);
					}
				}
				if (edge.flow === edge.capacity && edge.capacity > 0) { // blocking edge -> could be in min cut
					eInCut.push({to: edge.to, unreachable: u});
				}
			}
		}

		const minCut = [];
		let cutEdge: { to: number, unreachable: number };
		for (cutEdge of eInCut) {
			if (this.level[cutEdge.to] === -1) {
				// Only edges which are blocking and lead to the sink from unreachable vertices are in the min cut
				minCut.push(cutEdge.unreachable);
			}
		}
		return minCut;
	}

	/**
	 * Calculates min-cut graph using Dinic's Algorithm.
	 * use getMinCut to get the actual verticies in the minCut
	 * @param source - Source vertex
	 * @param sink - Sink vertex
	 */
	calcMinCut(source: number, sink: number) {
		if (source === sink) {
			return -1;
		}
		let ret = 0;
		let count = [];
		let flow = 0;
		while (this.createLevelGraph(source, sink)) {
			count = Array(this.totalVertices + 1).fill(0);
			do {
				flow = this.calcFlow(source, sink, Number.MAX_VALUE, count);
				if (flow > 0) {
					ret += flow;
				}
			} while (flow);
		}
		return ret;
	}
}

/**
 * An Array with Terrain information: -1 not usable, 2 Sink (Leads to Exit)
 * @param room - the room to generate the terrain map from
 */
function get2DArray(roomName: string, bounds: Rectangle = {x1: 0, y1: 0, x2: 49, y2: 49}) {

	const room2D = Array(50).fill(NORMAL).map((d) => Array(50).fill(NORMAL)); // Array for room tiles
	let x: number;
	let y: number;

	const terrain = Game.map.getRoomTerrain(roomName);

	for (x = bounds.x1; x <= bounds.x2; x++) {
		for (y = bounds.y1; y <= bounds.y2; y++) {
			if (terrain.get(x, y) === TERRAIN_MASK_WALL) {
				room2D[x][y] = UNWALKABLE; // Mark unwalkable
			} else if (x === bounds.x1 || y === bounds.y1 || x === bounds.x2 || y === bounds.y2) {
				room2D[x][y] = EXIT; // Mark exit tiles
			}
		}
	}

	// Marks tiles as unbuildable if they are proximate to exits
	for (y = bounds.y1 + 1; y <= bounds.y2 - 1; y++) {
		if (room2D[bounds.x1][y] === EXIT) {
			for (const dy of [-1, 0, 1]) {
				if (room2D[bounds.x1 + 1][y + dy] !== UNWALKABLE) {
					room2D[bounds.x1 + 1][y + dy] = CANNOT_BUILD;
				}
			}
		}
		if (room2D[bounds.x2][y] === EXIT) {
			for (const dy of [-1, 0, 1]) {
				if (room2D[bounds.x2 - 1][y + dy] !== UNWALKABLE) {
					room2D[bounds.x2 - 1][y + dy] = CANNOT_BUILD;
				}
			}
		}
	}
	for (x = bounds.x1 + 1; x <= bounds.x2 - 1; x++) {
		if (room2D[x][bounds.y1] === EXIT) {
			for (const dx of [-1, 0, 1]) {
				if (room2D[x + dx][bounds.y1 + 1] !== UNWALKABLE) {
					room2D[x + dx][bounds.y1 + 1] = CANNOT_BUILD;
				}
			}
		}
		if (room2D[x][bounds.y2] === EXIT) {
			for (const dx of [-1, 0, 1]) {
				if (room2D[x + dx][bounds.y2 - 1] !== UNWALKABLE) {
					room2D[x + dx][bounds.y2 - 1] = CANNOT_BUILD;
				}
			}
		}
	}

	return room2D;
}

/**
 * Function to create Source, Sink, Tiles arrays: takes a rectangle-Array as input for Tiles that are to Protect
 * @param room - the room to consider
 * @param toProtect - the coordinates to protect inside the walls
 * @param bounds - the area to consider for the minCut
 */

function createGraph(roomName: string, toProtect: Rectangle[],
							preferCloserBarriers     = true,
							preferCloserBarrierLimit = Infinity, // ignore the toProtect[n] for n > this value
							visualize                = true,
							bounds: Rectangle        = {x1: 0, y1: 0, x2: 49, y2: 49}) {
	const visual = new RoomVisual(roomName);
	const roomArray = get2DArray(roomName, bounds);
	// For all Rectangles, set edges as source (to protect area) and area as unused
	let r: Rectangle;
	let x: number;
	let y: number;
	for (r of toProtect) {
		if (bounds.x1 >= bounds.x2 || bounds.y1 >= bounds.y2 ||
			bounds.x1 < 0 || bounds.y1 < 0 || bounds.x2 > 49 || bounds.y2 > 49) {
			return console.log('ERROR: Invalid bounds', JSON.stringify(bounds));
		} else if (r.x1 >= r.x2 || r.y1 >= r.y2) {
			return console.log('ERROR: Rectangle', JSON.stringify(r), 'invalid.');
		} else if (r.x1 < bounds.x1 || r.x2 > bounds.x2 || r.y1 < bounds.y1 || r.y2 > bounds.y2) {
			return console.log('ERROR: Rectangle', JSON.stringify(r), 'out of bounds:', JSON.stringify(bounds));
		}
		for (x = r.x1; x <= r.x2; x++) {
			for (y = r.y1; y <= r.y2; y++) {
				if (x === r.x1 || x === r.x2 || y === r.y1 || y === r.y2) {
					if (roomArray[x][y] === NORMAL) {
						roomArray[x][y] = PROTECTED;
					}
				} else {
					roomArray[x][y] = UNWALKABLE;
				}
			}
		}
	}
	// Preferentially weight closer tiles
	if (preferCloserBarriers) {
		for (r of _.take(toProtect, preferCloserBarrierLimit)) {
			const [xmin, xmax] = [Math.max(r.x1 - RANGE_PADDING, 0), Math.min(r.x2 + RANGE_PADDING, 49)];
			const [ymin, ymax] = [Math.max(r.y1 - RANGE_PADDING, 0), Math.min(r.y2 + RANGE_PADDING, 49)];
			for (x = xmin; x <= xmax; x++) {
				for (y = ymin; y <= ymax; y++) {
					if (roomArray[x][y] >= NORMAL && roomArray[x][y] < PROTECTED) {
						const x1range = Math.max(r.x1 - x, 0);
						const x2range = Math.max(x - r.x2, 0);
						const y1range = Math.max(r.y1 - y, 0);
						const y2range = Math.max(y - r.y2, 0);
						const rangeToBorder = Math.max(x1range, x2range, y1range, y2range);
						const modifiedWeight = NORMAL + RANGE_MODIFIER * (RANGE_PADDING - rangeToBorder);
						roomArray[x][y] = Math.max(roomArray[x][y], modifiedWeight);
						if (visualize) {
							visual.text(`${roomArray[x][y]}`, x, y);
						}
					}
				}
			}
		}
	}

	// ********************** Visualization
	if (visualize) {
		for (x = bounds.x1; x <= bounds.x2; x++) {
			for (y = bounds.y1; y <= bounds.y2; y++) {
				if (roomArray[x][y] === UNWALKABLE) {
					visual.circle(x, y, {radius: 0.5, fill: '#1b1b9f', opacity: 0.3});
				} else if (roomArray[x][y] > UNWALKABLE && roomArray[x][y] < NORMAL) {
					visual.circle(x, y, {radius: 0.5, fill: '#42cce8', opacity: 0.3});
				} else if (roomArray[x][y] === NORMAL) {
					visual.circle(x, y, {radius: 0.5, fill: '#bdb8b8', opacity: 0.3});
				} else if (roomArray[x][y] > NORMAL && roomArray[x][y] < PROTECTED) {
					visual.circle(x, y, {radius: 0.5, fill: '#9929e8', opacity: 0.3});
				} else if (roomArray[x][y] === PROTECTED) {
					visual.circle(x, y, {radius: 0.5, fill: '#e800c6', opacity: 0.3});
				} else if (roomArray[x][y] === CANNOT_BUILD) {
					visual.circle(x, y, {radius: 0.5, fill: '#e8000f', opacity: 0.3});
				} else if (roomArray[x][y] === EXIT) {
					visual.circle(x, y, {radius: 0.5, fill: '#000000', opacity: 0.3});
				}
			}
		}
	}

	// initialise graph
	// possible 2*50*50 +2 (st) Vertices (Walls etc set to unused later)
	const g = new Graph(2 * 50 * 50 + 2);
	const infini = Number.MAX_VALUE;
	const surr = [[0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1]];
	// per Tile (0 in Array) top + bot with edge of c=1 from top to bott  (use every tile once!)
	// infini edge from bot to top vertices of adjacent tiles if they not protected (array =1)
	// (no reverse edges in normal graph)
	// per prot. Tile (1 in array) Edge from source to this tile with infini cap.
	// per exit Tile (2in array) Edge to sink with infini cap.
	// source is at  pos 2*50*50, sink at 2*50*50+1 as first tile is 0,0 => pos 0
	// top vertices <-> x,y : v=y*50+x   and x= v % 50  y=v/50 (math.floor?)
	// bot vertices <-> top + 2500
	const source = 2 * 50 * 50;
	const sink = 2 * 50 * 50 + 1;
	let top = 0;
	let bot = 0;
	let dx = 0;
	let dy = 0;
	// max = 49;
	const baseCapacity = 10;
	const modifyWeight = preferCloserBarriers ? 1 : 0;
	for (x = bounds.x1 + 1; x < bounds.x2; x++) {
		for (y = bounds.y1 + 1; y < bounds.y2; y++) {
			top = y * 50 + x;
			bot = top + 2500;
			if (roomArray[x][y] >= NORMAL && roomArray[x][y] <= PROTECTED) {
				if (roomArray[x][y] >= NORMAL && roomArray[x][y] < PROTECTED) {
					g.newEdge(top, bot, baseCapacity - modifyWeight * roomArray[x][y]); // add surplus weighting
				} else if (roomArray[x][y] === PROTECTED) { // connect this to the source
					g.newEdge(source, top, infini);
					g.newEdge(top, bot, baseCapacity - modifyWeight * RANGE_PADDING * RANGE_MODIFIER);
				}
				for (let i = 0; i < 8; i++) { // attach adjacent edges
					dx = x + surr[i][0];
					dy = y + surr[i][1];
					if ((roomArray[dx][dy] >= NORMAL && roomArray[dx][dy] < PROTECTED)
						|| roomArray[dx][dy] === CANNOT_BUILD) {
						g.newEdge(bot, dy * 50 + dx, infini);
					}
				}
			} else if (roomArray[x][y] === CANNOT_BUILD) { // near Exit
				g.newEdge(top, sink, infini);
			}
		}
	} // graph finished
	return g;
}

/**
 * Main function to be called by user: calculate min cut tiles from room using rectangles as protected areas
 * @param room - the room to use
 * @param rectangles - the areas to protect, defined as rectangles
 * @param bounds - the area to be considered for the minCut
 */
function getCutTiles(roomName: string, toProtect: Rectangle[],
							preferCloserBarriers     = true,
							preferCloserBarrierLimit = Infinity,
							visualize                = false, 
							bounds: Rectangle        = {x1: 0, y1: 0, x2: 49, y2: 49}): Pos[] {
	const graph = createGraph(roomName, toProtect, preferCloserBarriers, preferCloserBarrierLimit, visualize, bounds);
	if (!graph) {
		return [];
	}
	let x: number;
	let y: number;
	const source = 2 * 50 * 50; // Position Source / Sink in Room-Graph
	const sink = 2 * 50 * 50 + 1;
	const count = graph.calcMinCut(source, sink);
	// console.log('Number of Tiles in Cut:', count);
	const positions = [];
	if (count > 0) {
		const cutVertices = graph.getMinCut(source);
		let v: number;
		for (v of cutVertices) {
			// x= vertex % 50  y=v/50 (math.floor?)
			x = v % 50;
			y = Math.floor(v / 50);
			positions.push({x, y, roomName});
		}
	}
	const wholeRoom = bounds.x1 === 0 && bounds.y1 === 0 && bounds.x2 === 49 && bounds.y2 === 49;
	return wholeRoom ? positions : pruneDeadEnds(roomName, positions);
}

/**
 * Removes unnecessary tiles if they are blocking the path to a dead end
 * Useful if minCut has been run on a subset of the room
 * @param roomName - Room to work in
 * @param cutTiles - Array of tiles which are in the minCut
 */
function pruneDeadEnds(roomName: string, cutTiles: Pos[]) {
	// Get Terrain and set all cut-tiles as unwalkable
	const roomArray = get2DArray(roomName);
	let tile: Pos;
	for (tile of cutTiles) {
		roomArray[tile.x][tile.y] = UNWALKABLE;
	}
	// Floodfill from exits: save exit tiles in array and do a BFS-like search
	const unvisited: number[] = [];
	let y: number;
	let x: number;
	for (y = 0; y < 49; y++) {
		if (roomArray[0][y] === EXIT) {
			console.log('prune: toExit', 0, y);
			unvisited.push(50 * y);
		}
		if (roomArray[49][y] === EXIT) {
			console.log('prune: toExit', 49, y);
			unvisited.push(50 * y + 49);
		}
	}
	for (x = 0; x < 49; x++) {
		if (roomArray[x][0] === EXIT) {
			console.log('prune: toExit', x, 0);
			unvisited.push(x);
		}
		if (roomArray[x][49] === EXIT) {
			console.log('prune: toExit', x, 49);
			unvisited.push(2450 + x); // 50*49=2450
		}
	}
	// Iterate over all unvisited EXIT tiles and mark neigbours as EXIT tiles if walkable, add to unvisited
	const surr = [[0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1]];
	let currPos: number;
	let dx: number;
	let dy: number;
	while (unvisited.length > 0) {
		currPos = unvisited.pop()!;
		x = currPos % 50;
		y = Math.floor(currPos / 50);
		for (let i = 0; i < 8; i++) {
			dx = x + surr[i][0];
			dy = y + surr[i][1];
			if (dx < 0 || dx > 49 || dy < 0 || dy > 49) {
				continue;
			}
			if ((roomArray[dx][dy] >= NORMAL && roomArray[dx][dy] < PROTECTED)
				|| roomArray[dx][dy] === CANNOT_BUILD) {
				unvisited.push(50 * dy + dx);
				roomArray[dx][dy] = EXIT;
			}
		}
	}
	// Remove min-Cut-Tile if there is no EXIT reachable by it
	let leadsToExit: boolean;
	const validCut: Pos[] = [];
	for (tile of cutTiles) {
		leadsToExit = false;
		for (let j = 0; j < 8; j++) {
			dx = tile.x + surr[j][0];
			dy = tile.y + surr[j][1];
			if (roomArray[dx][dy] === EXIT) {
				leadsToExit = true;
			}
		}
		if (leadsToExit) {
			validCut.push(tile);
		}
	}
	return validCut;
}