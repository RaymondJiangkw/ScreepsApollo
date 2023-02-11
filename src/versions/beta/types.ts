interface Creep {
    /**
     * 移动到目标房间
     * @param roomName 目标房间名称
     */
    moveToRoom(roomName: string): CreepMoveReturnCode
}