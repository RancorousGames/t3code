import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { isPersistentChatGPTSessionOptedIn } from "../../browser/persistentChatGPTSessionMode";
import { guardedNativeChatGPTReload } from "../../browser/guardedNativeChatGPTReload";
import { chatGPTBrowserLastUrlKey, readChatGPTBrowserSessions } from "../../chatGPTBrowserSessions";
import { chatGPTSessionProfileId } from "../../chatGPTAccountProfiles";
import { chatGPTConversationIdFromUrl } from "../../chatGPTConversationIdentity";
import {
  hasChatGPTLoadFailure,
  cooldownElapsed,
  readRecoveryHistory,
  recordRecoveryAttempt,
} from "./chatGPTConversationRecovery";
import { CHATGPT_ACTIVITY_EXPRESSION } from "./chatGPTActivity";
import { hasUncertainChatGPTSend } from "../../chatGPTSessionControl";
import { recordChatGPTRecoveryEvent } from "../../chatGPTRecoveryDiagnostics";
import { recordChatGPTRecoveryObservation } from "../../chatGPTRecoveryMetrics";
import {
  isChatGPTRecoveryMutationPending,
  tryAcquireChatGPTRecoveryMutation,
} from "../../chatGPTRecoveryMutationGate";
import {
  readChatGPTRecoverySettings,
  subscribeChatGPTRecoverySettings,
} from "../../chatGPTRecoverySettings";
import {
  beginRecoveryAttempt,
  finishRecoveryAttempt,
  noteRecoveryFailure,
  noteRecoveryVerified,
  readRecoveryQueue,
  reconcileRecoveryQueue,
  type RecoveryQueueContext,
} from "./chatGPTRecoveryQueue";

/** Read-only native guest state. No preview webview or attach/reload side effects. */
interface NativeState {
  url: string;
  activity: string;
  loading: boolean;
  loadError: string | null;
  explicitLoadFailure: boolean;
}
type NativeBridge = NonNullable<NonNullable<Window["desktopBridge"]>["stableChatGPTViewRequest"]>;

const PROBE = `(() => ({
  url: location.href,
  activity: ${CHATGPT_ACTIVITY_EXPRESSION},
  explicitLoadFailure: (${hasChatGPTLoadFailure.toString()})(),
}))()`;

/** Only click the Retry button inside a positively verified load-error page.
 * A transiently absent composer must never grant permission to reload.
 * Validate the exact URL, error panel, drafts, uploads and generating state
 * again IN the same guest JS turn as the action. */
function nativeRetryExpression(expectedUrl: string, networkFailure = false): string {
  return `(() => {
    if (location.href !== ${JSON.stringify(expectedUrl)}) return "route-changed";
    const explicitError = (${hasChatGPTLoadFailure.toString()})();
    if (!explicitError && !${networkFailure}) return "error-cleared";
    const editors = [...document.querySelectorAll('#prompt-textarea,[data-testid="prompt-textarea"],[data-testid="composer-input"],[contenteditable="true"][role="textbox"],form textarea,textarea[placeholder]')];
    if (editors.some(el => (el instanceof HTMLTextAreaElement ? el.value :
      (el.innerText ?? el.textContent ?? "")).trim())) return "draft-present";
    if (document.querySelector('[data-testid="stop-button"],[data-testid="composer-stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"]')) return "generation-visible";
    if (document.querySelector('[data-testid*="attachment"],[data-testid*="upload-preview"],[data-state="recording"],[data-state="uploading"],[aria-label^="Remove file"],[aria-label^="Remove attachment"]') ||
        [...document.querySelectorAll('input[type="file"]')].some(input => input.files?.length)) return "attachments-present";
    const visible = el => el.getClientRects().length > 0 && !el.hasAttribute("disabled");
    const button = [...document.querySelectorAll('button,[role="button"]')].find(
      el => visible(el) && /^retry$/i.test(el.textContent?.trim() ?? "") &&
      !el.closest('[data-message-author-role],article,pre,code'));
    if (!button && !${networkFailure}) return "retry-missing";
    if (button) button.click();
    else location.reload();
    return "retry-issued";
  })()`;
}

const healthy = (state: NativeState) => state.activity === "working" || state.activity === "idle";
const reason = (state: NativeState): "load-failure" | "interrupted" | "delivery-timeout" | null => {
  if (state.explicitLoadFailure || state.loadError) return "load-failure";
  if (state.activity === "interrupted" || state.activity === "delivery-timeout")
    return state.activity;
  return null;
};

async function observeNative(
  bridge: NativeBridge,
  environmentId: EnvironmentId,
  sessionId: string,
): Promise<NativeState | null> {
  const identity = { environmentId, sessionId, profileId: chatGPTSessionProfileId(readChatGPTBrowserSessions(environmentId).find((entry) => entry.id === sessionId)) };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async (): Promise<NativeState | null> => {
        const host = (await bridge({ operation: "snapshot", identity })) as {
          url?: string;
          destroyed?: boolean;
          loading?: boolean;
          loadError?: string | null;
        };
        if (host.destroyed || !host.url) return null;
        // A main-frame load failure is authoritative even when guest JS cannot run.
        if (host.loadError && !host.loading)
          return {
            url: host.url,
            activity: "invalid",
            loading: false,
            loadError: host.loadError,
            explicitLoadFailure: false,
          };
        if (host.loading)
          return {
            url: host.url,
            activity: "unknown",
            loading: true,
            loadError: null,
            explicitLoadFailure: false,
          };
        const reply = (await bridge({ operation: "evaluate", identity, expression: PROBE })) as {
          result?: { url?: string; activity?: string; explicitLoadFailure?: boolean } | string;
        };
        if (!reply.result || typeof reply.result !== "object" || reply.result.url !== host.url)
          return null;
        return {
          url: host.url,
          loading: false,
          loadError: host.loadError ?? null,
          activity: reply.result.activity ?? "unknown",
          explicitLoadFailure: reply.result.explicitLoadFailure === true,
        };
      })(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 5_000);
      }),
    ]);
  } catch {
    // Missing/unresponsive native IPC is not proof the conversation failed.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The legacy recovery scanner deliberately excludes native WebContentsViews.
 * This coordinator supplies the missing native lane without ever treating an
 * unloaded page, loading animation or missing composer as a confirmed error.
 */
export function ChatGPTNativeRecoveryCoordinator({
  environmentId,
  sessionIds,
  redIds,
  interruptedIds,
  selectedId,
  managerIds,
}: {
  environmentId: EnvironmentId;
  sessionIds: readonly string[];
  redIds: readonly string[];
  interruptedIds: readonly string[];
  selectedId?: string | null | undefined;
  managerIds: readonly string[];
}) {
  const currentInputs = useEffectEvent(() => ({
    sessionIds,
    redIds,
    interruptedIds,
    selectedId,
    managerIds,
  }));
  useEffect(() => {
    const bridge = window.desktopBridge?.stableChatGPTViewRequest;
    if (!bridge) return;
    let disposed = false;
    let running = false;
    let rescan = false;
    let discoveryCursor = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const env = environmentId;
    const context = (): RecoveryQueueContext => {
      const input = currentInputs();
      return {
        eligibleIds: input.sessionIds,
        failingIds: input.redIds,
        selectedId: input.selectedId ?? null,
        managerIds: input.managerIds,
        interruptedIds: input.interruptedIds,
      };
    };
    const signal = (delay = 120) => {
      if (disposed || readChatGPTRecoverySettings().paused) return;
      if (running) {
        rescan = true;
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void run(), delay);
    };
    const run = async () => {
      if (disposed || running || readChatGPTRecoverySettings().paused) return;
      running = true;
      try {
        const eligible = currentInputs().sessionIds.filter(isPersistentChatGPTSessionOptedIn);
        // Legacy scheduler owns priority calculation; native and legacy share
        // one queue/lock but use their respective guest implementations.
        const ids = new Set(eligible);
        const pending = readRecoveryQueue(env);
        const candidates = eligible.filter(
          (id) =>
            currentInputs().redIds.includes(id) ||
            currentInputs().interruptedIds.includes(id) ||
            !!pending.failures[id],
        );
        // The watchdog also discovers failures on background Chromium pages
        // whose React activity observer has not yet raised an error. Probe a
        // bounded rotating sample; never load or wake an absent native page.
        const unqueued = eligible.filter((id) => !candidates.includes(id));
        for (let n = 0; n < Math.min(3, unqueued.length); n++)
          candidates.push(unqueued[(discoveryCursor + n) % unqueued.length]!);
        if (unqueued.length)
          discoveryCursor = (discoveryCursor + Math.min(3, unqueued.length)) % unqueued.length;
        let lastObservedAt = 0;
        for (const id of candidates) {
          if (disposed || !ids.has(id) || hasUncertainChatGPTSend(env, id)) continue;
          if (isChatGPTRecoveryMutationPending(env, id)) continue;
          const first = await observeNative(bridge, env, id);
          if (!first || first.loading) continue;
          lastObservedAt = Date.now();
          if (healthy(first)) {
            noteRecoveryVerified(env, id);
            continue;
          }
          const failure = reason(first);
          if (!failure) continue;
          const savedUrl = (() => {
            try {
              return JSON.parse(
                localStorage.getItem(chatGPTBrowserLastUrlKey(env, id)) ?? "null",
              ) as unknown;
            } catch {
              return null;
            }
          })();
          // Never act on a redirect, a new conversation, or an uncertain identity.
          const actualConversation = chatGPTConversationIdFromUrl(first.url);
          const storedConversation =
            typeof savedUrl === "string" ? chatGPTConversationIdFromUrl(savedUrl) : null;
          const boundConversation =
            readChatGPTBrowserSessions(env).find((session) => session.id === id)?.bootstrapIdentity
              ?.conversationId ?? null;
          // A canonical URL alone cannot establish that the correct T3
          // conversation is loaded. Require an existing stored binding.
          const expectedConversation = storedConversation ?? boundConversation;
          if (!expectedConversation || actualConversation !== expectedConversation) {
            // Report the error even if navigation never reached the expected route.
            // Never attempt automatic recovery without a matching binding.
            noteRecoveryFailure(env, id, failure, ctx);
            continue;
          }
          const ctx = context();
          noteRecoveryFailure(env, id, failure, ctx);
          const queue = reconcileRecoveryQueue(env, ctx);
          const entry = queue.failures[id];
          if (!entry || !queue.targets.includes(id)) continue;
          const settings = readChatGPTRecoverySettings();
          const now = Date.now();
          const history = readRecoveryHistory(env);
          const lane = entry.red ? "red" : "orange";
          const laneLast = lane === "red" ? history.redLastAttemptAt : history.orangeLastAttemptAt;
          const minimum = lane === "red" ? settings.globalSeconds : settings.orangeGlobalSeconds;
          if (
            now < (lane === "red" ? queue.redBackoffUntil : queue.orangeBackoffUntil) ||
            !cooldownElapsed(laneLast, now, minimum * 1_000) ||
            (!entry.red &&
              (now - entry.firstSeenAt < settings.orangeGraceMinutes * 60_000 ||
                !cooldownElapsed(
                  history.bySession[id] ?? 0,
                  now,
                  settings.perSessionSeconds * 1_000,
                )))
          )
            continue;

          // A separate, current browser probe is required at the point of
          // mutation; an earlier red sidebar color never authorizes a reload.
          const second = await observeNative(bridge, env, id);
          if (!second || second.loading || second.url !== first.url || reason(second) !== failure) {
            if (second && healthy(second)) noteRecoveryVerified(env, id);
            continue;
          }
          const lease = tryAcquireChatGPTRecoveryMutation(env, id, "automatic", "reload");
          if (!lease) continue;
          let pendingAction: Promise<unknown> | null = null;
          let yielded = false;
          try {
            if (
              readChatGPTRecoverySettings().paused ||
              !readRecoveryQueue(env).targets.includes(id) ||
              hasUncertainChatGPTSend(env, id)
            )
              continue;
            // Unlike a missing composer, the dedicated ChatGPT load-error panel
            // positively identifies a recoverable failure. Retry only that panel.
            if (failure === "load-failure" && !second.explicitLoadFailure && !second.loadError)
              continue;
            if (failure !== "load-failure" && settings.orangeStrategy === "observe-only") continue;
            const attempt = beginRecoveryAttempt(env, id, `native:${failure}`);
            if (attempt === null) continue;
            recordRecoveryAttempt(env, id, Date.now(), ctx.eligibleIds, lane);
            recordChatGPTRecoveryEvent(env, id, "native-recovery-attempt", failure);
            if (failure === "load-failure") {
              const identity = { environmentId: env, sessionId: id, profileId: chatGPTSessionProfileId(readChatGPTBrowserSessions(env).find((entry) => entry.id === id)) };
              pendingAction = bridge({
                operation: "evaluate",
                identity,
                expression: nativeRetryExpression(second.url, !!second.loadError),
              });
            } else {
              pendingAction = guardedNativeChatGPTReload({
                environmentId: env,
                sessionId: id,
                currentUrl: second.url,
                savedUrl: typeof savedUrl === "string" ? savedUrl : null,
                working: false,
                force: false,
                shouldContinue: () =>
                  !disposed &&
                  !readChatGPTRecoverySettings().paused &&
                  readRecoveryQueue(env).targets.includes(id) &&
                  !hasUncertainChatGPTSend(env, id),
                bridge,
              });
            }
            let deadline: ReturnType<typeof setTimeout> | undefined;
            const settled = await Promise.race([
              pendingAction.then(
                (value) => ({ timedOut: false as const, value }),
                (error) => ({ timedOut: false as const, error }),
              ),
              new Promise<{ timedOut: true }>((resolve) => {
                deadline = setTimeout(() => resolve({ timedOut: true }), 8_000);
              }),
            ]);
            if (deadline) clearTimeout(deadline);
            if (settled.timedOut) {
              yielded = true;
              lease.yieldToSession(id);
              finishRecoveryAttempt(env, id, "Native action still pending; outcome unknown");
            } else if ("error" in settled) {
              finishRecoveryAttempt(env, id, "Native action rejected; no verified recovery");
            } else {
              const result = settled.value as { result?: string } | null;
              const confirmed =
                failure === "load-failure"
                  ? result?.result === "retry-issued"
                  : !!result &&
                    typeof result === "object" &&
                    ("nativeReloadIssued" in result || "requestedNavigation" in result);
              finishRecoveryAttempt(
                env,
                id,
                confirmed
                  ? "Native action dispatched; independent health verification pending"
                  : "Native action not dispatched (changed state or unsafe)",
              );
            }
          } finally {
            // On an unknown bridge result the session stays exclusively reserved
            // until the original native operation settles; never double-retry.
            if (yielded && pendingAction)
              void pendingAction.finally(() => lease.release()).catch(() => undefined);
            else lease.release();
          }
        }
        // Recording once per actual inspection keeps the observation coverage
        // accurate without rewriting the ledger for every resident guest.
        if (lastObservedAt) recordChatGPTRecoveryObservation(env, lastObservedAt);
      } catch (error) {
        console.warn("[T3 native recovery] Scan unavailable:", error);
      } finally {
        running = false;
        if (!disposed) {
          const pending = rescan;
          rescan = false;
          signal(pending ? 200 : 20_000);
        }
      }
    };
    const onState = (event: Event) => {
      const detail = (event as CustomEvent<{ environmentId?: string; sessionId?: string }>).detail;
      if (
        detail?.environmentId === env &&
        (!detail.sessionId || isPersistentChatGPTSessionOptedIn(detail.sessionId))
      )
        signal();
    };
    const unsubscribeNative = window.desktopBridge?.onStableChatGPTViewState?.((state) => {
      if (state.environmentId === env) signal();
    });
    const unsubscribeSettings = subscribeChatGPTRecoverySettings(() => signal());
    window.addEventListener("t3:chatgpt-recovery-state-changed", onState);
    window.addEventListener("t3:chatgpt-recovery-inputs-changed", onState);
    window.addEventListener("t3:chatgpt-recovery-mutation-settled", onState);
    signal(0);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribeNative?.();
      unsubscribeSettings();
      window.removeEventListener("t3:chatgpt-recovery-state-changed", onState);
      window.removeEventListener("t3:chatgpt-recovery-inputs-changed", onState);
      window.removeEventListener("t3:chatgpt-recovery-mutation-settled", onState);
    };
  }, [environmentId]);
  return null;
}
