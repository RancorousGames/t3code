import { getChatGPTSessionPersistedStore } from "../../chatGPTSessionPersistedStore";
import {
  readChatGPTRecoverySettings,
  subscribeChatGPTRecoverySettings,
} from "../../chatGPTRecoverySettings";
import type { EnvironmentId } from "@t3tools/contracts";
import { allowsChatGPTOrangeRecoveryAction } from "../../chatGPTOrangeRecoveryStrategy";
import { useEffect, useEffectEvent, useRef } from "react";

import {
  acquireBrowserSurfaceActivity,
  useBrowserSurfaceStore,
} from "../../browser/browserSurfaceStore";
import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import { resetHostedBrowserGuest } from "../../browser/hostedBrowserGuestReset";
import { isPersistentChatGPTSessionOptedIn } from "../../browser/persistentChatGPTSessionMode";
import { chatGPTBrowserFailure, inspectChatGPTBrowserHealth } from "../../chatGPTBrowserHealth";
import { hasUncertainChatGPTSend } from "../../chatGPTSessionControl";
import {
  chatGPTBrowserLastUrlKey,
  chatGPTBrowserThreadRef,
  isChatGPTConversationUrl,
} from "../../chatGPTBrowserSessions";
import { chatGPTConversationIdFromUrl } from "../../chatGPTConversationIdentity";
import { chatGPTDirectSubmitExpression } from "../../chatGPTDirectSubmit";
import { recordChatGPTRecoveryEvent } from "../../chatGPTRecoveryDiagnostics";
import { recordChatGPTRecoveryAttemptLog } from "../../chatGPTRecoveryAttemptLog";
import {
  isChatGPTRecoveryMutationPending,
  tryAcquireChatGPTRecoveryMutation,
} from "../../chatGPTRecoveryMutationGate";
import {
  readChatGPTRecoveryMetrics,
  recordChatGPTRecoveryMetric,
  recordChatGPTRecoveryObservation,
  type RecoveryEpisode,
} from "../../chatGPTRecoveryMetrics";
import {
  beginRecoveryAttempt,
  finishRecoveryAttempt,
  noteRecoveryFailure,
  noteRecoveryVerified,
  readRecoveryQueue,
  reconcileRecoveryQueue,
  recoveryTargetOrder,
  recordRecoveryScan,
  type RecoveryQueueContext,
} from "./chatGPTRecoveryQueue";
import { recordChatGPTSessionRefreshedAt } from "../../chatGPTSessionTimestamps";
import { isChatGPTHomeUrl, isChatGPTSettingsUrl } from "../../chatGPTBrowserPrewarm";
import { inspectChatGPTPage } from "../../chatGPTSessionDom";
import { isChatGPTGuestHibernated } from "../../browser/chatGPTGuestHibernation";
import { subscribeHostedBrowserGuestPresence } from "../../browser/hostedBrowserGuestPresence";
import { recoveryNextWakeDelayMs } from "../../chatGPTRecoveryWake";
import { readThreadPreviewState } from "../../previewStateStore";
import { previewBridge } from "../preview/previewBridge";
import { CHATGPT_ACTIVITY_EXPRESSION } from "./chatGPTActivity";
import { ChatGPTNativeRecoveryCoordinator } from "./ChatGPTNativeRecoveryCoordinator";
import {
  RECOVERY_REFRESH_TIMEOUT_MS,
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
interface MetricBinding {
  id: string;
  conversationId: string;
  userTurnKey: string | null;
  /** Content is never stored; this hash only distinguishes an advanced assistant reply. */
  assistantAtStart: number | null;
}
interface PersistentRecovery {
  metrics: Record<string, MetricBinding>;
  red: Record<string, { attempts: number; nextAt: number; conversationId: string }>;
  orange: Record<string, OrangeEpisode>;
}
const recoveryStateKey = (environmentId: string) =>
  `t3code:chatgpt-browser:bounded-recovery:${environmentId}`;
function readBoundedState(environmentId: string): PersistentRecovery {
  try {
    const data: unknown =
      getChatGPTSessionPersistedStore(environmentId).getState().recovery.bounded;
    if (!data || typeof data !== "object") throw new Error("Invalid recovery record");
    const parsed = data as Partial<PersistentRecovery>;
    return {
      metrics: parsed.metrics ?? {},
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
    return { red: {}, orange: {}, metrics: {} };
  }
}
function saveBoundedState(environmentId: string, state: PersistentRecovery): boolean {
  try {
    localStorage.setItem(recoveryStateKey(environmentId), JSON.stringify(state));
    const store = getChatGPTSessionPersistedStore(environmentId);
    store.setState((previous) => ({
      recovery: { ...previous.recovery, bounded: structuredClone(state) },
    }));
    return true;
  } catch {
    // Fail closed if the at-most-once marker cannot be persisted.
    return false;
  }
}
/**
 * Telemetry is observational and must never change or prevent recovery.
 * Only a positively dispatched browser mutation advances the attempt ordinal.
 * A refresh completion, an idle STOP, or a Continue user turn is not recovery.
 */
function recoveryMetric(
  environmentId: string,
  state: PersistentRecovery,
  sessionId: string,
  conversationId: string,
  snapshot: RecoverySnapshot,
  problem: ChatGPTRecoveryProblem | "healthy",
  action?: "reload" | "stop" | "continue" | "uncertain",
): void {
  try {
    const now = Date.now();
    const ledger = readChatGPTRecoveryMetrics(environmentId);
    if (ledger.availability === "unavailable") return;
    let binding = state.metrics[sessionId];
    let metric: RecoveryEpisode | undefined = ledger.ledger?.episodes.find(
      (entry) => entry.id === binding?.id,
    );
    const sameConversation = binding?.conversationId === conversationId;
    const sameTurn =
      binding?.userTurnKey == null || binding.userTurnKey === snapshot.lastUserTurnKey;
    const continued =
      (metric?.actions?.continue ?? 0) > 0 &&
      snapshot.lastUserIsRecoveryContinue === true &&
      (state.orange[sessionId]?.stage === "continue_issued" ||
        state.orange[sessionId]?.stage === "recovered");
    if (metric?.outcome === "active" && (!sameConversation || (!sameTurn && !continued))) {
      recordChatGPTRecoveryMetric(environmentId, {
        ...metric,
        updatedAt: now,
        closedAt: now,
        outcome: "unknown",
      });
      metric = undefined;
    }
    if (problem === "healthy") {
      // Require actual resumed generation or positively advanced assistant content.
      const advanced =
        snapshot.activity === "working" ||
        (snapshot.lastRole === "assistant" &&
          snapshot.assistantHasContent === true &&
          binding?.assistantAtStart !== null &&
          binding?.assistantAtStart !== undefined &&
          assistantSignature(snapshot) !== binding.assistantAtStart);
      if (
        metric?.outcome === "active" &&
        sameConversation &&
        (sameTurn || continued) &&
        positivelyResumed(snapshot) &&
        advanced &&
        !snapshot.permanentReason
      ) {
        recordChatGPTRecoveryMetric(environmentId, {
          ...metric,
          updatedAt: now,
          closedAt: now,
          outcome: "recovered",
        });
      }
      return;
    }
    if (!metric || metric.outcome !== "active") {
      if (action === "uncertain") return;
      metric = {
        id: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
        sessionId,
        category: problem === "load-failure" ? "red" : "orange",
        cause:
          problem === "load-failure"
            ? "load-failure"
            : problem === "interrupted"
              ? "interrupted"
              : "stalled",
        source: "automatic",
        startedAt: now,
        updatedAt: now,
        attemptCount: 0,
        actions: { reload: 0, stop: 0, continue: 0 },
        outcome: "active",
        closedAt: null,
        // A previous completed incident is not evidence that this new one is partial.
        partial: (!metric && !!binding) || !!state.red[sessionId] || !!state.orange[sessionId],
      };
      binding = {
        id: metric.id,
        conversationId,
        userTurnKey: snapshot.lastUserTurnKey ?? null,
        assistantAtStart: snapshot.lastRole === "assistant" ? assistantSignature(snapshot) : 0,
      };
      state.metrics[sessionId] = binding;
      const ids = Object.keys(state.metrics);
      for (const id of ids.slice(0, Math.max(0, ids.length - 500))) delete state.metrics[id];
      if (!saveBoundedState(environmentId, state)) return;
    }
    if (action === "uncertain") {
      metric = { ...metric, updatedAt: now, partial: true };
    } else if (action) {
      metric = {
        ...metric,
        updatedAt: now,
        attemptCount: metric.attemptCount + 1,
        actions: {
          reload: metric.actions?.reload ?? 0,
          stop: metric.actions?.stop ?? 0,
          continue: metric.actions?.continue ?? 0,
          [action]: (metric.actions?.[action] ?? 0) + 1,
        },
      };
    }
    recordChatGPTRecoveryMetric(environmentId, metric);
  } catch {
    // Metrics are best effort. They never permit an otherwise unsafe reload/send.
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
  // Red failures retry indefinitely at the shared global cadence. Orange
  // retains its separate per-session cooldown and guarded recovery sequence.
  return readChatGPTRecoverySettings().globalSeconds * 1_000;
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
// STOP is scoped to an unchanged orphaned turn. Continue is passed to
// ChatGPT's React submit handler without ever typing into the user editor.
// Persist the episode before this call; an ambiguous callback is never replayed.
function guardedRecoveryContinueDirectExpression(
  conversationId: string,
  episode: OrangeEpisode,
): string {
  const submit = chatGPTDirectSubmitExpression({
    text: "Continue.",
    expectedConversationId: conversationId,
  });
  return `(() => {
    const actual = (${chatGPTConversationIdFromUrl.toString()})(location.href);
    if (actual !== ${JSON.stringify(conversationId)}) return {result:"identity_changed"};
    const page = (${inspectChatGPTPage.toString()})({from:"end",count:1,includeMessages:false});
    if (page.lastUserTurnKey !== ${JSON.stringify(episode.userTurnKey)} ||
        page.lastUserTurn !== ${episode.userTurn}) return {result:"turn_changed"};
    if (${CHATGPT_ACTIVITY_EXPRESSION} !== "idle") return {result:"not_idle"};
    const stop = document.querySelector('button[data-testid="stop-button"],button[data-testid="composer-stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"]');
    if (stop && stop.getClientRects().length && !stop.hasAttribute("disabled")) return {result:"still_generating"};
    const result = ${submit};
    return {result: result.submitted ? "continue_submitted" : result.reason ?? "direct_unavailable"};
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

// One active scanner per environment. A disconnected component must release its slot.
const activeRecoveryScans = new Map<string, symbol>();
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
  environmentId: string,
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
    const observed =
      problem && result && typeof result === "object"
        ? { problem, snapshot: result as RecoverySnapshot }
        : null;
    if (observed) recordChatGPTRecoveryObservation(environmentId, Date.now());
    return observed;
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
  onBridgeSettled: () => void,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The deadline bounds UI waiting, NOT the underlying bridge action. Keep its
  // exclusive mutation lease until the bridge promise actually settles.
  const operation = Promise.resolve().then(() => bridge.refresh(runtimeId));
  void operation.then(onBridgeSettled, onBridgeSettled);
  try {
    const finished = await Promise.race([
      operation.then(() => true),
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

/** Stop/Continue can also hang in an Electron guest; never replay a timed-out action. */
async function executeGuestRecoveryActionWithDeadline(
  webview: { executeJavaScript: (expression: string) => Promise<unknown> },
  expression: string,
  onActionSettled: () => void,
): Promise<{ result?: string } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = Promise.resolve().then(() => webview.executeJavaScript(expression));
  void operation.then(onActionSettled, onActionSettled);
  try {
    return (await Promise.race([
      operation,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), RECOVERY_REFRESH_TIMEOUT_MS);
      }),
    ])) as { result?: string } | null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Bound host reset without treating a timed-out IPC response as cancellation. */
async function resetWithDeadline(
  runtimeId: string,
  url: string,
  onBridgeSettled: () => void,
): Promise<Awaited<ReturnType<typeof resetHostedBrowserGuest>> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = Promise.resolve().then(() => resetHostedBrowserGuest(runtimeId, url));
  void operation.then(onBridgeSettled, onBridgeSettled);
  try {
    return await Promise.race([
      operation,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), RECOVERY_REFRESH_TIMEOUT_MS);
      }),
    ]);
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
  managerIds = NO_DEFERRED_IDS,
  interruptedIds = NO_DEFERRED_IDS,
  selectedId,
  lastActive = {},
  onPhaseChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly sessionIds: readonly string[];
  readonly deferredIds?: readonly string[];
  readonly wakeupIds?: readonly string[];
  /** All visible red sessions stay in the recovery queue, even while their guest cannot be inspected. */
  readonly redIds?: readonly string[];
  readonly managerIds?: readonly string[];
  /** Only statuses observed as interrupted/delivery-timeout, never role or title guesses. */
  readonly interruptedIds?: readonly string[];
  readonly selectedId?: string | null;
  readonly lastActive?: Readonly<Record<string, number>>;
  readonly onPhaseChange?: (sessionId: string, phase: ChatGPTRecoveryPhase | null) => void;
}) {
  const currentSessionIds = useEffectEvent(() => sessionIds);
  const currentDeferredIds = useEffectEvent(() => deferredIds);
  const currentWakeupIds = useEffectEvent(() => wakeupIds);
  const currentRedIds = useEffectEvent(() => redIds);
  const currentManagerIds = useEffectEvent(() => managerIds);
  const currentInterruptedIds = useEffectEvent(() => interruptedIds);
  const currentSelectedId = useEffectEvent(() => selectedId);
  const currentLastActive = useEffectEvent(() => lastActive);
  const reportPhase = useEffectEvent((sessionId: string, phase: ChatGPTRecoveryPhase | null) =>
    onPhaseChange?.(sessionId, phase),
  );

  useEffect(() => {
    if (!previewBridge) return;
    const bridge = previewBridge;
    const envId = environmentId;
    recordChatGPTRecoveryObservation(envId, Date.now());
    let disposed = false;
    const trackedPhases = new Map<string, ChatGPTRecoveryPhase>();
    let wakeupCursor = 0;
    // A transient ChatGPT homepage during startup is not proof of URL loss.
    // Require an unchanged root page across scans before restoring its durable conversation.
    const lostRouteFirstSeen = new Map<string, { url: string; at: number }>();
    // A temporarily missing composer must not turn a usable conversation into
    // a reload. Still recover a genuinely stuck composer after a full minute.
    const missingComposerFirstSeen = new Map<
      string,
      { conversationId: string; webview: Element; at: number }
    >();
    // Records live in localStorage rather than the React component lifecycle.
    // This prevents remounts from replaying a STOP or an ambiguous Continue.
    let cancelIndicatorWait: (() => void) | null = null;
    let activeScanToken: symbol | null = null;
    const changedSessionIds = new Set<string>();
    let fullScanPending = true;
    const context = (): RecoveryQueueContext => ({
      // Shared priority queue; each browser engine has its own guarded
      // recovery implementation. Native entries must not be discarded by
      // the legacy reconciler before the native coordinator inspects them.
      eligibleIds: currentSessionIds(),
      failingIds: currentRedIds(),
      selectedId: currentSelectedId() ?? null,
      managerIds: currentManagerIds(),
      interruptedIds: currentInterruptedIds(),
      recentClicks: readRecentSessionClicks(envId),
      lastActive: currentLastActive(),
      suspendedIds: currentSessionIds().filter((id) => isChatGPTRecoveryMutationPending(envId, id)),
    });
    // Only actual browser mutations count as attempts; there is no terminal cap.
    const begin = (id: string, action: string): boolean => {
      if (readChatGPTRecoverySettings().paused) return false;
      if (hasUncertainChatGPTSend(envId, id)) return false;
      return beginRecoveryAttempt(envId, id, action) !== null;
    };
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
      if (disposed || activeRecoveryScans.has(envId)) return;
      const settings = readChatGPTRecoverySettings();
      if (settings.paused) return;
      // Cross-path exclusion: manual reload and automated recovery share the
      // same environment lease, including all potentially pending guest mutations.
      const mutationLease = tryAcquireChatGPTRecoveryMutation(
        envId,
        "background-scanner",
        "automatic",
        "reload",
      );
      if (!mutationLease) return;
      let scanEnded = false;
      let underlyingBridgeActions = 0;
      let unresolvedBridgeSessionId: string | null = null;
      const retainBridge = (sessionId: string) => {
        unresolvedBridgeSessionId = sessionId;
        underlyingBridgeActions += 1;
        let ended = false;
        return () => {
          if (ended) return;
          ended = true;
          underlyingBridgeActions -= 1;
          if (scanEnded && underlyingBridgeActions === 0) mutationLease.release();
        };
      };
      const RECOVERY_GLOBAL_MS = settings.globalSeconds * 1000;
      const RECOVERY_ORANGE_GLOBAL_MS = settings.orangeGlobalSeconds * 1000;
      const RECOVERY_PER_SESSION_MS = settings.perSessionSeconds * 1000;
      const RECOVERY_ORANGE_GRACE_MS = settings.orangeGraceMinutes * 60000;
      const RECOVERY_MISSING_COMPOSER_GRACE_MS = settings.missingComposerSeconds * 1000;
      const RECOVERY_CONFIRMATION_GAP_MS = 1_000;
      const scanToken = Symbol("recovery-scan");
      activeRecoveryScans.set(envId, scanToken);
      activeScanToken = scanToken;
      recordRecoveryScan(envId);
      try {
        const now = Date.now();
        const history = readRecoveryHistory(envId);
        const persistent = readBoundedState(envId);
        // Red and orange have independent retry clocks AND dispatch slots.
        // An orange action must never consume the pinned red session's slot,
        // even if both become ready during the same event-driven scan.
        const dispatchedLanes = { red: false, orange: false };
        const laneFor = (id: string): "red" | "orange" =>
          readRecoveryQueue(envId).failures[id]?.red || currentRedIds().includes(id)
            ? "red"
            : "orange";
        const canAttemptFor = (lane: "red" | "orange", sessionId: string, at = Date.now()) => {
          const latest = readRecoveryHistory(envId);
          // No red round-robin: the current pin alone may dispatch red mutations.
          if (lane === "red" && readRecoveryQueue(envId).activeRedId !== sessionId) return false;
          return (
            !dispatchedLanes[lane] &&
            at >=
              (lane === "red"
                ? readRecoveryQueue(envId).redBackoffUntil
                : readRecoveryQueue(envId).orangeBackoffUntil) &&
            cooldownElapsed(
              lane === "red" ? latest.redLastAttemptAt : latest.orangeLastAttemptAt,
              at,
              lane === "red" ? RECOVERY_GLOBAL_MS : RECOVERY_ORANGE_GLOBAL_MS,
            )
          );
        };
        const eligibleIds = new Set(currentSessionIds());
        // Retain episode markers across hide/restore/remount. In particular,
        // a dispatched Continue cannot become eligible again after unmount.
        for (const id of trackedPhases.keys()) if (!eligibleIds.has(id)) phase(id, null);
        for (const id of missingComposerFirstSeen.keys()) {
          if (!eligibleIds.has(id)) missingComposerFirstSeen.delete(id);
        }

        // Probe background pages in small batches. Their webviews may be
        // suspended offscreen until clicked, so DOM-only checks miss failures.
        const clicked = readRecentSessionClicks(envId);
        const queue = reconcileRecoveryQueue(envId, context());
        const targets = recoveryTargetOrder(queue, currentSelectedId());
        const fullScan = fullScanPending;
        fullScanPending = false;
        const changed = new Set(changedSessionIds);
        changedSessionIds.clear();
        const allCandidates = [
          ...targets,
          ...orderedCandidates(
            currentSessionIds(),
            history,
            clicked,
            new Set(currentDeferredIds()),
            new Set(currentRedIds()),
          ).filter((id) => !targets.includes(id)),
        ];
        // Deadline and status events inspect affected/failed guests only. The
        // infrequent watchdog performs the full background discovery pass.
        const candidates = fullScan
          ? allCandidates
          : allCandidates.filter(
              (id) =>
                changed.has(id) ||
                queue.targets.includes(id) ||
                !!persistent.red[id] ||
                !!persistent.orange[id] ||
                missingComposerFirstSeen.has(id) ||
                lostRouteFirstSeen.has(id),
            );
        const wakeupSet = new Set(currentWakeupIds());
        // Native pages do not have legacy paint surfaces. Never spend scarce
        // webview wake slots on entries handled by the native coordinator.
        const toWake = candidates.filter((id) => wakeupSet.has(id) && !isPersistentChatGPTSessionOptedIn(id));
        const wakeNow = new Set<string>();
        for (let n = 0; n < Math.min(BACKGROUND_PROBES_PER_SCAN, toWake.length); n++) {
          wakeNow.add(toWake[(wakeupCursor + n) % toWake.length]!);
        }
        if (toWake.length) wakeupCursor = (wakeupCursor + wakeNow.size) % toWake.length;
        for (const sessionId of candidates) {
          if (disposed) return;
          // Native Chrome pages are not preview webviews. Stale preview health
          // or URL state can never authorize legacy reset/navigation/reload.
          if (isPersistentChatGPTSessionOptedIn(sessionId)) continue;
          if (!currentSessionIds().includes(sessionId)) continue;
          if (isChatGPTRecoveryMutationPending(envId, sessionId)) {
            recordChatGPTRecoveryEvent(
              envId,
              sessionId,
              "blocked",
              "previous-browser-action-unresolved",
            );
            continue;
          }
          const threadRef = chatGPTBrowserThreadRef(envId, sessionId);
          const state = readThreadPreviewState(threadRef);
          const tabId = state.activeTabId;
          if (!tabId || !state.serverEpoch) {
            missingComposerFirstSeen.delete(sessionId);
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
            missingComposerFirstSeen.delete(sessionId);
            if (persistent.red[sessionId])
              recordChatGPTRecoveryEvent(envId, sessionId, "blocked", "guest-not-attached");
            if (!currentRedIds().includes(sessionId)) phase(sessionId, null);
            continue;
          }

          // A settings tab is an intentional destination without a composer.
          // Never reset, reload or restore a conversation over the user's settings page.
          if (
            isChatGPTSettingsUrl(webview.getURL()) ||
            (nav?._tag === "Success" && isChatGPTSettingsUrl(nav.url))
          ) {
            lostRouteFirstSeen.delete(sessionId);
            missingComposerFirstSeen.delete(sessionId);
            phase(sessionId, null);
            continue;
          }
          if (currentRedIds().includes(sessionId)) phase(sessionId, "queued");

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
              missingComposerFirstSeen.delete(sessionId);
              if (persistent.red[sessionId])
                recordChatGPTRecoveryEvent(envId, sessionId, "blocked", "guest-hibernated");
              continue; // Closed/archived and sleeping guests are not recovery targets.
            }
            // A new blank homepage has no conversation identity, so it must be
            // handled before conversation-only recovery. Never wake hidden guests
            // just to diagnose a renderer, or reset a timed-out conversation blindly.
            // A blank page can stay red after its tab is deselected. The wake
            // lease keeps its offscreen guest inspectable; restricting this probe
            // to visible surfaces would queue that failure forever without a reset.
            if (
              useBrowserSurfaceStore.getState().byTabId[runtimeId]?.visible ||
              wakeNow.has(sessionId)
            ) {
              await inspectChatGPTBrowserHealth(webview);
              const failure = chatGPTBrowserFailure(webview);
              if (failure) {
                missingComposerFirstSeen.delete(sessionId);
                recordChatGPTRecoveryEvent(
                  envId,
                  sessionId,
                  "failure-observed",
                  `browser-unresponsive:${failure}`,
                );
                const guestUrl = webview.getURL();
                const automaticReset =
                  failure === "blank-page" || (!expectedUrl && isChatGPTHomeUrl(guestUrl));
                const latest = readThreadPreviewState(threadRef);
                const attemptedAt = Date.now();
                const recent = readRecoveryHistory(envId);
                if (automaticReset)
                  noteRecoveryFailure(envId, sessionId, "browser-unresponsive", context());
                if (
                  !disposed &&
                  currentSessionIds().includes(sessionId) &&
                  automaticReset &&
                  !hasUncertainChatGPTSend(envId, sessionId) &&
                  latest.activeTabId === tabId &&
                  latest.serverEpoch === state.serverEpoch &&
                  Array.from(document.querySelectorAll("webview")).includes(webview) &&
                  canAttemptFor(laneFor(sessionId), sessionId, attemptedAt) &&
                  readRecoveryQueue(envId).targets.includes(sessionId) &&
                  (currentRedIds().includes(sessionId) ||
                    cooldownElapsed(
                      recent.bySession[sessionId] ?? 0,
                      attemptedAt,
                      RECOVERY_PER_SESSION_MS,
                    ))
                ) {
                  if (!begin(sessionId, "browser-reset")) continue;
                  recordRecoveryAttempt(
                    envId,
                    sessionId,
                    attemptedAt,
                    currentSessionIds(),
                    laneFor(sessionId),
                  );
                  dispatchedLanes[laneFor(sessionId)] = true;
                  phase(sessionId, "refreshing");
                  recordChatGPTRecoveryEvent(envId, sessionId, "browser-reset-requested", failure);
                  try {
                    const result = await resetWithDeadline(
                      runtimeId,
                      expectedUrl ?? guestUrl,
                      retainBridge(sessionId),
                    );
                    if (!result) throw new Error("Browser reset still pending after deadline");
                    recordChatGPTRecoveryEvent(
                      envId,
                      sessionId,
                      "browser-reset-attached",
                      `${result.previousWebContentsId}->${result.webContentsId}`,
                    );
                    finishRecoveryAttempt(
                      envId,
                      sessionId,
                      "browser-reset attached; health pending",
                    );
                  } catch {
                    recordChatGPTRecoveryEvent(envId, sessionId, "browser-reset-unconfirmed");
                    finishRecoveryAttempt(envId, sessionId, "browser-reset unconfirmed");
                  } finally {
                    phase(sessionId, null);
                  }
                }
                continue;
              }
            }
            if (!expectedUrl) {
              lostRouteFirstSeen.delete(sessionId);
              missingComposerFirstSeen.delete(sessionId);
              if (persistent.orange[sessionId] || persistent.red[sessionId])
                noteRecoveryConcern(
                  envId,
                  persistent,
                  sessionId,
                  null,
                  "saved_conversation_url_lost",
                  Date.now(),
                );
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
              missingComposerFirstSeen.delete(sessionId);
              const first = lostRouteFirstSeen.get(sessionId);
              if (!first || first.url !== expectedUrl) {
                lostRouteFirstSeen.set(sessionId, { url: expectedUrl, at: Date.now() });
                continue;
              }
              if (
                Date.now() - first.at < RECOVERY_CONFIRMATION_GAP_MS ||
                !canAttemptFor(laneFor(sessionId), sessionId) ||
                (!currentRedIds().includes(sessionId) &&
                  !cooldownElapsed(
                    history.bySession[sessionId] ?? 0,
                    Date.now(),
                    RECOVERY_PER_SESSION_MS,
                  ))
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
              noteRecoveryFailure(envId, sessionId, "lost conversation route", context());
              if (!readRecoveryQueue(envId).targets.includes(sessionId)) continue;
              const attemptedAt = Date.now();
              const recent = readRecoveryHistory(envId);
              if (
                !canAttemptFor(laneFor(sessionId), sessionId, attemptedAt) ||
                (!currentRedIds().includes(sessionId) &&
                  !cooldownElapsed(
                    recent.bySession[sessionId] ?? 0,
                    attemptedAt,
                    RECOVERY_PER_SESSION_MS,
                  ))
              )
                continue;
              if (!begin(sessionId, "restore-route")) continue;
              recordRecoveryAttempt(
                envId,
                sessionId,
                attemptedAt,
                currentSessionIds(),
                laneFor(sessionId),
              );
              dispatchedLanes[laneFor(sessionId)] = true;
              phase(sessionId, "refreshing");
              let navigationTimer: ReturnType<typeof setTimeout> | undefined;
              const navigation = Promise.resolve().then(() =>
                bridge.navigate(runtimeId, expectedUrl),
              );
              const routeSettled = retainBridge(sessionId);
              void navigation.then(routeSettled, routeSettled);
              try {
                await Promise.race([
                  navigation,
                  new Promise<never>((_, reject) => {
                    navigationTimer = setTimeout(
                      () => reject(new Error("Lost-route navigation timed out")),
                      RECOVERY_REFRESH_TIMEOUT_MS,
                    );
                  }),
                ]);
                lostRouteFirstSeen.delete(sessionId);
                finishRecoveryAttempt(envId, sessionId, "route restored; health pending");
              } catch (error) {
                finishRecoveryAttempt(envId, sessionId, "route navigation unconfirmed");
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
            const observed = await inspectFailure(webview, expectedUrl, envId);
            if (disposed || !currentSessionIds().includes(sessionId)) continue;
            if (!observed) {
              missingComposerFirstSeen.delete(sessionId);
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
            if (snapshot.activity !== "invalid: the ChatGPT composer is unavailable")
              missingComposerFirstSeen.delete(sessionId);
            if (problem !== "healthy") {
              recordChatGPTRecoveryEvent(envId, sessionId, "failure-observed", problem);
              noteRecoveryFailure(envId, sessionId, problem, context());
            }
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
              missingComposerFirstSeen.delete(sessionId);
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
            recoveryMetric(envId, persistent, sessionId, conversationId, snapshot, problem);
            if (problem === "healthy") {
              if (red) {
                recordChatGPTRecoveryEvent(envId, sessionId, "healthy", "red-load-failure-cleared");
                delete persistent.red[sessionId];
                saveBoundedState(envId, persistent);
                noteRecoveryVerified(envId, sessionId);
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
              if (
                episode?.stage === "stop_issued" &&
                allowsChatGPTOrangeRecoveryAction(settings.orangeStrategy, "continue") &&
                safeIdleForContinue(snapshot, episode)
              ) {
                // The STOP click from the previous scan has visibly reached idle.
                // One durable marker must precede the direct callback.
                const latest = readThreadPreviewState(threadRef);
                if (latest.activeTabId !== tabId || latest.serverEpoch !== state.serverEpoch)
                  continue;
                const beforeContinue = await inspectFailure(webview, expectedUrl, envId);
                if (
                  !beforeContinue ||
                  beforeContinue.problem !== "healthy" ||
                  !safeIdleForContinue(beforeContinue.snapshot, episode) ||
                  disposed ||
                  !currentSessionIds().includes(sessionId)
                )
                  continue;
                // The Stop/Continue sequence belongs to an already-counted orange
                // reload; do not start a new orange cooldown between its guarded stages.
                if (
                  dispatchedLanes.orange ||
                  Date.now() < readRecoveryQueue(envId).orangeBackoffUntil
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
                dispatchedLanes.orange = true;
                recordChatGPTRecoveryAttemptLog(envId, {
                  at: Date.now(),
                  kind: "attempt",
                  sessionId,
                  attemptNumber: readRecoveryQueue(envId).failures[sessionId]?.attempts ?? 0,
                  detail: "orange Continue (guarded)",
                });
                try {
                  // Identity, orphan turn and idle state are checked atomically
                  // with the direct React callback. No intermediate typed draft.
                  const dispatched = await executeGuestRecoveryActionWithDeadline(
                    webview,
                    guardedRecoveryContinueDirectExpression(conversationId, stamped),
                    retainBridge(sessionId),
                  );
                  recoveryMetric(
                    envId,
                    persistent,
                    sessionId,
                    conversationId,
                    snapshot,
                    episode.problem,
                    dispatched?.result === "continue_submitted" ? "continue" : "uncertain",
                  );
                  if (dispatched?.result !== "continue_submitted")
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
                  recoveryMetric(
                    envId,
                    persistent,
                    sessionId,
                    conversationId,
                    snapshot,
                    episode.problem,
                    "uncertain",
                  );
                  console.warn("[ChatGPT recovery] Continue left for human reconciliation:", error);
                }
                // Even a successful callback is NOT proof of delivery or completion.
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
              if (!episode || episode.stage === "recovered" || episode.stage === "grace")
                noteRecoveryVerified(envId, sessionId);
              phase(sessionId, null);
              continue;
            }

            phase(sessionId, "queued");
            // A missing composer can occur while ChatGPT hydrates or briefly
            // re-renders a healthy conversation. Verify the same exact broken
            // conversation across >= 60 seconds before permitting a reload.
            if (snapshot.activity === "invalid: the ChatGPT composer is unavailable") {
              const first = missingComposerFirstSeen.get(sessionId);
              if (!first || first.conversationId !== conversationId || first.webview !== webview) {
                missingComposerFirstSeen.set(sessionId, {
                  conversationId,
                  webview,
                  at: Date.now(),
                });
                continue;
              }
              if (Date.now() - first.at < RECOVERY_MISSING_COMPOSER_GRACE_MS) continue;
            }
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
              if (!allowsChatGPTOrangeRecoveryAction(settings.orangeStrategy, "reload")) continue;
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
                if (!allowsChatGPTOrangeRecoveryAction(settings.orangeStrategy, "stop")) continue;
                // A *second* exact-conversation health check precedes STOP.
                if (Date.now() - episode.stageAt < 10_000) continue;
                const latest = readThreadPreviewState(threadRef);
                if (
                  latest.activeTabId !== tabId ||
                  latest.serverEpoch !== state.serverEpoch ||
                  document.querySelector(`webview[data-preview-tab="${runtimeId}"]`) !== webview
                )
                  continue;
                const confirmed = await inspectFailure(webview, expectedUrl, envId);
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
                // The Stop/Continue sequence belongs to an already-counted orange
                // reload; do not start a new orange cooldown between its guarded stages.
                if (
                  dispatchedLanes.orange ||
                  Date.now() < readRecoveryQueue(envId).orangeBackoffUntil
                )
                  continue;
                persistent.orange[sessionId] = {
                  ...episode,
                  stage: "stop_issued",
                  stageAt: Date.now(),
                  assistantSignature: assistantSignature(confirmed.snapshot),
                  stopAttempted: true,
                };
                if (!saveBoundedState(envId, persistent)) continue;
                dispatchedLanes.orange = true;
                recordChatGPTRecoveryAttemptLog(envId, {
                  at: Date.now(),
                  kind: "attempt",
                  sessionId,
                  attemptNumber: readRecoveryQueue(envId).failures[sessionId]?.attempts ?? 0,
                  detail: "orange Stop (guarded)",
                });
                try {
                  const response = await executeGuestRecoveryActionWithDeadline(
                    webview,
                    stopOrphanExpression(conversationId, episode),
                    retainBridge(sessionId),
                  );
                  recoveryMetric(
                    envId,
                    persistent,
                    sessionId,
                    conversationId,
                    snapshot,
                    problem,
                    response?.result === "stop_clicked" ? "stop" : "uncertain",
                  );
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
                  recoveryMetric(
                    envId,
                    persistent,
                    sessionId,
                    conversationId,
                    snapshot,
                    problem,
                    "uncertain",
                  );
                }
                continue;
              }
            } else {
              delete persistent.orange[sessionId];
              saveBoundedState(envId, persistent);
            }

            // Strategy applies only to orange stalls. Red load-failure retry
            // remains independent of user experiments with orange recovery.
            if (
              problem !== "load-failure" &&
              !allowsChatGPTOrangeRecoveryAction(settings.orangeStrategy, "reload")
            )
              continue;

            // Red skips individual cooldowns; orange keeps them.
            const perSessionWait =
              problem !== "load-failure" &&
              !cooldownElapsed(
                history.bySession[sessionId] ?? 0,
                Date.now(),
                RECOVERY_PER_SESSION_MS,
              );
            if (
              !canAttemptFor(problem === "load-failure" ? "red" : "orange", sessionId) ||
              perSessionWait ||
              !readRecoveryQueue(envId).targets.includes(sessionId)
            ) {
              recordChatGPTRecoveryEvent(
                envId,
                sessionId,
                "waiting",
                !canAttemptFor(problem === "load-failure" ? "red" : "orange", sessionId)
                  ? "lane-cooldown-or-global-backoff"
                  : `next-eligible:${new Date((history.bySession[sessionId] ?? 0) + RECOVERY_PER_SESSION_MS).toISOString()}`,
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
              const second = await inspectFailure(webview, expectedUrl, envId);
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
                  recoveryMetric(
                    envId,
                    persistent,
                    sessionId,
                    conversationId,
                    second.snapshot,
                    "healthy",
                  );
                  delete persistent.red[sessionId];
                  delete persistent.orange[sessionId];
                  saveBoundedState(envId, persistent);
                  noteRecoveryVerified(envId, sessionId);
                  stillFailed = false;
                }
                continue;
              }
              if (disposed || !currentSessionIds().includes(sessionId)) continue;
              const recent = readRecoveryHistory(envId);
              const attemptedAt = Date.now();
              if (
                !canAttemptFor(
                  problem === "load-failure" ? "red" : "orange",
                  sessionId,
                  attemptedAt,
                ) ||
                (problem !== "load-failure" &&
                  !cooldownElapsed(
                    recent.bySession[sessionId] ?? 0,
                    attemptedAt,
                    RECOVERY_PER_SESSION_MS,
                  ))
              )
                continue;

              if (!begin(sessionId, "refresh:" + problem)) continue;
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
                  `attempt:${persistent.red[sessionId]?.attempts},global-cadence`,
                );
              // A replaced/rehydrating guest must demonstrate the full sustained
              // missing-composer failure again before another automatic reload.
              if (snapshot.activity === "invalid: the ChatGPT composer is unavailable")
                missingComposerFirstSeen.delete(sessionId);
              // Persist global/per-tab serialization independently of component mounts.
              recordRecoveryAttempt(
                envId,
                sessionId,
                attemptedAt,
                currentSessionIds(),
                problem === "load-failure" ? "red" : "orange",
              );
              dispatchedLanes[problem === "load-failure" ? "red" : "orange"] = true;
              phase(sessionId, "refreshing");
              const startedAt = Date.now();
              try {
                recoveryMetric(
                  envId,
                  persistent,
                  sessionId,
                  conversationId,
                  snapshot,
                  problem,
                  "reload",
                );
                const finished = await refreshWithDeadline(
                  bridge,
                  runtimeId,
                  retainBridge(sessionId),
                );
                recordChatGPTRecoveryEvent(
                  envId,
                  sessionId,
                  finished ? "refresh-finished" : "refresh-timeout",
                  problem,
                );
                if (finished) recordChatGPTSessionRefreshedAt(envId, sessionId);
                finishRecoveryAttempt(
                  envId,
                  sessionId,
                  finished ? "refresh finished; health pending" : "refresh timed out",
                );
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
                finishRecoveryAttempt(envId, sessionId, "refresh failed");
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
              dispatchedLanes[problem === "load-failure" ? "red" : "orange"] = true;
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
        if (activeRecoveryScans.get(envId) === scanToken) activeRecoveryScans.delete(envId);
        if (activeScanToken === scanToken) activeScanToken = null;
        scanEnded = true;
        // Do not replay an unknown host action on its original guest. Let other
        // guests recover while that one remains exclusively reserved until settle.
        if (underlyingBridgeActions === 0) mutationLease.release();
        else if (unresolvedBridgeSessionId) mutationLease.yieldToSession(unresolvedBridgeSessionId);
      }
    };

    // One timer at the next *actual* deadline, rather than a full probe on
    // every scanSeconds tick. Status/presence changes schedule immediate work.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let rescanRequested = false;
    const arm = (delayMs: number) => {
      if (timer !== undefined) clearTimeout(timer);
      if (disposed || readChatGPTRecoverySettings().paused) return;
      timer = setTimeout(() => void run(), Math.max(0, delayMs));
    };
    const armNextDeadline = () => {
      if (disposed || readChatGPTRecoverySettings().paused) return;
      const settings = readChatGPTRecoverySettings();
      const now = Date.now();
      const persistent = readBoundedState(envId);
      const observationDeadlines = [
        ...[...lostRouteFirstSeen.values()].map((entry) => entry.at + 1_000),
        ...[...missingComposerFirstSeen.values()].map(
          (entry) => entry.at + settings.missingComposerSeconds * 1_000,
        ),
        ...Object.values(persistent.orange).flatMap((entry) => {
          if (entry.stage === "grace")
            return [entry.firstSeenAt + settings.orangeGraceMinutes * 60_000];
          if (entry.stage === "reloaded") return [entry.stageAt + 10_000];
          if (entry.stage === "stop_issued") return [entry.stageAt + 5_000];
          return [];
        }),
      ];
      const delay = recoveryNextWakeDelayMs({
        now,
        settings,
        queue: readRecoveryQueue(envId),
        history: readRecoveryHistory(envId),
        observationDeadlines,
      });
      // Only a fallback watchdog inspects healthy/background sessions.
      if (delay >= settings.watchdogSeconds * 1_000) fullScanPending = true;
      arm(delay);
    };
    const run = async () => {
      if (disposed || readChatGPTRecoverySettings().paused) return;
      if (running) {
        rescanRequested = true;
        return;
      }
      running = true;
      try {
        await scan();
      } finally {
        running = false;
        if (disposed) return;
        if (rescanRequested) {
          rescanRequested = false;
          arm(100);
        } else armNextDeadline();
      }
    };
    const signal = (id?: string) => {
      if (id) changedSessionIds.add(id);
      else fullScanPending = true;
      if (running) {
        rescanRequested = true;
        return;
      }
      arm(100);
    };
    const onSessionState = (event: Event) => {
      const detail = (event as CustomEvent<{ environmentId?: string; sessionId?: string }>).detail;
      if (detail?.environmentId !== envId) return;
      signal(detail.sessionId);
    };
    const onInputsChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ environmentId?: string }>).detail;
      if (detail?.environmentId === envId) signal();
    };
    const onQueueUpdated = () => {
      // Scanning itself publishes queue changes. Don't recurse on those.
      if (!running) signal();
    };
    window.addEventListener("t3:chatgpt-recovery-state-changed", onSessionState);
    window.addEventListener("t3:chatgpt-recovery-mutation-settled", onSessionState);
    window.addEventListener("t3:chatgpt-recovery-inputs-changed", onInputsChanged);
    window.addEventListener("chatgpt-recovery-queue-updated", onQueueUpdated);
    const unsubscribeGuest = subscribeHostedBrowserGuestPresence(() => signal());
    const unsubscribeSettings = subscribeChatGPTRecoverySettings(() => signal());
    // Inspect preexisting sessions once on mount; no periodic 20s full scans.
    arm(0);
    return () => {
      disposed = true;
      // Cancel passive ownership but never release an unresolved guest action.
      if (activeScanToken && activeRecoveryScans.get(envId) === activeScanToken)
        activeRecoveryScans.delete(envId);
      cancelIndicatorWait?.();
      for (const id of trackedPhases.keys()) reportPhase(id, null);
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener("t3:chatgpt-recovery-state-changed", onSessionState);
      window.removeEventListener("t3:chatgpt-recovery-mutation-settled", onSessionState);
      window.removeEventListener("t3:chatgpt-recovery-inputs-changed", onInputsChanged);
      window.removeEventListener("chatgpt-recovery-queue-updated", onQueueUpdated);
      unsubscribeGuest();
      unsubscribeSettings();
    };
  }, [environmentId]);

  // Input lists are supplied by activity observers. Changes should not wait for
  // the watchdog, and the coordinator effect itself must remain mounted.
  const inputSignature = JSON.stringify([
    sessionIds,
    redIds,
    interruptedIds,
    wakeupIds,
    deferredIds,
    managerIds,
    selectedId,
  ]);
  const initialInputs = useRef<string | null>(null);
  useEffect(() => {
    const signature = JSON.stringify([environmentId, inputSignature]);
    if (initialInputs.current === null) {
      initialInputs.current = signature;
      return;
    }
    if (initialInputs.current === signature) return;
    initialInputs.current = signature;
    window.dispatchEvent(
      new CustomEvent("t3:chatgpt-recovery-inputs-changed", {
        detail: { environmentId },
      }),
    );
  }, [environmentId, inputSignature]);

  return (
    <ChatGPTNativeRecoveryCoordinator
      environmentId={environmentId}
      sessionIds={sessionIds}
      redIds={redIds}
      interruptedIds={interruptedIds}
      selectedId={selectedId}
      managerIds={managerIds}
    />
  );
}
