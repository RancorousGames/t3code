import type { BrowserSession } from "../chatGPTBrowserSessions";
import { chatGPTConversationIdFromUrl } from "../chatGPTConversationIdentity";
import type { ChatGPTPageSnapshot } from "../chatGPTPageSnapshotInspection";

export const CHATGPT_RESTART_WORKING_GRACE_MS = 15 * 60_000;

/**
 * Only positive, recent evidence of an in-progress ChatGPT response may trigger
 * a guest mount after desktop restart. Never submit a message or replay an
 * unconfirmed send. A plain "worked recently" timestamp is not sufficient.
 */
export function chatGPTRestartWorkingSessions(
  sessions: readonly BrowserSession[],
  snapshots: Readonly<Record<string, unknown>>,
  now: number,
  uncertainOwners: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const result = new Set<string>();
  for (const session of sessions) {
    if (session.hidden || (session.snoozedUntil ?? 0) > now || uncertainOwners.has(session.id)) continue;
    const raw = snapshots[session.id];
    if (!raw || typeof raw !== "object") continue;
    const snapshot = raw as Partial<ChatGPTPageSnapshot>;
    if (!Number.isFinite(snapshot.observedAt) ||
      typeof snapshot.observedAt !== "number" ||
      snapshot.observedAt > now ||
      now - snapshot.observedAt > CHATGPT_RESTART_WORKING_GRACE_MS ||
      snapshot.activity !== "working" ||
      snapshot.signals?.stopButton !== true ||
      snapshot.signals.draftPresent ||
      snapshot.signals.signInOrCaptcha ||
      !snapshot.url ||
      snapshot.conversationId !== chatGPTConversationIdFromUrl(snapshot.url)) continue;
    result.add(session.id);
  }
  return result;
}
