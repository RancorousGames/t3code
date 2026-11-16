import { randomUUID } from "./lib/utils";

const STORAGE_KEY = "t3.agent-attention.v1";
export const AGENT_ATTENTION_CHANGE_EVENT = "t3-agent-attention-change";
const DAY = 86_400_000;

export type AgentAttention = {
  id: string;
  sessionId: string;
  message: string;
  spokenMessage?: string;
  createdAt: number;
  activatedAt?: number;
  status: "waiting" | "pending" | "snoozed" | "opened" | "dismissed";
  source?: "agent" | "manual";
  notifiedAt?: number;
  nextAt: number;
  resolvedAt?: number;
};

export function loadAgentAttention(): AgentAttention[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is AgentAttention =>
      typeof item?.id === "string" && typeof item?.sessionId === "string" &&
      typeof item?.message === "string" && typeof item?.createdAt === "number" &&
      ["waiting", "pending", "snoozed", "opened", "dismissed"].includes(item.status));
  } catch {
    return [];
  }
}

function save(items: AgentAttention[]) {
  // Keep receipts for a month; an armed manual Ctrl+D request must not expire.
  localStorage.setItem(STORAGE_KEY, JSON.stringify(
    items.filter((item) => (item.source === "manual" &&
      (item.status === "waiting" || item.status === "pending" || item.status === "snoozed")) ||
      Date.now() - item.createdAt < 30 * DAY),
  ));
  window.dispatchEvent(new Event(AGENT_ATTENTION_CHANGE_EVENT));
}

export function requestAgentAttention(
  id: string, sessionId: string, message: string,
  source: "agent" | "manual" = "agent", spokenMessage?: string,
) {
  const items = loadAgentAttention();
  const previous = items.find((item) => item.id === id);
  if (previous) {
    if (previous.sessionId !== sessionId || previous.message !== message ||
        previous.spokenMessage !== spokenMessage)
      throw new Error("Attention ID already belongs to a different request.");
    return previous;
  }
  const entry: AgentAttention = {
    id, sessionId, message, source, ...(spokenMessage === undefined ? {} : { spokenMessage }),
    createdAt: Date.now(), status: "waiting", nextAt: 0,
  };
  save([...items, entry]);
  return entry;
}

export function readAgentAttention(id: string) {
  return loadAgentAttention().find((item) => item.id === id) ?? null;
}

export function changeAttention(id: string, status: AgentAttention["status"], nextAt = 0) {
  save(loadAgentAttention().map((entry) => entry.id === id
    ? { ...entry, status, nextAt, ...(status === "opened" || status === "dismissed"
      ? { resolvedAt: Date.now() } : {}) }
    : entry));
}


/** A verified work/error -> idle transition activates the waiting requests for this session. */
export function activateAgentAttention(sessionIds: readonly string[]): string[] {
  const ids = new Set(sessionIds);
  const items = loadAgentAttention();
  const activated = items.filter((item) => ids.has(item.sessionId) && item.status === "waiting")
    .map((item) => item.id);
  if (activated.length === 0) return [];
  const activatedAt = Date.now();
  save(items.map((item) => ids.has(item.sessionId) && item.status === "waiting"
    ? { ...item, status: "pending" as const, activatedAt, nextAt: activatedAt } : item));
  return activated;
}

export function cancelAgentAttention(sessionIds: readonly string[]): void {
  const ids = new Set(sessionIds);
  const items = loadAgentAttention();
  if (!items.some((item) => ids.has(item.sessionId) &&
    (item.status === "waiting" || item.status === "pending" || item.status === "snoozed"))) return;
  save(items.map((item) => ids.has(item.sessionId) &&
    (item.status === "waiting" || item.status === "pending" || item.status === "snoozed")
    ? { ...item, status: "dismissed" as const, nextAt: 0, resolvedAt: Date.now() } : item));
}

/** A notification button/shortcut consumes one request, never its siblings. */
export function openAgentAttentionRequest(
  id: string, sessionIds: readonly string[],
): AgentAttention | undefined {
  const request = readAgentAttention(id);
  if (!request || !sessionIds.includes(request.sessionId) ||
      (request.status !== "pending" && request.status !== "snoozed") ||
      request.nextAt > Date.now()) return undefined;
  changeAttention(id, "opened");
  return request;
}

export function openAgentAttention(sessionIds: readonly string[]): void {
  const ids = new Set(sessionIds);
  const items = loadAgentAttention();
  if (!items.some((item) => ids.has(item.sessionId) &&
    (item.status === "waiting" || item.status === "pending" || item.status === "snoozed"))) return;
  save(items.map((item) => ids.has(item.sessionId) &&
    (item.status === "waiting" || item.status === "pending" || item.status === "snoozed")
    ? { ...item, status: "opened" as const, nextAt: 0, resolvedAt: Date.now() } : item));
}

/** Ctrl+D owns only its manual request. An agent's one-time requests must survive
 * turning the user's persistent attention off. */
export function cancelManualAgentAttention(sessionIds: readonly string[]): void {
  const ids = new Set(sessionIds);
  const items = loadAgentAttention();
  if (!items.some((item) => ids.has(item.sessionId) && item.source === "manual" &&
    (item.status === "waiting" || item.status === "pending" || item.status === "snoozed"))) return;
  save(items.map((item) => ids.has(item.sessionId) && item.source === "manual" &&
    (item.status === "waiting" || item.status === "pending" || item.status === "snoozed")
    ? { ...item, status: "dismissed" as const, nextAt: 0, resolvedAt: Date.now() } : item));
}

/** A user acknowledgement starts a NEW one-shot manual request, preserving
 * the Ctrl+D toggle. A fresh ID is required for phone-notification delivery. */
export function rearmManualAgentAttention(sessionIds: readonly string[], message?: string): void {
  const ids = new Set(sessionIds);
  const items = loadAgentAttention();
  const previous = items.filter((item) => ids.has(item.sessionId) && item.source === "manual").at(-1);
  if (!previous || previous.status === "waiting") return;
  const now = Date.now();
  const nextRequest: AgentAttention = {
    ...previous, ...(message === undefined ? {} : { message }),
    id: randomUUID(), createdAt: now, status: "waiting", nextAt: 0,
  };
  delete nextRequest.activatedAt;
  delete nextRequest.notifiedAt;
  delete nextRequest.resolvedAt;
  // Do not silently consume other outstanding requests for this session.
  // The user removes precisely one entry from the notification stack.
  save([...items, nextRequest]);
}

/** One shared, newest-first notification stack for the toast and Ctrl+S.
 * Resolved, waiting, and not-yet-due snoozed entries do not occupy the stack. */
export function activeAgentAttentionStack(
  items: readonly AgentAttention[],
  availableSessionIds?: ReadonlySet<string>,
  now = Date.now(),
): AgentAttention[] {
  const firedAt = (entry: AgentAttention) => entry.activatedAt ??
    (entry.nextAt > 0 ? entry.nextAt : undefined) ?? entry.notifiedAt ?? entry.createdAt;
  return items
    .filter((entry) =>
      (entry.status === "pending" || entry.status === "snoozed") &&
      entry.nextAt <= now &&
      (availableSessionIds === undefined || availableSessionIds.has(entry.sessionId)))
    .sort((a, b) => firedAt(b) - firedAt(a) || b.createdAt - a.createdAt);
}

/** Ctrl+S must target precisely the same visible entry as the Open session button. */
export function latestAgentAttention(
  availableSessionIds?: ReadonlySet<string>,
): AgentAttention | undefined {
  return activeAgentAttentionStack(loadAgentAttention(), availableSessionIds)[0];
}

/** History fallback for Ctrl+S, after all actionable notifications are handled.
 * Only previously activated and resolved requests count as recent attention.
 * Deduplicate by session: visiting the same session twice is not a useful cycle.
 * Snoozed/waiting requests remain untouched. */
export function recentAgentAttentionSessionIds(
  items: readonly AgentAttention[],
  availableSessionIds: ReadonlySet<string>,
  limit = 10,
): string[] {
  const seen = new Set<string>();
  // Explicit snooze must not be bypassed through an older resolved receipt.
  const snoozed = new Set(items.filter((item) => item.status === "snoozed")
    .map((item) => item.sessionId));
  const result: string[] = [];
  for (const item of [...items]
    .filter((entry) => (entry.status === "opened" || entry.status === "dismissed") &&
      entry.activatedAt !== undefined && availableSessionIds.has(entry.sessionId) &&
      !snoozed.has(entry.sessionId))
    .sort((a, b) => (b.activatedAt ?? 0) - (a.activatedAt ?? 0) ||
      b.createdAt - a.createdAt)) {
    if (seen.has(item.sessionId)) continue;
    seen.add(item.sessionId);
    result.push(item.sessionId);
    if (result.length >= limit) break;
  }
  return result;
}

/** Next historical session after the currently displayed one, wrapping at the end. */
export function nextRecentAgentAttentionSessionId(
  items: readonly AgentAttention[],
  availableSessionIds: ReadonlySet<string>,
  selectedSessionIds: readonly string[],
): string | undefined {
  const recent = recentAgentAttentionSessionIds(items, availableSessionIds);
  const currentIndex = recent.findIndex((id) => selectedSessionIds.includes(id));
  return recent[(currentIndex + 1) % recent.length];
}

export function markAgentAttentionNotified(id: string): void {
  const items = loadAgentAttention();
  if (!items.some((item) => item.id === id && !item.notifiedAt)) return;
  save(items.map((item) => item.id === id ? { ...item, notifiedAt: Date.now() } : item));
}
