import { useEffect, useState } from "react";
import type { BrowserSession } from "./chatGPTBrowserSessions";
import {
  AGENT_ATTENTION_CHANGE_EVENT,
  loadAgentAttention,
  isManualAttentionTemporarilySnoozed,
  type AgentAttention,
} from "./chatGPTAgentAttention";

/** The persistent Mark attention flag and outstanding one-off GMA requests
 * share one priority signal. Resolved or snoozed one-offs do not keep a guest hot. */
export function attentionPrioritySessionIds(
  sessions: readonly BrowserSession[],
  requests: readonly AgentAttention[],
): ReadonlySet<string> {
  const outstanding = new Set(requests
    .filter((request) => request.status === "waiting" || request.status === "pending")
    .map((request) => request.sessionId));
  return new Set(sessions
    .filter((session) =>
      Boolean(session.returnMarker) ||
      outstanding.has(session.id) ||
      (session.bootstrapIdentity?.publicId !== undefined &&
        outstanding.has(session.bootstrapIdentity.publicId)))
    .map((session) => session.id));
}

/** Listen for both in-window GMA changes and cross-window storage updates. */
export function useAttentionPrioritySessionIds(
  sessions: readonly BrowserSession[],
): ReadonlySet<string> {
  const [requests, setRequests] = useState(loadAgentAttention);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribes to the external attention registry to update sidebar priority.
  useEffect(() => {
    const refresh = () => setRequests(loadAgentAttention());
    const storageChanged = (event: StorageEvent) => {
      if (event.key === "t3.agent-attention.v1") refresh();
    };
    window.addEventListener(AGENT_ATTENTION_CHANGE_EVENT, refresh);
    window.addEventListener("storage", storageChanged);
    return () => {
      window.removeEventListener(AGENT_ATTENTION_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", storageChanged);
    };
  }, []);
  return attentionPrioritySessionIds(sessions, requests);
}

/** Mirror the notification queue's snooze state into the yellow sidebar marker.
 * The persistent Ctrl+D toggle stays armed, but the yellow outline must not
 * bypass the snoozed alert or cause Ctrl+S to re-open it. */
export function useSnoozedManualAttentionSessionIds(
  sessions: readonly BrowserSession[],
): ReadonlySet<string> {
  const [requests, setRequests] = useState(loadAgentAttention);
  const [now, setNow] = useState(Date.now);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Mirrors external notification changes and snooze deadlines into the yellow sidebar indicator.
  useEffect(() => {
    const refresh = () => { setRequests(loadAgentAttention()); setNow(Date.now()); };
    window.addEventListener(AGENT_ATTENTION_CHANGE_EVENT, refresh);
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      window.removeEventListener(AGENT_ATTENTION_CHANGE_EVENT, refresh);
      window.clearInterval(timer);
    };
  }, []);
  return new Set(sessions
    .filter((session) => isManualAttentionTemporarilySnoozed([
      session.id,
      ...(session.bootstrapIdentity?.publicId ? [session.bootstrapIdentity.publicId] : []),
    ], requests, now))
    .map((session) => session.id));
}
