import type { BrowserSession } from "./chatGPTBrowserSessions";
import { chatGPTConversationIdFromUrl } from "./chatGPTConversationIdentity";
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

/**
 * Search the entire persisted catalog, not only rows currently rendered in the
 * sidebar. Parked sessions and workers hidden by the visibility toggle are
 * returned as separate result groups without changing their saved visibility.
 */
export function searchChatGPTSessionCatalog(input: {
  groups: readonly ChatGPTSidebarGroup[];
  sessions: readonly BrowserSession[];
  query: string;
  now: number;
  hiddenWorkerIds?: ReadonlySet<string>;
  conversationUrl?: (sessionId: string) => string | null;
}): ChatGPTSidebarGroup[] {
  const term = input.query.trim().toLocaleLowerCase();
  if (!term) return [...input.groups];

  const regular = searchChatGPTSessionGroups(input.groups, term);
  const alreadyShown = new Set(regular.flatMap((group) => group.rows.map((row) => row.session.id)));
  const extra: Record<"hidden" | "snoozed" | "workers" | "other", BrowserSession[]> = {
    hidden: [], snoozed: [], workers: [], other: [],
  };

  for (const session of input.sessions) {
    if (alreadyShown.has(session.id)) continue;
    const url = input.conversationUrl?.(session.id) ?? session.archive?.conversationUrl ?? null;
    const conversationId = session.bootstrapIdentity?.conversationId ?? chatGPTConversationIdFromUrl(url);
    const fields = [
      session.title, session.id, session.bootstrapIdentity?.publicId,
      conversationId, url,
    ];
    if (!fields.some((field) => field?.toLocaleLowerCase().includes(term))) continue;

    const category = session.hidden ? "hidden"
      : (session.snoozedUntil ?? 0) > input.now ? "snoozed"
      : input.hiddenWorkerIds?.has(session.id) ? "workers" : "other";
    extra[category].push(session);
  }

  const titles = {
    hidden: "Hidden sessions",
    snoozed: "Snoozed sessions",
    workers: "Hidden workers",
    other: "Other sessions",
  } as const;
  const supplements = (Object.keys(titles) as Array<keyof typeof titles>).flatMap((category) =>
    extra[category].length
      ? [{
          key: `search:${category}`,
          title: titles[category],
          rows: extra[category].map((session) => ({ session, depth: 0, childCount: 0 })),
        }]
      : [],
  );
  return [...regular, ...supplements];
}
