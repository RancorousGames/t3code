import { type BrowserSession, isChatGPTConversationUrl } from "../chatGPTBrowserSessions";
import { CANONICAL_CHATGPT_CONVERSATION_ID } from "../chatGPTConversationIdentity";

/**
 * Recover only conversation URLs already tied to this exact T3 session.
 * Never manufacture a ChatGPT conversation ID from the T3 session ID or title.
 */
export function resolveWarmChatGPTConversationUrl(
  session: BrowserSession,
  savedUrl: string | null,
  previewUrl: string | null = null,
): string | null {
  if (isChatGPTConversationUrl(savedUrl)) return savedUrl;
  if (isChatGPTConversationUrl(previewUrl)) return previewUrl;
  const registeredId = session.bootstrapIdentity?.state === "registered"
    ? session.bootstrapIdentity.conversationId
    : null;
  if (registeredId && CANONICAL_CHATGPT_CONVERSATION_ID.test(registeredId))
    return `https://chatgpt.com/c/${registeredId}`;
  if (session.bootstrapIdentity && session.bootstrapIdentity.state !== "registered") return null;
  if (isChatGPTConversationUrl(session.archive?.conversationUrl ?? null))
    return session.archive!.conversationUrl;
  if (isChatGPTConversationUrl(session.completion?.observedUrl ?? null))
    return session.completion!.observedUrl!;
  return null;
}
