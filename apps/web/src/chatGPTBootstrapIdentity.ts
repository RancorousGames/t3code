/** A bootstrap marker is routing metadata, never caller authentication.
 *
 * Every browser session keeps its internal `id` (storage, preview owner and
 * Electron guest are keyed by it). `publicId` is the ID agents and users see:
 * T3-preassigned for spawned children, or the first Bootstrap tool result
 * (assistant `[T3_ID:uuid]` fallback) for manual and legacy sessions. External IDs are translated at the
 * desktop pipe boundary, so nothing else needs to be renamed. */
export interface ChatGPTBootstrapIdentity {
  readonly state: "awaiting_marker" | "registered" | "mismatch";
  /** Permanent public ID once known. Absent until a manual/legacy session registers. */
  readonly publicId?: string | undefined;
  readonly conversationId?: string | undefined;
  /** Last marker reported by the agent, kept for mismatch diagnostics. */
  readonly reportedId?: string | undefined;
  /** Briefly continue observing a streamed reply after its ID appears before its title. */
  readonly titlePendingUntil?: number | undefined;
}

export interface ChatGPTBootstrapObservation {
  readonly conversationId: string;
  readonly markerId: string;
  /** Optional suggestion printed immediately after the matching ID marker. */
  readonly proposedTitle?: string | undefined;
}

export interface IdentifiedSession {
  readonly id: string;
  readonly spawnRequestId?: string | undefined;
  readonly creationOrigin?: "manual" | "backend" | undefined;
  readonly bootstrapIdentity?: ChatGPTBootstrapIdentity | undefined;
  readonly titleSource?: "user" | "bootstrap" | undefined;
}

const isBackend = (session: IdentifiedSession) =>
  !!session.spawnRequestId?.trim() || session.creationOrigin === "backend";

/** The ID shown to users and agents. Falls back to the internal ID. */
export function publicChatGPTSessionId(session: IdentifiedSession): string {
  return session.bootstrapIdentity?.publicId ?? session.id;
}

/** Resolve an externally supplied ID: exact internal ID first, then public ID. */
export function findChatGPTSessionByAnyId<T extends IdentifiedSession>(
  sessions: readonly T[],
  id: string | null | undefined,
): T | undefined {
  if (!id) return undefined;
  const wanted = id.toLowerCase();
  return sessions.find((session) => session.id === id) ??
    sessions.find((session) => session.bootstrapIdentity?.publicId?.toLowerCase() === wanted);
}

/** Only sessions without a registered marker for their current conversation
 * scan for one. A mismatch is final for that conversation (first marker wins). */
export function needsChatGPTBootstrapMarker(session: IdentifiedSession): boolean {
  const identity = session.bootstrapIdentity;
  if (!identity || identity.state === "awaiting_marker") return true;
  // The ID may have streamed ahead of the title. Keep the same guest under
  // observation briefly, but never scan indefinitely or overrule a rename.
  return identity.state === "registered" && session.titleSource === undefined &&
    (identity.titlePendingUntil ?? 0) > Date.now();
}

/** Apply an observed assistant marker to one session. Preassigned/registered
 * public IDs never change: a different marker becomes a mismatch. A session
 * without a public ID adopts the marker unless another session already owns it. */
export function registerChatGPTBootstrapMarker<T extends IdentifiedSession>(
  sessions: readonly T[],
  id: string,
  observation: ChatGPTBootstrapObservation,
): T | null {
  const entry = sessions.find((session) => session.id === id);
  if (!entry || (entry.bootstrapIdentity?.state !== undefined &&
      entry.bootstrapIdentity.state !== "awaiting_marker")) return null;
  const marker = observation.markerId.toLowerCase();
  const expected = entry.bootstrapIdentity?.publicId ?? (isBackend(entry) ? entry.id : undefined);
  const taken = sessions.some((other) => other.id !== id &&
    (other.id.toLowerCase() === marker || other.bootstrapIdentity?.publicId?.toLowerCase() === marker));
  const accepted = expected ? expected.toLowerCase() === marker : !taken;
  return {
    ...entry,
    bootstrapIdentity: {
      state: accepted ? "registered" : "mismatch",
      ...(expected ? { publicId: expected } : accepted ? { publicId: marker } : {}),
      conversationId: observation.conversationId,
      reportedId: marker,
      ...(accepted && !observation.proposedTitle
        ? { titlePendingUntil: Date.now() + 90_000 }
        : {}),
    },
  };
}

/** A new conversation in the same session must confirm the same public ID again.
 * Sessions that never registered keep scanning as before. */
export function nextChatGPTBootstrapGeneration(
  identity: ChatGPTBootstrapIdentity | undefined,
): ChatGPTBootstrapIdentity | undefined {
  if (!identity) return undefined;
  return identity.publicId
    ? { state: "awaiting_marker", publicId: identity.publicId }
    : { state: "awaiting_marker" };
}

/** Read a completed Bootstrap tool response from this conversation before the
 * assistant has echoed its ID. A user message cannot claim a tool result. */
export function inspectChatGPTBootstrapToolResult(): ChatGPTBootstrapObservation | null {
  if (!["chatgpt.com", "www.chatgpt.com", "chat.openai.com"].includes(location.hostname))
    return null;
  const conversationId = location.pathname.match(
    /^(?:\/g\/[^/]+)?\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i,
  )?.[1];
  if (!conversationId) return null;
  const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
  const claim = new RegExp(`T3 session ID:\\s*(${uuid})\\s+ID marker:\\s*\\[T3_ID:\\s*\\1\\s*\\]`, "i");
  const cards = document.querySelectorAll('[data-testid*="tool-result"],[data-testid*="tool-output"]');
  for (const card of cards) {
    if (card.closest('[data-message-author-role="user"],[data-content-search-unit-key$=":user"]'))
      continue;
    const value = card.textContent ?? "";
    if (!/Role:\s*(personal|worker|manager)/i.test(value)) continue;
    const match = value.match(claim);
    if (!match) continue;
    const title = value.match(/Proposed title:\s*([^\r\n]{3,80})/i)?.[1]?.trim();
    return {
      conversationId: conversationId.toLowerCase(), markerId: match[1]!.toLowerCase(),
      ...(title && title !== "(not proposed)" ? { proposedTitle: title } : {}),
    };
  }
  return null;
}

/** Find the earliest explicit Bootstrap marker in any rendered assistant reply.
 * This supports chats that bootstrap after an earlier conversation turn.
 * Never read user messages, tool output, code, quotations or React state.
 * Self-contained because the desktop executes this inside the attached guest. */
export function inspectChatGPTBootstrapMarker(): ChatGPTBootstrapObservation | null {
  if (!["chatgpt.com", "www.chatgpt.com", "chat.openai.com"].includes(location.hostname))
    return null;
  // Project chats live under /g/<project>/c/<uuid>.
  const conversationId = location.pathname.match(
    /^(?:\/g\/[^/]+)?\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i,
  )?.[1];
  if (!conversationId) return null;
  // Cheap precheck: this runs on every page push while unregistered.
  if (!(document.body?.textContent ?? "").includes("T3_ID:")) return null;
  const roleReplies = document.querySelectorAll(
    '[data-message-author-role="assistant"],[data-content-search-unit-key$=":assistant"]',
  );
  // Older layouts: conversation-turn wrappers with an assistant body and no user message.
  const fallbackTurns = roleReplies.length ? [] : [
    ...document.querySelectorAll('[data-testid^="conversation-turn-"]'),
  ].filter((turn) =>
    !turn.querySelector('[data-message-author-role="user"],[data-testid="user-message"],.whitespace-pre-wrap') &&
    !!turn.querySelector('[data-markdown-text-style="assistant-message"],[data-testid="assistant-message"],.markdown,.prose'),
  );
  // Modern ChatGPT can render the actual assistant Markdown in a sibling
  // portal outside its empty :assistant content-search unit. An explicit
  // assistant-message style is positive role evidence independent of that
  // unit; never infer the role from an arbitrary .markdown/.prose element.
  const candidates = new Set<Element>([
    ...roleReplies, ...fallbackTurns,
    ...document.querySelectorAll('[data-markdown-text-style="assistant-message"]'),
  ]);
  const replies = [...candidates].sort((a, b) =>
    a === b ? 0 : (a.compareDocumentPosition(b) & 4) !== 0 ? -1 : 1, // DOCUMENT_POSITION_FOLLOWING
  );
  const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
  const marker = new RegExp(`\\[T3_ID:\\s*(${uuid})\\s*\\]`, "i");
  for (const reply of replies) {
    if (reply.closest('[data-message-author-role="user"],[data-content-search-unit-key$=":user"]') ||
        reply.closest('[data-testid*="tool"],[hidden],[aria-hidden="true"]'))
      continue;
    const copy = reply.cloneNode(true) as Element;
    copy.querySelectorAll(
      'pre,code,blockquote,[hidden],[aria-hidden="true"],[data-testid*="tool"],[data-message-author-role="user"],[data-content-search-unit-key$=":user"],button,[role="button"]',
    ).forEach((node) => node.remove());
    const text = copy.textContent ?? "";
    const matched = text.match(marker);
    if (!matched) continue;
    // A title belongs to this claim only if it immediately follows the marker.
    const afterId = text.slice((matched.index ?? 0) + matched[0].length);
    const proposedTitle = afterId.match(/^\s*\[T3_TITLE:([^\]\r\n]{3,80})\]/)?.[1]
      ?.replace(/\s+/g, " ").trim();
    return {
      conversationId: conversationId.toLowerCase(),
      markerId: matched[1]!.toLowerCase(),
      ...(proposedTitle && proposedTitle.length >= 3 ? { proposedTitle } : {}),
    };
  }
  return null;
}

/** Fallback for markers the DOM never renders, e.g. an intermediate assistant
 * message folded inside a collapsed "Thought for…" section. Reads the
 * conversation through the guest's own logged-in ChatGPT API and returns the
 * earliest assistant message addressed to the user that carries a marker.
 * Returns a string stage ("api_no_token", "api_http_404", "api_no_marker") on
 * failure for diagnostics. Self-contained; executed inside the guest. */
export async function inspectChatGPTBootstrapMarkerViaApi(): Promise<
  ChatGPTBootstrapObservation | string
> {
  const conversationId = location.pathname.match(
    /^(?:\/g\/[^/]+)?\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i,
  )?.[1];
  if (!conversationId) return "api_no_conversation";
  const session = await fetch("/api/auth/session", { credentials: "include" })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  const token = typeof session?.accessToken === "string" ? session.accessToken : null;
  if (!token) return "api_no_token";
  const response = await fetch(`/backend-api/conversation/${conversationId}`, {
    credentials: "include",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return `api_http_${response.status}`;
  const data = await response.json();
  type Node = {
    message?: {
      author?: { role?: string; name?: string };
      metadata?: { tool_name?: string };
      recipient?: string;
      create_time?: number | null;
      content?: { content_type?: string; parts?: unknown[] };
    } | null;
  };
  // Tool results are tied to the guest's conversation even while the
  // assistant is still working. Prefer their exact Bootstrap receipt.
  const toolUuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
  const toolClaim = new RegExp(`T3 session ID:\\s*(${toolUuid})\\s+ID marker:\\s*\\[T3_ID:\\s*\\1\\s*\\]`, "i");
  const toolMessages = Object.values((data?.mapping ?? {}) as Record<string, Node>)
    .map((node) => node.message)
    .filter((message) => message?.author?.role === "tool" ||
      message?.author?.role === "function" || message?.content?.content_type === "tool_result")
    .sort((a, b) => (a!.create_time ?? 0) - (b!.create_time ?? 0));
  for (const message of toolMessages) {
    const name = message?.author?.name ?? message?.metadata?.tool_name;
    if (typeof name === "string" && name &&
        !/(?:^|[_.-])Bootstrap$/i.test(name) && name !== "functions.exec") continue;
    const toolText = (message?.content?.parts ?? [])
      .map((part) => typeof part === "string" ? part :
        part && typeof part === "object" && "text" in part && typeof part.text === "string"
          ? part.text : "")
      .join("\n");
    // Some clients wrap Bootstrap in a functions.exec result. Require the
    // structured receipt's ID, marker and role to agree.
    if (name === "functions.exec" && toolText.trimStart().startsWith("{")) {
      try {
        const data = JSON.parse(toolText) as {
          structuredContent?: { id?: string; marker?: string; role?: string; title?: string };
        };
        const record = data.structuredContent;
        const id = record?.id?.toLowerCase();
        if (id && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) &&
            record?.marker?.toLowerCase() === "[t3_id:" + id + "]" &&
            ["personal", "worker", "manager"].includes(record?.role ?? "")) {
          return {
            conversationId: conversationId.toLowerCase(), markerId: id,
            ...(record?.title ? { proposedTitle: record.title } : {}),
          };
        }
      } catch {
        // A non-JSON tool result can still carry the plain-text receipt.
      }
    }
    if (!/Role:\s*(personal|worker|manager)/i.test(toolText)) continue;
    const claim = toolText.match(toolClaim);
    if (!claim) continue;
    const title = toolText.match(/Proposed title:\s*([^\r\n]{3,80})/i)?.[1]?.trim();
    return {
      conversationId: conversationId.toLowerCase(), markerId: claim[1]!.toLowerCase(),
      ...(title && title !== "(not proposed)" ? { proposedTitle: title } : {}),
    };
  }
  const messages = Object.values((data?.mapping ?? {}) as Record<string, Node>)
    .map((node) => node.message)
    .filter((message) =>
      message?.author?.role === "assistant" &&
      (message.recipient ?? "all") === "all" &&
      message.content?.content_type === "text")
    .sort((a, b) => (a!.create_time ?? 0) - (b!.create_time ?? 0));
  const uuid = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
  const marker = new RegExp(`\\[T3_ID:\\s*(${uuid})\\s*\\]`, "i");
  for (const message of messages) {
    // Same exclusions as the DOM scan: code, inline code and quotes never claim.
    const text = (message!.content!.parts ?? [])
      .filter((part): part is string => typeof part === "string")
      .join("\n")
      .replace(/```[\s\S]*?(?:```|$)/g, "")
      .replace(/`[^`\n]*`/g, "")
      .replace(/^\s*>.*$/gm, "");
    const matched = text.match(marker);
    if (!matched) continue;
    const afterId = text.slice((matched.index ?? 0) + matched[0].length);
    const proposedTitle = afterId.match(/^\s*\[T3_TITLE:([^\]\r\n]{3,80})\]/)?.[1]
      ?.replace(/\s+/g, " ").trim();
    return {
      conversationId: conversationId.toLowerCase(),
      markerId: matched[1]!.toLowerCase(),
      ...(proposedTitle && proposedTitle.length >= 3 ? { proposedTitle } : {}),
    };
  }
  return "api_no_marker";
}

/** Public ID of a session's parent, for prompts shown to agents. */
export function publicChatGPTParentId(
  sessions: readonly IdentifiedSession[],
  session: { readonly parentSessionId?: string | null | undefined },
): string | null | undefined {
  const parent = session.parentSessionId
    ? sessions.find((entry) => entry.id === session.parentSessionId)
    : undefined;
  return parent ? publicChatGPTSessionId(parent) : session.parentSessionId;
}

const ROUTED_ID_FIELDS = ["sessionId", "senderSessionId", "parentSessionId", "successorSessionId"] as const;

/** Desktop pipe inbound: map agent-facing IDs to internal session IDs. */
export function toInternalChatGPTIds<T extends object>(
  request: T,
  sessions: readonly IdentifiedSession[],
): T {
  let result = request;
  for (const field of ROUTED_ID_FIELDS) {
    const value = (request as Record<string, unknown>)[field];
    if (typeof value !== "string") continue;
    const match = findChatGPTSessionByAnyId(sessions, value);
    if (match && match.id !== value) result = { ...result, [field]: match.id };
  }
  return result;
}

/** Desktop pipe outbound: replace internal IDs with public IDs anywhere in a
 * response, so agents only ever see the ID they bootstrapped with. */
export function toPublicChatGPTIds<T>(value: T, sessions: readonly IdentifiedSession[]): T {
  const aliases = new Map<string, string>();
  for (const session of sessions) {
    const publicId = session.bootstrapIdentity?.publicId;
    if (publicId && publicId !== session.id) aliases.set(session.id, publicId);
  }
  if (!aliases.size) return value;
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return aliases.get(item) ?? item;
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object")
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry)]));
    return item;
  };
  return walk(value) as T;
}
