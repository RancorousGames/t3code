import type { BrowserSession } from "./chatGPTBrowserSessions";
import { findChatGPTSessionByAnyId } from "./chatGPTBootstrapIdentity";

/**
 * Parent links are local T3 browser-session IDs, never ChatGPT conversation URLs.
 * Corrupt storage, legacy orphan links and cycles must not invent ancestry.
 * Break *all* links inside a cycle, but retain valid descendants of its nodes.
 */
export function chatGPTParentIndex(
  sessions: readonly BrowserSession[],
): ReadonlyMap<string, string | null> {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const cyclic = new Set<string>();
  for (const session of sessions) {
    const visited = new Map<string, number>();
    const path: string[] = [];
    let current: string | null = session.id;
    while (current && byId.has(current) && !visited.has(current)) {
      visited.set(current, path.length);
      path.push(current);
      current = byId.get(current)?.parentSessionId ?? null;
    }
    if (current && visited.has(current)) {
      for (const id of path.slice(visited.get(current)!)) cyclic.add(id);
    }
  }
  return new Map(
    sessions.map((session) => {
      const parent = session.parentSessionId;
      return [
        session.id,
        parent && parent !== session.id && byId.has(parent) && !cyclic.has(session.id)
          ? parent
          : null,
      ] as const;
    }),
  );
}

/**
 * The named-pipe caller has no trustworthy ChatGPT guest identity. Only a
 * specifically supplied T3 ID can establish lineage; never use the active
 * route, last clicked session, project or another session's heartbeat.
 */
export function resolveExplicitChatGPTParent(
  sessions: readonly BrowserSession[],
  parentSessionId: string | undefined,
): BrowserSession | null {
  if (!parentSessionId) return null;
  const parent = findChatGPTSessionByAnyId(sessions, parentSessionId);
  if (!parent || parent.hidden) {
    throw new Error("Unknown or hidden parent T3 session ID. Use your own T3 session ID (from Bootstrap or the sidebar's Copy T3 session ID).");
  }
  return parent;
}
