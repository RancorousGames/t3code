import type { ScopedThreadRef } from "@t3tools/contracts";

const key = (threadRef: ScopedThreadRef) =>
  `t3code:chatgpt:indexed-find:v1:${threadRef.environmentId}:${threadRef.threadId}`;

export interface ChatGPTIndexedFindRequest {
  readonly term: string;
  readonly turnIndex: number;
  readonly role: "user" | "assistant";
}

/** FTS snippets bracket matching terms, but the surrounding ellipsis is not
 * literal DOM text. Only highlighted source text is eligible for guest find. */
export function indexedFindTerm(snippet: string): string | null {
  const highlighted = /\[([^\]\r\n]{2,120})\]/u.exec(snippet)?.[1]?.trim();
  return highlighted && highlighted.length >= 2 ? highlighted : null;
}

export function queueChatGPTIndexedFind(
  threadRef: ScopedThreadRef,
  match: { snippet: string; turnIndex: number; role: "user" | "assistant" },
): boolean {
  const term = indexedFindTerm(match.snippet);
  if (!term || !Number.isSafeInteger(match.turnIndex) || match.turnIndex < 0) return false;
  window.sessionStorage.setItem(key(threadRef), JSON.stringify({
    term, turnIndex: match.turnIndex, role: match.role,
  }));
  return true;
}

export function consumeChatGPTIndexedFind(threadRef: ScopedThreadRef): ChatGPTIndexedFindRequest | null {
  const saved = window.sessionStorage.getItem(key(threadRef));
  window.sessionStorage.removeItem(key(threadRef));
  if (!saved) return null;
  try {
    const value: unknown = JSON.parse(saved);
    if (!value || typeof value !== "object" ||
        !("term" in value) || typeof value.term !== "string" ||
        value.term.length < 2 || value.term.length > 120 ||
        !("turnIndex" in value) || !Number.isSafeInteger(value.turnIndex) ||
        (value.turnIndex as number) < 0 ||
        !("role" in value) || (value.role !== "user" && value.role !== "assistant"))
      return null;
    return value as ChatGPTIndexedFindRequest;
  } catch {
    return null;
  }
}
