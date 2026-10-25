import type { AgentProviderV1DesktopWork, EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { sendInitialChatGPTPrompt } from "./chatGPTBrowserAutomation";
import {
  chatGPTBrowserLastUrlKey, readChatGPTBrowserSessions,
} from "./chatGPTBrowserSessions";
import { chatGPTConversationIdFromUrl } from "./chatGPTConversationIdentity";
import { recordChatGPTSpawnCreated } from "./chatGPTSpawnReceipts";
import { browserCreateFingerprint, getBrowserCreateIntent, writeBrowserCreateIntent } from "./agentProviderBrowserCreateReceipts";
import { resolveExplicitChatGPTParent } from "./chatGPTSessionLineage";
import { inspectBrowserSession } from "./chatGPTSessionControl";
import { readProjects } from "./state/entities";
import { getLocalStorageItem } from "./hooks/useLocalStorage";

type Created = {
  created: true; sessionId: string; conversationId: string | null;
  promptDelivery: "user_turn_observed" | "unknown" | "not_sent";
  parentConfirmed: boolean; reason?: string;
};

export async function executeProviderBrowserCreate(
  environmentId: EnvironmentId,
  work: AgentProviderV1DesktopWork,
  createSession: (title: string, metadata?: { parentSessionId?: string; project?: string; spawnRequestId?: string }) => string,
): Promise<
  | { ok: true; data: Created | { created: false; reason: string; unknown?: boolean } }
  | { ok: false; code: "Busy" | "ConversationChanged" | "Unavailable" | "InvalidInput"; message: string }
> {
  if (work.action !== "create" || work.environmentId !== environmentId ||
      !work.clientRequestId || !work.title?.trim() || work.title.length > 180 ||
      (work.prompt?.length ?? 0) > 30_000)
    return { ok: false, code: "InvalidInput", message: "Invalid provider ChatGPT creation request." };
  // Renderer-persisted receipt guards against a lost server response or server
  // restart; the original message must NEVER be delivered twice on retry.
  const receiptId = "provider-v1:" + work.clientRequestId;
  const fingerprint = await browserCreateFingerprint(work);
  const existing = getBrowserCreateIntent(environmentId, receiptId);
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      return { ok: false, code: "InvalidInput", message: "Create request identity already belongs to different parameters." };
    if (existing.state === "Pending" || !existing.sessionId)
      return { ok: true, data: { created: false, unknown: true, reason: "Previous browser creation may have started; never spawn twice from this id." } };
    const found = readChatGPTBrowserSessions(environmentId).find((s) => s.id === existing.sessionId);
    if (!found)
      return { ok: true, data: { created: false, unknown: true, reason: "Existing created T3 session missing from current inventory; never spawn twice." } };
    const lastUrl = getLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, found.id), Schema.String);
    return { ok: true, data: {
      created: true, sessionId: found.id,
      conversationId: chatGPTConversationIdFromUrl(lastUrl),
      promptDelivery: "unknown",
      parentConfirmed: !work.parentSessionId || found.parentSessionId === work.parentSessionId,
      reason: "Previously created. First-prompt result requires manual readback; no replay.",
    } };
  }
  let parentId: string | undefined;
  try {
    parentId = resolveExplicitChatGPTParent(
      readChatGPTBrowserSessions(environmentId), work.parentSessionId,
    )?.id;
  } catch (cause) {
    return { ok: false, code: "InvalidInput", message: cause instanceof Error ? cause.message : String(cause) };
  }
  let project: string | undefined;
  if (work.project) {
    const matched = readProjects().find((p) =>
      p.environmentId === environmentId &&
      (p.title === work.project || p.id === work.project || p.workspaceRoot === work.project));
    if (!matched)
      return { ok: false, code: "InvalidInput", message: "Requested project is not registered in the exact T3 environment." };
    project = matched.title;
  }
  if (!writeBrowserCreateIntent({ environmentId, requestId: receiptId, fingerprint, state: "Pending", sessionId: null }))
    return { ok: false, code: "Unavailable", message: "Could not persist create write-ahead guard. No browser session created." };
  let sessionId: string;
  try {
    sessionId = createSession(work.title, {
      // Own a distinct backend guest; never consume a user's manually prewarmed session.
      spawnRequestId: receiptId,
      ...(parentId ? { parentSessionId: parentId } : {}),
      ...(project ? { project } : {}),
    });
    if (!writeBrowserCreateIntent({ environmentId, requestId: receiptId, fingerprint, state: "Created", sessionId }))
      return { ok: true, data: { created: false, unknown: true, reason: "Session created but stable receipt persistence failed; do not retry create or prompt." } };
    recordChatGPTSpawnCreated(environmentId, receiptId, sessionId);
  } catch (cause) {
    // A thrown browser creation may have created the session before throwing.
    return { ok: true, data: { created: false, unknown: true, reason: cause instanceof Error ? cause.message : "Create call uncertain; do not retry." } };
  }
  let delivery: Created["promptDelivery"] = "not_sent";
  let reason: string | undefined;
  if (work.prompt?.trim()) {
    try {
      const sent = await sendInitialChatGPTPrompt({ environmentId, sessionId, requestId: receiptId, prompt: work.prompt });
      delivery = sent.delivery;
      reason = sent.reason;
    } catch (cause) {
      delivery = "unknown";
      reason = cause instanceof Error ? cause.message : String(cause);
    }
  }
  const lastUrl = getLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, sessionId), Schema.String);
  let verifiedConversationId = chatGPTConversationIdFromUrl(lastUrl);
  const session = readChatGPTBrowserSessions(environmentId).find((s) => s.id === sessionId);
  if (session) {
    try {
      const inspected = await inspectBrowserSession(environmentId, session, "end", 1, false);
      verifiedConversationId = chatGPTConversationIdFromUrl(inspected.observedGuestUrl ?? inspected.url) ?? verifiedConversationId;
    } catch { /* Partial browser history must not erase a created session receipt. */ }
  }
  if (delivery === "user_turn_observed" && !verifiedConversationId) {
    delivery = "unknown";
    reason = "User turn observed, but exact conversation URL was not verifiable.";
  }
  return { ok: true, data: {
    created: true, sessionId, conversationId: verifiedConversationId,
    promptDelivery: delivery, parentConfirmed: !work.parentSessionId || parentId === work.parentSessionId,
    ...(reason ? { reason } : {}),
  } };
}
