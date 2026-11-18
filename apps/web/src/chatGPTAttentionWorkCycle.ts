import type { ChatGPTActivityState } from "./components/sidebar/chatGPTActivity";
import { deferredCaffyAttention } from "./chatGPTCaffyAttentionPolicy";

/** A recovery is attention-worthy only when it belongs to work the user
 * has not visited or acknowledged since that work began. */
const unvisitedWork = new Set<string>();
const key = (environmentId: string, sessionId: string) => environmentId + ":" + sessionId;

export function completedAttentionTransition(
  previous: ChatGPTActivityState | undefined,
  next: ChatGPTActivityState,
  hasUnvisitedWork: boolean,
): boolean {
  return hasUnvisitedWork && next === "idle" && (
    previous === "working" ||
    previous === "invalid" ||
    previous === "interrupted" ||
    previous === "delivery-timeout"
  );
}

/** Observe the real activity timeline, not just the last error->idle pair. */
export function observeChatGPTAttentionCompletion(
  environmentId: string,
  sessionId: string,
  previous: ChatGPTActivityState | undefined,
  next: ChatGPTActivityState,
): boolean {
  const identity = key(environmentId, sessionId);
  if (next === "working") unvisitedWork.add(identity);
  return completedAttentionTransition(previous, next, unvisitedWork.has(identity));
}

/** Called by session visits, explicit alert opens, and selected-session
 * auto-acknowledgement. Clicking while still working cannot read its final output. */
export function markChatGPTAttentionVisited(
  environmentId: string,
  sessionId: string,
  activity: ChatGPTActivityState,
): void {
  if (activity !== "working") {
    unvisitedWork.delete(key(environmentId, sessionId));
    deferredCaffyAttention.clear(environmentId, sessionId);
  }
}
