import type {
  ChatGPTSessionSortActivity,
  ChatGPTSidebarGroup,
  ChatGPTSidebarSession,
} from "./chatGPTSessionGrouping";
import { chatGPTSessionHighlightAccentClass } from "./components/sidebar/chatGPTSidebarVisuals";

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
