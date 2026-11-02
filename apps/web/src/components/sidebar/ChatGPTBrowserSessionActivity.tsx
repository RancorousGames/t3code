import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { CircleIcon, GlobeIcon, LoaderCircleIcon, MoonIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

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
import { isPersistentChatGPTSessionOptedIn } from "../../browser/persistentChatGPTSessionMode";
import { usePersistentChatGPTSidebarActivity } from "./usePersistentChatGPTSidebarActivity";
import {
  hasHostedBrowserGuestTab,
  subscribeHostedBrowserGuestPresence,
} from "../../browser/hostedBrowserGuestPresence";
import { hasVerifiedEmptyChatGPTComposer } from "../../chatGPTDraftInspection";
import { observeChatGPTIdleSnapshot } from "../../chatGPTIdleTransitions";
import { inspectChatGPTBrowserHealth } from "../../chatGPTBrowserHealth";
import { saveChatGPTPageSnapshot } from "../../chatGPTPageSnapshot";
import { hasUncertainChatGPTSend, inspectBrowserSession } from "../../chatGPTSessionControl";
import { ingestChatGPTTranscript } from "../../state/chatGPTTranscriptIndex";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  chatGPTBrowserLastWorkingKey,
  chatGPTBrowserThreadRef,
  isChatGPTConversationUrl,
  readChatGPTBrowserSessions,
  wakeChatGPTBrowserSession,
  useChatGPTBrowserSessions,
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

// A guest preload pushes DOM-change hints at most once per second. The slow
// probe heartbeat remains necessary to detect blank or hung renderers.
const BROWSER_HEARTBEAT_MS = 30_000;
const ACTIVE_HEARTBEAT_MS = 5_000;
const UNHEALTHY_HEARTBEAT_MS = 10_000;
const WORKING_HEARTBEAT_MS = 30_000;

export function useChatGPTBrowserSessionActivity(
  environmentId: EnvironmentId,
  sessionId: string,
  snoozed = false,
  selected = false,
): {
  age: ChatGPTActivityAge;
  label: string;
  lastWorkingAt: number;
  recoveryProblem: ChatGPTRecoveryProblem | null;
  /** Chromium host residency, distinct from obsolete Electron webview attachment. */
  resident?: boolean | null;
} {
  const threadRef = useMemo(
    () => chatGPTBrowserThreadRef(environmentId, sessionId),
    [environmentId, sessionId],
  );
  const preview = useThreadPreviewState(threadRef);
  const { markHumanControlled } = useChatGPTBrowserSessions(environmentId);
  const ingestTranscript = useAtomCommand(ingestChatGPTTranscript, { reportFailure: false });
  const tabId = preview.activeTabId;
  const runtimeTabId = tabId ? previewRuntimeTabId(threadRef, preview.serverEpoch, tabId) : null;
  const unloaded = useChatGPTGuestHibernation((state) =>
    runtimeTabId ? selectChatGPTGuestHibernated(state, runtimeTabId) : false,
  );
  const attached = useSyncExternalStore(
    subscribeHostedBrowserGuestPresence,
    () => runtimeTabId !== null && hasHostedBrowserGuestTab(threadRef, runtimeTabId),
    () => false,
  );
  const [lastWorkingAt, setLastWorkingAt] = useLocalStorage(
    chatGPTBrowserLastWorkingKey(environmentId, sessionId),
    0,
    Schema.Number,
  );
  const isPersistentChromium = isPersistentChatGPTSessionOptedIn(sessionId);
  const chromiumActivity = usePersistentChatGPTSidebarActivity(
    sessionId,
    environmentId,
    isPersistentChromium,
    snoozed,
    lastWorkingAt,
    setLastWorkingAt,
    selected,
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
    let inspecting = false;
    let queuedPush = false;
    let indexTimer: ReturnType<typeof setTimeout> | undefined;
    let idleConfirmTimer: ReturnType<typeof setTimeout> | undefined;
    let lastIndexedRevision = "";
    let indexing = false;
    let pendingIndex = false;
    let latestIndexRevision = "";
    const queueIndex = (revision: string) => {
      latestIndexRevision = revision;
      if (!revision || revision === lastIndexedRevision || disposed) return;
      if (indexTimer !== undefined) clearTimeout(indexTimer);
      // Do not index every streaming mutation. Wait for the content to settle,
      // and read the currently mounted guest only; never wake an unloaded one.
      indexTimer = setTimeout(() => {
        indexTimer = undefined;
        if (indexing) {
          pendingIndex = true;
          return;
        }
        indexing = true;
        void (async () => {
          const entry = readChatGPTBrowserSessions(environmentId).find((s) => s.id === sessionId);
          if (!entry || disposed || isChatGPTGuestHibernated(runtimeTabId!)) return;
          const read = await inspectBrowserSession(environmentId, entry, "end", 20, true, 24_000);
          if (!read.url || !read.conversationId || !read.messages.length || disposed) return;
          const turns = read.messages.map((message) => ({
            conversationUrl: read.url!,
            sessionId,
            observedAt: read.statusObservedAt,
            role: message.role,
            turn: message.turn,
            index: message.turn,
            text: message.text,
            ...(message.turnKey ? { turnKey: message.turnKey } : {}),
            title: entry.title,
            project: entry.project ?? null,
          }));
          // The server deliberately accepts at most 40 turns per RPC. Never
          // acknowledge an indexed revision after a silently truncated batch.
          for (let offset = 0; offset < turns.length; offset += 40) {
            const batch = turns.slice(offset, offset + 40);
            const reply = await ingestTranscript({ environmentId, input: { turns: batch } });
            if (reply._tag !== "Success" || reply.value.processed !== batch.length) return;
          }
          lastIndexedRevision = revision;
        })()
          .catch((error: unknown) => {
            console.warn("[ChatGPT transcript index] Ingest unavailable", error);
          })
          .finally(() => {
            indexing = false;
            if (pendingIndex && !disposed) {
              pendingIndex = false;
              queueIndex(latestIndexRevision);
            }
          });
      }, 1_500);
    };
    previousState.current = "unknown";
    missingComposerObservations.current = 0;
    lastHeartbeatAt.current = 0;
    // Snooze blocks automatic loading, but an already-attached page can still
    // receive external messages. Observe that existing guest without waking it.
    if (isPersistentChromium || !runtimeTabId || (snoozed && !attached)) return;
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
            const webview = Array.from(
              document.querySelectorAll<HTMLElementTagNameMap["webview"]>(
                'webview, [data-t3-chromium-guest="true"]',
              ),
            ).find((element) => element.dataset.previewTab === runtimeTabId);
            if (webview) {
              // Guest preload confirms a new rendered user turn after a trusted
              // composer submission. No sidebar visibility or cached URL needed.
              const session = readChatGPTBrowserSessions(environmentId).find(
                (entry) => entry.id === sessionId,
              );
              if (session && !session.humanControlled) {
                try {
                  const observed: unknown = await webview.executeJavaScript(
                    `(() => {
                      const root = document.documentElement;
                      const verified = Number(root.getAttribute("data-t3code-human-chat-verified-at"));
                      return Number.isFinite(verified) && verified > 0;
                    })()`,
                  );
                  if (observed === true) markHumanControlled(sessionId);
                } catch {
                  // Guest reloads and navigation races should not affect status.
                }
              }
              const value = await inspectChatGPTBrowserHealth(webview, (snapshot) => {
                if (saveChatGPTPageSnapshot(environmentId, sessionId, snapshot))
                  queueIndex(
                    `${snapshot.conversationId}:${snapshot.contentHash}:${snapshot.turnCount}`,
                  );
                const currentSession = readChatGPTBrowserSessions(environmentId).find(
                  (s) => s.id === sessionId,
                );
                const currentNav = tabId
                  ? readThreadPreviewState(threadRef).sessions[tabId]?.navStatus
                  : null;
                if (
                  !currentSession ||
                  currentSession.hidden ||
                  currentNav?._tag !== "Success" ||
                  currentNav.url !== snapshot.url
                )
                  return;
                const idle = observeChatGPTIdleSnapshot(
                  environmentId,
                  sessionId,
                  currentSession.binding?.boundAt ?? null,
                  snapshot,
                );
                // Confirm apparent completion with a second real guest snapshot,
                // rather than treating a transient disappearance of Stop as idle.
                if (idle.confirmAgain && idleConfirmTimer === undefined) {
                  idleConfirmTimer = setTimeout(() => {
                    idleConfirmTimer = undefined;
                    if (!disposed)
                      window.dispatchEvent(
                        new CustomEvent("t3:chatgpt-page-push", {
                          detail: { runtimeTabId },
                        }),
                      );
                  }, 850);
                }
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
      const sessions = readChatGPTBrowserSessions(environmentId);
      const session = sessions.find((entry) => entry.id === sessionId);
      const managerIds = (() => {
        try {
          const raw = localStorage.getItem(
            `t3code:chatgpt-browser:verified-manager-retention:${environmentId}`,
          );
          const parsed: unknown = raw ? JSON.parse(raw) : null;
          const ids =
            parsed && typeof parsed === "object" ? (parsed as { ids?: unknown }).ids : null;
          return Array.isArray(ids) ? ids : [];
        } catch {
          return [];
        }
      })();
      const longIdle =
        !!session &&
        (session.humanControlled === true ||
          (!session.markedAsWorkerAt &&
            (managerIds.includes(sessionId) ||
              sessions.some((entry) => entry.parentSessionId === sessionId) ||
              !session.parentSessionId)));
      const touchedAt = chatGPTGuestTouchedAt(runtimeTabId);
      if (visible) touchChatGPTGuest(runtimeTabId, observedAt);
      else if (
        !hibernated &&
        shouldHibernateChatGPTGuest({
          visible,
          longIdle,
          onConversation: isOnConversation(),
          activity: next,
          lastWorkingAt: lastWorkingAtRef.current,
          // Give restored guests an idle window without changing their real-use order.
          touchedAt: Math.max(touchedAt ?? 0, firstObservedAt),
          now: observedAt,
        })
      ) {
        // Hibernation unmounts the guest and irreversibly loses in-memory
        // composer text. Unknown is NOT empty. Never wake or focus a guest.
        const attached = Array.from(
          document.querySelectorAll<HTMLElementTagNameMap["webview"]>(
            'webview, [data-t3-chromium-guest="true"]',
          ),
        ).find((element) => element.dataset.previewTab === runtimeTabId);
        const latest = tabId ? readThreadPreviewState(threadRef).sessions[tabId]?.navStatus : null;
        const provenEmpty =
          attached &&
          latest?._tag === "Success" &&
          (await hasVerifiedEmptyChatGPTComposer(attached, latest.url)) &&
          Array.from(
            document.querySelectorAll<HTMLElementTagNameMap["webview"]>(
              'webview, [data-t3-chromium-guest="true"]',
            ),
          ).some((element) => element === attached && element.dataset.previewTab === runtimeTabId);
        // The DOM can change while the two composer checks are pending.
        // Revalidate the actual activity and route before releasing the renderer.
        let stillIdle = false;
        if (provenEmpty && attached) {
          try {
            const latestNav = tabId
              ? readThreadPreviewState(threadRef).sessions[tabId]?.navStatus
              : null;
            stillIdle =
              (await attached.executeJavaScript(CHATGPT_ACTIVITY_EXPRESSION)) === "idle" &&
              latestNav?._tag === "Success" &&
              latestNav.url === latest.url;
          } catch {
            stillIdle = false;
          }
        }
        if (
          !disposed &&
          provenEmpty &&
          stillIdle &&
          !hasUncertainChatGPTSend(environmentId, sessionId) &&
          useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.visible !== true
        ) {
          hibernateChatGPTGuest(runtimeTabId);
          next = "idle";
          reason = null;
        } else if (!disposed) {
          reason = hasUncertainChatGPTSend(environmentId, sessionId)
            ? "Guest kept loaded: an earlier ChatGPT send has no verified delivery receipt."
            : "Guest kept loaded: page activity, route or empty composer could not be verified.";
        }
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
      if (previousState.current !== next) {
        if (snoozed && !hibernated && previousState.current !== "unknown" && next !== "unknown") {
          wakeChatGPTBrowserSession(environmentId, sessionId);
        }
        window.dispatchEvent(
          new CustomEvent("t3:chatgpt-recovery-state-changed", {
            detail: { environmentId, sessionId },
          }),
        );
      }
      previousState.current = next;
      setResult((current) =>
        current.tabId === runtimeTabId && current.activity === next && current.reason === reason
          ? current
          : { tabId: runtimeTabId, activity: next, reason },
      );
    };
    const scheduleInspect = () => {
      if (disposed) return;
      if (inspecting) {
        queuedPush = true;
        return;
      }
      if (timer !== undefined) clearTimeout(timer);
      inspecting = true;
      void inspect().finally(() => {
        inspecting = false;
        if (disposed) return;
        if (queuedPush) {
          queuedPush = false;
          timer = setTimeout(scheduleInspect, 0);
        } else {
          const delay =
            missingComposerObservations.current === 1
              ? 1_000
              : previousState.current === "working" || previousState.current === "interrupted"
                ? ACTIVE_HEARTBEAT_MS
                : previousState.current === "invalid" || previousState.current === "unknown"
                  ? UNHEALTHY_HEARTBEAT_MS
                  : BROWSER_HEARTBEAT_MS;
          timer = setTimeout(scheduleInspect, delay);
        }
      });
    };
    const onPagePush = (event: Event) => {
      const detail = (event as CustomEvent<{ runtimeTabId?: string }>).detail;
      if (detail?.runtimeTabId === runtimeTabId) scheduleInspect();
    };
    window.addEventListener("t3:chatgpt-page-push", onPagePush);
    scheduleInspect();
    return () => {
      disposed = true;
      window.removeEventListener("t3:chatgpt-page-push", onPagePush);
      if (timer !== undefined) clearTimeout(timer);
      if (indexTimer !== undefined) clearTimeout(indexTimer);
      if (idleConfirmTimer !== undefined) clearTimeout(idleConfirmTimer);
    };
  }, [
    isPersistentChromium,
    runtimeTabId,
    setLastWorkingAt,
    snoozed,
    attached,
    tabId,
    threadRef,
    ingestTranscript,
  ]);

  // Browser presence can change without a ChatGPT DOM push (detach, reattach).
  // Reinspect after attaching rather than waiting for an idle heartbeat.
  useEffect(() => {
    if (!isPersistentChromium && attached && runtimeTabId)
      window.dispatchEvent(
        new CustomEvent("t3:chatgpt-page-push", {
          detail: { runtimeTabId },
        }),
      );
  }, [isPersistentChromium, attached, runtimeTabId]);

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
  // A recent answer or stale navigation overlay is not proof of a resident
  // browser guest. Missing/hibernated guests must remain visibly unloaded.
  const notResident = unloaded || !attached;
  const age = snoozed
    ? "snoozed"
    : notResident
      ? "unloaded"
      : chatGPTActivityAge(activity, lastWorkingAt, now);
  const reason = result.tabId === runtimeTabId ? result.reason : null;
  const label =
    age === "snoozed"
      ? "ChatGPT is snoozed; unsnooze to reload the conversation"
      : age === "unloaded"
        ? "ChatGPT is unloaded; open to reload the conversation"
        : age === "working"
          ? "ChatGPT is working"
          : age === "recent"
            ? "ChatGPT worked within the last 2 hours"
            : age === "inactive"
              ? "ChatGPT is inactive; no work in the last 2 hours"
              : age === "interrupted"
                ? "ChatGPT connection interrupted; waiting for the complete answer"
                : age === "delivery-timeout"
                  ? "ChatGPT message delivery timed out; please try again"
                  : age === "invalid"
                    ? reason === "browser-unresponsive"
                      ? "ChatGPT browser is blank or unresponsive; waiting for an instance reset"
                      : `ChatGPT page unavailable${reason ? `: ${reason}` : ""}`
                    : reason === "ChatGPT settings open"
                      ? "ChatGPT settings open"
                      : `ChatGPT status unknown${reason ? `: ${reason}` : ""}`;
  const recoveryProblem =
    !snoozed && !notResident && result.tabId === runtimeTabId
      ? chatGPTRecoveryProblem(activity === "invalid" ? `invalid: ${reason ?? ""}` : activity)
      : null;
  return isPersistentChromium ? chromiumActivity : { age, label, lastWorkingAt, recoveryProblem };
}

/** Shared status glyph. Its containing button is also the drag handle. */
export function ChatGPTBrowserSessionActivityIcon({
  age,
  recovering = false,
}: {
  readonly age: ChatGPTActivityAge;
  readonly recovering?: boolean;
}) {
  if (age === "snoozed") return <MoonIcon aria-hidden className="size-4" />;
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
