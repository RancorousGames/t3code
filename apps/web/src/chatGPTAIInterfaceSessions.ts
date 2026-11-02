import type { BrowserSession } from "./chatGPTBrowserSessions";

/** T3's agent-provider API creates guests with this durable receipt prefix.
 * This is provenance, not a title/role heuristic: manual and manager spawns
 * retain their own identities. */
export function isAIInterfaceSession(
  session: Pick<BrowserSession, "spawnRequestId">,
): boolean {
  return session.spawnRequestId?.startsWith("provider-v1:") === true;
}

export const AI_INTERFACE_IDLE_CLOSE_MS = 2 * 60 * 60_000;

/** Preserve selected, active or uncertain sessions instead of deleting a draft. */
export function aiInterfaceCloseDue(
  session: BrowserSession,
  lastActivityAt: number | null,
  now: number,
  isSelected: boolean,
): boolean {
  return isAIInterfaceSession(session) &&
    !isSelected &&
    session.autoCloseExempt !== true &&
    session.snoozedUntil === undefined &&
    lastActivityAt !== null && Number.isFinite(lastActivityAt) &&
    lastActivityAt > 0 &&
    now - lastActivityAt >= AI_INTERFACE_IDLE_CLOSE_MS;
}
