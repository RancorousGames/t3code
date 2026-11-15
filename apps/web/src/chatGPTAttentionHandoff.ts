import * as Schema from "effect/Schema";
import { readChatGPTBrowserSessions, chatGPTBrowserLastUrlKey } from "./chatGPTBrowserSessions";
import { chatGPTConversationIdFromUrl } from "./chatGPTConversationIdentity";
import { getLocalStorageItem } from "./hooks/useLocalStorage";
import type { AgentAttention } from "./chatGPTAgentAttention";

/** Shared desktop/phone dismissal gate: only a durable one-off agent receipt resolves GMA. */
export async function queueAgentAttentionDismissal(
  environmentId: string, attention: AgentAttention,
): Promise<boolean> {
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
