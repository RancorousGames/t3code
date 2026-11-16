import type { ChatGPTActivityState } from "./components/sidebar/chatGPTActivity";
import { advanceChatGPTReturnMarker, clearChatGPTSessionVerificationOnWorking, updateChatGPTReturnMarker } from "./chatGPTBrowserSessions";
import { activateAgentAttention } from "./chatGPTAgentAttention";
import { acknowledgeChatGPTSessionAttention } from "./chatGPTPersistentAttention";
import { getChatGPTSessionPersistedStore } from "./chatGPTSessionPersistedStore";
import { observeSpawnAutoCloseActivity } from "./chatGPTSpawnAutoClose";

type Observation = { activity: ChatGPTActivityState; observedAt: number };
const observations = new Map<string, Observation>();
const key = (environmentId: string, sessionId: string) => environmentId + ":" + sessionId;

/** "Error" is represented by three distinct provider states, not a literal enum. */
export function completedAttentionTransition(
  previous: ChatGPTActivityState | undefined,
  next: ChatGPTActivityState,
): boolean {
  return next === "idle" && (
    previous === "working" ||
    previous === "invalid" ||
    previous === "interrupted" ||
    previous === "delivery-timeout"
  );
}

/** Desktop uses hash routing; only the main selected session auto-acknowledges. */
export function isSelectedChatGPTAttentionSession(sessionId: string, hash: string): boolean {
  const match = /^#\/browser\/([^/?#]+)\/?(?:\?.*)?$/.exec(hash);
  if (!match) return false;
  try { return decodeURIComponent(match[1]!) === sessionId; }
  catch { return false; }
}

/** Share the sidebar's verified activity with the phone-facing provider catalog. */
export function recordChatGPTProviderActivity(
  environmentId: string,
  sessionId: string,
  activity: ChatGPTActivityState,
): void {
  if (activity === "unknown") return;
  if (activity === "working") clearChatGPTSessionVerificationOnWorking(environmentId, sessionId);
  const session = getChatGPTSessionPersistedStore(environmentId).getState().sessions.find(
    (entry) => entry.id === sessionId && entry.autoClose === true,
  );
  if (session) observeSpawnAutoCloseActivity(environmentId, session, activity);
  const identity = key(environmentId, sessionId);
  const previous = observations.get(identity);
  observations.set(identity, { activity, observedAt: Date.now() });
  const completed = completedAttentionTransition(previous?.activity, activity);
  if (activity === "working" || completed) {
    updateChatGPTReturnMarker(environmentId, sessionId, (marker) => {
      if (!marker) return undefined;
      // A session already in an error state may have been armed directly from
      // idle. Error -> idle is a completion even without a preceding working probe.
      if (completed && previous?.activity !== "working" && marker === "armed") return "ready";
      return advanceChatGPTReturnMarker(marker, activity === "working" ? "working" : "idle");
    });
    if (completed) {
      const entry = getChatGPTSessionPersistedStore(environmentId).getState().sessions.find(
        (session) => session.id === sessionId);
      const ids = [sessionId, ...(entry?.bootstrapIdentity?.publicId
        ? [entry.bootstrapIdentity.publicId] : [])];
      // An agent's one-time attention request is independent of Ctrl+D.
      // It must activate even when the user never armed a return marker.
      activateAgentAttention(ids);
      if (entry && isSelectedChatGPTAttentionSession(sessionId, window.location.hash)) {
        // A selected session has already been seen. Do not leave it yellow or
        // play an attention sound; retain only its next persistent Ctrl+D cycle.
        acknowledgeChatGPTSessionAttention(environmentId, entry, activity);
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
  return observation && now - observation.observedAt < 90_000
    ? observation.activity
    : "unknown";
}