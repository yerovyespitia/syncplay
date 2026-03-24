const ROOM_ID_LENGTH = 6;
const ROOM_ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function createRoomId(): string {
  let roomId = "";

  for (let index = 0; index < ROOM_ID_LENGTH; index += 1) {
    const charIndex = Math.floor(Math.random() * ROOM_ID_CHARS.length);
    roomId += ROOM_ID_CHARS[charIndex];
  }

  return roomId;
}

export function normalizeRoomId(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, ROOM_ID_LENGTH);
}
