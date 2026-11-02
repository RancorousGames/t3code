import type { BrowserSession } from "../../chatGPTBrowserSessions";
import type { ChatGPTSidebarGroup } from "../../chatGPTSessionGrouping";

/** Human questions always occupy the first sidebar section, even if their
 * session was snoozed/hidden. They are presentation-only, never duplicated. */
export function prioritizePendingChatGPTQuestions(
  groups: readonly ChatGPTSidebarGroup[],
  sessions: readonly BrowserSession[],
  pendingIds: ReadonlySet<string>,
): ChatGPTSidebarGroup[] {
  if (!pendingIds.size) return [...groups];
  const questions = sessions.filter(session => pendingIds.has(session.id))
    .map(session => ({ session, depth: 0, childCount: 0 }));
  if (!questions.length) return [...groups];
  return [
    { key: "status:questions", title: "Needs your answer", rows: questions },
    ...groups.map(group => ({ ...group, rows: group.rows.filter(row => !pendingIds.has(row.session.id)) })),
  ];
}
