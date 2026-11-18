import type { AgentAttention } from "./chatGPTAgentAttention";

/** A toast appearance is a specific activated request (including a reappearance
 * after a snooze). Updating its delivery receipt must not count as new attention. */
function appearanceKey(item: Pick<AgentAttention, "id" | "nextAt" | "activatedAt">): string {
  return JSON.stringify([item.id, item.activatedAt ?? null, item.nextAt]);
}

/** Hide only the alerts already on screen. It must not change their status,
 * snooze deadline or whether Ctrl+S can navigate to them. */
export function captureHiddenAttention(
  actionable: readonly AgentAttention[],
): ReadonlySet<string> {
  return new Set(actionable.map(appearanceKey));
}

/** An alert activated after Hide, including a snooze expiry, reveals the full
 * existing stack. Removing/reordering an old alert does not reveal it. */
export function retainHiddenAttention(
  hidden: ReadonlySet<string> | null,
  actionable: readonly AgentAttention[],
): ReadonlySet<string> | null {
  if (hidden === null) return null;
  return actionable.some((item) => !hidden.has(appearanceKey(item))) ? null : hidden;
}
