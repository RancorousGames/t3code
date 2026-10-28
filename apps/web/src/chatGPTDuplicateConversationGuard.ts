import type { BrowserSession } from "./chatGPTBrowserSessions";
import { findExistingChatGPTConversation } from "./chatGPTBrowserSessions";

/**
 * A guest can navigate independently of T3's open path. Detect another
 * persisted owner without rewriting either T3 session ID or touching a guest.
 */
export function findDuplicateChatGPTConversationOwner(
  sessions: readonly BrowserSession[],
  currentSessionId: string,
  observedUrl: string | null,
  lastUrl: (id: string) => string | null,
): BrowserSession | undefined {
  if (!observedUrl) return undefined;
  const eligible = sessions
    .filter((session) => session.id !== currentSessionId)
    .toSorted((a, b) => Number(a.hidden === true) - Number(b.hidden === true));
  return findExistingChatGPTConversation(eligible, observedUrl, lastUrl);
}

/**
 * No existing API can positively prove an arbitrary other guest's composer,
 * pending sends and managed ownership disposable. Refuse destructive moves.
 */
export function refuseChatGPTConversationMove(hasUncertainSend: boolean): string {
  return hasUncertainSend
    ? "Move refused: the other session has an unresolved send (UNKNOWN). Its identity and delivery evidence must be preserved. Switch to it instead."
    : "Move refused: T3 cannot verify that the other session has no unsent draft or active work. Its session identity is preserved. Switch to it instead.";
}
