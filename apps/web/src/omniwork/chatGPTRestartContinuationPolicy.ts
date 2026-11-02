import type { BrowserSession } from "../chatGPTBrowserSessions";
import { chatGPTConversationIdFromUrl } from "../chatGPTConversationIdentity";
import type { ChatGPTPageSnapshot } from "../chatGPTPageSnapshotInspection";
import { CHATGPT_RESTART_WORKING_GRACE_MS } from "./chatGPTRestartWorkingSessions";

export interface ChatGPTRestartSource {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly contentHash: string;
  readonly observedAt: number;
  readonly turnCount: number;
  readonly lastAssistantText: string | null;
}
export type ChatGPTRestartContinuationDecision = "wait" | "continue" | "ignore";

/** Only a bound managed agent gets an auto continuation. Ordinary personal
 * ChatGPT threads must NEVER receive an unexpected message on T3 launch. */
export function chatGPTRestartSource(
  session: BrowserSession,
  candidate: unknown,
  now: number,
): ChatGPTRestartSource | null {
  if (!["manager", "worker"].includes(session.binding?.role ?? "") ||
    session.hidden || (session.snoozedUntil ?? 0) > now ||
    !candidate || typeof candidate !== "object") return null;
  const snapshot = candidate as Partial<ChatGPTPageSnapshot>;
  if (snapshot.activity !== "working" || snapshot.signals?.stopButton !== true ||
    typeof snapshot.contentHash !== "string" || !/^[a-f0-9]{8}$/.test(snapshot.contentHash) ||
    typeof snapshot.observedAt !== "number" || !Number.isFinite(snapshot.observedAt) || snapshot.observedAt > now ||
    now - snapshot.observedAt > CHATGPT_RESTART_WORKING_GRACE_MS ||
    typeof snapshot.conversationId !== "string" ||
    snapshot.conversationId !== chatGPTConversationIdFromUrl(snapshot.url ?? null) ||
    typeof snapshot.turnCount !== "number" || !Number.isSafeInteger(snapshot.turnCount) || snapshot.turnCount <= 0 ||
    snapshot.signals?.draftPresent || snapshot.signals?.signInOrCaptcha ||
    session.completion) return null;
  return {
    sessionId: session.id,
    conversationId: snapshot.conversationId,
    observedAt: snapshot.observedAt,
    contentHash: snapshot.contentHash,
    turnCount: snapshot.turnCount,
    lastAssistantText: snapshot.lastAssistant?.text ?? null,
  };
}

/** A page with evidence of a newer assistant turn has already advanced; don't
 * append a duplicate Continue just because its old guest was remounted. */
export function decideChatGPTRestartContinuation(
  source: ChatGPTRestartSource,
  candidate: unknown,
  now: number,
  unknownSend: boolean,
): ChatGPTRestartContinuationDecision {
  if (unknownSend) return "ignore";
  if (!candidate || typeof candidate !== "object") return "wait";
  const snapshot = candidate as Partial<ChatGPTPageSnapshot>;
  if (typeof snapshot.observedAt !== "number" || snapshot.observedAt <= source.observedAt)
    return "wait";
  if (snapshot.conversationId !== source.conversationId ||
    snapshot.conversationId !== chatGPTConversationIdFromUrl(snapshot.url ?? null))
    return "ignore";
  if (snapshot.activity === "working") return "wait";
  if (snapshot.activity !== "idle") return "wait";
  if (!snapshot.signals?.composerPresent ||
      snapshot.signals.draftPresent ||
      snapshot.signals.signInOrCaptcha ||
      snapshot.signals.conversationFull) return "wait";
  if (snapshot.turnCount !== source.turnCount ||
      (snapshot.lastAssistant?.text ?? null) !== source.lastAssistantText) return "ignore";
  if (snapshot.observedAt > now || now - snapshot.observedAt > 2 * 60_000)
    return "wait";
  return "continue";
}
