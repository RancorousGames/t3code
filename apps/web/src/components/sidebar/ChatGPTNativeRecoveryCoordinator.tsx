import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { isPersistentChatGPTSessionOptedIn } from "../../browser/persistentChatGPTSessionMode";
import { guardedNativeChatGPTReload } from "../../browser/guardedNativeChatGPTReload";
import { chatGPTBrowserLastUrlKey, readChatGPTBrowserSessions } from "../../chatGPTBrowserSessions";
import { chatGPTSessionProfileId } from "../../chatGPTAccountProfiles";
import { chatGPTConversationIdFromUrl } from "../../chatGPTConversationIdentity";
import { chatGPTDirectSubmitExpression } from "../../chatGPTDirectSubmit";
import {
  hasChatGPTLoadFailure,
  cooldownElapsed,
  readRecoveryHistory,
  recordRecoveryAttempt,
} from "./chatGPTConversationRecovery";
import { CHATGPT_ACTIVITY_EXPRESSION } from "./chatGPTActivity";
import { inspectChatGPTPage } from "../../chatGPTSessionDom";
import { allowsChatGPTOrangeRecoveryAction } from "../../chatGPTOrangeRecoveryStrategy";
import { recordChatGPTRecoveryAttemptLog } from "../../chatGPTRecoveryAttemptLog";
import { logChatGPTRecoveryTimeline } from "../../chatGPTRecoveryTimeline";
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
  lastUserTurnKey: string | null;
  lastUserTurn: number | null;
  lastUserIsRecoveryContinue: boolean;
  draftEmpty: boolean | null;
  stopVisible: boolean;
}
type NativeBridge = NonNullable<NonNullable<Window["desktopBridge"]>["stableChatGPTViewRequest"]>;

const PROBE = `(() => ({
  url: location.href,
  activity: ${CHATGPT_ACTIVITY_EXPRESSION},
  explicitLoadFailure: (${hasChatGPTLoadFailure.toString()})(),
  ...(() => {
    const page = (${inspectChatGPTPage.toString()})({from:"end",count:1,includeMessages:false});
    const editor = document.querySelector('#prompt-textarea,[data-testid="prompt-textarea"],[data-testid="composer-input"],form textarea,[contenteditable="true"][role="textbox"]');
    const draft = editor instanceof HTMLTextAreaElement ? editor.value : editor instanceof HTMLElement ? (editor.innerText || editor.textContent || "") : null;
    const stop = document.querySelector('button[data-testid="stop-button"],button[data-testid="composer-stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"]');
    return {lastUserTurnKey:page.lastUserTurnKey,lastUserTurn:page.lastUserTurn,
      lastUserIsRecoveryContinue:page.lastUserIsRecoveryContinue,draftEmpty:draft === null ? null : !draft.trim(),
      stopVisible:!!stop && stop.getClientRects().length > 0 && !stop.hasAttribute("disabled")};
  })(),
}))()`;

/** An explicit red error panel can contain a Retry OR Try again control.
 * Recheck the exact failing page and unsent input before asking Chromium itself
 * to reload it; clicking a provider button is not a browser page reload. */
function nativeRedReloadGuardExpression(expectedUrl: string): string {
  return `(() => {
    if (location.href !== ${JSON.stringify(expectedUrl)}) return "route-changed";
    if (!(${hasChatGPTLoadFailure.toString()})()) return "error-cleared";
    const editors = [...document.querySelectorAll('#prompt-textarea,[data-testid="prompt-textarea"],[data-testid="composer-input"],[contenteditable="true"][role="textbox"],form textarea,textarea[placeholder]')];
    if (editors.some(el => (el instanceof HTMLTextAreaElement ? el.value :
      (el.innerText ?? el.textContent ?? "")).trim())) return "draft-present";
    const stop = document.querySelector('[data-testid="stop-button"],[data-testid="composer-stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"]');
    if (stop && stop.getClientRects().length > 0 && !stop.hasAttribute("disabled")) return "generation-visible";
    if (document.querySelector('[data-testid*="attachment"],[data-testid*="upload-preview"],[data-state="recording"],[data-state="uploading"],[aria-label^="Remove file"],[aria-label^="Remove attachment"]') ||
        [...document.querySelectorAll('input[type="file"]')].some(input => input.files?.length)) return "attachments-present";
    return "reload-safe";
  })()`;
}

type NativeOrangeStage = "stop-pending" | "stop" | "type-pending" | "typed" | "send-pending" | "sent";
interface NativeOrangeEpisode {
  conversationId: string;
  turnKey: string;
  turn: number;
  stage: NativeOrangeStage;
}
const orangeKey = (env: string, id: string) => `t3code:chatgpt-native-orange-action:${env}:${id}`;
function nativeOrangeEpisode(env: string, id: string): NativeOrangeEpisode | null {
  try {
    const value = JSON.parse(localStorage.getItem(orangeKey(env, id)) ?? "null") as NativeOrangeEpisode | null;
    return value && typeof value.conversationId === "string" && typeof value.turnKey === "string" &&
      Number.isSafeInteger(value.turn) && ["stop-pending", "stop", "type-pending", "typed", "send-pending", "sent"].includes(value.stage) ? value : null;
  } catch { return null; }
}
function saveNativeOrangeEpisode(env: string, id: string, episode: NativeOrangeEpisode): boolean {
  try { localStorage.setItem(orangeKey(env, id), JSON.stringify(episode)); return true; }
  catch { return false; }
}
/** Preserve observed orange failure age through a T3 restart. The queue itself
 * intentionally resets per launch, but a verified unchanged conversation
 * should not wait another full grace period after each reboot. */
const failureAgeKey = (env: string, id: string) =>
  `t3code:chatgpt-native-failure-age:v1:${env}:${id}`;
function durableFailureAge(env: string, id: string, conversationId: string,
  failure: string, firstSeenAt: number): number {
  const key = failureAgeKey(env, id);
  let since = firstSeenAt;
  try {
    const old = JSON.parse(localStorage.getItem(key) ?? "null") as {
      conversationId?: string; failure?: string; firstSeenAt?: number;
    } | null;
    if (old?.conversationId === conversationId && old.failure === failure &&
        typeof old.firstSeenAt === "number" && old.firstSeenAt > 0 &&
        old.firstSeenAt <= firstSeenAt) since = old.firstSeenAt;
    localStorage.setItem(key, JSON.stringify({ conversationId, failure, firstSeenAt: since }));
  } catch { /* Without storage, use this scan's verified first observation. */ }
  return since;
}
function clearDurableFailureAge(env: string, id: string): void {
  try { localStorage.removeItem(failureAgeKey(env, id)); }
  catch { /* best effort */ }
}
/** Recovery checks URL, last human turn, and generation atomically with the
 * direct callback. No synthetic typing or Send click is performed. */
function nativeOrangeExpression(url: string, episode: NativeOrangeEpisode, action: "stop" | "send"): string {
  const submit = chatGPTDirectSubmitExpression({
    text: "Continue.",
    expectedConversationId: episode.conversationId,
  });
  return `(() => {
    if (location.href !== ${JSON.stringify(url)}) return "route-changed";
    const page = (${inspectChatGPTPage.toString()})({from:"end",count:1,includeMessages:false});
    if (page.lastUserTurnKey !== ${JSON.stringify(episode.turnKey)} ||
        page.lastUserTurn !== ${episode.turn} || page.lastUserIsRecoveryContinue) return "turn-changed";
    const activity = ${CHATGPT_ACTIVITY_EXPRESSION};
    const editor = document.querySelector('#prompt-textarea,[data-testid="prompt-textarea"],[data-testid="composer-input"],form textarea,[contenteditable="true"][role="textbox"]');
    if (!(editor instanceof HTMLElement)) return "editor-missing";
    const draft = editor instanceof HTMLTextAreaElement ? editor.value : (editor.innerText || editor.textContent || "");
    const stop = document.querySelector('button[data-testid="stop-button"],button[data-testid="composer-stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"]');
    if (document.querySelector('[data-testid*="upload-preview"],[data-state="recording"],[data-state="uploading"],[aria-label^="Remove file"],[aria-label^="Remove attachment"]') ||
        [...document.querySelectorAll('input[type="file"]')].some(el => el.files?.length)) return "attachment-present";
    if (${JSON.stringify(action)} === "stop") {
      if (!["interrupted","delivery-timeout"].includes(activity) || draft.trim() ||
          !(stop instanceof HTMLButtonElement) || stop.disabled || !stop.getClientRects().length) return "stop-unsafe";
      stop.click(); return "stop-clicked";
    }
    if (activity !== "idle" || (stop && stop.getClientRects().length && !stop.hasAttribute("disabled"))) return "not-idle";
    // Preserve the old automatic-recovery policy: a human draft blocks
    // unsolicited Continue. A legacy staged "Continue." may still complete
    // without modifying that old draft.
    if (draft.trim() && !(${JSON.stringify(episode.stage)} === "typed" && draft.trim() === "Continue."))
      return "draft-present";
    const result = ${submit};
    return result.submitted ? "continue-submitted" : result.reason ?? "direct-unavailable";
  })()`;
}
/** A missing composer must stay broken across two observations and a full grace period.
 * Unlike normal reload, there is no editor available to check for an unsent draft. */
function nativeMissingComposerReloadExpression(url: string): string {
  return `(() => {
    if (location.href !== ${JSON.stringify(url)} ||
        ${CHATGPT_ACTIVITY_EXPRESSION} !== "invalid: the ChatGPT composer is unavailable") return "state-changed";
    const editors = [...document.querySelectorAll('#prompt-textarea,[data-testid="prompt-textarea"],[data-testid="composer-input"],form textarea,[contenteditable="true"][role="textbox"]')];
    if (editors.some(el => (el instanceof HTMLTextAreaElement ? el.value : (el.innerText || el.textContent || "")).trim())) return "draft-present";
    const stop = document.querySelector('[data-testid="stop-button"],[data-testid="composer-stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"]');
    if (stop && stop.getClientRects().length && !stop.hasAttribute("disabled")) return "generation-present";
    if (document.querySelector('[data-testid*="upload-preview"],[data-state="recording"],[data-state="uploading"],[aria-label^="Remove file"],[aria-label^="Remove attachment"]') ||
        [...document.querySelectorAll('input[type="file"]')].some(el => el.files?.length)) return "attachment-present";
    location.reload(); return "reload-issued";
  })()`;
}
const healthy = (state: NativeState) => state.activity === "working" || state.activity === "idle";
const reason = (state: NativeState): "load-failure" | "interrupted" | "delivery-timeout" | "missing-composer" | null => {
  if (state.explicitLoadFailure || state.loadError) return "load-failure";
  if (state.activity === "interrupted" || state.activity === "delivery-timeout")
    return state.activity;
  if (state.activity === "invalid: the ChatGPT composer is unavailable")
    return "missing-composer";
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
            lastUserTurnKey: null, lastUserTurn: null, lastUserIsRecoveryContinue: false,
            draftEmpty: null, stopVisible: false,
          };
        if (host.loading)
          return {
            url: host.url,
            activity: "unknown",
            loading: true,
            loadError: null,
            explicitLoadFailure: false,
            lastUserTurnKey: null, lastUserTurn: null, lastUserIsRecoveryContinue: false,
            draftEmpty: null, stopVisible: false,
          };
        const reply = (await bridge({ operation: "evaluate", identity, expression: PROBE })) as {
          result?: Partial<NativeState> | string;
        };
        if (!reply.result || typeof reply.result !== "object" || reply.result.url !== host.url)
          return null;
        return {
          url: host.url,
          loading: false,
          loadError: host.loadError ?? null,
          activity: reply.result.activity ?? "unknown",
          explicitLoadFailure: reply.result.explicitLoadFailure === true,
          lastUserTurnKey: reply.result.lastUserTurnKey ?? null,
          lastUserTurn: reply.result.lastUserTurn ?? null,
          lastUserIsRecoveryContinue: reply.result.lastUserIsRecoveryContinue === true,
          draftEmpty: reply.result.draftEmpty ?? null,
          stopVisible: reply.result.stopVisible === true,
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
    // Keep known-uninspectable guests queued, but do not allow them to occupy
    // scarce recovery dispatch slots while inspectable peers can be repaired.
    const suspendedIds = new Set<string>();
    const lastDecision = new Map<string, { code: string; at: number }>();
    /** A decision describes why an orange candidate did (or did not) run.
     * A scheduled progress bar alone is never evidence of an action. */
    const decision = (id: string, code: string, detail: string) => {
      const previous = lastDecision.get(id);
      const now = Date.now();
      if (previous?.code === code && now - previous.at < 60_000) return;
      lastDecision.set(id, { code, at: now });
      logChatGPTRecoveryTimeline(env, "native", "deferred", `${code}: ${detail}`, { sessionId: id });
      recordChatGPTRecoveryAttemptLog(env, {
        at: now, kind: "deferred", sessionId: id,
        attemptNumber: readRecoveryQueue(env).failures[id]?.attempts ?? 0,
        detail: `${code}: ${detail}`,
      });
    };
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
        suspendedIds: [...suspendedIds],
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
          if (disposed || !ids.has(id)) continue;
          if (hasUncertainChatGPTSend(env, id)) {
            suspendedIds.add(id);
            reconcileRecoveryQueue(env, context());
            decision(id, "uncertain-send", "Recovery deferred to avoid duplicating an unconfirmed message.");
            continue;
          }
          if (isChatGPTRecoveryMutationPending(env, id)) {
            suspendedIds.add(id);
            reconcileRecoveryQueue(env, context());
            decision(id, "mutation-pending", "Another recovery or manual action owns this guest.");
            continue;
          }
          const first = await observeNative(bridge, env, id);
          if (!first) {
            suspendedIds.add(id);
            reconcileRecoveryQueue(env, context());
            if (currentInputs().redIds.includes(id) || currentInputs().interruptedIds.includes(id) || pending.failures[id])
              decision(id, "guest-unavailable", "No inspectable native guest. Waiting for normal capped warm loading, not creating an extra page.");
            continue;
          }
          if (first.loading) {
            suspendedIds.add(id);
            reconcileRecoveryQueue(env, context());
            if (currentInputs().redIds.includes(id) || currentInputs().interruptedIds.includes(id) || pending.failures[id])
              decision(id, "guest-loading", "Chromium navigation in progress; retry after it settles.");
            continue;
          }
          suspendedIds.delete(id);
          lastObservedAt = Date.now();
          const existingEpisode = nativeOrangeEpisode(env, id);
          if (existingEpisode && chatGPTConversationIdFromUrl(first.url) === existingEpisode.conversationId) {
            const sameTurn = first.lastUserTurnKey === existingEpisode.turnKey &&
              first.lastUserTurn === existingEpisode.turn;
            if (sameTurn && ["stop-pending", "type-pending", "send-pending"].includes(existingEpisode.stage)) {
              // A guest mutation with an unknown outcome must never be replayed.
              if (existingEpisode.stage === "send-pending" && first.activity === "working")
                noteRecoveryVerified(env, id);
              continue;
            }
            if (sameTurn && (existingEpisode.stage === "stop" || existingEpisode.stage === "typed") &&
                (first.activity === "idle" || first.activity === "working")) {
              if (first.activity === "working") {
                // A genuinely resumed answer needs no synthetic Continue.
                noteRecoveryVerified(env, id);
                continue;
              }
              if (readChatGPTRecoverySettings().paused || hasUncertainChatGPTSend(env, id))
                continue;
              const next = "send";
              if (!allowsChatGPTOrangeRecoveryAction(
                readChatGPTRecoverySettings().orangeStrategy, "continue")) {
                decision(id, "continue-disabled", "Orange recovery settings prohibit sending Continue.");
                continue;
              }
              const lease = tryAcquireChatGPTRecoveryMutation(env, id, "automatic", "continue");
              if (!lease) {
                decision(id, "continue-lock", "Another guest mutation is active; follow-up deferred.");
                continue;
              }
              try {
                // Persist an at-most-once marker before invoking the guest. A lost
                // IPC reply must not cause a duplicate Continue on the next scan.
                const updated = { ...existingEpisode, stage: "send-pending" as const };
                if (!saveNativeOrangeEpisode(env, id, updated)) continue;
                recordChatGPTRecoveryAttemptLog(env, {
                  at: Date.now(), kind: "attempt", sessionId: id,
                  attemptNumber: readRecoveryQueue(env).failures[id]?.attempts ?? 0,
                  detail: "native orange Continue direct submission",
                });
                logChatGPTRecoveryTimeline(env, "native", "attempt", `Guarded orange ${next} on exact stalled user turn.`, { sessionId: id });
                const identity = { environmentId: env, sessionId: id,
                  profileId: chatGPTSessionProfileId(readChatGPTBrowserSessions(env).find(s => s.id === id)) };
                const response = await bridge({
                  operation: "evaluate", identity,
                  expression: nativeOrangeExpression(first.url, existingEpisode, next),
                }) as { result?: string };
                if (response.result === "continue-submitted")
                  saveNativeOrangeEpisode(env, id, { ...updated, stage: "sent" });
                recordChatGPTRecoveryEvent(env, id, "native-orange-action",
                  `${next}:${response.result ?? "unconfirmed"}`);
                logChatGPTRecoveryTimeline(env, "native", "outcome",
                  `Native orange ${next}: ${response.result ?? "unconfirmed"}.`, { sessionId: id });
              } catch (error) {
                recordChatGPTRecoveryEvent(env, id, "native-orange-action",
                  `${next}:bridge-unconfirmed`);
                decision(id, "continue-unconfirmed", `Native orange ${next} outcome unknown; action not duplicated.`);
                console.warn("[T3 native recovery] Orange follow-up outcome unknown:", error);
              } finally { lease.release(); }
              continue;
            }
            if (sameTurn && existingEpisode.stage !== "sent") continue;
            if (sameTurn && existingEpisode.stage === "sent") {
              // An idle page alone is not proof that the synthetic send landed.
              if (first.activity === "working") noteRecoveryVerified(env, id);
              continue;
            }
            if (["sent", "send-pending"].includes(existingEpisode.stage) && first.lastUserIsRecoveryContinue) {
              // The new user turn is positive evidence the single Continue was delivered.
              noteRecoveryVerified(env, id);
              continue;
            }
            // Only a distinct, positively identified human turn can rearm.
            if (!first.lastUserTurnKey || first.lastUserIsRecoveryContinue) continue;
            try { localStorage.removeItem(orangeKey(env, id)); } catch { /* best effort */ }
          }
          if (healthy(first)) {
            clearDurableFailureAge(env, id);
            const wasQueued = !!readRecoveryQueue(env).failures[id];
            noteRecoveryVerified(env, id);
            if (wasQueued) logChatGPTRecoveryTimeline(env, "native", "health",
              `Verified healthy DOM (${first.activity}); no mutation necessary.`, { sessionId: id });
            continue;
          }
          const failure = reason(first);
          if (!failure) {
            decision(id, "unclassified", `Guest reports ${first.activity}; no positively verified recoverable error.`);
            continue;
          }
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
          const ctx = context();
          if (!expectedConversation || actualConversation !== expectedConversation) {
            // Report the error even if navigation never reached the expected route.
            // Never attempt automatic recovery without a matching binding.
            noteRecoveryFailure(env, id, failure, ctx);
            decision(id, "identity-unverified", "Guest conversation does not match saved/registered binding; mutation prohibited.");
            continue;
          }
          noteRecoveryFailure(env, id, failure, ctx);
          const queue = reconcileRecoveryQueue(env, ctx);
          const entry = queue.failures[id];
          if (!entry || !queue.targets.includes(id)) {
            decision(id, "queue-wait", "Verified failure is waiting for its turn among ranked recovery targets.");
            continue;
          }
          const settings = readChatGPTRecoverySettings();
          const firstSeenAt = durableFailureAge(env, id, expectedConversation, failure, entry.firstSeenAt);
          if (failure === "missing-composer" &&
              (first.draftEmpty === false || first.stopVisible ||
                Date.now() - firstSeenAt < settings.missingComposerSeconds * 1_000)) {
            decision(id, "composer-grace", "Composer absent; waiting for sustained failure and guarding drafts/generation.");
            continue;
          }
          const now = Date.now();
          const history = readRecoveryHistory(env);
          const lane = entry.red ? "red" : "orange";
          const laneLast = lane === "red" ? history.redLastAttemptAt : history.orangeLastAttemptAt;
          const minimum = lane === "red" ? settings.globalSeconds : settings.orangeGlobalSeconds;
          // Report the precise gate and deadline; never show a fictional
          // "retrying" state when the scheduler has not dispatched anything.
          const gate = [
            {
              code: "lane-backoff",
              until: lane === "red" ? queue.redBackoffUntil : queue.orangeBackoffUntil,
            },
            {
              code: "global-cooldown",
              until: laneLast > 0 && laneLast <= now ? laneLast + minimum * 1_000 : 0,
            },
            {
              code: "orange-grace",
              // A visible, independently rechecked delivery-timeout notice
              // is terminal enough to try recovery after one minute; ordinary
              // transient interruption retains user-configured grace.
              until: entry.red ? 0 : firstSeenAt +
                (failure === "delivery-timeout"
                  ? Math.min(settings.orangeGraceMinutes, 1)
                  : settings.orangeGraceMinutes) * 60_000,
            },
            {
              code: "session-cooldown",
              until: entry.red || !((history.bySession[id] ?? 0) > 0) ? 0 :
                history.bySession[id]! + settings.perSessionSeconds * 1_000,
            },
          ].find((block) => block.until > now);
          if (gate) {
            decision(id, gate.code,
              `No action yet. Next eligible after ${new Date(gate.until).toISOString()} (attempts: ${entry.attempts}; last outcome: ${entry.lastOutcome}).`);
            continue;
          }

          // A separate, current browser probe is required at the point of
          // mutation; an earlier red sidebar color never authorizes a reload.
          const second = await observeNative(bridge, env, id);
          if (!second || second.loading || second.url !== first.url || reason(second) !== failure) {
            if (second && healthy(second)) noteRecoveryVerified(env, id);
            decision(id, "verification-changed", "Independent second inspection did not confirm the same recoverable failure.");
            continue;
          }
          const specialStop = failure !== "load-failure" && failure !== "missing-composer" &&
            second.stopVisible && second.draftEmpty === true &&
            !!second.lastUserTurnKey && second.lastUserTurn !== null &&
            !second.lastUserIsRecoveryContinue &&
            allowsChatGPTOrangeRecoveryAction(settings.orangeStrategy, "stop") &&
            allowsChatGPTOrangeRecoveryAction(settings.orangeStrategy, "continue");
          // An interrupted page retaining Stop cannot pass the safe reload
          // guard. Use the exact-turn Stop/Continue sequence instead.
          const lease = tryAcquireChatGPTRecoveryMutation(
            env, id, "automatic", specialStop ? "stop" : "reload");
          if (!lease) {
            decision(id, "mutation-lock", "Recovery lease already held; retry when it is released.");
            continue;
          }
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
            if (failure !== "load-failure" && settings.orangeStrategy === "observe-only") {
              decision(id, "observe-only", "Orange mutation disabled in recovery settings.");
              continue;
            }
            const attempt = beginRecoveryAttempt(env, id, `native:${failure}`);
            if (attempt === null) {
              decision(id, "queue-denied", "Recovery attempt not admitted by queue/backoff.");
              continue;
            }
            recordRecoveryAttempt(env, id, Date.now(), ctx.eligibleIds, lane);
            recordChatGPTRecoveryEvent(env, id, "native-recovery-attempt", failure);
            if (specialStop) {
              const episode: NativeOrangeEpisode = {
                conversationId: expectedConversation, turnKey: second.lastUserTurnKey!,
                turn: second.lastUserTurn!, stage: "stop-pending",
              };
              if (!saveNativeOrangeEpisode(env, id, episode)) {
                finishRecoveryAttempt(env, id, "Cannot persist at-most-once Stop marker");
                continue;
              }
              const identity = { environmentId: env, sessionId: id,
                profileId: chatGPTSessionProfileId(readChatGPTBrowserSessions(env).find(s => s.id === id)) };
              pendingAction = bridge({
                operation: "evaluate", identity,
                expression: nativeOrangeExpression(second.url, episode, "stop"),
              });
            } else if (failure === "missing-composer") {
              const identity = { environmentId: env, sessionId: id,
                profileId: chatGPTSessionProfileId(readChatGPTBrowserSessions(env).find(s => s.id === id)) };
              pendingAction = bridge({
                operation: "evaluate", identity,
                expression: nativeMissingComposerReloadExpression(second.url),
              });
            } else if (failure === "load-failure") {
              const identity = { environmentId: env, sessionId: id, profileId: chatGPTSessionProfileId(readChatGPTBrowserSessions(env).find((entry) => entry.id === id)) };
              // Red recovery must actually reload the Chromium page, not
              // depend on ChatGPT's Retry/Try again button text. A main-frame
              // network error cannot execute guest JS; two matching host
              // snapshots are the prerequisite in that case.
              pendingAction = (async () => {
                const origin = second.explicitLoadFailure ? "provider-error-panel" : "main-frame-network-error";
                if (second.explicitLoadFailure) {
                  const checked = await bridge({
                    operation: "evaluate",
                    identity,
                    expression: nativeRedReloadGuardExpression(second.url),
                  }) as { result?: string; url?: string };
                  if (typeof checked.url === "string" && checked.url !== second.url)
                    return { result: "red-guard-route-changed" };
                  if (checked.result !== "reload-safe")
                    return { result: `red-guard-${checked.result ?? "unconfirmed"}` };
                }
                logChatGPTRecoveryTimeline(env, "native", "retry",
                  `Red native Chromium reload requested (${origin}); verified conversation binding and unchanged failure.`,
                  { sessionId: id, attempt });
                // The host returns after invoking webContents.reload(), not
                // after the new page is healthy. Only a later probe proves that.
                await bridge({ operation: "reload", identity });
                return { result: "red-native-reload-issued", origin };
              })();
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
              decision(id, "action-unconfirmed", failure === "load-failure"
                ? "Red native Chromium reload not acknowledged within 8 seconds; awaiting original host operation."
                : "Native operation timed out; never blindly duplicate an unknown action.");
              yielded = true;
              lease.yieldToSession(id);
              finishRecoveryAttempt(env, id, failure === "load-failure"
                ? "Red native Chromium reload request pending; host acknowledgement unknown"
                : "Native action still pending; outcome unknown");
            } else if ("error" in settled) {
              const why = String(settled.error instanceof Error ? settled.error.message : settled.error)
                .split("\n")[0]?.slice(0, 165) ?? "unknown error";
              decision(id, "action-rejected", `Native recovery rejected: ${why}`);
              finishRecoveryAttempt(env, id, failure === "load-failure"
                ? `Red native Chromium reload request rejected (${why}); no verified recovery`
                : `Native action rejected (${why}); no verified recovery`);
            } else {
              const result = settled.value as { result?: string; origin?: string } | null;
              if (specialStop && result?.result === "stop-clicked" &&
                  second.lastUserTurnKey && second.lastUserTurn !== null)
                saveNativeOrangeEpisode(env, id, {
                  conversationId: expectedConversation, turnKey: second.lastUserTurnKey,
                  turn: second.lastUserTurn, stage: "stop",
                });
              const confirmed =
                specialStop ? result?.result === "stop-clicked"
                : failure === "missing-composer" ? result?.result === "reload-issued"
                : failure === "load-failure" ? result?.result === "red-native-reload-issued"
                  : !!result &&
                    typeof result === "object" &&
                    ("nativeReloadIssued" in result || "requestedNavigation" in result);
              finishRecoveryAttempt(
                env,
                id,
                failure === "load-failure"
                  ? confirmed
                    ? `Red native Chromium reload acknowledged (${result?.origin}); independent health verification pending`
                    : `Red page reload not dispatched: ${result?.result ?? "changed state or unsafe"}`
                  : confirmed
                    ? "Native action dispatched; independent health verification pending"
                    : `Native action not dispatched: ${result?.result ?? "changed state or unsafe"}`,
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
