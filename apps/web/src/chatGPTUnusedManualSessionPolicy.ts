import type { BrowserSession } from "./chatGPTBrowserSessions";

export const EMPTY_MANUAL_CHAT_MAX_IDLE_MS = 30 * 60_000;

export type EmptyManualChatRejection =
  | "legacy-or-unverified-origin"
  | "not-idle-for-30-minutes"
  | "protected-metadata"
  | "child-or-parent-session"
  | "protected-by-manager-seat"
  | "manager-seat-unknown"
  | "send-or-recovery-uncertain"
  | "conversation-or-navigation-observed"
  | "guest-not-proven-empty"
  | "eligible";

/**
 * This is deliberately a one-way, fail-closed policy. Only explicit UI-origin
 * new chats are candidates; legacy records and backend-created guests have no
 * trustworthy first-use baseline and are never eligible.
 */
export function emptyManualChatEligibility(input: {
  session: BrowserSession;
  sessions: readonly BrowserSession[];
  now: number;
  lastTouchedAt: number;
  activeSessionId: string | undefined;
  managerIds: ReadonlySet<string> | null;
  hasUncertainSend: boolean;
  recoveryPending: boolean;
  hasConversationUrl: boolean;
}): EmptyManualChatRejection {
  const {
    session,
    sessions,
    now,
    lastTouchedAt,
    activeSessionId,
    managerIds,
    hasUncertainSend,
    recoveryPending,
    hasConversationUrl,
  } = input;
  if (
    !session.manualEmptyCandidateCreatedAt ||
    !Number.isFinite(session.manualEmptyCandidateCreatedAt) ||
    session.manualEmptyCandidateCreatedAt > now
  )
    return "legacy-or-unverified-origin";
  if (
    !Number.isFinite(lastTouchedAt) ||
    lastTouchedAt < 0 ||
    lastTouchedAt > now ||
    now - Math.max(session.manualEmptyCandidateCreatedAt, lastTouchedAt) <
      EMPTY_MANUAL_CHAT_MAX_IDLE_MS
  )
    return "not-idle-for-30-minutes";
  if (
    session.id === "chatgpt" ||
    session.id === activeSessionId ||
    session.hidden ||
    session.archive ||
    session.snoozedUntil ||
    session.borderColor ||
    session.autoCloseExempt ||
    session.humanControlled ||
    session.completion ||
    session.spawnRequestId ||
    session.project ||
    !/^ChatGPT \d+$/.test(session.title)
  )
    return "protected-metadata";
  if (
    session.parentSessionId !== undefined ||
    sessions.some((entry) => entry.parentSessionId === session.id)
  )
    return "child-or-parent-session";
  if (managerIds === null) return "manager-seat-unknown";
  if (managerIds.has(session.id)) return "protected-by-manager-seat";
  if (hasUncertainSend || recoveryPending) return "send-or-recovery-uncertain";
  if (session.manualEmptyCandidateDisqualified || hasConversationUrl)
    return "conversation-or-navigation-observed";
  return "eligible";
}
