import type { BrowserSession } from "./chatGPTBrowserSessions";
import type { SpawnReceipt } from "./chatGPTSpawnReceipts";

export const BLANK_CHATGPT_SESSION_GRACE_MS = 2 * 60_000;

/** Candidates still need two live, read-only proofs of an unused ChatGPT homepage.
 * An absent guest, stale cached homepage or unknown initial send is not proof. */
export function blankChatGPTSessionCandidate(input: {
  session: BrowserSession;
  sessions: readonly BrowserSession[];
  selectedId: string | undefined;
  managerIds: ReadonlySet<string> | null;
  receipt: SpawnReceipt | undefined;
  now: number;
  lastTouchedAt: number;
  hasConversationUrl: boolean;
  hasPendingSend: boolean;
}): boolean {
  const { session, sessions, selectedId, managerIds, receipt, now, lastTouchedAt,
    hasConversationUrl, hasPendingSend } = input;
  const created = session.createdAt ?? session.manualEmptyCandidateCreatedAt ?? receipt?.createdAt;
  if (!created || !Number.isFinite(created) || created > now ||
      !Number.isFinite(lastTouchedAt) || lastTouchedAt > now ||
      now - Math.max(created, lastTouchedAt, session.lastDirectInteractionAt ?? 0) <
        BLANK_CHATGPT_SESSION_GRACE_MS) return false;
  if (session.id === "chatgpt" || session.id === selectedId || session.hidden ||
      session.archive || session.completion || session.verificationPending ||
      session.autoCloseExempt || session.returnMarker || session.borderColor || session.snoozedUntil ||
      session.binding?.role === "manager" ||
      session.bootstrapIdentity?.state === "registered" ||
      session.bootstrapIdentity?.state === "mismatch" ||
      session.bootstrapIdentity?.conversationId || session.manualEmptyCandidateDisqualified ||
      hasConversationUrl || hasPendingSend ||
      sessions.some((other) => other.parentSessionId === session.id) ||
      managerIds === null || managerIds.has(session.id)) return false;
  if (session.spawnRequestId) {
    // An in-flight callback might still submit after the sweep. Only a finished
    // outcome can enter the independently verified blank-home cleanup path.
    if (!receipt || receipt.requestId !== session.spawnRequestId ||
        !receipt.initialDelivery ||
        receipt.initialDelivery.delivery === "user_turn_observed" ||
        (receipt.initialDelivery.delivery === "unknown" &&
          (receipt.initialDelivery.sendAttempted !== true ||
            !receipt.initialDelivery.reason ||
            /has not been confirmed/i.test(receipt.initialDelivery.reason)))) return false;
  }
  return true;
}
