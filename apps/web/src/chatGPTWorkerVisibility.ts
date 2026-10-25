import type { BrowserSession } from "./chatGPTBrowserSessions";
import type { ChatGPTSidebarGroup } from "./chatGPTSessionGrouping";
import { chatGPTParentIndex } from "./chatGPTSessionLineage";

export const chatGPTWorkerVisibilityStorageKey = (environmentId: string | null) =>
  `t3code:chatgpt-browser:show-manager-workers:${environmentId ?? "unconnected"}`;

/** A sidebar-only view filter: every session with a parent is a child, regardless of spawn source or role. */
export function childChatGPTSessionIds(sessions: readonly BrowserSession[]): ReadonlySet<string> {
  return new Set(sessions.filter((session) => !!session.parentSessionId).map((session) => session.id));
}

export const chatGPTVerifiedWorkerEvidenceKey = (environmentId: string | null) =>
  `t3code:chatgpt-browser:verified-worker-identity:v1:${environmentId ?? "unconnected"}`;

export interface VerifiedChatGPTWorkerIdentity {
  sessionId: string;
  parentSessionId: string;
  spawnRequestId: string;
}

/**
 * A worker must have BOTH a valid explicit parentSessionId and a durable
 * backend spawn reservation. Manually created/drag-linked chats and orphaned
 * parent links are not evidence of a managed worker. A manager seat can itself
 * be spawned below another manager, so verified RigSpec manager tabs are exempt.
 *
 * If manager ledgers are unavailable, fail open instead of hiding managers.
 * Titles and project labels are never role evidence.
 */
export function linkedChatGPTWorkerIds(
  sessions: readonly BrowserSession[],
  verifiedManagerSessionIds: ReadonlySet<string> | null = new Set(),
): ReadonlySet<string> {
  // The manager-seat ledger is unavailable: a linked child may itself be an
  // active manager, so unknown role classifications must stay visible.
  if (verifiedManagerSessionIds === null) return new Set();
  const parentById = chatGPTParentIndex(sessions);
  return new Set(
    sessions.flatMap((session) =>
      parentById.get(session.id) &&
      session.spawnRequestId?.trim() &&
      !verifiedManagerSessionIds.has(session.id)
        ? [session.id]
        : [],
    ),
  );
}

/** Remember only worker identities actually classified while complete manager-seat evidence was online. */
export function captureVerifiedChatGPTWorkerIdentities(
  sessions: readonly BrowserSession[],
  verifiedManagerSessionIds: ReadonlySet<string>,
): VerifiedChatGPTWorkerIdentity[] {
  const workers = linkedChatGPTWorkerIds(sessions, verifiedManagerSessionIds);
  return sessions
    .flatMap((session) =>
      workers.has(session.id) && session.parentSessionId && session.spawnRequestId
        ? [
            {
              sessionId: session.id,
              parentSessionId: session.parentSessionId,
              spawnRequestId: session.spawnRequestId,
            },
          ]
        : [],
    )
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

/** During a transient seat-ledger outage, show/hide only previously VERIFIED worker identities.
 * A changed/missing/cyclic parent link or spawn reservation invalidates the snapshot.
 * New children stay visible until fresh manager evidence can exclude manager seats.
 */
export function restoreVerifiedChatGPTWorkerIds(
  sessions: readonly BrowserSession[],
  snapshot: readonly VerifiedChatGPTWorkerIdentity[],
): ReadonlySet<string> {
  const parents = chatGPTParentIndex(sessions);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return new Set(
    snapshot.flatMap((record) => {
      const current = byId.get(record.sessionId);
      return current?.spawnRequestId === record.spawnRequestId &&
        current.parentSessionId === record.parentSessionId &&
        parents.get(current.id) === record.parentSessionId
        ? [record.sessionId]
        : [];
    }),
  );
}

/**
 * Filter sidebar rows after grouping/sorting so their project assignments and
 * order do not jump when workers are toggled off. Runtime and recovery should
 * always consume the unfiltered non-hidden session list instead.
 */
export function filterChatGPTWorkerGroups(
  groups: readonly ChatGPTSidebarGroup[],
  workerIds: ReadonlySet<string>,
  showWorkers: boolean,
  persistentGroupKeys: ReadonlySet<string>,
): ChatGPTSidebarGroup[] {
  if (showWorkers) return [...groups];

  return groups.flatMap((group) => {
    const rows = group.rows.filter(({ session }) => !workerIds.has(session.id));
    if (!rows.length && (!group.key || !persistentGroupKeys.has(group.key))) return [];

    const ids = new Set(rows.map(({ session }) => session.id));
    const childCounts = new Map<string, number>();
    for (const { session } of rows) {
      const parentId = session.parentSessionId;
      if (parentId && ids.has(parentId))
        childCounts.set(parentId, (childCounts.get(parentId) ?? 0) + 1);
    }

    return [
      {
        ...group,
        rows: rows.map((row) => ({
          ...row,
          depth:
            row.session.parentSessionId && ids.has(row.session.parentSessionId) ? row.depth : 0,
          childCount: childCounts.get(row.session.id) ?? 0,
        })),
      },
    ];
  });
}
