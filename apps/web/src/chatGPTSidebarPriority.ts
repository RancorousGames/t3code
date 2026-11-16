import type { BrowserSession } from "./chatGPTBrowserSessions";
import type {
  ChatGPTSessionSortActivity,
  ChatGPTSidebarGroup,
  ChatGPTSidebarSession,
} from "./chatGPTSessionGrouping";
import { chatGPTSessionHighlightAccentClass } from "./components/sidebar/chatGPTSidebarVisuals";

/** Verification is a first-in-first-out queue, independent of work recency and
 * priority colors. Old entries lack a dedicated timestamp: use their snooze
 * timestamp as the best available proxy, then original creation order. */
export function sortChatGPTVerificationRows(
  rows: readonly ChatGPTSidebarSession[],
): ChatGPTSidebarSession[] {
  const markedAt = (session: BrowserSession) =>
    session.verificationMarkedAt ?? session.snoozedAt ?? 0;
  return [...rows].sort((a, b) =>
    markedAt(a.session) - markedAt(b.session) ||
    (a.session.createdAt ?? 0) - (b.session.createdAt ?? 0) ||
    a.session.id.localeCompare(b.session.id),
  );
}

/** Restore the last selection when it survives; otherwise use actual activity history, not row order. */
export function selectChatGPTSidebarReplacement(
  sessions: readonly BrowserSession[],
  excludedIds: ReadonlySet<string>,
  previousId: string | null | undefined,
  activity: Readonly<Record<string, ChatGPTSessionSortActivity>>,
  now: number,
): string | null {
  const eligible = sessions.filter(
    (session) =>
      !excludedIds.has(session.id) &&
      !session.hidden &&
      !session.verificationPending &&
      (session.snoozedUntil ?? 0) <= now,
  );
  if (previousId && eligible.some((session) => session.id === previousId)) return previousId;
  return eligible.toSorted((left, right) =>
    (activity[right.id]?.lastActivityAt ?? activity[right.id]?.lastWorkingAt ?? 0) -
      (activity[left.id]?.lastActivityAt ?? activity[left.id]?.lastWorkingAt ?? 0) ||
    (right.createdAt ?? 0) - (left.createdAt ?? 0) ||
    left.id.localeCompare(right.id),
  )[0]?.id ?? null;
}

/** Explicit highlights outrank all non-working statuses and project buckets. */
export function prioritizeChatGPTSessionHighlights(
  groups: readonly ChatGPTSidebarGroup[],
  activity: Readonly<Record<string, ChatGPTSessionSortActivity>>,
  permanentProjectKeys: ReadonlySet<string> = new Set(),
): ChatGPTSidebarGroup[] {
  const isWorking = (row: ChatGPTSidebarSession) => activity[row.session.id]?.age === "working";
  const isHighlighted = (row: ChatGPTSidebarSession) =>
    chatGPTSessionHighlightAccentClass(row.session.borderColor) !== null;
  const allRows = groups.flatMap((group) => group.rows);
  const priority = [
    ...allRows.filter(isWorking),
    ...allRows.filter((row) => !isWorking(row) && isHighlighted(row)),
  ];
  if (!priority.length) return [...groups];

  const prioritizedIds = new Set(priority.map((row) => row.session.id));
  const rest = groups
    .map((group) => ({
      ...group,
      rows: group.rows.filter((row) => !prioritizedIds.has(row.session.id)),
    }))
    .filter((group, index) => group.rows.length > 0 || groups[index]!.rows.length === 0 ||
      (group.key !== null && permanentProjectKeys.has(group.key)));
  const activityIndex = rest.findIndex((group) => group.key === "status:activity");
  if (activityIndex >= 0) {
    const activityGroup = rest[activityIndex]!;
    return [
      { ...activityGroup, rows: [...priority, ...activityGroup.rows] },
      ...rest.filter((_, index) => index !== activityIndex),
    ];
  }
  return [{ key: "status:activity", title: null, rows: priority }, ...rest];
}

/**
 * Keep the active selection at its last committed row index, even when its
 * activity/status/highlight changes. Once deselected it follows normal sorting.
 */
export function preserveSelectedChatGPTSessionPosition(
  groups: readonly ChatGPTSidebarGroup[],
  previous: readonly ChatGPTSidebarGroup[] | null,
  selectedId: string | undefined,
): ChatGPTSidebarGroup[] {
  if (!previous || !selectedId) return [...groups];
  const lastIndex = previous
    .flatMap((group) => group.rows)
    .findIndex((row) => row.session.id === selectedId);
  if (lastIndex < 0) return [...groups];
  const current = groups.flatMap((group) => group.rows);
  const currentIndex = current.findIndex((row) => row.session.id === selectedId);
  if (currentIndex < 0 || currentIndex === lastIndex) return [...groups];

  const selected = current[currentIndex]!;
  const without = groups.map((group) => ({
    ...group,
    rows: group.rows.filter((row) => row.session.id !== selectedId),
  }));
  const target = Math.min(lastIndex, current.length - 1);
  let seen = 0;
  for (let index = 0; index < without.length; index++) {
    const group = without[index]!;
    const end = seen + group.rows.length;
    if (target <= end || index === without.length - 1) {
      const rows = [...group.rows];
      rows.splice(Math.min(target - seen, rows.length), 0, selected);
      without[index] = { ...group, rows };
      break;
    }
    seen = end;
  }
  return without;
}
