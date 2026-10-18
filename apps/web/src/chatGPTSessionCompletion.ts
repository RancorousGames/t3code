import type { BrowserSession } from "./chatGPTBrowserSessions";
import { chatGPTConversationIdFromUrl } from "./chatGPTConversationIdentity";

/**
 * Completion is a caller declaration for an observed ChatGPT conversation,
 * not a provider signal. A tab's T3 UUID alone is never enough: tabs navigate.
 */
export function validChatGPTCompletion(
  declared: BrowserSession["completion"],
  currentUrl: string | null,
  renderedTurns: number,
  readableIdle: boolean,
): BrowserSession["completion"] | null {
  const current = chatGPTConversationIdFromUrl(currentUrl);
  const original = chatGPTConversationIdFromUrl(declared?.observedUrl ?? null);
  return declared &&
    readableIdle &&
    current !== null &&
    current === original &&
    renderedTurns === declared.observedTurns
    ? declared
    : null;
}
