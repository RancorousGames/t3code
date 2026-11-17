import type { ChatGPTActivityState } from "./components/sidebar/chatGPTActivity";
import {
  advanceChatGPTReturnMarker,
  clearChatGPTSessionVerificationOnWorking,
  updateChatGPTReturnMarker,
} from "./chatGPTBrowserSessions";
import { activateAgentAttention } from "./chatGPTAgentAttention";
import { acknowledgeChatGPTSessionAttention } from "./chatGPTPersistentAttention";
import {
  markChatGPTAttentionVisited,
  observeChatGPTAttentionCompletion,
} from "./chatGPTAttentionWorkCycle";
import { getChatGPTSessionPersistedStore } from "./chatGPTSessionPersistedStore";
import { observeSpawnAutoCloseActivity } from "./chatGPTSpawnAutoClose";

// `since` is when the activity last changed (turn start while working).
type Observation = { activity: ChatGPTActivityState; observedAt: number; since: number };
const observations = new Map<string, Observation>();
const key = (environmentId: string, sessionId: string) => environmentId + ":" + sessionId;

/** Desktop uses hash routing; only the main selected session auto-acknowledges. */
export function isSelectedChatGPTAttentionSession(sessionId: string, hash: string): boolean {
  const match = /^#\/browser\/([^/?#]+)\/?(?:\?.*)?$/.exec(hash);
  if (!match) return false;
  try {
    return decodeURIComponent(match[1]!) === sessionId;
  } catch {
    return false;
  }
}

/** Share the sidebar's verified activity with the phone-facing provider catalog. */
export function recordChatGPTProviderActivity(
  environmentId: string,
  sessionId: string,
  activity: ChatGPTActivityState,
): void {
  if (activity === "unknown") return;
  if (activity === "working") clearChatGPTSessionVerificationOnWorking(environmentId, sessionId);
  const session = getChatGPTSessionPersistedStore(environmentId)
    .getState()
    .sessions.find((entry) => entry.id === sessionId && entry.autoClose === true);
  if (session) observeSpawnAutoCloseActivity(environmentId, session, activity);
  const identity = key(environmentId, sessionId);
  const previous = observations.get(identity);
  const now = Date.now();
  observations.set(identity, {
    activity,
    observedAt: now,
    since: previous?.activity === activity ? previous.since : now,
  });
  const completed = observeChatGPTAttentionCompletion(
    environmentId,
    sessionId,
    previous?.activity,
    activity,
  );
  if (activity === "working" || completed) {
    updateChatGPTReturnMarker(environmentId, sessionId, (marker) => {
      if (!marker) return undefined;
      // Preserve the Ctrl+D rule: armed while idle waits for NEW work.
      // A previously observed working marker still becomes ready through errors.
      return advanceChatGPTReturnMarker(marker, activity === "working" ? "working" : "idle");
    });
    if (completed) {
      const entry = getChatGPTSessionPersistedStore(environmentId)
        .getState()
        .sessions.find((session) => session.id === sessionId);
      const ids = [
        sessionId,
        ...(entry?.bootstrapIdentity?.publicId ? [entry.bootstrapIdentity.publicId] : []),
      ];
      // An agent's one-time attention request is independent of Ctrl+D.
      // It must activate even when the user never armed a return marker.
      const newlyActivated = activateAgentAttention(ids);
      if (entry && isSelectedChatGPTAttentionSession(sessionId, window.location.hash)) {
        // Auto-acknowledge only requests activated by this transition.
        // Existing stack entries must not disappear when a selected page
        // finishes another response.
        for (const requestId of newlyActivated)
          acknowledgeChatGPTSessionAttention(environmentId, entry, activity, requestId);
        // Already selected means the output is visible, even if there was no
        // new request to acknowledge. Do not re-alert on a later error->idle.
        markChatGPTAttentionVisited(environmentId, sessionId, activity);
      }
    }
  }
  if (previous?.activity !== activity)
    window.dispatchEvent(new CustomEvent("t3:agent-provider-refresh"));
}

export function readChatGPTProviderActivity(
  environmentId: string,
  sessionId: string,
  now = Date.now(),
): ChatGPTActivityState {
  const observation = observations.get(key(environmentId, sessionId));
  return observation && now - observation.observedAt < 90_000 ? observation.activity : "unknown";
}

/** Activity plus when it began; `since` is null when the observation is stale. */
export function readChatGPTProviderActivityDetail(
  environmentId: string,
  sessionId: string,
  now = Date.now(),
): { activity: ChatGPTActivityState; since: number | null } {
  const observation = observations.get(key(environmentId, sessionId));
  return observation && now - observation.observedAt < 90_000
    ? { activity: observation.activity, since: observation.since }
    : { activity: "unknown", since: null };
}
