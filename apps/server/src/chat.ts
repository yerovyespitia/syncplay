import type { Participant } from "@syncplay/shared";

export const MAX_CHAT_MESSAGE_LENGTH = 280;

export function normalizeChatMessageText(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, MAX_CHAT_MESSAGE_LENGTH);
}

export function buildJoinMessage(participant: Participant) {
  return `${resolveParticipantName(participant)} joined the room.`;
}

export function buildLeaveMessage(participant: Participant) {
  return `${resolveParticipantName(participant)} left the room.`;
}

export function resolveParticipantName(participant: Participant) {
  return participant.displayName?.trim() || participant.id.slice(0, 6);
}
