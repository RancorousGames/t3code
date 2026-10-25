import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import {
  acquireBrowserSurfaceActivity,
  useBrowserSurfaceStore,
} from "../../browser/browserSurfaceStore";
import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import { resetHostedBrowserGuest } from "../../browser/hostedBrowserGuestReset";
import { chatGPTBrowserFailure, inspectChatGPTBrowserHealth } from "../../chatGPTBrowserHealth";
import { hasUncertainChatGPTSend } from "../../chatGPTSessionControl";
import {
  chatGPTBrowserLastUrlKey,
  chatGPTBrowserThreadRef,
  isChatGPTConversationUrl,
} from "../../chatGPTBrowserSessions";
import { chatGPTConversationIdFromUrl } from "../../chatGPTConversationIdentity";
import { recordChatGPTRecoveryEvent } from "../../chatGPTRecoveryDiagnostics";
import { recordChatGPTSessionRefreshedAt } from "../../chatGPTSessionTimestamps";
import { isChatGPTHomeUrl } from "../../chatGPTBrowserPrewarm";
import { inspectChatGPTPage } from "../../chatGPTSessionDom";
import { isChatGPTGuestHibernated } from "../../browser/chatGPTGuestHibernation";
import { readThreadPreviewState } from "../../previewStateStore";
import { previewBridge } from "../preview/previewBridge";
import { CHATGPT_ACTIVITY_EXPRESSION } from "./chatGPTActivity";
import {
  RECOVERY_GLOBAL_MS,
  RECOVERY_PER_SESSION_MS,
  RECOVERY_ORANGE_GRACE_MS,
  RECOVERY_REFRESH_TIMEOUT_MS,
  RECOVERY_SCAN_MS,
  cooldownElapsed,
  chatGPTRecoveryProblem,
  orderedCandidates,
  readRecentSessionClicks,
  readRecoveryHistory,
  recordRecoveryAttempt,
  type ChatGPTRecoveryProblem,
} from "./chatGPTConversationRecovery";

// One passive guest probe. Keep the draft as a boolean; never persist its text.
const CHATGPT_RECOVERY_PROBE_EXPRESSION = `(() => {
  const page = (${inspectChatGPTPage.toString()})({from: "end", count: 1, includeMessages: false});
  const editor = document.querySelector('#prompt-textarea,[data-testid="prompt-textarea"],[data-testid="composer-input"],form textarea,[contenteditable="true"][role="textbox"]');
  const draft = editor instanceof HTMLTextAreaElement ? editor.value : editor instanceof HTMLElement ? (editor.innerText || editor.textContent || "") : null;
  const stop = document.querySelector('button[data-testid="stop-button"],button[data-testid="composer-stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"]');
  const visible = (node) => !!node && node.getClientRects().length > 0 && !node.hasAttribute("disabled");
  const alerts = [...document.querySelectorAll('[role="alert"],[role="status"],[data-testid*="error"]')]
    .filter(el => el.getClientRects().length && !el.closest('[data-message-author-role],pre,code'))
    .map(el => el.textContent?.trim().slice(0,250) ?? "").join(" ");
  const permanentReason = /conversation (?:is )?(?:too long|full)|maximum (?:conversation )?length/i.test(alerts) ? "conversation_full"
    : /(?:access denied|do not have access|don't have access|permission denied)/i.test(alerts) ? "access"
    : /(?:sign in|log in|session expired|authentication required)/i.test(alerts) ? "auth" : null;
  return {...page, activity: ${CHATGPT_ACTIVITY_EXPRESSION}, draftEmpty: draft === null ? null : !draft.trim(),
    stopVisible: visible(stop), permanentReason};
})()`;

interface RecoverySnapshot {
  activity: string;
  url: string;
  lastUserTurnKey?: string | null;
  lastUserTurn?: number | null;
  lastUserIsRecoveryContinue?: boolean;
  totalTurns?: number;
  lastRole?: "user" | "assistant" | null;
  lastText?: string;
  assistantHasContent?: boolean;
  draftEmpty?: boolean | null;
  stopVisible?: boolean;
  permanentReason?: string | null;
}

type OrangeStage =
  | "grace"
  | "reloaded"
  | "stop_issued"
  | "continue_issued"
  | "recovered"
  | "observe_only";
interface OrangeEpisode {
  conversationId: string;
  userTurnKey: string;
  userTurn: number;
  problem: ChatGPTRecoveryProblem;
  firstSeenAt: number;
  stage: OrangeStage;
  stageAt: number;
  assistantSignature?: number;
  continuedTurnKey?: string;
  /** Stop may have executed despite an ambiguous bridge result. Never issue it again for this turn. */
  stopAttempted?: boolean;
  reason?: string;
}
interface PersistentRecovery {
  red: Record<string, { attempts: number; nextAt: number; conversationId: string }>;
  orange: Record<string, OrangeEpisode>;
}
const recoveryStateKey = (environmentId: string) =>
  `t3code:chatgpt-browser:bounded-recovery:${environmentId}`;
function readBoundedState(environmentId: string): PersistentRecovery {
  try {
    const data: unknown = JSON.parse(
      localStorage.getItem(recoveryStateKey(environmentId)) ?? "null",
    );
    if (!data || typeof data !== "object") throw new Error("Invalid recovery record");
    const parsed = data as Partial<PersistentRecovery>;
    return {
      red: parsed.red ?? {},
      // Legacy terminal escalation is deliberately ignored: it may not suppress retries.
      orange: Object.fromEntries(
        Object.entries(parsed.orange ?? {}).map(([id, episode]) => [
          id,
          (episode as { stage: string }).stage === "needs_human"
            ? { ...episode, stage: "observe_only" as const, stopAttempted: true }
            : episode,
        ]),
      ),
    };
  } catch {
    return { red: {}, orange: {} };
  }
}
function saveBoundedState(environmentId: string, state: PersistentRecovery): boolean {
  try {
    localStorage.setItem(recoveryStateKey(environmentId), JSON.stringify(state));
    return true;
  } catch {
    // Fail closed if the at-most-once marker cannot be persisted.
    return false;
  }
}
function noteRecoveryConcern(
  environmentId: string,
  state: PersistentRecovery,
  sessionId: string,
  _conversationId: string | null,
  reason: string,
  _now: number,
): void {
  // A diagnostic is not a terminal escalation. Keep inspecting this exact
  // conversation; never retry an uncertain Stop/Continue on the same user turn.
  const episode = state.orange[sessionId];
  if (episode) {
    state.orange[sessionId] = {
      ...episode,
      stage: episode.stage === "continue_issued" ? "continue_issued" : "observe_only",
      stopAttempted: episode.stopAttempted || episode.stage === "stop_issued",
      reason,
    };
    saveBoundedState(environmentId, state);
  }
  recordChatGPTRecoveryEvent(environmentId, sessionId, "diagnostic", reason);
}
export function nextRedRetryDelay(_sessionId: string, _attempts: number): number {
  // Uniform fixed cadence, independent of count and persisted across remounts.
  return RECOVERY_PER_SESSION_MS;
}
function assistantSignature(snapshot: RecoverySnapshot): number {
  let hash = 2166136261;
  for (const char of snapshot.lastRole === "assistant" ? (snapshot.lastText ?? "") : "")
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}
function sameEpisode(snapshot: RecoverySnapshot, episode: OrangeEpisode): boolean {
  return (
    snapshot.lastUserTurnKey === episode.userTurnKey && snapshot.lastUserTurn === episode.userTurn
  );
}
function positivelyResumed(snapshot: RecoverySnapshot): boolean {
  return (
    snapshot.activity === "working" ||
    (snapshot.activity === "idle" &&
      snapshot.lastRole === "assistant" &&
      snapshot.assistantHasContent === true)
  );
}
function safeIdleForContinue(snapshot: RecoverySnapshot, episode: OrangeEpisode): boolean {
  return (
    sameEpisode(snapshot, episode) &&
    snapshot.activity === "idle" &&
    snapshot.stopVisible === false &&
    snapshot.draftEmpty === true &&
    snapshot.permanentReason == null
  );
}
// The STOP click is scoped to a still-interrupted response, same user turn and exact URL.
// Persist the stop attempt BEFORE this command; ambiguous results must not be replayed.
// Type only into a provably empty editor for the exact orphaned turn.
// This guest-side check and the mutation run in one JS evaluation, avoiding
// a user draft arriving between the passive probe and editing.
function guardedRecoveryContinueTypeExpression(
  conversationId: string,
  episode: OrangeEpisode,
): string {
  return `(() => {
    const actual = (${chatGPTConversationIdFromUrl.toString()})(location.href);
    if (actual !== ${JSON.stringify(conversationId)}) return {result:"identity_changed"};
    const page = (${inspectChatGPTPage.toString()})({from:"end",count:1,includeMessages:false});
    if (page.lastUserTurnKey !== ${JSON.stringify(episode.userTurnKey)} ||
        page.lastUserTurn !== ${episode.userTurn}) return {result:"turn_changed"};
    if (${CHATGPT_ACTIVITY_EXPRESSION} !== "idle") return {result:"not_idle"};
    const editor = document.querySelector('#prompt-textarea,[data-testid="prompt-textarea"],[data-testid="composer-input"],form textarea,[contenteditable="true"][role="textbox"]');
    if (!(editor instanceof HTMLElement)) return {result:"editor_missing"};
    const before = editor instanceof HTMLTextAreaElement ? editor.value : (editor.innerText || editor.textContent || "");
    if (before.trim()) return {result:"existing_draft"};
    editor.focus();
    if (editor.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else if (editor instanceof HTMLTextAreaElement) {
      editor.select();
    } else return {result:"not_editable"};
    const inserted = document.execCommand("insertText", false, "Continue.");
    const after = editor instanceof HTMLTextAreaElement ? editor.value : (editor.innerText || editor.textContent || "");
    return {result: inserted && after.trim() === "Continue." ? "continue_typed" : "type_uncertain"};
  })()`;
}

function guardedRecoveryContinueSendExpression(
  conversationId: string,
  episode: OrangeEpisode,
): string {
  return `(() => {
    const actual = (${chatGPTConversationIdFromUrl.toString()})(location.href);
    if (actual !== ${JSON.stringify(conversationId)}) return {result:"identity_changed"};
    const page = (${inspectChatGPTPage.toString()})({from:"end",count:1,includeMessages:false});
    if (page.lastUserTurnKey !== ${JSON.stringify(episode.userTurnKey)} ||
        page.lastUserTurn !== ${episode.userTurn}) return {result:"turn_changed"};
    const status = ${CHATGPT_ACTIVITY_EXPRESSION};
    if (status !== "idle") return {result:"not_idle"};
    const stop = document.querySelector('button[data-testid="stop-button"],button[data-testid="composer-stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"]');
    if (stop && stop.getClientRects().length && !stop.hasAttribute("disabled")) return {result:"still_generating"};
    const editor = document.querySelector('#prompt-textarea,[data-testid="prompt-textarea"],[data-testid="composer-input"],form textarea,[contenteditable="true"][role="textbox"]');
    const draft = editor instanceof HTMLTextAreaElement ? editor.value : editor instanceof HTMLElement ? (editor.innerText || editor.textContent || "") : null;
    if (draft?.trim() !== "Continue.") return {result:"draft_changed"};
    const buttons = ['[data-testid="send-button"]','[data-testid="composer-submit-button"]','button[aria-label="Send prompt"]','button[aria-label="Send message"]','button[aria-label="Send"]','button[type="submit"]']
      .flatMap(selector => [...document.querySelectorAll(selector)]);
    const send = buttons.find(node => node instanceof HTMLButtonElement &&
      !node.disabled && node.getAttribute("aria-disabled") !== "true");
    if (!(send instanceof HTMLButtonElement)) return {result:"send_control_unavailable"};
    send.click();
    return {result:"continue_clicked"};
  })()`;
}
function stopOrphanExpression(conversationId: string, episode: OrangeEpisode): string {
  return `(() => {
    const actual = (${chatGPTConversationIdFromUrl.toString()})(location.href);
    if (actual !== ${JSON.stringify(conversationId)}) return {result:"identity_changed"};
    const page = (${inspectChatGPTPage.toString()})({from:"end",count:1,includeMessages:false});
    if (page.lastUserTurnKey !== ${JSON.stringify(episode.userTurnKey)} ||
        page.lastUserTurn !== ${episode.userTurn}) return {result:"turn_changed"};
    const status = ${CHATGPT_ACTIVITY_EXPRESSION};
    if (status !== "interrupted" && status !== "delivery-timeout") return {result:"resumed"};
    const editor = document.querySelector('#prompt-textarea,[data-testid="prompt-textarea"],[data-testid="composer-input"],form textarea,[contenteditable="true"][role="textbox"]');
    const draft = editor instanceof HTMLTextAreaElement ? editor.value : editor instanceof HTMLElement ? (editor.innerText || editor.textContent || "") : null;
    if (draft === null || draft.trim()) return {result:"draft_or_editor"};
    const button = document.querySelector('button[data-testid="stop-button"],button[data-testid="composer-stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled || !button.getClientRects().length) return {result:"no_stop"};
    button.click();
    return {result:"stop_clicked"};
  })()`;
}

export type ChatGPTRecoveryPhase = "queued" | "checking" | "refreshing";
const BACKGROUND_PROBES_PER_SCAN = 4;
const BACKGROUND_PROBE_SETTLE_MS = 1_000;

// A single scan across all ChatGPT tabs avoids concurrent reload storms.
let scanning = false;
const NO_DEFERRED_IDS: readonly string[] = [];

// A preview can remain in Loading even after the guest has rendered the
// conversation error. Use the last confirmed URL as a fallback, but never
// refresh unless the *actual guest URL* still identifies that conversation.
function expectedConversationUrl(
  environmentId: EnvironmentId,
  sessionId: string,
  nav: { readonly _tag: string; readonly url?: string } | undefined,
): string | null {
  if (nav?.url && isChatGPTConversationUrl(nav.url)) return nav.url;
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(chatGPTBrowserLastUrlKey(environmentId, sessionId)) ?? "null",
    );
    return typeof saved === "string" && isChatGPTConversationUrl(saved) ? saved : null;
  } catch {
    return null;
  }
}

function recoveryProblemForConversation(
  result: unknown,
  expectedUrl: string | null,
): ChatGPTRecoveryProblem | "healthy" | null {
  if (!result || typeof result !== "object" || !expectedUrl) return null;
  const probe = result as { activity?: unknown; url?: unknown };
  const expectedId = chatGPTConversationIdFromUrl(expectedUrl);
  if (
    expectedId === null ||
    typeof probe.url !== "string" ||
    chatGPTConversationIdFromUrl(probe.url) !== expectedId ||
    typeof probe.activity !== "string"
  )
    return null;
  return (
    chatGPTRecoveryProblem(probe.activity) ??
    (probe.activity === "idle" || probe.activity === "working" ? "healthy" : null)
  );
}

async function inspectFailure(
  webview: { executeJavaScript: (expression: string) => Promise<unknown> },
  expectedUrl: string,
): Promise<{ problem: ChatGPTRecoveryProblem | "healthy"; snapshot: RecoverySnapshot } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      webview.executeJavaScript(CHATGPT_RECOVERY_PROBE_EXPRESSION) as Promise<unknown>,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 4_000);
      }),
    ]);
    const problem = recoveryProblemForConversation(result, expectedUrl);
    return problem && result && typeof result === "object"
      ? { problem, snapshot: result as RecoverySnapshot }
      : null;
  } catch {
    // Navigation, detach and unresponsive guests are not confirmed failures.
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Bounded refresh is essential: a never-settling desktop bridge promise used
// to leave the module-level scanner locked forever.
async function refreshWithDeadline(
  bridge: NonNullable<typeof previewBridge>,
  runtimeId: string,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const finished = await Promise.race([
      bridge.refresh(runtimeId).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), RECOVERY_REFRESH_TIMEOUT_MS);
      }),
    ]);
    if (!finished) console.warn("[ChatGPT recovery] Refresh timed out:", runtimeId);
    return finished;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function ChatGPTBrowserRecoveryCoordinator({
  environmentId,
  sessionIds,
  deferredIds = NO_DEFERRED_IDS,
  wakeupIds = NO_DEFERRED_IDS,
  redIds = NO_DEFERRED_IDS,
  onPhaseChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly sessionIds: readonly string[];
  readonly deferredIds?: readonly string[];
  readonly wakeupIds?: readonly string[];
  /** All visible red sessions stay in the recovery queue, even while their guest cannot be inspected. */
  readonly redIds?: readonly string[];
  readonly onPhaseChange?: (sessionId: string, phase: ChatGPTRecoveryPhase | null) => void;
}) {
  const currentSessionIds = useEffectEvent(() => sessionIds);
  const currentDeferredIds = useEffectEvent(() => deferredIds);
  const currentWakeupIds = useEffectEvent(() => wakeupIds);
  const currentRedIds = useEffectEvent(() => redIds);
  const reportPhase = useEffectEvent((sessionId: string, phase: ChatGPTRecoveryPhase | null) =>
    onPhaseChange?.(sessionId, phase),
  );

  useEffect(() => {
    if (!previewBridge) return;
    const bridge = previewBridge;
    const envId = environmentId;
    let disposed = false;
    const trackedPhases = new Map<string, ChatGPTRecoveryPhase>();
    let wakeupCursor = 0;
    // A transient ChatGPT homepage during startup is not proof of URL loss.
    // Require an unchanged root page across scans before restoring its durable conversation.
    const lostRouteFirstSeen = new Map<string, { url: string; at: number }>();
    // Records live in localStorage rather than the React component lifecycle.
    // This prevents remounts from replaying a STOP or an ambiguous Continue.
    let cancelIndicatorWait: (() => void) | null = null;
    const phase = (sessionId: string, state: ChatGPTRecoveryPhase | null) => {
      if (state === trackedPhases.get(sessionId) || (!state && !trackedPhases.has(sessionId)))
        return;
      if (state) {
        trackedPhases.set(sessionId, state);
        recordChatGPTRecoveryEvent(envId, sessionId, "phase", state);
      } else trackedPhases.delete(sessionId);
      if (!disposed) reportPhase(sessionId, state);
    };

    const scan = async () => {
      if (disposed || scanning) return;
      scanning = true;
      try {
        const now = Date.now();
        const history = readRecoveryHistory(envId);
        const persistent = readBoundedState(envId);
        let canAttempt = cooldownElapsed(history.lastAttemptAt, now, RECOVERY_GLOBAL_MS);
        const eligibleIds = new Set(currentSessionIds());
        // Retain episode markers across hide/restore/remount. In particular,
        // a dispatched Continue cannot become eligible again after unmount.
        for (const id of trackedPhases.keys()) if (!eligibleIds.has(id)) phase(id, null);

        // Probe background pages in small batches. Their webviews may be
        // suspended offscreen until clicked, so DOM-only checks miss failures.
        const clicked = readRecentSessionClicks(envId);
        const candidates = orderedCandidates(
          currentSessionIds(),
          history,
          clicked,
          new Set(currentDeferredIds()),
        );
        const wakeupSet = new Set(currentWakeupIds());
        const toWake = candidates.filter((id) => wakeupSet.has(id));
        const wakeNow = new Set<string>();
        for (let n = 0; n < Math.min(BACKGROUND_PROBES_PER_SCAN, toWake.length); n++) {
          wakeNow.add(toWake[(wakeupCursor + n) % toWake.length]!);
        }
        if (toWake.length) wakeupCursor = (wakeupCursor + wakeNow.size) % toWake.length;
        for (const sessionId of candidates) {
          if (disposed) return;
          if (!currentSessionIds().includes(sessionId)) continue;
          // Missing/composer-less guests may have no inspectable DOM. Do not silently
          // drop red sessions from recovery just because the probe fails.
          if (currentRedIds().includes(sessionId)) phase(sessionId, "queued");

          const threadRef = chatGPTBrowserThreadRef(envId, sessionId);
          const state = readThreadPreviewState(threadRef);
          const tabId = state.activeTabId;
          if (!tabId || !state.serverEpoch) {
            if (persistent.red[sessionId])
              recordChatGPTRecoveryEvent(envId, sessionId, "blocked", "preview-not-ready");
            if (!currentRedIds().includes(sessionId)) phase(sessionId, null);
            continue;
          }
          const nav = state.sessions[tabId]?.navStatus;
          const expectedUrl = expectedConversationUrl(envId, sessionId, nav);
          const runtimeId = previewRuntimeTabId(threadRef, state.serverEpoch, tabId);
          const webview = Array.from(document.querySelectorAll("webview")).find(
            (element) => element.dataset.previewTab === runtimeId,
          );
          if (!webview) {
            if (persistent.red[sessionId])
              recordChatGPTRecoveryEvent(envId, sessionId, "blocked", "guest-not-attached");
            if (!currentRedIds().includes(sessionId)) phase(sessionId, null);
            continue;
          }

          let releasePaint: (() => void) | undefined;
          try {
            if (
              wakeNow.has(sessionId) &&
              !useBrowserSurfaceStore.getState().byTabId[runtimeId]?.visible
            ) {
              releasePaint = acquireBrowserSurfaceActivity(runtimeId);
              // Allow an offscreen Electron guest to render/hydrate before reading
              // its DOM. Never focus, navigate or refresh on an unconfirmed error.
              await new Promise<void>((resolve) => setTimeout(resolve, BACKGROUND_PROBE_SETTLE_MS));
            }

            if (isChatGPTGuestHibernated(runtimeId)) {
              if (persistent.red[sessionId])
                recordChatGPTRecoveryEvent(envId, sessionId, "blocked", "guest-hibernated");
              continue; // Closed/archived and sleeping guests are not recovery targets.
            }
            // A new blank homepage has no conversation identity, so it must be
            // handled before conversation-only recovery. Never wake hidden guests
            // just to diagnose a renderer, or reset a timed-out conversation blindly.
            if (useBrowserSurfaceStore.getState().byTabId[runtimeId]?.visible) {
              await inspectChatGPTBrowserHealth(webview);
              const failure = chatGPTBrowserFailure(webview);
              if (failure) {
                recordChatGPTRecoveryEvent(envId, sessionId, "failure-observed", `browser-unresponsive:${failure}`);
                const guestUrl = webview.getURL();
                const automaticReset = failure === "blank-page" ||
                  (!expectedUrl && isChatGPTHomeUrl(guestUrl));
                const latest = readThreadPreviewState(threadRef);
                const attemptedAt = Date.now();
                const recent = readRecoveryHistory(envId);
                if (
                  !disposed && currentSessionIds().includes(sessionId) &&
                  automaticReset && !hasUncertainChatGPTSend(envId, sessionId) &&
                  latest.activeTabId === tabId && latest.serverEpoch === state.serverEpoch &&
                  Array.from(document.querySelectorAll("webview")).includes(webview) &&
                  canAttempt &&
                  cooldownElapsed(recent.lastAttemptAt, attemptedAt, RECOVERY_GLOBAL_MS) &&
                  cooldownElapsed(recent.bySession[sessionId] ?? 0, attemptedAt, RECOVERY_PER_SESSION_MS)
                ) {
                  recordRecoveryAttempt(envId, sessionId, attemptedAt, currentSessionIds());
                  canAttempt = false;
                  phase(sessionId, "refreshing");
                  recordChatGPTRecoveryEvent(envId, sessionId, "browser-reset-requested", failure);
                  try {
                    const result = await resetHostedBrowserGuest(runtimeId, expectedUrl ?? guestUrl);
                    recordChatGPTRecoveryEvent(envId, sessionId, "browser-reset-attached",
                      `${result.previousWebContentsId}->${result.webContentsId}`);
                  } catch {
                    recordChatGPTRecoveryEvent(envId, sessionId, "browser-reset-unconfirmed");
                  } finally {
                    phase(sessionId, null);
                  }
                }
                continue;
              }
            }
            if (!expectedUrl) {
              lostRouteFirstSeen.delete(sessionId);
              if (persistent.orange[sessionId] || persistent.red[sessionId])
                noteRecoveryConcern(envId, persistent, sessionId, null,
                  "saved_conversation_url_lost", Date.now());
              if (!currentRedIds().includes(sessionId)) phase(sessionId, null);
              continue;
            }
            // The guest can redirect to chatgpt.com/ while the last confirmed
            // /c/<id> survives in localStorage. A normal refresh would only
            // reload the empty homepage, so navigate to that exact retained URL.
            // Never do so on an unknown session, a draft, or a working response.
            // Electron can display the guest homepage before the preview
            // state catches up, retaining a stale /c/<id> or Loading status.
            // Read its actual URL without running JavaScript in every guest.
            const guestLocation = (
              webview as typeof webview & { getURL?: () => string }
            ).getURL?.();
            if (
              (nav?._tag === "Success" && isChatGPTHomeUrl(nav.url)) ||
              (nav?._tag !== "Idle" &&
                typeof guestLocation === "string" &&
                isChatGPTHomeUrl(guestLocation))
            ) {
              const first = lostRouteFirstSeen.get(sessionId);
              if (!first || first.url !== expectedUrl) {
                lostRouteFirstSeen.set(sessionId, { url: expectedUrl, at: Date.now() });
                continue;
              }
              if (
                Date.now() - first.at < RECOVERY_SCAN_MS ||
                !canAttempt ||
                !cooldownElapsed(
                  history.bySession[sessionId] ?? 0,
                  Date.now(),
                  RECOVERY_PER_SESSION_MS,
                )
              )
                continue;
              // Both the preview's navigation AND the real guest must still
              // show an empty homepage, never a new conversation or unsent text.
              const safeHomepage = async (): Promise<boolean> => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                  const result = (await Promise.race([
                    webview.executeJavaScript(CHATGPT_RECOVERY_PROBE_EXPRESSION),
                    new Promise<null>((resolve) => {
                      timer = setTimeout(() => resolve(null), 4_000);
                    }),
                  ])) as RecoverySnapshot | null;
                  return (
                    result !== null &&
                    isChatGPTHomeUrl(result.url) &&
                    result.activity === "idle" &&
                    result.totalTurns === 0 &&
                    result.lastRole == null &&
                    result.assistantHasContent !== true &&
                    result.draftEmpty === true &&
                    result.stopVisible === false &&
                    result.permanentReason == null
                  );
                } catch {
                  return false;
                } finally {
                  if (timer !== undefined) clearTimeout(timer);
                }
              };
              if (!(await safeHomepage())) continue;
              const latest = readThreadPreviewState(threadRef);
              const latestNav = latest.sessions[tabId]?.navStatus;
              const latestGuestUrl = (
                webview as typeof webview & { getURL?: () => string }
              ).getURL?.();
              if (
                disposed ||
                !currentSessionIds().includes(sessionId) ||
                latest.activeTabId !== tabId ||
                latest.serverEpoch !== state.serverEpoch ||
                !(
                  (latestNav?._tag === "Success" && isChatGPTHomeUrl(latestNav.url)) ||
                  (latestNav?._tag !== "Idle" &&
                    typeof latestGuestUrl === "string" &&
                    isChatGPTHomeUrl(latestGuestUrl))
                ) ||
                expectedConversationUrl(envId, sessionId, latestNav) !== expectedUrl ||
                document.querySelector(`webview[data-preview-tab="${runtimeId}"]`) !== webview ||
                !(await safeHomepage())
              )
                continue;
              const attemptedAt = Date.now();
              const recent = readRecoveryHistory(envId);
              if (
                !cooldownElapsed(recent.lastAttemptAt, attemptedAt, RECOVERY_GLOBAL_MS) ||
                !cooldownElapsed(
                  recent.bySession[sessionId] ?? 0,
                  attemptedAt,
                  RECOVERY_PER_SESSION_MS,
                )
              )
                continue;
              recordRecoveryAttempt(envId, sessionId, attemptedAt, currentSessionIds());
              canAttempt = false;
              phase(sessionId, "refreshing");
              let navigationTimer: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  bridge.navigate(runtimeId, expectedUrl),
                  new Promise<never>((_, reject) => {
                    navigationTimer = setTimeout(
                      () => reject(new Error("Lost-route navigation timed out")),
                      RECOVERY_REFRESH_TIMEOUT_MS,
                    );
                  }),
                ]);
                lostRouteFirstSeen.delete(sessionId);
              } catch (error) {
                console.warn("[ChatGPT recovery] Lost-route navigation not confirmed:", {
                  sessionId,
                  error,
                });
              } finally {
                if (navigationTimer !== undefined) clearTimeout(navigationTimer);
                phase(sessionId, null);
              }
              continue;
            }
            lostRouteFirstSeen.delete(sessionId);
            const observed = await inspectFailure(webview, expectedUrl);
            if (disposed || !currentSessionIds().includes(sessionId)) continue;
            if (!observed) {
              if (persistent.red[sessionId])
                recordChatGPTRecoveryEvent(envId, sessionId, "blocked", "probe-unverifiable");
              const episode = persistent.orange[sessionId];
              if (episode && Date.now() - episode.stageAt > 2 * RECOVERY_ORANGE_GRACE_MS)
                noteRecoveryConcern(
                  envId,
                  persistent,
                  sessionId,
                  episode.conversationId,
                  "guest_url_or_health_unverifiable",
                  Date.now(),
                );
              const red = persistent.red[sessionId];
              if (red && Date.now() > red.nextAt + 2 * RECOVERY_ORANGE_GRACE_MS)
                noteRecoveryConcern(
                  envId,
                  persistent,
                  sessionId,
                  red.conversationId,
                  "guest_url_or_health_unverifiable",
                  Date.now(),
                );
              continue; // A detached guest is not proof of recovery.
            }
            const { problem, snapshot } = observed;
            if (problem !== "healthy")
              recordChatGPTRecoveryEvent(envId, sessionId, "failure-observed", problem);
            const conversationId = chatGPTConversationIdFromUrl(expectedUrl)!;
            let episode = persistent.orange[sessionId];
            const red = persistent.red[sessionId];

            if (
              (episode && episode.conversationId !== conversationId) ||
              (red?.conversationId && red.conversationId !== conversationId)
            ) {
              noteRecoveryConcern(
                envId,
                persistent,
                sessionId,
                conversationId,
                "conversation_identity_changed",
                Date.now(),
              );
              if (!currentRedIds().includes(sessionId)) phase(sessionId, null);
              continue;
            }
            if (snapshot.permanentReason) {
              noteRecoveryConcern(
                envId,
                persistent,
                sessionId,
                conversationId,
                snapshot.permanentReason,
                Date.now(),
              );
              if (!currentRedIds().includes(sessionId)) phase(sessionId, null);
              continue;
            }
            if (problem === "healthy") {
              if (red) {
                recordChatGPTRecoveryEvent(envId, sessionId, "healthy", "red-load-failure-cleared");
                delete persistent.red[sessionId];
                saveBoundedState(envId, persistent);
              }
              if (
                episode?.stage === "stop_issued" &&
                (snapshot.activity === "working" ||
                  (snapshot.activity === "idle" &&
                    snapshot.assistantHasContent === true &&
                    episode.assistantSignature !== undefined &&
                    assistantSignature(snapshot) !== episode.assistantSignature))
              ) {
                // A reply visibly resumed/advanced after STOP; cancel Continue.
                persistent.orange[sessionId] = {
                  ...episode,
                  stage: "recovered",
                  stageAt: Date.now(),
                };
                saveBoundedState(envId, persistent);
                phase(sessionId, null);
                continue;
              }
              if (
                episode?.stage === "stop_issued" &&
                snapshot.activity === "idle" &&
                !safeIdleForContinue(snapshot, episode) &&
                Date.now() - episode.stageAt > RECOVERY_ORANGE_GRACE_MS
              ) {
                noteRecoveryConcern(
                  envId,
                  persistent,
                  sessionId,
                  conversationId,
                  "post_stop_editor_or_turn_changed",
                  Date.now(),
                );
                continue;
              }
              if (episode?.stage === "stop_issued" && safeIdleForContinue(snapshot, episode)) {
                // The STOP click from the previous scan has visibly reached idle.
                // One durable marker must precede ANY typing or Send operation.
                const latest = readThreadPreviewState(threadRef);
                if (latest.activeTabId !== tabId || latest.serverEpoch !== state.serverEpoch)
                  continue;
                const beforeContinue = await inspectFailure(webview, expectedUrl);
                if (
                  !beforeContinue ||
                  beforeContinue.problem !== "healthy" ||
                  !safeIdleForContinue(beforeContinue.snapshot, episode) ||
                  disposed ||
                  !currentSessionIds().includes(sessionId)
                )
                  continue;
                const stamped = {
                  ...episode,
                  stage: "continue_issued" as const,
                  stageAt: Date.now(),
                };
                persistent.orange[sessionId] = stamped;
                if (!saveBoundedState(envId, persistent)) {
                  noteRecoveryConcern(
                    envId,
                    persistent,
                    sessionId,
                    conversationId,
                    "unable_to_persist_at_most_once_continue",
                    Date.now(),
                  );
                  continue;
                }
                try {
                  const typed = (await webview.executeJavaScript(
                    guardedRecoveryContinueTypeExpression(conversationId, stamped),
                  )) as { result?: string } | null;
                  if (typed?.result !== "continue_typed") {
                    noteRecoveryConcern(
                      envId,
                      persistent,
                      sessionId,
                      conversationId,
                      "continue_type_not_confirmed",
                      Date.now(),
                    );
                    continue;
                  }
                  const beforePress = await inspectFailure(webview, expectedUrl);
                  if (
                    !beforePress ||
                    beforePress.problem !== "healthy" ||
                    !sameEpisode(beforePress.snapshot, stamped) ||
                    beforePress.snapshot.stopVisible !== false ||
                    beforePress.snapshot.permanentReason
                  ) {
                    noteRecoveryConcern(
                      envId,
                      persistent,
                      sessionId,
                      conversationId,
                      "continue_typed_but_pre_send_identity_or_health_changed",
                      Date.now(),
                    );
                    continue; // Leave the typed draft for a human; never retry.
                  }
                  // Same guest JS turn checks URL, the exact user turn, idle state
                  // and that the editor is *exactly* our Continue. before clicking.
                  const dispatched = (await webview.executeJavaScript(
                    guardedRecoveryContinueSendExpression(conversationId, stamped),
                  )) as { result?: string } | null;
                  if (dispatched?.result !== "continue_clicked")
                    noteRecoveryConcern(
                      envId,
                      persistent,
                      sessionId,
                      conversationId,
                      "continue_send_not_confirmed",
                      Date.now(),
                    );
                } catch (error) {
                  noteRecoveryConcern(
                    envId,
                    persistent,
                    sessionId,
                    conversationId,
                    "continue_dispatch_ambiguous_or_failed",
                    Date.now(),
                  );
                  console.warn("[ChatGPT recovery] Continue left for human reconciliation:", error);
                }
                // Even a successful click is NOT proof of delivery or completion.
                phase(sessionId, null);
                continue;
              }
              if (episode) {
                if (episode.stage === "grace") {
                  // An idle composer with an empty assistant is NOT proof of a
                  // reply, but the orange banner disappeared: its grace interval
                  // is no longer sustained. Start fresh if it reappears.
                  delete persistent.orange[sessionId];
                } else if (episode.stage === "continue_issued") {
                  if (
                    snapshot.lastUserTurnKey !== episode.userTurnKey &&
                    snapshot.lastUserTurnKey != null &&
                    snapshot.lastUserIsRecoveryContinue === true
                  )
                    persistent.orange[sessionId] = {
                      ...episode,
                      stage: "recovered",
                      continuedTurnKey: snapshot.lastUserTurnKey,
                      stageAt: Date.now(),
                    };
                } else if (episode.stage === "reloaded" || episode.stage === "stop_issued") {
                  if (positivelyResumed(snapshot) && episode.stage === "reloaded")
                    persistent.orange[sessionId] = {
                      ...episode,
                      stage: "recovered",
                      stageAt: Date.now(),
                    };
                  else if (
                    episode.stage === "reloaded" &&
                    Date.now() - episode.stageAt > RECOVERY_ORANGE_GRACE_MS &&
                    snapshot.stopVisible === false
                  ) {
                    noteRecoveryConcern(
                      envId,
                      persistent,
                      sessionId,
                      conversationId,
                      "orphan_stop_unavailable_after_reload",
                      Date.now(),
                    );
                  }
                }
                saveBoundedState(envId, persistent);
              }
              phase(sessionId, null);
              continue;
            }

            phase(sessionId, "queued");
            if (problem !== "load-failure") {
              const key = snapshot.lastUserTurnKey;
              const turn = snapshot.lastUserTurn;
              // Only a positively verified NEW user turn can rearm an episode.
              // This also handles differing orange error labels on the same turn.
              if (episode && key && key !== episode.userTurnKey) {
                if (snapshot.lastUserIsRecoveryContinue !== false) continue;
                delete persistent.orange[sessionId];
                episode = undefined;
                saveBoundedState(envId, persistent);
              }
              if (!key || typeof turn !== "number") {
                // May still be rendering; never auto-continue an unidentified turn.
                if (!episode) {
                  persistent.orange[sessionId] = {
                    conversationId,
                    userTurnKey: "",
                    userTurn: -1,
                    problem,
                    firstSeenAt: Date.now(),
                    stage: "grace",
                    stageAt: Date.now(),
                  };
                  saveBoundedState(envId, persistent);
                } else if (Date.now() - episode.firstSeenAt >= RECOVERY_ORANGE_GRACE_MS) {
                  noteRecoveryConcern(
                    envId,
                    persistent,
                    sessionId,
                    conversationId,
                    "last_user_turn_not_identifiable",
                    Date.now(),
                  );
                }
                continue;
              }
              if (episode?.stage === "recovered") {
                // Re-arm only for a demonstrably NEW user turn, never for the
                // continuation turn itself or the same stalled answer.
                const lastHandled = episode.continuedTurnKey ?? episode.userTurnKey;
                if (key === lastHandled || snapshot.lastUserIsRecoveryContinue !== false) continue;
                episode = undefined;
              }
              // A Stop/Continue attempt or an unverified situation is durable
              // for this turn. Recheck passively; never duplicate either action.
              if (episode?.stage === "continue_issued") continue;
              if (
                episode?.stage === "observe_only" &&
                (episode.stopAttempted || !episode.userTurnKey)
              ) {
                // Stop/Continue uncertainty is never replayed. Without an
                // attempted mutation, a verified stuck turn can still be
                // safely refreshed at the normal fixed cadence below.
                continue;
              }
              if (!episode || episode.userTurnKey !== key || episode.userTurn !== turn) {
                episode = {
                  conversationId,
                  userTurnKey: key,
                  userTurn: turn,
                  problem,
                  firstSeenAt: Date.now(),
                  stage: "grace",
                  stageAt: Date.now(),
                };
                persistent.orange[sessionId] = episode;
                saveBoundedState(envId, persistent);
                continue;
              }
              if (Date.now() - episode.firstSeenAt < RECOVERY_ORANGE_GRACE_MS) continue;
              if (episode.stage === "stop_issued") {
                if (Date.now() - episode.stageAt > 2 * RECOVERY_ORANGE_GRACE_MS)
                  noteRecoveryConcern(
                    envId,
                    persistent,
                    sessionId,
                    conversationId,
                    "stop_did_not_reach_idle",
                    Date.now(),
                  );
                continue;
              }
              if (episode.stage === "reloaded") {
                // A *second* exact-conversation health check precedes STOP.
                if (Date.now() - episode.stageAt < 10_000) continue;
                const latest = readThreadPreviewState(threadRef);
                if (
                  latest.activeTabId !== tabId ||
                  latest.serverEpoch !== state.serverEpoch ||
                  document.querySelector(`webview[data-preview-tab="${runtimeId}"]`) !== webview
                )
                  continue;
                const confirmed = await inspectFailure(webview, expectedUrl);
                if (
                  !confirmed ||
                  confirmed.problem !== problem ||
                  !sameEpisode(confirmed.snapshot, episode) ||
                  confirmed.snapshot.draftEmpty !== true ||
                  confirmed.snapshot.stopVisible !== true
                ) {
                  if (confirmed?.problem === "healthy") continue;
                  noteRecoveryConcern(
                    envId,
                    persistent,
                    sessionId,
                    conversationId,
                    "orphan_stop_unavailable_or_draft_present",
                    Date.now(),
                  );
                  continue;
                }
                persistent.orange[sessionId] = {
                  ...episode,
                  stage: "stop_issued",
                  stageAt: Date.now(),
                  assistantSignature: assistantSignature(confirmed.snapshot),
                  stopAttempted: true,
                };
                if (!saveBoundedState(envId, persistent)) continue;
                try {
                  const response = (await webview.executeJavaScript(
                    stopOrphanExpression(conversationId, episode),
                  )) as { result?: string } | null;
                  if (response?.result !== "stop_clicked")
                    noteRecoveryConcern(
                      envId,
                      persistent,
                      sessionId,
                      conversationId,
                      "stop_not_confirmed",
                      Date.now(),
                    );
                } catch {
                  noteRecoveryConcern(
                    envId,
                    persistent,
                    sessionId,
                    conversationId,
                    "stop_outcome_ambiguous",
                    Date.now(),
                  );
                }
                continue;
              }
            } else {
              delete persistent.orange[sessionId];
              saveBoundedState(envId, persistent);
            }

            // Legacy persisted exponential deadlines may be far in the future.
            // The history timestamp is the sole per-session cooldown authority.
            const redNextAt =
              problem === "load-failure"
                ? (history.bySession[sessionId] ?? 0) + RECOVERY_PER_SESSION_MS
                : 0;
            if (
              !canAttempt ||
              Date.now() < redNextAt ||
              !cooldownElapsed(
                history.bySession[sessionId] ?? 0,
                Date.now(),
                RECOVERY_PER_SESSION_MS,
              )
            ) {
              const nextAt = Math.max(
                redNextAt,
                (history.bySession[sessionId] ?? 0) + RECOVERY_PER_SESSION_MS,
              );
              recordChatGPTRecoveryEvent(
                envId,
                sessionId,
                "waiting",
                !canAttempt ? "global-cooldown" : `next-eligible:${new Date(nextAt).toISOString()}`,
              );
              continue;
            }
            phase(sessionId, "checking");
            let stillFailed = true;
            try {
              const latest = readThreadPreviewState(threadRef);
              if (
                latest.activeTabId !== tabId ||
                latest.serverEpoch !== state.serverEpoch ||
                Array.from(document.querySelectorAll("webview")).find(
                  (element) => element.dataset.previewTab === runtimeId,
                ) !== webview ||
                chatGPTConversationIdFromUrl(
                  expectedConversationUrl(envId, sessionId, latest.sessions[tabId]?.navStatus),
                ) !== conversationId
              ) {
                stillFailed = false;
                continue;
              }
              const second = await inspectFailure(webview, expectedUrl);
              if (
                !second ||
                second.problem !== problem ||
                (episode && !sameEpisode(second.snapshot, episode)) ||
                // A dedicated red load-error panel legitimately has no composer.
                // No visible editor exists to contain an unsent draft in that
                // state; otherwise demand a positively empty existing editor.
                !(
                  second.snapshot.draftEmpty === true ||
                  (problem === "load-failure" &&
                    second.snapshot.draftEmpty === null &&
                    second.snapshot.stopVisible === false)
                ) ||
                second.snapshot.permanentReason ||
                (second.snapshot.stopVisible === true && problem === "load-failure")
              ) {
                if (second?.problem === "healthy" && positivelyResumed(second.snapshot)) {
                  delete persistent.red[sessionId];
                  delete persistent.orange[sessionId];
                  saveBoundedState(envId, persistent);
                  stillFailed = false;
                }
                continue;
              }
              if (disposed || !currentSessionIds().includes(sessionId)) continue;
              const recent = readRecoveryHistory(envId);
              const attemptedAt = Date.now();
              if (
                !cooldownElapsed(recent.lastAttemptAt, attemptedAt, RECOVERY_GLOBAL_MS) ||
                !cooldownElapsed(
                  recent.bySession[sessionId] ?? 0,
                  attemptedAt,
                  RECOVERY_PER_SESSION_MS,
                )
              )
                continue;

              if (problem === "load-failure") {
                const attempts = (persistent.red[sessionId]?.attempts ?? 0) + 1;
                persistent.red[sessionId] = {
                  attempts,
                  nextAt: attemptedAt + nextRedRetryDelay(sessionId, attempts),
                  conversationId,
                };
              } else if (episode) {
                persistent.orange[sessionId] = {
                  ...episode,
                  stage: "reloaded",
                  stageAt: attemptedAt,
                };
              }
              if (!saveBoundedState(envId, persistent)) continue;
              if (problem === "load-failure")
                recordChatGPTRecoveryEvent(
                  envId,
                  sessionId,
                  "retry-scheduled",
                  `attempt:${persistent.red[sessionId]?.attempts},next:${new Date(persistent.red[sessionId]!.nextAt).toISOString()}`,
                );
              // Persist global/per-tab serialization independently of component mounts.
              recordRecoveryAttempt(envId, sessionId, attemptedAt, currentSessionIds());
              phase(sessionId, "refreshing");
              const startedAt = Date.now();
              try {
                const finished = await refreshWithDeadline(bridge, runtimeId);
                recordChatGPTRecoveryEvent(
                  envId,
                  sessionId,
                  finished ? "refresh-finished" : "refresh-timeout",
                  problem,
                );
                if (finished) recordChatGPTSessionRefreshedAt(envId, sessionId);
                if (!finished && problem !== "load-failure")
                  noteRecoveryConcern(
                    envId,
                    persistent,
                    sessionId,
                    conversationId,
                    "reload_outcome_ambiguous",
                    Date.now(),
                  );
              } catch (error) {
                recordChatGPTRecoveryEvent(envId, sessionId, "refresh-failed", problem);
                console.warn("[ChatGPT recovery] Refresh failed:", error);
                if (problem !== "load-failure")
                  noteRecoveryConcern(
                    envId,
                    persistent,
                    sessionId,
                    conversationId,
                    "reload_outcome_ambiguous",
                    Date.now(),
                  );
              } finally {
                const remaining = Math.max(0, 1_200 - (Date.now() - startedAt));
                if (remaining) {
                  await new Promise<void>((resolve) => {
                    const timer = setTimeout(() => {
                      cancelIndicatorWait = null;
                      resolve();
                    }, remaining);
                    cancelIndicatorWait = () => {
                      clearTimeout(timer);
                      resolve();
                    };
                  });
                }
              }
              canAttempt = false;
            } finally {
              phase(
                sessionId,
                stillFailed && currentSessionIds().includes(sessionId) ? "queued" : null,
              );
            }
          } finally {
            releasePaint?.();
          }
        }
      } catch (error) {
        console.warn("[ChatGPT recovery] Scanner failed:", error);
      } finally {
        scanning = false;
      }
    };

    const initial = setTimeout(() => void scan(), 20_000);
    const interval = setInterval(() => void scan(), RECOVERY_SCAN_MS);
    return () => {
      disposed = true;
      cancelIndicatorWait?.();
      for (const id of trackedPhases.keys()) reportPhase(id, null);
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [environmentId]);

  return null;
}
