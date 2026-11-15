const STORAGE_KEY = "t3.agent-attention.v1";
export const AGENT_ATTENTION_CHANGE_EVENT = "t3-agent-attention-change";
const DAY = 86_400_000;

export type AgentAttention = {
  id: string;
  sessionId: string;
  message: string;
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
  // Keep receipts for a month, including dismissals, so a resumed agent can reconcile.
  localStorage.setItem(STORAGE_KEY, JSON.stringify(
    items.filter((item) => Date.now() - item.createdAt < 30 * DAY),
  ));
  window.dispatchEvent(new Event(AGENT_ATTENTION_CHANGE_EVENT));
}

export function requestAgentAttention(id: string, sessionId: string, message: string, source: "agent" | "manual" = "agent") {
  const items = loadAgentAttention();
  const previous = items.find((item) => item.id === id);
  if (previous) {
    if (previous.sessionId !== sessionId || previous.message !== message)
      throw new Error("Attention ID already belongs to a different request.");
    return previous;
  }
  const entry: AgentAttention = {
    id, sessionId, message, source, createdAt: Date.now(), status: "waiting", nextAt: 0,
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
