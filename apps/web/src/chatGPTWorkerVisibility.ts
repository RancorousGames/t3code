import type { BrowserSession } from "./chatGPTBrowserSessions";
import type { ChatGPTSidebarGroup } from "./chatGPTSessionGrouping";
import { chatGPTParentIndex } from "./chatGPTSessionLineage";

export const chatGPTWorkerVisibilityStorageKey = (environmentId: string | null) =>
  `t3code:chatgpt-browser:show-manager-workers:${environmentId ?? "unconnected"}`;

/**
 * A worker must have a real, same-environment T3 parent link. A title,
 * project, or an orphaned parent ID cannot establish a spawn relationship.
 */
export function linkedChatGPTWorkerIds(sessions: readonly BrowserSession[]): ReadonlySet<string> {
  const parentById = chatGPTParentIndex(sessions);
  return new Set(sessions.flatMap((session) => (parentById.get(session.id) ? [session.id] : [])));
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
