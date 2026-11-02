import {
  CANONICAL_CHATGPT_CONVERSATION_ID,
  chatGPTConversationIdFromUrl,
} from "./chatGPTConversationIdentity";
import type { BrowserSession } from "./chatGPTBrowserSessions";

export type ChatGPTExistingAddress = {
  readonly sessionId: string;
  readonly conversationId: string | null;
  readonly create: false;
};
export type ChatGPTResolvedAddress =
  | ChatGPTExistingAddress
  | { readonly sessionId: null; readonly conversationId: string; readonly create: true };

/** Ordinary reads and deliveries address only an existing persistent T3 browser session. */
export function resolveExistingChatGPTSessionAddress(
  sessionId: string,
  sessions: readonly BrowserSession[],
  expectedConversationId?: string,
): ChatGPTExistingAddress {
  const exact = sessions.find((entry) => entry.id === sessionId);
  if (!exact || exact.hidden) {
    throw new Error("T3 browser session is missing; original recipient retained, no message sent.");
  }
  return { sessionId: exact.id, conversationId: expectedConversationId ?? null, create: false };
}

/**
 * Deliberate conversation opening is distinct from message routing. Look up
 * hidden owners too: an archived conversation must be restored, not duplicated.
 */
export function resolveExplicitChatGPTConversationAddress(
  conversationId: string,
  sessions: readonly BrowserSession[],
  lastUrl: (id: string) => string | null,
): ChatGPTResolvedAddress {
  if (!CANONICAL_CHATGPT_CONVERSATION_ID.test(conversationId)) {
    throw new Error(
      "Explicit conversation opening requires a canonical lowercase ChatGPT /c/<uuid> ID.",
    );
  }
  const matches = sessions.filter(
    (entry) =>
      chatGPTConversationIdFromUrl(lastUrl(entry.id) ?? entry.archive?.conversationUrl ?? null) ===
        conversationId ||
      chatGPTConversationIdFromUrl(entry.archive?.conversationUrl ?? null) === conversationId,
  );
  if (matches.length > 1) {
    throw new Error(
      "Several T3 sessions reference this ChatGPT conversation; refusing ambiguous routing.",
    );
  }
  const owner = matches[0];
  if (owner?.hidden) {
    throw new Error(
      "This ChatGPT conversation has a hidden T3 owner; restore that session instead of creating a duplicate.",
    );
  }
  if (owner) return { sessionId: owner.id, conversationId, create: false };
  return { sessionId: null, conversationId, create: true };
}
