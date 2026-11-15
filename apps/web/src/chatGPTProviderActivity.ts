import type { ChatGPTActivityState } from "./components/sidebar/chatGPTActivity";
import { advanceChatGPTReturnMarker, clearChatGPTSessionVerificationOnWorking, updateChatGPTReturnMarker } from "./chatGPTBrowserSessions";
import { activateAgentAttention } from "./chatGPTAgentAttention";
import { getChatGPTSessionPersistedStore } from "./chatGPTSessionPersistedStore";
import { observeSpawnAutoCloseActivity } from "./chatGPTSpawnAutoClose";

type Observation = { activity: ChatGPTActivityState; observedAt: number };
const observations = new Map<string, Observation>();
const key = (environmentId: string, sessionId: string) => environmentId + ":" + sessionId;

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
  if (activity === "working" || (activity === "idle" && previous?.activity === "working")) {
    const next = updateChatGPTReturnMarker(environmentId, sessionId, (marker) =>
      marker ? advanceChatGPTReturnMarker(marker, activity) : undefined);
    if (activity === "idle" && next === "ready") {
      const entry = getChatGPTSessionPersistedStore(environmentId).getState().sessions.find(
        (session) => session.id === sessionId);
      activateAgentAttention([sessionId, ...(entry?.bootstrapIdentity?.publicId
        ? [entry.bootstrapIdentity.publicId] : [])]);
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