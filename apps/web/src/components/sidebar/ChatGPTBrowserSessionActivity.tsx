import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { CircleIcon, GlobeIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useBrowserSurfaceStore } from "../../browser/browserSurfaceStore";
import {
  chatGPTGuestTouchedAt,
  hibernateChatGPTGuest,
  isChatGPTGuestHibernated,
  selectChatGPTGuestHibernated,
  shouldHibernateChatGPTGuest,
  touchChatGPTGuest,
  useChatGPTGuestHibernation,
} from "../../browser/chatGPTGuestHibernation";
import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import {
  chatGPTBrowserLastWorkingKey,
  chatGPTBrowserThreadRef,
  isChatGPTConversationUrl,
} from "../../chatGPTBrowserSessions";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { readThreadPreviewState, useThreadPreviewState } from "../../previewStateStore";
import { chatGPTRecoveryProblem, type ChatGPTRecoveryProblem } from "./chatGPTConversationRecovery";
import {
  CHATGPT_ACTIVITY_EXPRESSION,
  CHATGPT_RECENT_ACTIVITY_MS,
  chatGPTActivityAge,
  type ChatGPTActivityAge,
  type ChatGPTActivityState,
} from "./chatGPTActivity";

const POLL_INTERVAL_MS = 2_000;
// Each probe runs inside the guest; dozens of background guests add up.
const BACKGROUND_POLL_INTERVAL_MS = 6_000;
const WORKING_HEARTBEAT_MS = 30_000;

export function useChatGPTBrowserSessionActivity(
  environmentId: EnvironmentId,
  sessionId: string,
): {
  age: ChatGPTActivityAge;
  label: string;
  lastWorkingAt: number;
  recoveryProblem: ChatGPTRecoveryProblem | null;
} {
  const threadRef = useMemo(
    () => chatGPTBrowserThreadRef(environmentId, sessionId),
    [environmentId, sessionId],
  );
  const preview = useThreadPreviewState(threadRef);
  const tabId = preview.activeTabId;
  const runtimeTabId = tabId ? previewRuntimeTabId(threadRef, preview.serverEpoch, tabId) : null;
  const unloaded = useChatGPTGuestHibernation((state) =>
    runtimeTabId ? selectChatGPTGuestHibernated(state, runtimeTabId) : false,
  );
  const [lastWorkingAt, setLastWorkingAt] = useLocalStorage(
    chatGPTBrowserLastWorkingKey(environmentId, sessionId),
    0,
    Schema.Number,
  );
  const lastWorkingAtRef = useRef(lastWorkingAt);
  useEffect(() => {
    lastWorkingAtRef.current = lastWorkingAt;
  }, [lastWorkingAt]);
  const [now, setNow] = useState(() => Date.now());
  const previousState = useRef<ChatGPTActivityState>("unknown");
  const missingComposerObservations = useRef(0);
  const lastHeartbeatAt = useRef(0);
  const [result, setResult] = useState<{
    tabId: string | null;
    activity: ChatGPTActivityState;
    reason: string | null;
  }>({ tabId: null, activity: "unknown", reason: null });

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    previousState.current = "unknown";
    missingComposerObservations.current = 0;
    lastHeartbeatAt.current = 0;
    if (!runtimeTabId) return;
    const firstObservedAt = Date.now();

    const isOnConversation = () => {
      const nav = tabId ? readThreadPreviewState(threadRef).sessions[tabId]?.navStatus : null;
      return nav?._tag === "Success" && isChatGPTConversationUrl(nav.url);
    };

    const inspect = async () => {
      let next: ChatGPTActivityState = "unknown";
      let reason: string | null = "the browser page is not attached";
      // Only real display counts as use: recovery probes also hold surface activity.
      const visible = useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.visible === true;
      const hibernated = isChatGPTGuestHibernated(runtimeTabId);
      // Hibernation only happens while not working, so idle is the last truth.
      if (hibernated) {
        next = "idle";
        reason = null;
      } else
        try {
          const state = readThreadPreviewState(threadRef);
          const nav = tabId ? state.sessions[tabId]?.navStatus : null;
          const loading = tabId ? state.desktopByTabId[tabId]?.loading : false;
          if (nav?._tag === "LoadFailed") {
            next = "invalid";
            reason = nav.description || "the ChatGPT page failed to load";
          } else {
            // The navigation overlay can remain "Loading" even after ChatGPT has
            // rendered its own conversation failure panel. Inspect the attached
            // guest anyway: the session-control reader does so and correctly
            // identifies these failures, while the old sidebar stayed grey.
            const isLoading = nav?._tag === "Loading" || loading;
            reason = isLoading ? "the page is loading" : reason;
            const webview = Array.from(document.querySelectorAll("webview")).find(
              (element) => element.dataset.previewTab === runtimeTabId,
            );
            if (webview) {
              let deadline: ReturnType<typeof setTimeout> | undefined;
              const value = await Promise.race([
                webview.executeJavaScript(CHATGPT_ACTIVITY_EXPRESSION),
                new Promise<string>((resolve) => {
                  deadline = setTimeout(
                    () => resolve("unknown: ChatGPT inspection timed out"),
                    4_000,
                  );
                }),
              ]).finally(() => {
                if (deadline !== undefined) clearTimeout(deadline);
              });
              if (
                value === "working" ||
                value === "idle" ||
                value === "interrupted" ||
                value === "delivery-timeout"
              ) {
                next = value;
                reason =
                  value === "interrupted"
                    ? "waiting for the complete answer"
                    : value === "delivery-timeout"
                      ? "Message delivery timed out. Please try again."
                      : null;
              } else if (typeof value === "string" && value.startsWith("invalid: ")) {
                next =
                  value === "invalid: the ChatGPT composer is unavailable" && isLoading
                    ? "unknown"
                    : "invalid";
                reason = value.slice(9);
              } else if (typeof value === "string" && value.startsWith("unknown: ")) {
                reason = value.slice(9);
              } else reason = "page inspection returned an unexpected result";
            }
          }
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
        }
      if (disposed) return;

      // A successful navigation can briefly have no composer during hydration.
      // Require two consecutive observations before showing it as unavailable.
      if (next === "invalid" && reason === "the ChatGPT composer is unavailable") {
        missingComposerObservations.current++;
        if (missingComposerObservations.current < 2) {
          next = "unknown";
          reason = "checking the ChatGPT composer";
        }
      } else missingComposerObservations.current = 0;

      const observedAt = Date.now();
      const touchedAt = chatGPTGuestTouchedAt(runtimeTabId);
      if (visible) touchChatGPTGuest(runtimeTabId, observedAt);
      else if (
        !hibernated &&
        shouldHibernateChatGPTGuest({
          visible,
          onConversation: isOnConversation(),
          activity: next,
          lastWorkingAt: lastWorkingAtRef.current,
          // Give restored guests an idle window without changing their real-use order.
          touchedAt: Math.max(touchedAt ?? 0, firstObservedAt),
          now: observedAt,
        })
      ) {
        hibernateChatGPTGuest(runtimeTabId);
        next = "idle";
        reason = null;
      }
      if (next === "working") {
        // Persist a heartbeat rather than writing localStorage on every 2s probe.
        if (
          previousState.current !== "working" ||
          observedAt - lastHeartbeatAt.current >= WORKING_HEARTBEAT_MS
        ) {
          lastHeartbeatAt.current = observedAt;
          setLastWorkingAt(observedAt);
          setNow(observedAt);
        }
      } else if (previousState.current === "working") {
        // Timestamp the observed stop, rather than the preceding heartbeat.
        setLastWorkingAt(observedAt);
        setNow(observedAt);
      }
      previousState.current = next;
      setResult((current) =>
        current.tabId === runtimeTabId && current.activity === next && current.reason === reason
          ? current
          : { tabId: runtimeTabId, activity: next, reason },
      );
      timer = setTimeout(
        () => void inspect(),
        visible ? POLL_INTERVAL_MS : BACKGROUND_POLL_INTERVAL_MS,
      );
    };
    void inspect();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [runtimeTabId, setLastWorkingAt, tabId, threadRef]);

  // Reclassify recently finished sessions as old even when the browser
  // remains idle, without making every row repaint once per second.
  useEffect(() => {
    if (lastWorkingAt <= 0) return;
    const remaining = lastWorkingAt + CHATGPT_RECENT_ACTIVITY_MS - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), remaining + 1);
    return () => clearTimeout(timer);
  }, [lastWorkingAt]);

  const activity = result.tabId === runtimeTabId ? result.activity : "unknown";
  const age = unloaded ? "unloaded" : chatGPTActivityAge(activity, lastWorkingAt, now);
  const reason = result.tabId === runtimeTabId ? result.reason : null;
  const label =
    age === "unloaded"
      ? "ChatGPT is unloaded; open to reload the conversation"
      : age === "working"
        ? "ChatGPT is working"
        : age === "recent"
          ? "ChatGPT worked within the last 15 minutes"
          : age === "inactive"
            ? "ChatGPT is inactive; no work in the last 15 minutes"
            : age === "interrupted"
              ? "ChatGPT connection interrupted; waiting for the complete answer"
              : age === "delivery-timeout"
                ? "ChatGPT message delivery timed out; please try again"
                : age === "invalid"
                  ? `ChatGPT page unavailable${reason ? `: ${reason}` : ""}`
                  : `ChatGPT status unknown${reason ? `: ${reason}` : ""}`;
  const recoveryProblem =
    !unloaded && result.tabId === runtimeTabId
      ? chatGPTRecoveryProblem(activity === "invalid" ? `invalid: ${reason ?? ""}` : activity)
      : null;
  return { age, label, lastWorkingAt, recoveryProblem };
}

/** Shared status glyph. Its containing button is also the drag handle. */
export function ChatGPTBrowserSessionActivityIcon({
  age,
  recovering = false,
}: {
  readonly age: ChatGPTActivityAge;
  readonly recovering?: boolean;
}) {
  if (recovering)
    return (
      <LoaderCircleIcon
        aria-hidden
        className="size-4 animate-spin motion-reduce:animate-none"
        style={{ animationDuration: "3s" }}
      />
    );
  return age === "unknown" ? (
    <GlobeIcon aria-hidden className="size-4" />
  ) : (
    <CircleIcon aria-hidden className="size-3 fill-current" />
  );
}
