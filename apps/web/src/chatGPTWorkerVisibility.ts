import type { BrowserSession } from "./chatGPTBrowserSessions";
import type { ChatGPTSidebarGroup } from "./chatGPTSessionGrouping";
import { chatGPTParentIndex } from "./chatGPTSessionLineage";

export const chatGPTWorkerVisibilityStorageKey = (environmentId: string | null) =>
  `t3code:chatgpt-browser:show-manager-workers:${environmentId ?? "unconnected"}`;

/**
 * Parentage alone does not establish a worker role: an authoritative OpenRig
 * manager seat can itself be nested under another manager. The caller passes
 * only active manager tab UUIDs verified against RigSpec seat roles and ledgers.
 * Never classify managers from their display titles or project names.
 *
 * Missing/cyclic parent links stay visible rather than guessing worker status.
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
      parentById.get(session.id) && !verifiedManagerSessionIds.has(session.id) ? [session.id] : [],
    ),
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
