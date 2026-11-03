import type { ChatGPTSidebarGroup } from "./chatGPTSessionGrouping";
import type { BrowserSession } from "./chatGPTBrowserSessions";

/** Only UI-created blank chats with no observed work retain the pinned tier. */
export function freshManualSessionIds(
  sessions: readonly BrowserSession[],
  lastWorkingAt: (id: string) => number,
): string[] {
  return sessions
    .filter(
      (session) =>
        session.manualEmptyCandidateCreatedAt !== undefined && lastWorkingAt(session.id) <= 0,
    )
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .map((session) => session.id);
}

/** Keep brand-new user-created conversations at the top until first observed work. */
export function prioritizeFreshManualSession(
  groups: readonly ChatGPTSidebarGroup[],
  pendingIds: readonly string[],
): ChatGPTSidebarGroup[] {
  if (!pendingIds.length) return [...groups];
  const rowsById = new Map(
    groups.flatMap((group) => group.rows.map((row) => [row.session.id, row] as const)),
  );
  const pinned = pendingIds.flatMap((id) => {
    const row = rowsById.get(id);
    return row ? [{ ...row, depth: 0, childCount: 0 }] : [];
  });
  if (!pinned.length) return [...groups];
  const pinnedIds = new Set(pinned.map((row) => row.session.id));
  return [
    { key: "status:fresh-manual", title: null, rows: pinned },
    ...groups.map((group) => ({
      ...group,
      rows: group.rows.filter(({ session }) => !pinnedIds.has(session.id)),
    })),
  ];
}
