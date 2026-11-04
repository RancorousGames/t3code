import { useEffect, useRef, useState } from "react";
import { recordChatGPTProviderActivity } from "../../chatGPTProviderActivity";
import { wakeChatGPTBrowserSession } from "../../chatGPTBrowserSessions";
import { getChatGPTSessionPersistedStore } from "../../chatGPTSessionPersistedStore";
import { chatGPTConversationIdFromUrl } from "../../chatGPTConversationIdentity";
import { readChatGPTSessionProfileId } from "../../chatGPTAccountProfiles";
import { inspectChatGPTPageSnapshot, saveChatGPTPageSnapshot, type ChatGPTPageSnapshot } from "../../chatGPTPageSnapshot";
import { observeChatGPTIdleSnapshot } from "../../chatGPTIdleTransitions";

import {
  CHATGPT_ACTIVITY_EXPRESSION,
  chatGPTActivityAge,
  unloadedChatGPTActivityAge,
  type ChatGPTActivityAge,
  type ChatGPTActivityState,
} from "./chatGPTActivity";
import { chatGPTRecoveryProblem, type ChatGPTRecoveryProblem } from "./chatGPTConversationRecovery";
import { noteRecoveryVerified } from "./chatGPTRecoveryQueue";
import { logChatGPTRecoveryHealth } from "../../chatGPTRecoveryTimeline";
import { recordWarmActivityObservation, wasWarmSessionActiveBeforeFailure } from "../../omniwork/chatGPTWarmPriorityHistory";

// The persistent browser host owns page liveness, not Electron's preview tabs.
// Poll read-only IPC only: NEVER attach, navigate, wake, reset or reload a page.
type Observation = {
  readonly resident: boolean | null;
  readonly activity: ChatGPTActivityState;
  readonly reason: string | null;
};
const INITIAL: Observation = { resident: null, activity: "unknown", reason: null };
const FOREGROUND_POLL_MS = 1_250;
const WORKING_POLL_MS = 5_000;
const IDLE_POLL_MS = 30_000;
const MISSING_POLL_MS = 10_000;

export function usePersistentChatGPTSidebarActivity(
  sessionId: string,
  environmentId: string,
  enabled: boolean,
  snoozed: boolean,
  lastWorkingAt: number,
  setLastWorkingAt: (value: number) => void,
  selected = false,
): {
  age: ChatGPTActivityAge;
  label: string;
  lastWorkingAt: number;
  recoveryProblem: ChatGPTRecoveryProblem | null;
  resident: boolean | null;
} {
  const [observation, setObservation] = useState<Observation>(INITIAL);
  const [now, setNow] = useState(() => Date.now());
  const latestWorkingAt = useRef(lastWorkingAt);
  latestWorkingAt.current = lastWorkingAt;

  useEffect(() => {
    // A read-only probe never wakes, attaches or navigates a Chromium page.
    // Keep probing snoozed sessions too: the host may already be working even
    // when T3 first mounts their sidebar row with residency unknown.
    if (!enabled) return;
    let disposed = false;
    let previousActivity = observation.activity;
    let previousResidency = observation.resident;
    let next: ReturnType<typeof setTimeout> | undefined;
    let inspecting = false;
    let queued = false;
    // Foreground selection deserves low-latency reads; all other sessions
    // retain slow, read-only polling. Never accumulate overlapping IPC calls.
    const schedule = (delayMs: number) => {
      if (disposed) return;
      if (next !== undefined) clearTimeout(next);
      next = setTimeout(() => void probe(), delayMs);
    };
    const probe = async () => {
      if (disposed) return;
      if (inspecting) {
        queued = true;
        return;
      }
      inspecting = true;
      let observed: Observation = INITIAL;
      let confirmIdleSoon = false;
      try {
        const bridge = window.desktopBridge?.stableChatGPTViewRequest;
        if (!bridge) throw new Error("The Chromium host is unavailable");
        // The owner-side probe reads missing native sessions without throwing
        // thousands of IPC errors or mistaking another profile for an empty slot.
        // Secondary-account tabs have a different immutable Chromium
        // partition. Probing them as "default" reports a false mismatch and
        // makes loaded, healthy sessions appear permanently unavailable.
        const identity = {
          sessionId,
          environmentId,
          profileId: readChatGPTSessionProfileId(environmentId, sessionId),
        };
        const status = (await bridge({ operation: "probe", identity })) as {
          residency?: "resident" | "missing" | "mismatch";
          destroyed?: boolean;
          loading?: boolean;
          loadError?: string | null;
          url?: string;
        };
        if (status.residency === "missing") {
          observed = { resident: false, activity: "unknown", reason: "Persistent Chromium page is not attached" };
        } else if (status.residency !== "resident" || status.destroyed || !status.url) {
          throw new Error("Chromium host identity or residency is unverified");
        } else {
        observed = {
          resident: true,
          activity: "unknown",
          reason: status.loading ? "ChatGPT is loading" : null,
        };
        if (status.loadError && !status.loading) {
          observed = {
            resident: true,
            activity: "invalid",
            reason: `Browser load failed: ${status.loadError}`,
          };
        } else if (!status.loading) {
          const response = (await bridge({
            operation: "evaluate",
            identity,
            // Persistent Chromium must use the SAME verified idle transition
            // reducer as legacy webviews. Activity-only probes never emitted
            // idle events, leaving Caffy idle_waking permanently inert.
            expression: `(() => { const activity = ${CHATGPT_ACTIVITY_EXPRESSION};
              return { activity, snapshot: (${inspectChatGPTPageSnapshot.toString()})(String(activity ?? "unknown")) }; })()`,
          })) as { result?: string | { activity?: string; snapshot?: ChatGPTPageSnapshot | null } };
          const activity = typeof response.result === "string" ? response.result : response.result?.activity;
          const page = typeof response.result === "object" ? response.result.snapshot : null;
          const session = getChatGPTSessionPersistedStore(environmentId)
            .getState().sessions.find(row => row.id === sessionId);
          // BrowserSession does NOT have a conversationId property. Gating on
          // session.conversationId silently dropped every snapshot and idle
          // completion event from native Chromium. Compare the actual live
          // document and status URLs instead, and require the session to exist.
          if (session && session.hidden !== true && page?.url === status.url &&
              page.conversationId === chatGPTConversationIdFromUrl(status.url)) {
            saveChatGPTPageSnapshot(environmentId, sessionId, page);
            const idle = observeChatGPTIdleSnapshot(environmentId, sessionId,
              session.binding?.boundAt ?? null, page);
            confirmIdleSoon = idle.confirmAgain;
          }
          if (
            activity === "working" ||
            activity === "idle" ||
            activity === "interrupted" ||
            activity === "delivery-timeout"
          ) {
            observed = { resident: true, activity, reason: null };
          } else if (activity === "invalid: the ChatGPT composer is unavailable") {
            // Missing composer does not prove a failure during React hydration.
            // Only explicit error UI or a failed Chromium load enters recovery.
            observed = {
              resident: true,
              activity: "unknown",
              reason: "ChatGPT composer not yet available",
            };
          } else if (typeof activity === "string" && activity.startsWith("invalid: ")) {
            observed = { resident: true, activity: "invalid", reason: activity.slice(9) };
          } else if (typeof activity === "string" && activity.startsWith("unknown: ")) {
            observed = { resident: true, activity: "unknown", reason: activity.slice(9) };
          }
        }
        }
      } catch (error) {
        // An IPC transport error is not evidence that Chromium is unloaded.
        // A missing page is reported explicitly by probe; transport errors
        // and profile mismatches never trigger automatic reattachment.
        observed = { resident: null, activity: "unknown", reason: "Chromium status temporarily unavailable" };
      }
      if (disposed) {
        inspecting = false;
        return;
      }
      if (
        observed.resident === true &&
        (observed.activity === "idle" || observed.activity === "working")
      ) {
        // A successful manual refresh is authoritative even after a real
        // failure 20 minutes ago. Remove stale recovery before the next scan.
        noteRecoveryVerified(environmentId, sessionId);
      }
      // Only verified DOM observations count as a healthy ChatGPT page;
      // presence and did-stop-loading alone never prove recovery.
      const observationState =
        observed.resident === false
          ? "missing"
          : observed.resident === null
            ? "unknown"
            : observed.activity;
      logChatGPTRecoveryHealth(
        environmentId,
        "native",
        sessionId,
        `chatgpt:${observationState}`,
        observed.activity === "idle" || observed.activity === "working"
          ? `ChatGPT DOM verified: ${observed.activity}; composer/activity checks succeeded.`
          : observed.reason
            ? `ChatGPT health: ${observationState} (${observed.reason.slice(0, 160)})`
            : `ChatGPT health: ${observationState}; not independently verified healthy.`,
      );
      const changed = previousActivity !== observed.activity ||
        previousResidency !== observed.resident;
      if (changed && observed.resident === true) {
        recordWarmActivityObservation(environmentId, sessionId, observed.activity);
      }
      if (changed) {
        // Downstream recovery/ordering subscribes to state changes, not merely
        // the legacy webview push notifications.
        window.dispatchEvent(
          new CustomEvent("t3:chatgpt-recovery-state-changed", {
            detail: { environmentId, sessionId },
          }),
        );
      }
      if (
        snoozed &&
        observed.resident === true &&
        previousActivity !== "unknown" &&
        observed.activity !== "unknown" &&
        previousActivity !== observed.activity
      ) {
        wakeChatGPTBrowserSession(environmentId, sessionId);
      }
      if (
        (observed.activity === "working" && previousActivity !== "working") ||
        (previousActivity === "working" && observed.activity === "idle")
      ) {
        latestWorkingAt.current = Date.now();
        setLastWorkingAt(latestWorkingAt.current);
      }
      if (observed.resident === true)
        recordChatGPTProviderActivity(environmentId, sessionId, observed.activity);
      previousActivity = observed.activity;
      previousResidency = observed.resident;
      setObservation((previous) =>
        previous.resident === observed.resident &&
        previous.activity === observed.activity &&
        previous.reason === observed.reason
          ? previous
          : observed,
      );
      if (observed.activity === "working" && Date.now() - latestWorkingAt.current > 60_000) {
        latestWorkingAt.current = Date.now();
        setLastWorkingAt(latestWorkingAt.current);
      }
      setNow(Date.now());
      inspecting = false;
      if (queued) {
        queued = false;
        schedule(0);
      } else {
        schedule(
          confirmIdleSoon ? 850
          : selected
            ? FOREGROUND_POLL_MS
            : observed.resident === false
              ? MISSING_POLL_MS
              : observed.activity === "working"
                ? WORKING_POLL_MS
                : observed.activity === "unknown"
                  ? 2_500
                  : IDLE_POLL_MS,
        );
      }
    };
    // A selected Chromium surface also emits this hint; never depend on it
    // because background pages remain resident with no mounted surface.
    const onPush = (event: Event) => {
      const target = (
        event as CustomEvent<{
          sessionId?: string;
          environmentId?: string;
        }>
      ).detail;
      if (target?.sessionId && target.sessionId !== sessionId) return;
      if (target?.environmentId && target.environmentId !== environmentId) return;
      schedule(100);
    };
    const onVisibility = () => {
      if (selected && document.visibilityState === "visible") schedule(0);
    };
    window.addEventListener("t3:chromium-sidebar-probe", onPush);
    // Native events include manual refreshes on background pages. Inspect the
    // live document on every transition rather than trusting old queue state.
    const unsubscribeNative = window.desktopBridge?.onStableChatGPTViewState?.((state) => {
      if (state.environmentId !== environmentId || state.sessionId !== sessionId) return;
      schedule(0);
    });
    document.addEventListener("visibilitychange", onVisibility);
    void probe();
    return () => {
      disposed = true;
      if (next !== undefined) clearTimeout(next);
      window.removeEventListener("t3:chromium-sidebar-probe", onPush);
      unsubscribeNative?.();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [
    enabled,
    sessionId,
    environmentId,
    setLastWorkingAt,
    snoozed,
    observation.resident,
    selected,
  ]);

  const age: ChatGPTActivityAge = snoozed
    ? "snoozed"
    : observation.resident === false
      ? unloadedChatGPTActivityAge(
          lastWorkingAt, wasWarmSessionActiveBeforeFailure(environmentId, sessionId), now,
        )
      : chatGPTActivityAge(observation.activity, lastWorkingAt, now);
  const label = snoozed
    ? "ChatGPT is snoozed"
    : age === "unloaded-working"
      ? "Persistent Chromium page unloaded while working (within 2 hours)"
    : age === "unloaded-recent"
      ? "Persistent Chromium page unloaded; recently worked (within 2 hours)"
    : observation.resident === false
      ? "Persistent Chromium page is not loaded"
      : observation.resident === null
        ? "Checking persistent Chromium session"
        : age === "working"
          ? "ChatGPT is working in persistent Chromium"
          : age === "recent"
            ? "ChatGPT worked within the last 2 hours"
            : age === "inactive"
              ? "ChatGPT is idle in persistent Chromium"
              : age === "interrupted"
                ? "ChatGPT connection interrupted"
                : age === "delivery-timeout"
                  ? "ChatGPT message delivery timed out"
                  : age === "invalid"
                    ? `ChatGPT page unavailable: ${observation.reason ?? "unknown error"}`
                    : (observation.reason ?? "Checking ChatGPT page activity");

  const recoveryProblem =
    observation.resident === true
      ? chatGPTRecoveryProblem(
          observation.activity === "invalid"
            ? `invalid: ${observation.reason ?? ""}`
            : observation.activity,
        )
      : null;
  return { age, label, lastWorkingAt, recoveryProblem, resident: observation.resident };
}
