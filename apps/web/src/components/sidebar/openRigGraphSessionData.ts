import type { BrowserSession } from "../../chatGPTBrowserSessions";
import { linkedChatGPTWorkerIds } from "../../chatGPTWorkerVisibility";
import type { AgentNetwork, LedgerResult } from "./openRigNetwork";

/** Only an OpenRig ledger's explicit browser binding AND an existing T3 slot can open a graph seat. */
export function exactGraphSeatBrowserSessions(
  network: AgentNetwork,
  ledgers: ReadonlyMap<string, LedgerResult>,
  browserSessions: readonly BrowserSession[],
): ReadonlyMap<string, readonly string[]> {
  const existing = new Set(browserSessions.map((session) => session.id));
  const result = new Map<string, readonly string[]>();
  for (const seatId of network.seats.keys()) {
    const ledgerResult = ledgers.get(seatId);
    if (!ledgerResult?.ok) continue;
    const seen = new Set<string>();
    const sessions = [...ledgerResult.ledger.sessions].sort(
      (a, b) =>
        Number(b.id === ledgerResult.ledger.primarySessionId) -
        Number(a.id === ledgerResult.ledger.primarySessionId),
    );
    for (const entry of sessions) {
      const candidates = [
        entry.attachedTabUuid,
        entry.target?.kind === "chatgpt-conversation"
          ? entry.target.preferredBrowserSessionId
          : entry.target?.kind === "legacy-browser"
            ? entry.target.sessionId
            : null,
      ];
      // One managed session has one slot: prefer its attached tab, then the
      // explicitly preferred slot. Never combine conflicting stale bindings.
      const candidate = candidates.find((id) => id && existing.has(id));
      if (candidate) seen.add(candidate);
    }
    if (seen.size) result.set(seatId, [...seen]);
  }
  return result;
}

export interface GraphWorkerSession {
  id: string;
  parentId: string;
  title: string;
  status: string;
  working: boolean;
}

/**
 * Display only backend-proven T3 worker descendants of the selected manager.
 * Parent IDs come from T3's real session lineage, not labels or OpenRig guesses.
 * Never hide them based on the sidepanel's Hide Workers preference.
 */
export function graphWorkerDescendants(
  network: AgentNetwork,
  selectedSeatId: string | null,
  seatBrowserIds: ReadonlyMap<string, readonly string[]>,
  sessions: readonly BrowserSession[],
  now = Date.now(),
): GraphWorkerSession[] {
  if (!selectedSeatId) return [];
  const seat = network.seats.get(selectedSeatId);
  if (!seat || !seat.inTopology ||
    !(seat.role === "manager" || seat.role?.endsWith("-manager") || seat.childIds.length > 0))
    return [];
  const roots = seatBrowserIds.get(selectedSeatId);
  if (!roots?.length) return [];

  const knownManagers = new Set(
    [...seatBrowserIds].flatMap(([id, ids]) => {
      const node = network.seats.get(id);
      return node && (node.role === "manager" || node.role?.endsWith("-manager") || node.childIds.length > 0)
        ? ids : [];
    }),
  );
  const verifiedWorkers = linkedChatGPTWorkerIds(sessions, knownManagers);
  const childrenByParent = new Map<string, BrowserSession[]>();
  for (const child of sessions) {
    if (!child.parentSessionId || !verifiedWorkers.has(child.id)) continue;
    const list = childrenByParent.get(child.parentSessionId) ?? [];
    list.push(child);
    childrenByParent.set(child.parentSessionId, list);
  }

  const visited = new Set(roots);
  const queue = [...roots];
  const result: GraphWorkerSession[] = [];
  while (queue.length) {
    const parentId = queue.shift()!;
    for (const child of childrenByParent.get(parentId) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      queue.push(child.id);
      const archived = child.archive && !child.archive.restoredAt;
      result.push({
        id: child.id,
        parentId: selectedSeatId,
        title: child.title,
        // Session index does not report generation state. Do not invent "idle" or "working".
        status: archived ? "archived" : child.hidden ? "hidden" :
          (child.snoozedUntil ?? 0) > now ? "snoozed" : "state unknown",
        working: false,
      });
    }
  }
  return result;
}
