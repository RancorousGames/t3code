import type { ChatGPTSessionSortActivity, ChatGPTSidebarGroup } from "./chatGPTSessionGrouping";
import type { BrowserSession } from "./chatGPTBrowserSessions";

/** Only genuinely new, still-blank manual chats qualify for a temporary priority tier. */
export const FRESH_MANUAL_PRIORITY_MAX_AGE_MS = 30 * 60_000;
export function freshManualSessionIds(
  sessions: readonly BrowserSession[],
  lastWorkingAt: (id: string) => number,
  now = Date.now(),
): string[] {
  return sessions
    .filter(
      (session) =>
        session.manualEmptyCandidateDisqualified !== true &&
        session.manualEmptyCandidateCreatedAt !== undefined &&
        session.manualEmptyCandidateCreatedAt > 0 &&
        session.manualEmptyCandidateCreatedAt <= now &&
        now - session.manualEmptyCandidateCreatedAt < FRESH_MANUAL_PRIORITY_MAX_AGE_MS &&
        lastWorkingAt(session.id) <= 0,
    )
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .map((session) => session.id);
}

/** Fresh manual chats are prioritized below working sessions, never over them. */
export function prioritizeFreshManualSession(
  groups: readonly ChatGPTSidebarGroup[],
  pendingIds: readonly string[],
  activityById: Readonly<Record<string, ChatGPTSessionSortActivity>> = {},
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
  const rest = groups.map((group) => ({
    ...group,
    rows: group.rows.filter(({ session }) => !pinnedIds.has(session.id)),
  }));
  // The activity queue begins with working sessions; insert fresh chats immediately
  // afterwards without splitting the queue or moving its working sessions down.
  const activityIndex = rest.findIndex((group) => group.key === "status:activity");
  if (activityIndex >= 0) {
    const group = rest[activityIndex]!;
    const firstIdle = group.rows.findIndex(
      ({ session }) => activityById[session.id]?.age !== "working",
    );
    const position = firstIdle < 0 ? group.rows.length : firstIdle;
    return rest.map((entry, index) =>
      index === activityIndex
        ? { ...entry, rows: [
            ...entry.rows.slice(0, position),
            ...pinned,
            ...entry.rows.slice(position),
          ] }
        : entry,
    );
  }
  return [{ key: "status:fresh-manual", title: null, rows: pinned }, ...rest];
}
