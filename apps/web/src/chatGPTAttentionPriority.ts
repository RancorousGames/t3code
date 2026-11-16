import { useEffect, useMemo, useState } from "react";
import type { BrowserSession } from "./chatGPTBrowserSessions";
import {
  AGENT_ATTENTION_CHANGE_EVENT,
  loadAgentAttention,
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
  return useMemo(() => attentionPrioritySessionIds(sessions, requests), [sessions, requests]);
}
