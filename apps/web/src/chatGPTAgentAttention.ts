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
export function activateAgentAttention(
  sessionIds: readonly string[],
  source?: "manual" | "agent",
): string[] {
  const ids = new Set(sessionIds);
  const items = loadAgentAttention();
  const eligible = (item: AgentAttention) => ids.has(item.sessionId) &&
    item.status === "waiting" && (source === undefined || (
      source === "manual" ? item.source === "manual" : item.source !== "manual"));
  const activated = items.filter(eligible).map((item) => item.id);
  if (activated.length === 0) return [];
  const activatedAt = Date.now();
  save(items.map((item) => eligible(item)
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

/** Temporarily hide a persistent Ctrl+D notification while its session is snoozed.
 * Waiting requests remain waiting and will be activated when the session wakes. */
export function snoozePersistentManualAttention(
  sessionIds: readonly string[],
  until: number,
): void {
  const ids = new Set(sessionIds);
  const items = loadAgentAttention();
  if (!items.some((item) => ids.has(item.sessionId) && item.source === "manual" &&
    (item.status === "pending" || item.status === "snoozed") &&
    (item.status !== "snoozed" || item.nextAt !== until))) return;
  save(items.map((item) => ids.has(item.sessionId) && item.source === "manual" &&
    (item.status === "pending" || item.status === "snoozed")
    ? { ...item, status: "snoozed" as const, nextAt: until } : item));
}

/** A wake into active work is not a completed answer. Hold its Ctrl+D notice
 * for the existing working -> idle completion path. */
export function deferPersistentManualAttention(sessionIds: readonly string[]): void {
  const ids = new Set(sessionIds);
  const items = loadAgentAttention();
  if (!items.some((item) => ids.has(item.sessionId) && item.source === "manual" &&
    (item.status === "pending" || item.status === "snoozed"))) return;
  save(items.map((item) => {
    if (!ids.has(item.sessionId) || item.source !== "manual" ||
        (item.status !== "pending" && item.status !== "snoozed")) return item;
    const held: AgentAttention = { ...item, status: "waiting", nextAt: 0 };
    delete held.notifiedAt;
    delete held.activatedAt;
    return held;
  }));
}

/** Session-snooze wake is a fresh attention event, even without new agent work.
 * Reuse the unresolved Ctrl+D request so the stack contains no duplicate item,
 * and reset its delivery/sound stamp so it announces again. */
export function reactivatePersistentManualAttention(
  sessionIds: readonly string[],
  title: string,
): void {
  const ids = new Set(sessionIds);
  const items = loadAgentAttention();
  const previous = [...items].reverse().find((item) =>
    ids.has(item.sessionId) && item.source === "manual" &&
    (item.status === "waiting" || item.status === "pending" || item.status === "snoozed"));
  const now = Date.now();
  if (previous) {
    save(items.map((item) => {
      if (item.id !== previous.id) return item;
      const ready: AgentAttention = {
        ...item, message: title, status: "pending", activatedAt: now, nextAt: now,
      };
      delete ready.notifiedAt;
      delete ready.resolvedAt;
      return ready;
    }));
  } else {
    save([...items, {
      id: randomUUID(), sessionId: sessionIds[0] ?? "", message: title,
      source: "manual", createdAt: now, activatedAt: now,
      status: "pending", nextAt: now,
    }]);
  }
}

/** Snooze the full queue of currently actionable alerts in one durable update.
 * Requests which have not fired yet, or are already snoozed until later, are
 * never included; only the queue the user can see is affected. */
export function snoozeActionableAttentionQueue(
  until: number,
  availableSessionIds?: ReadonlySet<string>,
  now = Date.now(),
): AgentAttention[] {
  if (!Number.isFinite(until) || until <= now) return [];
  const items = loadAgentAttention();
  const targeted = activeAgentAttentionStack(items, availableSessionIds, now);
  if (!targeted.length) return [];
  const ids = new Set(targeted.map((item) => item.id));
  save(items.map((item) => ids.has(item.id)
    ? { ...item, status: "snoozed" as const, nextAt: until } : item));
  return targeted;
}

/** Resolve only successfully dismissed entries, atomically. A failed agent
 * handoff retains its pending alert instead of silently losing the request. */
export function resolveAttentionQueueEntries(ids: readonly string[]): AgentAttention[] {
  const targets = new Set(ids);
  const items = loadAgentAttention();
  const changed = items.filter((item) => targets.has(item.id) &&
    (item.status === "pending" || item.status === "snoozed"));
  if (!changed.length) return [];
  const now = Date.now();
  save(items.map((item) => targets.has(item.id) &&
    (item.status === "pending" || item.status === "snoozed")
    ? { ...item, status: "dismissed" as const, nextAt: 0, resolvedAt: now } : item));
  return changed;
}

/** A temporarily snoozed manual notification suppresses the yellow marker
 * until the snooze expires; the persistent Ctrl+D flag itself stays enabled. */
export function isManualAttentionTemporarilySnoozed(
  sessionIds: readonly string[],
  items: readonly AgentAttention[],
  now = Date.now(),
): boolean {
  const ids = new Set(sessionIds);
  return items.some((item) => ids.has(item.sessionId) &&
    item.source === "manual" && item.status === "snoozed" && item.nextAt > now);
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

/** The same persistent "ready" marker that draws the yellow sidebar outline
 * must count as active attention even if its one-shot notification is absent
 * or already opened. Do not fall through to historical receipts while yellow
 * sessions remain. Non-verification sessions always take precedence. */
export function priorityChatGPTAttentionTarget(
  sessions: readonly {
    id: string;
    bootstrapIdentity?: { readonly publicId?: string | undefined } | undefined;
    verificationPending?: boolean | undefined;
    returnMarker?: "armed" | "working" | "ready" | undefined;
    hidden?: boolean | undefined;
    snoozedUntil?: number | undefined;
    working?: boolean | undefined;
    lastActiveAt?: number | null | undefined;
  }[],
  items: readonly AgentAttention[],
  now = Date.now(),
): { sessionId: string; reason: "ready" | "request"; requestId?: string } | undefined {
  const eligibleSessions = sessions.filter((session) =>
    (session.snoozedUntil ?? 0) <= now);
  const ids = new Set(eligibleSessions.flatMap((session) => [
    session.id,
    ...(session.bootstrapIdentity?.publicId ? [session.bootstrapIdentity.publicId] : []),
  ]));
  const pending = activeAgentAttentionStack(items, ids, now);
  const requestsFor = (session: (typeof sessions)[number]) => pending.filter((item) =>
    item.sessionId === session.id || item.sessionId === session.bootstrapIdentity?.publicId);
  for (const verification of [false, true]) {
    const group = eligibleSessions.filter((session) =>
      Boolean(session.verificationPending) === verification);
    const ready = group.filter((session) =>
      session.returnMarker === "ready" && !session.hidden &&
      !session.working &&
      !isManualAttentionTemporarilySnoozed([
        session.id,
        ...(session.bootstrapIdentity?.publicId ? [session.bootstrapIdentity.publicId] : []),
      ], items, now))
      .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
    if (ready.length) {
      const session = ready[0]!;
      // Prefer the session's own persistent request so Ctrl+S clears exactly
      // one stack entry rather than accidentally clearing unrelated requests.
      const request = requestsFor(session).find((item) => item.source === "manual") ??
        requestsFor(session)[0];
      return {
        sessionId: session.id, reason: "ready",
        ...(request ? { requestId: request.id } : {}),
      };
    }
    const allowedIds = new Set(group.flatMap((session) => [
      session.id,
      ...(session.bootstrapIdentity?.publicId ? [session.bootstrapIdentity.publicId] : []),
    ]));
    const request = pending.find((item) => allowedIds.has(item.sessionId));
    if (request) return { sessionId: request.sessionId, requestId: request.id, reason: "request" };
  }
  return undefined;
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

/** Browse resolved attention: non-verification sessions before verification,
 * with idle ahead of working inside each group. Continue through the entire
 * cycle rather than restarting at the beginning every time. */
export function nextRecentAgentAttentionSessionId(
  items: readonly AgentAttention[],
  availableSessionIds: ReadonlySet<string>,
  selectedSessionIds: readonly string[],
  workingSessionIds: ReadonlySet<string> = new Set(),
  previousTargetId?: string,
  verificationSessionIds: ReadonlySet<string> = new Set(),
): string | undefined {
  const recent = recentAgentAttentionSessionIds(items, availableSessionIds);
  if (!recent.length) return undefined;
  const ordered = [
    ...recent.filter((id) => !verificationSessionIds.has(id) && !workingSessionIds.has(id)),
    ...recent.filter((id) => !verificationSessionIds.has(id) && workingSessionIds.has(id)),
    ...recent.filter((id) => verificationSessionIds.has(id) && !workingSessionIds.has(id)),
    ...recent.filter((id) => verificationSessionIds.has(id) && workingSessionIds.has(id)),
  ];
  // A manual session switch resets the tour, while another Ctrl+S continues
  // from its previous target across both priority groups.
  const continuing = previousTargetId !== undefined &&
    selectedSessionIds.includes(previousTargetId);
  const selectedIndex = continuing
    ? ordered.indexOf(previousTargetId)
    : ordered.findIndex((id) =>
        !verificationSessionIds.has(id) && !workingSessionIds.has(id) &&
        selectedSessionIds.includes(id));
  return ordered[(selectedIndex + 1) % ordered.length];
}

export function markAgentAttentionNotified(id: string): void {
  const items = loadAgentAttention();
  if (!items.some((item) => item.id === id && !item.notifiedAt)) return;
  save(items.map((item) => item.id === id ? { ...item, notifiedAt: Date.now() } : item));
}
