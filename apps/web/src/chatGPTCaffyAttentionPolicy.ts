import type { ChatGPTActivityState } from "./components/sidebar/chatGPTActivity";
import type { T3CaffyEntry } from "./hooks/useT3CaffyOverview";

/** Caffy owns this idle period: it is about to continue the same session,
 * so the persistent Ctrl+D request must not advertise a completed turn. */
export function isCaffyIdleContinuationActive(
  overview: { readonly entries: readonly (
    Pick<T3CaffyEntry, "sessionId" | "mode" | "paused" | "expiresAt"> &
    Partial<Pick<T3CaffyEntry, "browserSessionId" | "publicSessionId">>
  )[] } | null,
  session: { id: string; bootstrapIdentity?: { readonly publicId?: string | undefined } | undefined },
  now = Date.now(),
): boolean {
  if (!overview) return false;
  const ids = new Set([session.id, session.bootstrapIdentity?.publicId].filter(Boolean));
  return overview.entries.some((entry) =>
    entry.mode === "idle" && !entry.paused &&
    (entry.expiresAt === null || entry.expiresAt > now) &&
    [entry.sessionId, entry.browserSessionId, entry.publicSessionId]
      .some((id) => id !== undefined && ids.has(id)));
}

/** In-memory handoff across Caffy continuations. Never mark the session
 * yellow until its continuation has stopped AND it remains idle/unvisited. */
export class CaffyDeferredAttention {
  private readonly deferred = new Map<string, Set<string>>();

  defer(environmentId: string, sessionId: string): void {
    let ids = this.deferred.get(environmentId);
    if (!ids) {
      ids = new Set();
      this.deferred.set(environmentId, ids);
    }
    ids.add(sessionId);
  }

  clear(environmentId: string, sessionId: string): void {
    this.deferred.get(environmentId)?.delete(sessionId);
  }

  isDeferred(environmentId: string, sessionId: string): boolean {
    return this.deferred.get(environmentId)?.has(sessionId) ?? false;
  }

  sessions(environmentId: string): readonly string[] {
    return [...(this.deferred.get(environmentId) ?? [])];
  }

  takeIfReady(
    environmentId: string,
    sessionId: string,
    activeContinuation: boolean,
    activity: ChatGPTActivityState,
  ): boolean {
    if (!this.isDeferred(environmentId, sessionId) ||
        activeContinuation || activity !== "idle") return false;
    this.clear(environmentId, sessionId);
    return true;
  }
}

export const deferredCaffyAttention = new CaffyDeferredAttention();
