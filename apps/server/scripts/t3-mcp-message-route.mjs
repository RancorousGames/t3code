/** Route MCP sends to the running T3 desktop, which owns the actual
 * ChatGPT delivery queue and native-thread command transport.
 * The server's separately populated ChatGPT registry is not a reliable
 * recipient directory: it can miss a live tab and leave a send queued forever.
 */
import * as Crypto from "node:crypto";
import { controlSessions } from "../../../scripts/chatgpt-sessions.mjs";
import { controlNativeThreads } from "../../../scripts/t3-native-threads.mjs";
import { isExactConversationUrl } from "../../../scripts/t3-registry-read.mjs";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const refused = (reason, requestId) => ({
  ok: false,
  action: "send",
  status: "refused",
  messageSent: false,
  ...(requestId ? { requestId } : {}),
  reason,
});
const validConversation = (session) => {
  const id = session.conversationId;
  if (isExactConversationUrl(session.url, id)) return id;
  const identity = session.bootstrapIdentity;
  if (identity?.state === "registered" && UUID.test(identity.conversationId ?? ""))
    return identity.conversationId;
  return null;
};

export async function sendMcpMessage(
  input,
  { browser = controlSessions, native = controlNativeThreads, newId = Crypto.randomUUID } = {},
) {
  if (!UUID.test(input?.sessionId ?? "")) return refused("An exact T3 session UUID is required.");
  if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 8000)
    return refused("Message must contain 1–8000 characters.");
  if (input.requestId !== undefined && !UUID.test(input.requestId))
    return refused("requestId must be a UUID.");
  const requestId = input.requestId ?? newId();
  if (input.expectedConversationId !== undefined && !UUID.test(input.expectedConversationId))
    return refused("Invalid expectedConversationId.", requestId);

  // The running desktop's list, not the server's often-incomplete registry,
  // provides the actual browser session/conversation binding.
  const browserList = await browser({ action: "list", which: "all", includeHidden: true });
  const matches = (browserList.sessions ?? []).filter((session) =>
    [session.id, session.browserSessionId, session.publicSessionId].includes(input.sessionId),
  );
  if (matches.length > 1) return refused("Ambiguous ChatGPT recipient.", requestId);
  if (matches.length === 1) {
    const session = matches[0];
    const sessionId = session.browserSessionId ?? session.id;
    const conversationId = validConversation(session);
    if (!conversationId)
      return refused("ChatGPT session has no verified conversation binding.", requestId);
    if (input.expectedConversationId && input.expectedConversationId !== conversationId)
      return refused("ChatGPT conversation binding mismatch; nothing sent.", requestId);
    // A stable requestId is also the desktop queue's messageId. T3 owns
    // retries, duplicate suppression and the eventual user-turn receipt.
    const result = await browser({
      action: "enqueue",
      messageId: requestId,
      sessionId,
      expectedConversationId: conversationId,
      message: input.message,
    });
    if (
      result.messageId !== requestId ||
      result.sessionId !== sessionId ||
      result.conversationId !== conversationId ||
      !result.status
    )
      throw new Error(
        `T3 enqueue acknowledgement uncertain (requestId=${requestId}); inspect receipt; do not retry with a new ID.`,
      );
    return {
      action: "send",
      requestId,
      sessionId: input.sessionId,
      status: result.status,
      queueAccepted: true,
      messageSent: result.status === "delivered",
      delivery: result.status === "delivered" ? "user_turn_observed" : "unconfirmed",
      resolved: result.status === "delivered",
      verifiedConversationId: conversationId,
    };
  }

  // Native T3 threads have IDs in a different namespace/directory. Their
  // existing command path already accepts clientRequestId for stable sends.
  const nativeList = await native({ action: "list" });
  const thread = (nativeList.threads ?? []).find((item) => item.id === input.sessionId);
  if (!thread)
    return refused(
      "Session not found in running ChatGPT sessions or native T3 threads.",
      requestId,
    );
  if (input.expectedConversationId !== undefined)
    return refused("expectedConversationId applies only to ChatGPT sessions.", requestId);
  const result = await native({
    action: "send",
    environmentId: nativeList.environmentId,
    threadId: input.sessionId,
    clientRequestId: requestId,
    message: input.message,
  });
  if (
    result.threadId !== input.sessionId ||
    result.messageId !== requestId ||
    result.messageSent !== true
  )
    throw new Error(
      `Native T3 send acknowledgement uncertain (requestId=${requestId}); do not retry with a new ID.`,
    );
  return {
    action: "send",
    requestId,
    sessionId: input.sessionId,
    status: "delivered",
    messageSent: true,
    delivery: "native_message_acknowledged",
    resolved: true,
  };
}

export async function readDesktopMessageReceipt(input, { browser = controlSessions } = {}) {
  try {
    const result = await browser({ action: "delivery_status", messageId: input.requestId });
    if (!result || result.messageId !== input.requestId) return null;
    return {
      action: "receipt",
      requestId: input.requestId,
      sessionId: result.sessionId,
      status: result.status,
      messageSent: result.status === "delivered",
      delivery: result.status === "delivered" ? "user_turn_observed" : "unconfirmed",
      resolved: ["delivered", "cancelled", "needs_attention"].includes(result.status),
      attempts: result.attempts,
      ...(result.lastError ? { reason: result.lastError } : {}),
    };
  } catch (error) {
    // A receipt from the old server-registry route is not in the desktop
    // outbox. Let the registry's existing receipt handler look it up.
    if (/Unknown delivery messageId/.test(String(error))) return null;
    throw error;
  }
}
