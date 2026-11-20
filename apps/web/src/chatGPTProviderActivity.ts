import type { ChatGPTActivityState } from "./components/sidebar/chatGPTActivity";
import {
  advanceChatGPTReturnMarker,
  clearChatGPTSessionVerificationOnWorking,
  updateChatGPTReturnMarker,
} from "./chatGPTBrowserSessions";
import { activateAgentAttention } from "./chatGPTAgentAttention";
import {
  acknowledgeChatGPTSessionAttention,
  rearmPersistentSessionAttention,
} from "./chatGPTPersistentAttention";
import {
  markChatGPTAttentionVisited,
  observeChatGPTAttentionCompletion,
} from "./chatGPTAttentionWorkCycle";
import { getChatGPTSessionPersistedStore } from "./chatGPTSessionPersistedStore";
import {
  deferredCaffyAttention,
  isCaffyIdleContinuationActive,
} from "./chatGPTCaffyAttentionPolicy";
import { readVerifiedT3CaffyOverview } from "./hooks/useT3CaffyOverview";
import { observeSpawnAutoCloseActivity } from "./chatGPTSpawnAutoClose";

// `since` is when the activity last changed (turn start while working).
type ProviderProblem = "temporary-limit" | "browser-unresponsive" | "page-failed" | null;
type Observation = {
  activity: ChatGPTActivityState;
  observedAt: number;
  since: number;
  problem: ProviderProblem;
};

// Only known browser status reasons are published to phone clients, never arbitrary page content.
function classifyProblem(activity: ChatGPTActivityState, reason: string | null): ProviderProblem {
  if (activity !== "invalid") return null;
  if (reason === "A temporary limit is preventing this chat from loading. Try again later.")
    return "temporary-limit";
  if (reason === "browser-unresponsive") return "browser-unresponsive";
  return "page-failed";
}
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
  reason: string | null = null,
): void {
  if (activity === "unknown") return;
  if (activity === "working") clearChatGPTSessionVerificationOnWorking(environmentId, sessionId);
  const session = getChatGPTSessionPersistedStore(environmentId)
    .getState()
    .sessions.find((entry) => entry.id === sessionId);
  if (session?.autoClose === true) observeSpawnAutoCloseActivity(environmentId, session, activity);
  const identity = key(environmentId, sessionId);
  const previous = observations.get(identity);
  const now = Date.now();
  const problem = classifyProblem(activity, reason);
  observations.set(identity, {
    activity,
    observedAt: now,
    since: previous?.activity === activity ? previous.since : now,
    problem,
  });
  const completed = observeChatGPTAttentionCompletion(
    environmentId,
    sessionId,
    previous?.activity,
    activity,
  );
  const continuation = session
    ? isCaffyIdleContinuationActive(readVerifiedT3CaffyOverview(), session, Date.now())
    : false;
  if (activity === "working") {
    updateChatGPTReturnMarker(environmentId, sessionId, (marker) =>
      marker ? advanceChatGPTReturnMarker(marker, "working") : undefined,
    );
  }
  if (completed) {
    const ids = [
      sessionId,
      ...(session?.bootstrapIdentity?.publicId ? [session.bootstrapIdentity.publicId] : []),
    ];
    const deferPersistent = continuation && Boolean(session?.returnMarker);
    if (deferPersistent) {
      // Caffy will continue this work, so its temporary idle state is not a
      // genuine reason to call the user back.
      deferredCaffyAttention.defer(environmentId, sessionId);
    } else {
      deferredCaffyAttention.clear(environmentId, sessionId);
      updateChatGPTReturnMarker(environmentId, sessionId, (marker) =>
        marker ? advanceChatGPTReturnMarker(marker, "idle") : undefined,
      );
    }
    // An explicit agent request is independent of the persistent Ctrl+D flag.
    const newlyActivated = activateAgentAttention(ids, deferPersistent ? "agent" : undefined);
    if (session && isSelectedChatGPTAttentionSession(sessionId, window.location.hash)) {
      for (const requestId of newlyActivated)
        acknowledgeChatGPTSessionAttention(environmentId, session, activity, requestId);
      // The visible answer is already handled, even when the request stack
      // contained no manual record. Re-arm persistent Ctrl+D for the next
      // actual turn instead of leaving a stale yellow marker behind.
      if (session.returnMarker) rearmPersistentSessionAttention(environmentId, session, activity);
      markChatGPTAttentionVisited(environmentId, sessionId, activity);
    }
  }
  if (activity === "idle" && !continuation) flushDeferredCaffyAttention(environmentId);
  if (previous?.activity !== activity || previous.problem !== problem)
    window.dispatchEvent(new CustomEvent("t3:agent-provider-refresh"));
}

/** Check deferred idle completions when Caffy is disabled, paused or expires.
 * Called both by live activity observations and the desktop toast's periodic
 * refresh, so an unloaded session can become yellow without a new message. */
export function flushDeferredCaffyAttention(environmentId: string): void {
  const store = getChatGPTSessionPersistedStore(environmentId);
  for (const sessionId of deferredCaffyAttention.sessions(environmentId)) {
    const session = store.getState().sessions.find((entry) => entry.id === sessionId);
    if (!session?.returnMarker) {
      deferredCaffyAttention.clear(environmentId, sessionId);
      continue;
    }
    const continuing = isCaffyIdleContinuationActive(readVerifiedT3CaffyOverview(), session);
    const observed = observations.get(key(environmentId, sessionId))?.activity ?? "unknown";
    if (!deferredCaffyAttention.takeIfReady(environmentId, sessionId, continuing, observed))
      continue;
    updateChatGPTReturnMarker(environmentId, sessionId, (marker) =>
      marker ? advanceChatGPTReturnMarker(marker, "idle") : undefined,
    );
    const ids = [
      sessionId,
      ...(session.bootstrapIdentity?.publicId ? [session.bootstrapIdentity.publicId] : []),
    ];
    const activated = activateAgentAttention(ids, "manual");
    if (isSelectedChatGPTAttentionSession(sessionId, window.location.hash)) {
      const current = store.getState().sessions.find((entry) => entry.id === sessionId);
      if (current) {
        for (const requestId of activated)
          acknowledgeChatGPTSessionAttention(environmentId, current, observed, requestId);
        if (current.returnMarker) rearmPersistentSessionAttention(environmentId, current, observed);
        markChatGPTAttentionVisited(environmentId, sessionId, observed);
      }
    }
  }
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
): { activity: ChatGPTActivityState; since: number | null; problem: ProviderProblem } {
  const observation = observations.get(key(environmentId, sessionId));
  return observation && now - observation.observedAt < 90_000
    ? { activity: observation.activity, since: observation.since, problem: observation.problem }
    : { activity: "unknown", since: null, problem: null };
}
