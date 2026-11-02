import type { ChatGPTSidebarGroup } from "./chatGPTSessionGrouping";

/** Keep a just-created manual chat above every project/status group until it is deselected. */
export function prioritizeFreshManualSession(
  groups: readonly ChatGPTSidebarGroup[],
  selectedId: string | null,
): ChatGPTSidebarGroup[] {
  if (!selectedId) return [...groups];
  const row = groups.flatMap((group) => group.rows).find(({ session }) => session.id === selectedId);
  if (!row) return [...groups];
  return [
    {
      key: "status:fresh-manual",
      title: null,
      rows: [{ ...row, depth: 0, childCount: 0 }],
    },
    ...groups.map((group) => ({
      ...group,
      rows: group.rows.filter(({ session }) => session.id !== selectedId),
    })),
  ];
}
