import type { BrowserSession } from "./chatGPTBrowserSessions";
import { findChatGPTSessionByAnyId } from "./chatGPTBootstrapIdentity";

export type ChatGPTParentLinkStatus = "not_requested" | "resolved" | "hidden" | "unresolved";

/** Best-effort spawns use only visible, registered parents. An unavailable
 * parent is reported but never persisted as a speculative lineage edge. */
export function resolveChatGPTSpawnParent(
  sessions: readonly BrowserSession[],
  requestedId: string | undefined,
  requireParent = false,
): {
  parentSessionId: string | null;
  verifiedParent: BrowserSession | null;
  status: ChatGPTParentLinkStatus;
} {
  if (!requestedId) {
    if (requireParent) throw new Error("A verified parent T3 session ID is required.");
    return { parentSessionId: null, verifiedParent: null, status: "not_requested" };
  }
  const parent = findChatGPTSessionByAnyId(sessions, requestedId);
  const status = !parent ? "unresolved" : parent.hidden ? "hidden" : "resolved";
  if (requireParent && status !== "resolved")
    throw new Error(
      "Unknown or hidden parent T3 session ID; strict require_parent requires a visible, registered parent.",
    );
  return {
    parentSessionId: parent && !parent.hidden ? parent.id : null,
    verifiedParent: parent && !parent.hidden ? parent : null,
    status,
  };
}

/**
 * Parent links are local T3 browser-session IDs (or unresolved explicitly
 * requested public IDs), never guessed from the current tab or project.
 * Break cycle edges without deleting their valid descendants.
 */
export function chatGPTParentIndex(
  sessions: readonly BrowserSession[],
): ReadonlyMap<string, string | null> {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const publicIds = new Map<string, string>();
  for (const session of sessions) {
    const publicId = session.bootstrapIdentity?.publicId?.toLowerCase();
    if (publicId && !publicIds.has(publicId)) publicIds.set(publicId, session.id);
  }
  const direct = new Map(
    sessions.map((session) => {
      const requested = session.parentSessionId;
      return [
        session.id,
        requested
          ? byId.has(requested)
            ? requested
            : (publicIds.get(requested.toLowerCase()) ?? null)
          : null,
      ] as const;
    }),
  );
  const cyclic = new Set<string>();
  for (const session of sessions) {
    const visited = new Map<string, number>();
    const path: string[] = [];
    let current: string | null = session.id;
    while (current && byId.has(current) && !visited.has(current)) {
      visited.set(current, path.length);
      path.push(current);
      current = direct.get(current) ?? null;
    }
    if (current && visited.has(current)) {
      for (const id of path.slice(visited.get(current)!)) cyclic.add(id);
    }
  }
  return new Map(
    sessions.map((session) => {
      const parent = direct.get(session.id);
      return [
        session.id,
        parent && parent !== session.id && !cyclic.has(session.id) ? parent : null,
      ] as const;
    }),
  );
}
