import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";
import { useStore } from "zustand";

import { useChatGPTBrowserSessions } from "../../chatGPTBrowserSessions";
import { readChatGPTRestartContinuationEnabled } from "../../omniwork/chatGPTRestartContinuationSetting";
import { getChatGPTSessionPersistedStore } from "../../chatGPTSessionPersistedStore";
import {
  hasUncertainChatGPTSend,
  runChatGPTSessionControl,
} from "../../chatGPTSessionControl";
import {
  chatGPTRestartSource,
  decideChatGPTRestartContinuation,
  type ChatGPTRestartSource,
} from "../../omniwork/chatGPTRestartContinuationPolicy";

const MODULE_STARTED_AT = Date.now();
const sourcesByEnvironment = new Map<string, ReadonlyMap<string, ChatGPTRestartSource>>();
const inFlight = new Set<string>();
const continuePrompt = "Continue where you left off.";
const statusKey = (environmentId: string, source: ChatGPTRestartSource) =>
  `t3code:chatgpt-browser:restart-continuation:v1:${environmentId}:${source.sessionId}`;

/** Durable once-per-old-generation intent; write BEFORE dispatch. Any ambiguous
 * outcome blocks retries, even across a second T3 restart. */
function markDispatch(
  environmentId: string,
  source: ChatGPTRestartSource,
): boolean {
  const key = statusKey(environmentId, source);
  const fingerprint = `${source.conversationId}:${source.observedAt}:${source.contentHash}`;
  try {
    const old = window.localStorage.getItem(key);
    if (old) {
      const previous = JSON.parse(old) as { fingerprint?: string; state?: string };
      if (previous.fingerprint === fingerprint) return false;
      // A later T3 restart must not replace an uncertain earlier attempt
      // for this same conversation just because observedAt changed.
      if (previous.fingerprint?.startsWith(`${source.conversationId}:`) &&
          (previous.state === "attempting" || previous.state === "uncertain"))
        return false;
    }
    window.localStorage.setItem(key, JSON.stringify({
      fingerprint, state: "attempting", at: Date.now(),
    }));
    return true;
  } catch {
    // Without durable write-ahead evidence no automation may send a turn.
    return false;
  }
}

function markResult(
  environmentId: string, source: ChatGPTRestartSource, state: "confirmed" | "uncertain" | "skipped",
): void {
  try {
    window.localStorage.setItem(statusKey(environmentId, source), JSON.stringify({
      fingerprint: `${source.conversationId}:${source.observedAt}:${source.contentHash}`,
      state, at: Date.now(),
    }));
  } catch {
    // The attempt was claimed in memory, so this renderer never blindly retries.
  }
}

/**
 * Mounted once by the guest retention root, NOT per tab. Captures restart
 * evidence before the first fresh guest probe. Neither boot nor observation
 * wakes a guest; the separate guarded startup policy selects the small set
 * that should be remounted.
 */
export function ChatGPTRestartContinuation({ environmentId }: {
  readonly environmentId: EnvironmentId;
}) {
  const store = useMemo(() => getChatGPTSessionPersistedStore(environmentId), [environmentId]);
  const snapshots = useStore(store, (state) => state.snapshots);
  const { sessions } = useChatGPTBrowserSessions(environmentId);
  if (!sourcesByEnvironment.has(environmentId) && sessions.length > 0) {
    const eligible = new Map<string, ChatGPTRestartSource>();
    for (const session of sessions) {
      const source = chatGPTRestartSource(session, snapshots[session.id], MODULE_STARTED_AT);
      // Evidence from this renderer is ordinary activity, NOT a restart signal.
      if (source && source.observedAt < MODULE_STARTED_AT) eligible.set(session.id, source);
    }
    sourcesByEnvironment.set(environmentId, eligible);
  }
  const sources = sourcesByEnvironment.get(environmentId);

  useEffect(() => {
    if (!sources?.size || !readChatGPTRestartContinuationEnabled()) return;
    for (const source of sources.values()) {
      const session = sessions.find((entry) => entry.id === source.sessionId);
      if (!session || session.hidden || session.completion ||
        (session.lastDirectInteractionAt ?? 0) > source.observedAt ||
        (session.snoozedUntil ?? 0) > Date.now() ||
        !["manager", "worker"].includes(session.binding?.role ?? "")) continue;
      if (decideChatGPTRestartContinuation(
        source, snapshots[source.sessionId], Date.now(),
        hasUncertainChatGPTSend(environmentId, source.sessionId),
      ) !== "continue") continue;

      const operation = statusKey(environmentId, source);
      if (inFlight.has(operation) || !markDispatch(environmentId, source)) continue;
      inFlight.add(operation);
      void (async () => {
        try {
          // Another wake or user turn may have arrived since the saved snapshot.
          // Inspect the exact live guest again; if it advanced, do not submit.
          const before = await runChatGPTSessionControl({
            environmentId, sessions, action: "read", sessionId: source.sessionId,
            expectedConversationId: source.conversationId, from: "end", count: 1,
          });
          const actual = before && typeof before === "object" && "session" in before
            ? (before as { session?: {
              totalTurns?: number;
              status?: string;
              lastRole?: string | null;
            } }).session : null;
          if (actual?.totalTurns !== source.turnCount || actual.status !== "done_or_idle" ||
              actual.lastRole !== "assistant" ||
              hasUncertainChatGPTSend(environmentId, source.sessionId)) {
            markResult(environmentId, source, "skipped");
            return;
          }
          // Guest control rechecks URL, composer, draft, UNKNOWN and delivery.
          const result = await runChatGPTSessionControl({
            environmentId, sessions, action: "send", sessionId: source.sessionId,
            expectedConversationId: source.conversationId,
            message: continuePrompt,
          });
          const receipt = result as { delivery?: string } | null;
          markResult(environmentId, source,
            receipt?.delivery === "user_turn_observed" ? "confirmed" : "uncertain");
        } catch {
          markResult(environmentId, source, "uncertain");
          // Never replay. A human can inspect the exact thread and receipt.
        } finally {
          inFlight.delete(operation);
        }
      })();
    }
  }, [environmentId, sessions, snapshots, sources]);
  return null;
}
