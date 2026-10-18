/**
 * ChatGPT's /c/<id> URL is the best available conversation reference.
 * It is NOT the T3 browser-session UUID: a single webview can navigate
 * between conversations (or to an unrelated site) without changing its ID.
 * We do not claim the URL is a provider API contract or globally unique ID.
 */
/** Only canonical /c/<uuid> IDs can be used as routing preconditions. */
export const CANONICAL_CHATGPT_CONVERSATION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function requireExpectedChatGPTConversation(
  expectedConversationId: string,
  observedGuestUrl: string | null,
): string {
  if (!CANONICAL_CHATGPT_CONVERSATION_ID.test(expectedConversationId)) {
    throw new Error(
      "expectedConversationId must be a canonical lowercase ChatGPT conversation UUID.",
    );
  }
  const observed = chatGPTConversationIdFromUrl(observedGuestUrl);
  if (observed !== expectedConversationId) {
    throw new Error(
      `ChatGPT conversation guard mismatch: expected ${expectedConversationId}, observed ${observed ?? "no ChatGPT conversation"}; refusing operation.`,
    );
  }
  return observed;
}

export function chatGPTConversationIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      (parsed.hostname !== "chatgpt.com" && parsed.hostname !== "chat.openai.com")
    )
      return null;
    const match = parsed.pathname.match(/(?:^|\/)c\/([a-z0-9-]+)(?:\/|$)/i);
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}
