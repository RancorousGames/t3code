import type { ChatGPTSidebarGroup } from "./chatGPTSessionGrouping";

/** Filter already-grouped sessions without changing the underlying ordering or saved metadata. */
export function searchChatGPTSessionGroups(
  groups: readonly ChatGPTSidebarGroup[],
  query: string,
): ChatGPTSidebarGroup[] {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return [...groups];

  return groups.flatMap((group) => {
    if (!group.rows.length) return [];
    if (group.title?.toLocaleLowerCase().includes(term)) return [group];

    const matches = group.rows.filter(({ session }) =>
      session.title.toLocaleLowerCase().includes(term),
    );
    if (!matches.length) return [];

    // A descendant can match even when its ancestors don't. Make the visible
    // result a root unless its actual parent is also among the matches.
    const visibleIds = new Set(matches.map(({ session }) => session.id));
    const depths = new Map<string, number>();
    const visibleChildCounts = new Map<string, number>();
    for (const { session } of matches) {
      if (session.parentSessionId && visibleIds.has(session.parentSessionId))
        visibleChildCounts.set(
          session.parentSessionId,
          (visibleChildCounts.get(session.parentSessionId) ?? 0) + 1,
        );
    }
    return [
      {
        ...group,
        rows: matches.map((row) => {
          const parent = row.session.parentSessionId;
          const depth =
            parent !== null && parent !== undefined && depths.has(parent)
              ? depths.get(parent)! + 1
              : 0;
          depths.set(row.session.id, depth);
          return { ...row, depth, childCount: visibleChildCounts.get(row.session.id) ?? 0 };
        }),
      },
    ];
  });
}
