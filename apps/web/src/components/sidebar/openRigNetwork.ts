import type {
  DesktopOpenRigAgent,
  DesktopOpenRigManagedSession,
  DesktopOpenRigSeatSessions,
  DesktopOpenRigSeatTopology,
} from "@t3tools/contracts";

import { isCostlyModel, selectionEffort } from "./openRigCostPolicy";
import { historyHref, sessionDisplayTitle, sessionProviderLabel } from "./openRigAgentPresentation";

/**
 * Agent network model. Four relations are kept separate and never derived
 * from one another:
 *  1. seat hierarchy     — RigSpec delegates_to / spawned_by edges (topology)
 *  2. session ownership  — OpenRig's managed-session ledger per seat
 *  3. spawn lineage      — parentSeatId / parentManagedSessionId on a managed
 *                          session, and T3's own parentThreadId lineage
 *  4. communication      — not exposed by any read endpoint yet; never drawn
 * A T3 thread no loaded ledger owns is "unattributed", even if its T3 parent
 * thread belongs to a seat.
 */

/** Structural subset of a T3 thread shell; EnvironmentThreadShell satisfies it. */
export interface NetworkThreadInput {
  environmentId: string;
  id: string;
  projectId: string;
  title: string;
  providerInstanceId: string;
  modelSelection: { model: string; options?: unknown };
  runtime: { status: string } | null;
  lineage: { parentThreadId: string | null; relationshipToParent: "fork" | "subagent" | null };
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export type LedgerResult = { ok: true; ledger: DesktopOpenRigSeatSessions } | { ok: false; error: string };

export interface NetworkSession {
  key: string;
  ownership: "openrig-managed" | "unattributed";
  seatId: string | null;
  managedSessionId: string | null;
  title: string;
  provider: string;
  model: string | null;
  effort: string | null;
  modelSource: "T3 thread" | "OpenRig launch intent" | "not recorded";
  status: string;
  active: boolean;
  primary: boolean;
  spawnedFrom: { seatId: string; managedSessionId: string | null } | null;
  t3Parent: { threadId: string; relationship: "fork" | "subagent" | null; ownerSeatId: string | null } | null;
  href: string | null;
  environmentId: string | null;
  threadId: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  archived: boolean;
}

export interface NetworkSeat {
  id: string;
  name: string;
  role: string | null;
  rigId: string | null;
  rigName: string | null;
  /** OpenRig's reported status; null when the seat is absent from the agent list. */
  status: string | null;
  task: string | null;
  parentIds: readonly string[];
  childIds: readonly string[];
  inTopology: boolean;
  ledger: "loaded" | "failed" | "not-loaded";
  ledgerError: string | null;
  sessions: NetworkSession[];
}

export interface ModelUsage {
  model: string;
  total: number;
  active: number;
  managed: number;
  unattributed: number;
  costly: boolean;
}

export interface NetworkEvent {
  key: string;
  at: string;
  seatId: string | null;
  title: string;
  detail: string | null;
}

export interface AgentNetwork {
  seats: ReadonlyMap<string, NetworkSeat>;
  topologyAvailable: boolean;
  /** Seats whose ledger failed or was not read; their threads may wrongly look unattributed. */
  unreadLedgers: number;
  unattributed: NetworkSession[];
  modelUsage: ModelUsage[];
  events: NetworkEvent[];
}

const ACTIVE_RUNTIME = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const threadKey = (environmentId: string, threadId: string) => `${environmentId}\u0000${threadId}`;

function stringAt(value: unknown, ...path: string[]): string | null {
  let current = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null || !(segment in current)) return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" && current ? current : null;
}

function managedSession(
  seatId: string,
  session: DesktopOpenRigManagedSession,
  isPrimary: boolean,
  thread: NetworkThreadInput | undefined,
  owners: ReadonlyMap<string, string>,
): NetworkSession {
  const intentModel = stringAt(session.intent, "modelSelection", "model");
  const model = thread?.modelSelection.model ?? intentModel;
  const parentThreadId = thread?.lineage.parentThreadId ?? null;
  return {
    key: `managed:${seatId}:${session.id}`,
    ownership: "openrig-managed",
    seatId,
    managedSessionId: session.id,
    title: sessionDisplayTitle(session),
    provider: thread?.providerInstanceId ?? sessionProviderLabel(session),
    model,
    effort: thread ? selectionEffort(thread.modelSelection.options) : null,
    modelSource: thread ? "T3 thread" : intentModel ? "OpenRig launch intent" : "not recorded",
    status: session.status,
    active: session.status === "active" || session.status === "pending",
    primary: isPrimary,
    spawnedFrom: session.parentSeatId
      ? { seatId: session.parentSeatId, managedSessionId: session.parentManagedSessionId }
      : null,
    t3Parent: thread && parentThreadId
      ? { threadId: parentThreadId, relationship: thread.lineage.relationshipToParent,
          ownerSeatId: owners.get(threadKey(thread.environmentId, parentThreadId)) ?? null }
      : null,
    href: historyHref(session.target),
    environmentId: session.target?.kind === "t3-thread" ? session.target.environmentId : null,
    threadId: session.target?.kind === "t3-thread" ? session.target.threadId : null,
    projectId: session.projectId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastActivityAt: session.lastActivityAt ?? null,
    archived: Boolean(thread?.archivedAt),
  };
}

function unattributedSession(thread: NetworkThreadInput, owners: ReadonlyMap<string, string>): NetworkSession {
  const parentThreadId = thread.lineage.parentThreadId;
  const status = thread.runtime?.status ?? "idle";
  return {
    key: `thread:${thread.environmentId}:${thread.id}`,
    ownership: "unattributed",
    seatId: null,
    managedSessionId: null,
    title: thread.title || thread.id,
    provider: thread.providerInstanceId,
    model: thread.modelSelection.model,
    effort: selectionEffort(thread.modelSelection.options),
    modelSource: "T3 thread",
    status,
    active: !thread.archivedAt && ACTIVE_RUNTIME.has(status),
    primary: false,
    spawnedFrom: null,
    t3Parent: parentThreadId
      ? { threadId: parentThreadId, relationship: thread.lineage.relationshipToParent,
          ownerSeatId: owners.get(threadKey(thread.environmentId, parentThreadId)) ?? null }
      : null,
    href: `/${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.id)}`,
    environmentId: thread.environmentId,
    threadId: thread.id,
    projectId: thread.projectId,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    lastActivityAt: null,
    archived: Boolean(thread.archivedAt),
  };
}

export function buildAgentNetwork(input: {
  agents: readonly DesktopOpenRigAgent[];
  topology: DesktopOpenRigSeatTopology | null;
  ledgers: ReadonlyMap<string, LedgerResult>;
  threads: readonly NetworkThreadInput[];
  costlyPatterns: readonly string[];
}): AgentNetwork {
  const threads = new Map<string, NetworkThreadInput>();
  for (const thread of input.threads)
    // ChatGPT browser sessions are scoped as pseudo-threads; they are not native T3 threads.
    if (!thread.id.startsWith("t3-browser-session:")) threads.set(threadKey(thread.environmentId, thread.id), thread);

  // Which native thread each loaded ledger owns. Detached sessions no longer own.
  const owners = new Map<string, string>();
  for (const [seatId, result] of input.ledgers) {
    if (!result.ok) continue;
    for (const session of result.ledger.sessions)
      if (session.status !== "detached" && session.target?.kind === "t3-thread")
        owners.set(threadKey(session.target.environmentId, session.target.threadId), seatId);
  }

  const agentById = new Map(input.agents.map((agent) => [agent.id, agent]));
  const seats = new Map<string, NetworkSeat>();
  const ids = new Set([...(input.topology?.seats.map((seat) => seat.id) ?? []), ...agentById.keys()]);
  const topologyById = new Map(input.topology?.seats.map((seat) => [seat.id, seat]) ?? []);
  for (const id of ids) {
    const node = topologyById.get(id);
    const agent = agentById.get(id);
    const result = input.ledgers.get(id);
    const sessions = result?.ok
      ? result.ledger.sessions.map((session) => managedSession(
          id, session, result.ledger.primarySessionId === session.id,
          session.target?.kind === "t3-thread"
            ? threads.get(threadKey(session.target.environmentId, session.target.threadId))
            : undefined,
          owners,
        ))
      : [];
    seats.set(id, {
      id,
      name: agent?.name ?? node?.name ?? id,
      role: agent?.role ?? node?.role ?? null,
      rigId: node?.rigId ?? null,
      rigName: node?.rigName || null,
      status: agent?.status ?? null,
      task: agent?.task ?? null,
      // Edges to seats outside the snapshot are dropped, never re-parented.
      parentIds: (node?.parentIds ?? []).filter((parent) => ids.has(parent) && parent !== id),
      childIds: (node?.childIds ?? []).filter((child) => ids.has(child) && child !== id),
      inTopology: Boolean(node),
      ledger: !result ? "not-loaded" : result.ok ? "loaded" : "failed",
      ledgerError: result && !result.ok ? result.error : null,
      sessions: sessions.sort((a, b) => Number(b.primary) - Number(a.primary) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    });
  }

  const unattributed = [...threads.entries()]
    .filter(([key]) => !owners.has(key))
    .map(([, thread]) => unattributedSession(thread, owners))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  const usage = new Map<string, ModelUsage>();
  const count = (session: NetworkSession) => {
    const model = session.model ?? "model not recorded";
    const entry = usage.get(model) ?? {
      model, total: 0, active: 0, managed: 0, unattributed: 0,
      costly: isCostlyModel(session.model, input.costlyPatterns),
    };
    entry.total += 1;
    if (session.active) entry.active += 1;
    if (session.ownership === "openrig-managed") entry.managed += 1;
    else entry.unattributed += 1;
    usage.set(model, entry);
  };
  for (const seat of seats.values()) seat.sessions.forEach(count);
  unattributed.forEach(count);

  const events: NetworkEvent[] = [];
  for (const seat of seats.values())
    for (const session of seat.sessions) {
      events.push({
        key: `${session.key}:created`, at: session.createdAt, seatId: seat.id,
        title: `${seat.name}: session created · ${session.title}`,
        detail: [session.provider, session.model,
          session.spawnedFrom ? `spawned from seat ${session.spawnedFrom.seatId}` : null].filter(Boolean).join(" · ") || null,
      });
      if (session.updatedAt !== session.createdAt)
        events.push({
          key: `${session.key}:updated`, at: session.updatedAt, seatId: seat.id,
          title: `${seat.name}: ledger ${session.status} · ${session.title}`, detail: null,
        });
    }
  events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return {
    seats,
    topologyAvailable: input.topology !== null,
    unreadLedgers: [...seats.values()].filter((seat) => seat.ledger !== "loaded").length,
    unattributed,
    modelUsage: [...usage.values()].sort((a, b) => Number(b.costly) - Number(a.costly) || b.total - a.total),
    events: events.slice(0, 100),
  };
}

export interface NetworkFilter {
  query: string;
  activeOnly: boolean;
  costlyOnly: boolean;
  rigId: string;
  model: string;
  costlyPatterns: readonly string[];
}

export function sessionMatches(session: NetworkSession, filter: NetworkFilter): boolean {
  if (filter.activeOnly && !session.active) return false;
  if (filter.costlyOnly && !isCostlyModel(session.model, filter.costlyPatterns)) return false;
  if (filter.model && (session.model ?? "model not recorded") !== filter.model) return false;
  const query = filter.query.trim().toLowerCase();
  return !query || [session.title, session.provider, session.model, session.projectId, session.threadId, session.status]
    .some((value) => value?.toLowerCase().includes(query));
}

function seatMatchesText(seat: NetworkSeat, query: string) {
  const value = query.trim().toLowerCase();
  return !value || [seat.name, seat.id, seat.role, seat.task, seat.status].some((entry) => entry?.toLowerCase().includes(value));
}

export type TreeRow =
  | { kind: "seat"; key: string; seat: NetworkSeat; depth: number; expandable: boolean; expanded: boolean; alsoUnder: string[]; sessionCount: number }
  | { kind: "session"; key: string; session: NetworkSession; depth: number };

/**
 * Visible rows of the seat tree. A seat with several RigSpec parents renders
 * once, under its first parent by name, and lists the others; cycles stop at
 * the first repeat. While a filter is active every matching path is expanded.
 */
export function flattenAgentTree(network: AgentNetwork, expanded: ReadonlySet<string>, filter: NetworkFilter): TreeRow[] {
  const seats = network.seats;
  const byName = (a: string, b: string) => (seats.get(a)?.name ?? a).localeCompare(seats.get(b)?.name ?? b);
  const placement = new Map<string, string | null>();
  for (const seat of seats.values()) placement.set(seat.id, [...seat.parentIds].sort(byName)[0] ?? null);
  const children = new Map<string | null, string[]>();
  for (const [id, parent] of placement) children.set(parent, [...(children.get(parent) ?? []), id]);
  for (const list of children.values()) list.sort(byName);
  // Seats reachable only through a parent cycle still need a root.
  const reachable = new Set<string>();
  const walk = (id: string) => { if (reachable.has(id)) return; reachable.add(id); (children.get(id) ?? []).forEach(walk); };
  (children.get(null) ?? []).forEach(walk);
  const roots = [...(children.get(null) ?? []), ...[...seats.keys()].filter((id) => !reachable.has(id)).sort(byName)];

  const filtering = Boolean(filter.query.trim() || filter.activeOnly || filter.costlyOnly || filter.model || filter.rigId);
  const sessionFilterActive = Boolean(filter.query.trim() || filter.activeOnly || filter.costlyOnly || filter.model);
  const visibleCache = new Map<string, boolean>();
  const visible = (id: string, trail: Set<string>): boolean => {
    const cached = visibleCache.get(id);
    if (cached !== undefined) return cached;
    if (trail.has(id)) return false;
    const seat = seats.get(id)!;
    const rigOk = !filter.rigId || seat.rigId === filter.rigId;
    const own = rigOk && (sessionFilterActive
      ? seat.sessions.some((session) => sessionMatches(session, filter)) ||
        (!filter.activeOnly && !filter.costlyOnly && !filter.model && seatMatchesText(seat, filter.query))
      : true);
    const next = new Set(trail).add(id);
    const result = own || (children.get(id) ?? []).some((child) => visible(child, next));
    visibleCache.set(id, result);
    return result;
  };

  const rows: TreeRow[] = [];
  const emitted = new Set<string>();
  const emit = (id: string, depth: number) => {
    if (emitted.has(id) || (filtering && !visible(id, new Set()))) return;
    emitted.add(id);
    const seat = seats.get(id)!;
    const sessions = seat.sessions.filter((session) => sessionMatches(session, { ...filter, query: seatMatchesText(seat, filter.query) ? "" : filter.query }));
    const kids = (children.get(id) ?? []).filter((child) => !emitted.has(child));
    const open = filtering || expanded.has(id);
    rows.push({
      kind: "seat", key: `seat:${id}`, seat, depth,
      expandable: sessions.length > 0 || kids.length > 0, expanded: open,
      alsoUnder: [...seat.parentIds].sort(byName).slice(1), sessionCount: sessions.length,
    });
    if (!open) return;
    for (const session of sessions) rows.push({ kind: "session", key: session.key, session, depth: depth + 1 });
    for (const child of kids) emit(child, depth + 1);
  };
  for (const root of roots) emit(root, 0);
  return rows;
}
