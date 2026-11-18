import * as Schema from "effect/Schema";
import { readChatGPTBrowserSessions, chatGPTBrowserLastUrlKey } from "./chatGPTBrowserSessions";
import { chatGPTConversationIdFromUrl } from "./chatGPTConversationIdentity";
import { getLocalStorageItem } from "./hooks/useLocalStorage";
import type { AgentAttention } from "./chatGPTAgentAttention";

/** Only agent-initiated transient requests need a durable handoff.
 * Persistent Ctrl+D reminders are local UI state; sending an agent a dismissal
 * message for one would be incorrect and can interrupt ongoing work. */
export async function queueAgentAttentionDismissal(
  environmentId: string, attention: AgentAttention,
): Promise<boolean> {
  if (attention.source === "manual") return true;
  const session = readChatGPTBrowserSessions(environmentId as Parameters<typeof readChatGPTBrowserSessions>[0])
    .find((entry) => entry.id === attention.sessionId ||
      entry.bootstrapIdentity?.publicId === attention.sessionId);
  if (!session) return false;
  const conversationId = session.bootstrapIdentity?.conversationId ??
    chatGPTConversationIdFromUrl(getLocalStorageItem(
      chatGPTBrowserLastUrlKey(environmentId as Parameters<typeof chatGPTBrowserLastUrlKey>[0], session.id),
      Schema.String,
    ));
  const enqueue = window.desktopBridge?.appActivation?.enqueueChatGPT;
  if (!conversationId || !enqueue) return false;
  try {
    const receipt = await enqueue({
      messageId: attention.id, sessionId: session.id, conversationId,
      body: `[T3 attention request ${attention.id}] User dismissed the request for direct
attention: "${attention.message}". Do not notify again. Put the unresolved question
on the ORIGINAL TaskBoard task using task ask-user, or request verification in
the Review Inbox if implementation is finished.`,
    });
    return receipt.status !== "cancelled" && receipt.status !== "needs_attention";
  } catch (error) {
    console.warn("[Agent attention] Could not queue dismissal notice", error);
    return false;
  }
}
