import type { ChatGPTActivityState } from "./components/sidebar/chatGPTActivity";

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
  const identity = key(environmentId, sessionId);
  const previous = observations.get(identity);
  observations.set(identity, { activity, observedAt: Date.now() });
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