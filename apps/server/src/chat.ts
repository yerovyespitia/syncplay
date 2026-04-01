import type { Participant } from "@syncplay/shared";

export const MAX_CHAT_MESSAGE_LENGTH = 280;

export function normalizeChatMessageText(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_CHAT_MESSAGE_LENGTH);
}

export function buildHostJoinMessage(participant: Participant) {
  return `${resolveParticipantName(participant)} created the room.`;
}

export function buildJoinMessage(participant: Participant) {
  return `${resolveParticipantName(participant)} joined the room.`;
}

export function buildLeaveMessage(participant: Participant) {
  return `${resolveParticipantName(participant)} left the room.`;
}

export function buildPlaybackActionMessage(
  participant: Participant,
  action: "player_play" | "player_pause" | "player_seek",
  currentTime: number
) {
  const name = resolveParticipantName(participant);
  const time = formatTime(currentTime);
  if (action === "player_play") return `${name} resumed playback at ${time}.`;
  if (action === "player_pause") return `${name} paused at ${time}.`;
  return `${name} skipped to ${time}.`;
}

export function buildSubtitleAddedMessage(participant: Participant, fileName: string) {
  return `${resolveParticipantName(participant)} added subtitles: ${fileName}.`;
}

function formatTime(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function resolveParticipantName(participant: Participant) {
  return participant.displayName?.trim() || participant.id.slice(0, 6);
}
