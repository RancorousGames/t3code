import type { ChatGPTSidebarGroup } from "./chatGPTSessionGrouping";
import type { ChatGPTSessionSortActivity } from "./chatGPTSessionGrouping";

export interface ChatGPTActivityOrderSnapshot {
  readonly context: string;
  readonly idleRows: readonly { id: string; interactionAt: number }[];
}

/**
 * A status probe may change recent/idle/unloaded colors without any new user
 * action or work. Keep those rows in place; only new work, a direct interaction,
 * or entry/exit from the 24-hour activity queue should change their order.
 */
export function stabilizeChatGPTActivityOrder(
  groups: readonly ChatGPTSidebarGroup[],
  previous: ChatGPTActivityOrderSnapshot | null,
  context: string,
  activity: Readonly<Record<string, ChatGPTSessionSortActivity>>,
): ChatGPTSidebarGroup[] {
  if (!previous || previous.context !== context) return [...groups];
  const previousPositions = new Map(
    previous.idleRows.map((row, index) => [row.id, { index, interactionAt: row.interactionAt }]),
  );
  return groups.map((group) => {
    if (group.key !== "status:activity") return group;
    const stable = group.rows.filter(({ session }) => {
      const past = previousPositions.get(session.id);
      return activity[session.id]?.age !== "working" &&
        past !== undefined &&
        past.interactionAt === (session.lastDirectInteractionAt ?? 0);
    }).sort((a, b) =>
      previousPositions.get(a.session.id)!.index - previousPositions.get(b.session.id)!.index,
    );
    const stableIds = new Set(stable.map(({ session }) => session.id));
    let next = 0;
    return {
      ...group,
      rows: group.rows.map((row) => stableIds.has(row.session.id) ? stable[next++]! : row),
    };
  });
}

export function snapshotChatGPTActivityOrder(
  groups: readonly ChatGPTSidebarGroup[],
  context: string,
  activity: Readonly<Record<string, ChatGPTSessionSortActivity>>,
): ChatGPTActivityOrderSnapshot {
  const group = groups.find((entry) => entry.key === "status:activity");
  return {
    context,
    idleRows: (group?.rows ?? [])
      .filter(({ session }) => activity[session.id]?.age !== "working")
      .map(({ session }) => ({
        id: session.id,
        interactionAt: session.lastDirectInteractionAt ?? 0,
      })),
  };
}

export function sameChatGPTActivityOrder(
  a: ChatGPTActivityOrderSnapshot | null,
  b: ChatGPTActivityOrderSnapshot,
): boolean {
  return a?.context === b.context &&
    a.idleRows.length === b.idleRows.length &&
    a.idleRows.every((row, index) =>
      row.id === b.idleRows[index]?.id && row.interactionAt === b.idleRows[index]?.interactionAt,
    );
}
