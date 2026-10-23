import { CANONICAL_CHATGPT_CONVERSATION_ID, chatGPTConversationIdFromUrl } from "./chatGPTConversationIdentity";
import type { BrowserSession } from "./chatGPTBrowserSessions";

export type ChatGPTResolvedAddress =
  | { readonly sessionId: string; readonly conversationId: string | null; readonly create: false }
  | { readonly sessionId: null; readonly conversationId: string; readonly create: true };

/**
 * Keep the persistent T3 browser UUID distinct from a ChatGPT conversation UUID.
 * An unknown T3-style UUIDv4 is not evidence of a ChatGPT conversation.
 * Explicit conversation guards can opt in to UUIDv4 URL lookup, while other
 * unknown canonical conversation IDs retain their existing lookup behavior.
 */
export function resolveChatGPTSessionAddress(
  requestedId: string,
  sessions: readonly BrowserSession[],
  lastUrl: (id: string) => string | null,
  expectedConversationId?: string,
): ChatGPTResolvedAddress {
  const exact = sessions.find((entry) => entry.id === requestedId);
  if (exact) {
    return { sessionId: exact.id, conversationId: expectedConversationId ?? null, create: false };
  }
  if (!CANONICAL_CHATGPT_CONVERSATION_ID.test(requestedId)) {
    throw new Error("Unknown T3 session ID; conversation lookup requires a canonical lowercase ChatGPT /c/<uuid> ID.");
  }
  if (expectedConversationId && expectedConversationId !== requestedId) {
    throw new Error("Conversation ID and expectedConversationId disagree; refusing to route.");
  }
  // T3 sessions are generated with crypto.randomUUID() (RFC 4122 v4).
  // Treating a missing/stale T3 session ID as a ChatGPT /c/ ID creates bogus
  // "Conversation <id>" tabs that ChatGPT reports as inaccessible.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestedId) &&
      expectedConversationId !== requestedId) {
    throw new Error("Unknown T3-style session UUID; use an existing T3 session ID or explicitly specify expectedConversationId for a ChatGPT /c/ lookup.");
  }
  const matches = sessions.filter(
    (entry) => !entry.hidden && (
      chatGPTConversationIdFromUrl(lastUrl(entry.id)) === requestedId
    ),
  );
  if (matches.length > 1) {
    throw new Error("Several live T3 sessions reference this ChatGPT conversation; refusing ambiguous routing.");
  }
  if (matches.length === 1) {
    return { sessionId: matches[0]!.id, conversationId: requestedId, create: false };
  }
  return { sessionId: null, conversationId: requestedId, create: true };
}
