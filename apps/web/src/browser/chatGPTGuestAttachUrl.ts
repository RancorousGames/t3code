import type { BrowserSession } from "../chatGPTBrowserSessions";
import { isChatGPTHomeUrl } from "../chatGPTBrowserPrewarm";
import { resolveWarmChatGPTConversationUrl } from "../omniwork/chatGPTWarmConversationUrl";
import { CANONICAL_CHATGPT_CONVERSATION_ID } from "../chatGPTConversationIdentity";

/**
 * A restored preview's homepage is often a transient redirect, not the URL
 * the user actually saved. Resolve the destination BEFORE a new Electron
 * guest attaches; do not navigate an already-mounted guest or replace drafts.
 */
export function resolveChatGPTGuestAttachUrl(
  session: BrowserSession | undefined,
  savedUrl: string | null,
  previewUrl: string | null,
  lastObservedConversationId: string | null = null,
): string | null {
  if (!session || (previewUrl && !isChatGPTHomeUrl(previewUrl))) return previewUrl;
  const recovered = resolveWarmChatGPTConversationUrl(session, savedUrl, previewUrl);
  if (recovered) return recovered;
  // Only legacy sessions without a pending reboot may use the last real page observation.
  if (!session.bootstrapIdentity && lastObservedConversationId &&
      CANONICAL_CHATGPT_CONVERSATION_ID.test(lastObservedConversationId))
    return `https://chatgpt.com/c/${lastObservedConversationId}`;
  return previewUrl;
}
