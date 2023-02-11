import { mountCreepTravelTo } from "./traveler"

export function mountCreepPrototype() {
    mountCreepTravelTo()

    Creep.prototype.moveToRoom = function (roomName: string) {
        return this.travelTo(new RoomPosition(25, 25, roomName))
    }
}