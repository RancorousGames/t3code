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


/** One observed working -> idle transition activates all waiting requests for this session. */
export function activateAgentAttention(sessionIds: readonly string[]): void {
  const ids = new Set(sessionIds);
  const items = loadAgentAttention();
  if (!items.some((item) => ids.has(item.sessionId) && item.status === "waiting")) return;
  const activatedAt = Date.now();
  save(items.map((item) => ids.has(item.sessionId) && item.status === "waiting"
    ? { ...item, status: "pending" as const, activatedAt, nextAt: activatedAt } : item));
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
export function rearmManualAgentAttention(sessionIds: readonly string[]): void {
  const ids = new Set(sessionIds);
  const items = loadAgentAttention();
  const previous = items.filter((item) => ids.has(item.sessionId) && item.source === "manual").at(-1);
  if (!previous || previous.status === "waiting") return;
  const now = Date.now();
  const nextRequest: AgentAttention = {
    ...previous, id: randomUUID(), createdAt: now, status: "waiting", nextAt: 0,
  };
  delete nextRequest.activatedAt;
  delete nextRequest.notifiedAt;
  delete nextRequest.resolvedAt;
  save([...items.map((item) => ids.has(item.sessionId) && item.source === "manual" &&
    (item.status === "pending" || item.status === "snoozed")
    ? { ...item, status: "opened" as const, nextAt: 0, resolvedAt: now } : item), nextRequest]);
}

export function latestAgentAttention(): AgentAttention | undefined {
  const firedAt = (entry: AgentAttention) => entry.activatedAt ??
    (entry.status === "pending" && entry.nextAt > 0 ? entry.nextAt : undefined) ??
    entry.notifiedAt ?? entry.createdAt;
  return loadAgentAttention()
    .filter((entry) => entry.status !== "waiting")
    .sort((a, b) => firedAt(b) - firedAt(a) || b.createdAt - a.createdAt)[0];
}

export function markAgentAttentionNotified(id: string): void {
  const items = loadAgentAttention();
  if (!items.some((item) => item.id === id && !item.notifiedAt)) return;
  save(items.map((item) => item.id === id ? { ...item, notifiedAt: Date.now() } : item));
}
