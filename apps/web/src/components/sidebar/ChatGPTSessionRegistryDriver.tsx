// Desktop-only registry driver. Deliberately independent of the sidebar route:
// changing between Session/Browser never changes which desktop owns the guest.
import {
  AuthOrchestrationOperateScope,
  readCaffyRecord,
  type CaffyReadout,
  type ChatGPTRegistryAction,
  type ChatGPTRegistryRecord,
  type ChatGPTRegistrySnapshot,
  type ChatGPTRegistryTimeline,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { isElectron } from "../../env";
import { CHATGPT_CLOSE_UNDO_MS } from "../../chatGPTClosedSessionUndo";
import { randomUUID } from "../../lib/utils";
import { getChatGPTSessionPersistedStore } from "../../chatGPTSessionPersistedStore";
import type { ChatGPTPageSnapshot } from "../../chatGPTPageSnapshotInspection";
import {
  BrowserSessions,
  chatGPTBrowserRemovalAuditKey,
  chatGPTBrowserSessionsKey,
  readChatGPTBrowserSessions,
  useChatGPTBrowserSessions,
} from "../../chatGPTBrowserSessions";
import { hydrateRegistryEvidence, registryBrowserSession } from "../../chatGPTRegistryProjection";
import { setLocalStorageItem } from "../../hooks/useLocalStorage";
import { runChatGPTSessionControl } from "../../chatGPTSessionControl";
import { queueChatGPTSessionMessage } from "../../chatGPTSessionMessageQueue";
import { manuallyRetryRecovery, readRecoveryQueue } from "./chatGPTRecoveryQueue";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import {
  readChatGPTRegistry,
  registerChatGPTRegistryDriver,
  heartbeatChatGPTRegistryDriver,
  disconnectChatGPTRegistryDriver,
  syncChatGPTRegistry,
  closeChatGPTRegistry,
  takeChatGPTRegistryActions,
  finishChatGPTRegistryAction,
} from "../../state/chatGPTSessionRegistry";

// Keep the server snapshot intentionally smaller than the existing local one.
// These fields are page observations, NEVER the composer's draft text or hash.
export function registrySnapshotFromPage(value: unknown): ChatGPTRegistrySnapshot | null {
  if (!value || typeof value !== "object") return null;
  const page = value as Partial<ChatGPTPageSnapshot>;
  if (
    typeof page.contentHash !== "string" ||
    typeof page.observedAt !== "number" ||
    !Number.isFinite(page.observedAt)
  )
    return null;
  const signals: Record<string, unknown> = {};
  if (page.signals) {
    const { draftPresent: _draftPresent, ...safeSignals } = page.signals;
    Object.assign(signals, safeSignals);
  }
  return {
    contentHash: page.contentHash,
    observedAt: page.observedAt,
    ...(typeof page.lastUser?.text === "string"
      ? { lastUserText: page.lastUser.text.slice(0, 600) }
      : {}),
    ...(typeof page.lastAssistant?.text === "string"
      ? { lastAssistantText: page.lastAssistant.text.slice(0, 600) }
      : {}),
    ...(typeof page.lastAssistant?.endsWithQuestion === "boolean"
      ? { lastAssistantEndsWithQuestion: page.lastAssistant.endsWithQuestion }
      : {}),
    ...(typeof page.url === "string" ? { url: page.url } : {}),
    ...(typeof page.conversationId === "string" ? { conversationId: page.conversationId } : {}),
    ...(Number.isSafeInteger(page.turnCount) ? { turnCount: page.turnCount } : {}),
    ...(page.activity &&
    ["working", "idle", "interrupted", "failed", "unknown"].includes(page.activity)
      ? { activity: page.activity }
      : {}),
    signals,
  };
}

interface SyncRecord {
  environmentId: string;
  sessionId: string;
  record: ChatGPTRegistryRecord;
  snapshot: ChatGPTRegistrySnapshot | null;
  timeline: ChatGPTRegistryTimeline | null;
  appliedMetadataRevision: number;
}
export function registryChangesFromStore(
  environmentId: string,
  appliedRevisions: Readonly<Record<string, number>> = {},
): SyncRecord[] {
  const state = getChatGPTSessionPersistedStore(environmentId).getState();
  return state.sessions
    .filter((session) => typeof session.id === "string" && !!session.id)
    .map((session) => ({
      environmentId,
      sessionId: session.id,
      record: { ...session },
      snapshot: registrySnapshotFromPage(state.snapshots[session.id]),
      timeline: state.timeline[session.id] ?? null,
      appliedMetadataRevision:
        Number.isSafeInteger(appliedRevisions[session.id]) &&
        (appliedRevisions[session.id] ?? 0) > 0
          ? appliedRevisions[session.id]!
          : 0,
    }));
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 240)
    : "The guarded ChatGPT operation failed.";
}

/** Only known guarded operations can run. Unsupported registry action IDs
 * return a negative receipt; they never fall back to arbitrary guest JS. */
export async function executeRegistryDriverAction(
  environmentId: EnvironmentId,
  action: ChatGPTRegistryAction,
  setSessionSnooze: (ids: readonly string[], until: number | null) => void,
  setSessionCompletion: (
    id: string,
    completion: { declaredAt: string; observedTurns: number; observedUrl: string | null },
  ) => void,
): Promise<Record<string, unknown>> {
  const scheduler = window.desktopBridge?.caffyControl;
  if (["schedule_new", "schedule_list", "schedule_cancel"].includes(action.actionId)) {
    if (action.sessionId !== "scheduled-chatgpt")
      return { ok: false, reason: "Invalid scheduler target." };
    if (!scheduler) return { ok: false, reason: "Desktop scheduler unavailable." };
    try {
      if (action.actionId === "schedule_list") {
        const result = await scheduler({ action: "list" });
        const data = result && typeof result === "object" ? result as {
          scheduledSpawns?: readonly Record<string, unknown>[];
          entries?: readonly Record<string, unknown>[];
          keepT3Busy?: boolean;
        } : {};
        return { ok: true, status: "schedules_listed",
          jobs: (data.scheduledSpawns ?? []).slice(-30),
          entries: (data.entries ?? []).filter(entry =>
            (typeof entry.beginAt === "number" && entry.beginAt > Date.now()) ||
            (typeof entry.delayedPrompt === "string" && !!entry.delayedPrompt) ||
            (typeof entry.pendingMessageBody === "string" && !!entry.pendingMessageBody &&
              !entry.pendingMessageBody.startsWith("Continue working on your current assignment.")))
            .map(entry => ({
              sessionId: entry.sessionId, beginAt: entry.beginAt,
              mode: entry.mode, onceOnly: entry.onceOnly, pendingWake: entry.pendingWake,
              onIdle: entry.mode === "queued" && entry.beginAt == null,
            })),
          keepT3Busy: data.keepT3Busy ?? false,
        };
      }
      if (action.actionId === "schedule_cancel") {
        const jobId = action.args.jobId;
        if (typeof jobId !== "string" || !/^[0-9a-f-]{36}$/i.test(jobId))
          return { ok: false, reason: "A scheduled job UUID is required." };
        await scheduler({ action: "cancel_spawn", jobId });
        return { ok: true, status: "schedule_cancelled" };
      }
      const title = action.args.title;
      const prompt = action.args.prompt;
      const onIdle = action.args.onIdle === true;
      const beginAt = action.args.beginAt;
      if (typeof title !== "string" || title.trim().length < 1 || title.length > 120 ||
          typeof prompt !== "string" || !prompt.trim() || prompt.length > 8_000 ||
          (onIdle ? beginAt !== null : !Number.isSafeInteger(beginAt) ||
            (beginAt as number) <= Date.now() ||
            (beginAt as number) > Date.now() + 90 * 24 * 60 * 60_000))
        return { ok: false, reason: "Provide a title, prompt and valid schedule." };
      await scheduler({
        action: "schedule_spawn", jobId: action.requestId,
        title: title.trim(), prompt, onIdle, beginAt: onIdle ? null : beginAt as number,
      });
      return { ok: true, status: "scheduled", jobId: action.requestId };
    } catch (error) {
      return { ok: false, reason: errorText(error) };
    }
  }

  const sessions = readChatGPTBrowserSessions(environmentId);
  const target = sessions.find((entry) => entry.id === action.sessionId);
  if (!target) return { ok: false, reason: "ChatGPT session no longer exists on desktop." };
  if (["caffy_toggle", "caffy_stop", "caffy_once"].includes(action.actionId)) {
    if (!scheduler) return { ok: false, reason: "Desktop Caffy scheduler unavailable." };
    try {
      const state: unknown = await scheduler({ action: "status", sessionId: target.id });
      const current = readCaffyRecord(state);
      if (action.actionId === "caffy_once") {
        if (current) {
          return { ok: false, reason: "A Caffy schedule already exists. Edit or stop it first." };
        }
        await scheduler({ action: "set", sessionId: target.id, mode: "idle",
          onceOnly: true, keepAwake: false, startup: false, respectSlots: false,
          intervalMinutes: 20 });
        return { ok: true, status: "Caffy will continue once when idle." };
      }
      if (!current) return { ok: false, reason: "No active Caffy schedule." };
      if (action.actionId === "caffy_stop") {
        await scheduler({ action: "stop", sessionId: target.id, stopInitiator: "user" });
        return { ok: true, status: "Caffy stopped." };
      }
      await scheduler({ action: current.paused ? "resume" : "pause", sessionId: target.id });
      return { ok: true, status: current.paused ? "Caffy resumed." : "Caffy paused." };
    } catch (error) {
      return { ok: false, reason: errorText(error) };
    }
  }
  if (action.actionId === "schedule_cancel_existing") {
    if (!scheduler) return { ok: false, reason: "Desktop scheduler unavailable." };
    try {
      await scheduler({ action: "cancel_begin", sessionId: target.id });
      return { ok: true, status: "schedule_cancelled" };
    } catch (error) {
      return { ok: false, reason: errorText(error) };
    }
  }
  if (action.actionId === "schedule_existing") {
    if (!scheduler) return { ok: false, reason: "Desktop scheduler unavailable." };
    const prompt = action.args.prompt;
    const onIdle = action.args.onIdle === true;
    const beginAt = action.args.beginAt;
    const expectedConversationId = action.args.expectedConversationId;
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 8_000 ||
        typeof expectedConversationId !== "string" ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(expectedConversationId) ||
        (onIdle ? beginAt !== null : !Number.isSafeInteger(beginAt) ||
          (beginAt as number) <= Date.now() ||
          (beginAt as number) > Date.now() + 90 * 24 * 60 * 60_000))
      return { ok: false, reason: "Provide a prompt, exact conversation ID and valid schedule." };
    const registered = target.bootstrapIdentity?.state === "registered"
      ? target.bootstrapIdentity.conversationId : null;
    if (registered !== expectedConversationId)
      return { ok: false, reason: "Conversation changed or is unregistered; no prompt scheduled." };
    try {
      await scheduler(onIdle
        ? { action: "set", sessionId: target.id, conversationId: expectedConversationId,
            mode: "queued", onceOnly: true, startup: false, keepAwake: false,
            prompt, beginAt: null }
        : { action: "begin_in", sessionId: target.id, conversationId: expectedConversationId,
            beginAt: beginAt as number, prompt });
      return { ok: true, status: onIdle ? "queued_for_capacity" : "scheduled" };
    } catch (error) {
      return { ok: false, reason: errorText(error) };
    }
  }

  if (action.actionId === "snooze" || action.actionId === "unsnooze") {
    const hours = action.args.hours;
    if (
      action.actionId === "snooze" &&
      (typeof hours !== "number" || !Number.isFinite(hours) || hours < 0.1 || hours > 24)
    ) {
      return { ok: false, reason: "Snooze requires 0.1–24 hours." };
    }
    setSessionSnooze(
      [target.id],
      action.actionId === "unsnooze" ? null : Date.now() + (hours as number) * 3_600_000,
    );
    return { ok: true, status: "metadata_updated" };
  }
  if (action.actionId === "retry_recovery") {
    if (!readRecoveryQueue(environmentId).failures[target.id])
      return { ok: false, reason: "No active recovery episode." };
    manuallyRetryRecovery(environmentId, target.id);
    return { ok: true, status: "manual_recovery_requested" };
  }
  if (action.actionId === "complete") {
    try {
      const value = await runChatGPTSessionControl({
        environmentId,
        sessions,
        action: "complete",
        sessionId: target.id,
      });
      const receipt = value as {
        completion?: { declaredAt: string; observedTurns: number; observedUrl: string | null };
      };
      if (
        !receipt.completion ||
        !Number.isSafeInteger(receipt.completion.observedTurns) ||
        !receipt.completion.observedUrl
      ) {
        return { ok: false, reason: "Completion could not be verified." };
      }
      setSessionCompletion(target.id, receipt.completion);
      return { ok: true, status: "completion_recorded" };
    } catch (error) {
      return { ok: false, reason: errorText(error) };
    }
  }
  if (action.actionId === "reload") {
    try {
      await runChatGPTSessionControl({
        environmentId,
        sessions,
        action: "reload",
        sessionId: target.id,
        force: false,
      });
      return { ok: true, status: "guarded_reload_completed" };
    } catch (error) {
      return { ok: false, reason: errorText(error) };
    }
  }
  if (action.actionId === "read") {
    const { count, from, expectedConversationId } = action.args;
    if (
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 20 ||
      (from !== "start" && from !== "end") ||
      typeof expectedConversationId !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(expectedConversationId)
    ) {
      return {
        ok: false,
        reason: "Read requires an exact conversation UUID, range and count 1–20.",
      };
    }
    try {
      const receipt = (await runChatGPTSessionControl({
        environmentId,
        sessions,
        action: "read",
        sessionId: target.id,
        expectedConversationId,
        count,
        from,
        maxMessageChars: 2_000,
      })) as {
        verifiedConversationId?: string;
        selection?: { from: string; count: number };
        session?: {
          messages?: Array<{ role: string; text: string; turn: number; turnKey?: string }>;
          totalTurns?: number;
          status?: string;
          activity?: string;
          statusObservedAt?: string;
          lastRole?: string | null;
        };
      };
      const messages = Array.isArray(receipt.session?.messages)
        ? receipt.session.messages.slice(0, 20).map((message) => ({
            role: message.role === "user" ? "user" : "assistant",
            text: String(message.text ?? "").slice(0, 2_000),
            turn: Number.isSafeInteger(message.turn) ? message.turn : null,
            ...(typeof message.turnKey === "string"
              ? { turnKey: message.turnKey.slice(0, 128) }
              : {}),
          }))
        : [];
      return {
        ok: true,
        status: "guarded_read_completed",
        verifiedConversationId: receipt.verifiedConversationId,
        totalTurns: receipt.session?.totalTurns ?? null,
        pageStatus: receipt.session?.status ?? "unavailable",
        pageActivity: receipt.session?.activity ?? "unknown",
        pageLastRole: receipt.session?.lastRole ?? null,
        pageObservedAt: receipt.session?.statusObservedAt ?? null,
        messages,
      };
    } catch (error) {
      return { ok: false, reason: errorText(error) };
    }
  }
  if (action.actionId === "when_idle") {
    const message = action.args.message;
    const expectedConversationId = action.args.expectedConversationId;
    if (
      typeof message !== "string" ||
      !message.trim() ||
      message.length > 8_000 ||
      typeof expectedConversationId !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(expectedConversationId)
    )
      return {
        ok: false,
        reason: "when_idle requires a bounded message and exact conversation UUID.",
      };
    // A queue receipt confirms persistence, NOT that ChatGPT received a turn.
    // Never run the direct-send branch here: it could submit while a recipient
    // is actively generating. The existing per-session FIFO driver owns the
    // idle observation, draft protection, exact generation and retry rules.
    const registered =
      target.bootstrapIdentity?.state === "registered"
        ? target.bootstrapIdentity.conversationId
        : undefined;
    if (registered && registered !== expectedConversationId)
      return { ok: false, reason: "Bootstrap conversation changed; no message queued." };
    try {
      const messageId = queueChatGPTSessionMessage(
        environmentId,
        target.id,
        message,
        expectedConversationId,
        action.requestId,
        { condition: "when_idle" },
      );
      return {
        ok: true,
        status: "queued",
        messageSent: false,
        messageId,
        deliveryCondition: "recipient_idle",
      };
    } catch (error) {
      return { ok: false, reason: errorText(error) };
    }
  }
  if (action.actionId === "send" || action.actionId === "answer") {
    const message = action.args.message;
    const expectedConversationId = action.args.expectedConversationId;
    if (
      typeof message !== "string" ||
      !message.trim() ||
      message.length > 8_000 ||
      typeof expectedConversationId !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(expectedConversationId)
    ) {
      return {
        ok: false,
        reason: "Sending requires a bounded message and the exact ChatGPT conversation ID.",
      };
    }
    try {
      const result = await runChatGPTSessionControl({
        environmentId,
        sessions,
        action: "send",
        sessionId: target.id,
        message,
        expectedConversationId,
        neverWake: false,
      });
      // The guarded control path may RETURN normally for UNKNOWN delivery or
      // a proven pre-submit abort. The driver receipt must preserve that
      // distinction; a resolved RPC is not evidence of a sent user turn.
      const receipt = result as {
        delivery?: unknown;
        messageSent?: unknown;
        sendAttempted?: unknown;
        reason?: unknown;
      };
      if (receipt?.delivery === "user_turn_observed" && receipt.messageSent === true) {
        return { ok: true, status: "user_turn_observed", deliveryObserved: true };
      }
      if (receipt?.delivery === "pre_submit_aborted" && receipt.sendAttempted === false) {
        return {
          ok: false,
          status: "pre_submit_aborted",
          deliveryObserved: false,
          reason: "Composer submission was aborted before the send action.",
        };
      }
      return {
        ok: false,
        status: "unknown_delivery_no_retry",
        deliveryObserved: false,
        reason:
          typeof receipt?.reason === "string"
            ? receipt.reason.slice(0, 240)
            : "The user turn was not positively observed. No automatic resend is permitted.",
      };
    } catch (error) {
      // No automatic replay. An exception can follow a successful submit.
      return { ok: false, status: "unknown_delivery_no_retry", reason: errorText(error) };
    }
  }
  return { ok: false, reason: "This action is not supported by the desktop registry driver." };
}

/** Existing verified local close journal is the authority for removal.
 * Never infer deletion merely because a session disappeared from a partial
 * browser list (startup, profile corruption, or a concurrent renderer).
 */
function registryCloseReceipts(
  environmentId: EnvironmentId,
): readonly { sessionId: string; removedAt: string }[] {
  try {
    const json: unknown = JSON.parse(
      window.localStorage.getItem(chatGPTBrowserRemovalAuditKey(environmentId)) ?? "[]",
    );
    if (!Array.isArray(json)) return [];
    return json
      .flatMap((item: unknown) => {
        if (!item || typeof item !== "object") return [];
        const entry = item as Record<string, unknown>;
        if (
          entry.version !== 1 ||
          typeof entry.sessionId !== "string" ||
          !/^[a-f0-9-]{36}$/i.test(entry.sessionId) ||
          typeof entry.removedAt !== "string" ||
          !Number.isFinite(Date.parse(entry.removedAt))
        )
          return [];
        // Give human closes a bounded local undo window before finalizing server-side.
        if (
          (entry.source === "desktop-menu-action" || entry.source === "sidebar-user-action") &&
          Date.now() - Date.parse(entry.removedAt) < CHATGPT_CLOSE_UNDO_MS
        ) return [];
        return [{ sessionId: entry.sessionId, removedAt: entry.removedAt }];
      })
      .slice(-128);
  } catch {
    return [];
  }
}

const TICK_MS = 5_000;

export function ChatGPTSessionRegistryDriver() {
  const environmentId = usePrimaryEnvironmentId();
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const { setSessionSnooze, setSessionCompletion, renameSession, setSessionProject } =
    useChatGPTBrowserSessions(environmentId);
  const driverId = useRef(randomUUID()).current;
  const readRegistry = useAtomCommand(readChatGPTRegistry, { reportFailure: false });
  const register = useAtomCommand(registerChatGPTRegistryDriver, { reportFailure: false });
  const heartbeat = useAtomCommand(heartbeatChatGPTRegistryDriver, { reportFailure: false });
  const sync = useAtomCommand(syncChatGPTRegistry, { reportFailure: false });
  const closeRegistry = useAtomCommand(closeChatGPTRegistry, { reportFailure: false });
  const take = useAtomCommand(takeChatGPTRegistryActions, { reportFailure: false });
  const finish = useAtomCommand(finishChatGPTRegistryAction, { reportFailure: false });
  const disconnect = useAtomCommand(disconnectChatGPTRegistryDriver, { reportFailure: false });

  useEffect(() => {
    if (!isElectron || !environmentId || !canOperate) return;
    const targetEnvironment = environmentId;
    let disposed = false;
    let registered = false;
    let migrating = true;
    let running = false;
    let actionRunning = false;
    let next: ReturnType<typeof setTimeout> | undefined;
    let lastHashes = new Map<string, string>();
    const reportedRemovals = new Set<string>();
    // Guarded browser actions can take longer than the server's driver lease.
    // Keep the lease alive independently so a slow guest cannot make all local
    // sessions disappear from the external registry during that operation.
    let heartbeatPending = false;
    const keepLeaseAlive = setInterval(() => {
      if (disposed || !registered || heartbeatPending) return;
      heartbeatPending = true;
      void heartbeat({
        environmentId: targetEnvironment,
        input: { environmentId: targetEnvironment, driverId },
      })
        .then((response) => {
          if (!disposed && (response._tag !== "Success" || !response.value.ok)) registered = false;
        })
        .catch(() => {
          if (!disposed) registered = false;
        })
        .finally(() => {
          heartbeatPending = false;
        });
    }, 10_000);

    // Never let a large/failed registry snapshot or migration block external
    // when_idle wakes. Heartbeat already runs independently; action dispatch
    // must do the same. The server only hands out actions for registered rows,
    // and this worker retains the usual single-consumer FIFO semantics.
    const drainActions = async () => {
      if (disposed || !registered || actionRunning) return;
      actionRunning = true;
      try {
        const pending = await take({
          environmentId: targetEnvironment,
          input: { environmentId: targetEnvironment, driverId },
        });
        if (disposed || pending._tag !== "Success" || !pending.value.ok) return;
        for (const action of pending.value.actions) {
          if (disposed) return;
          const result = await executeRegistryDriverAction(
            targetEnvironment,
            action,
            setSessionSnooze,
            setSessionCompletion,
          );
          if (disposed) return;
          await finish({
            environmentId: targetEnvironment,
            input: { requestId: action.requestId, driverId, result },
          });
        }
      } catch (error) {
        console.warn("[ChatGPT registry] Action drain failed", error);
      } finally {
        actionRunning = false;
      }
    };
    const actionTimer = setInterval(() => void drainActions(), 5_000);

    const tick = async () => {
      if (disposed || running) return;
      running = true;
      try {
        if (!registered) {
          const response = await register({
            environmentId: targetEnvironment,
            input: { environmentId: targetEnvironment, driverId },
          });
          if (disposed || response._tag !== "Success" || !response.value.ok) return;
          registered = true;
          migrating = true;
          void drainActions();
        } else {
          const response = await heartbeat({
            environmentId: targetEnvironment,
            input: { environmentId: targetEnvironment, driverId },
          });
          if (disposed || response._tag !== "Success" || !response.value.ok) {
            registered = false;
            return;
          }
        }

        // Synchronize local sessions before handling potentially slow guest actions.
        // The action queue retains its one-use receipts; a stalled guest must not
        // prevent a newly created T3 session from becoming externally addressable.
        // The registry owns narrow remote metadata overlays. Pull BEFORE
        // uploading the local cache so stale desktop records cannot erase
        // offline snooze/rename/project edits on reconnect.
        const remote = await readRegistry({
          environmentId: targetEnvironment,
          input: { environmentId: targetEnvironment },
        });
        if (disposed || remote._tag !== "Success") return;
        const localStore = getChatGPTSessionPersistedStore(targetEnvironment);
        const audit = registryCloseReceipts(targetEnvironment);
        const removed = new Set(audit.map((item) => item.sessionId));
        const legacySessionsKey = chatGPTBrowserSessionsKey(targetEnvironment);
        // An empty new renderer profile may recover the original desktop catalog
        // from the server. Never resurrect sessions after an explicit local close:
        // a local empty list has a persisted legacy key and is authoritative.
        if (
          localStore.getState().sessions.length === 0 &&
          window.localStorage.getItem(legacySessionsKey) === null
        ) {
          const restored = remote.value.sessions.flatMap((row) => {
            if (row.closedAt !== null || removed.has(row.sessionId)) return [];
            const session = registryBrowserSession(row);
            return session ? [session] : [];
          });
          if (restored.length) {
            setLocalStorageItem(legacySessionsKey, restored, BrowserSessions);
            localStore.setState({ sessions: restored });
          }
        }
        // The existing sidebar and session view consume the local cache. Make
        // server-observed history visible there without navigating a guest.
        hydrateRegistryEvidence(targetEnvironment, remote.value.sessions);
        const revisionKey = `t3code:chatgpt-registry:applied-revisions:${targetEnvironment}`;
        let applied: Record<string, number> = {};
        try {
          const saved: unknown = JSON.parse(window.localStorage.getItem(revisionKey) ?? "{}");
          if (saved && typeof saved === "object" && !Array.isArray(saved))
            applied = saved as Record<string, number>;
        } catch {
          /* Never lose local work because a revision-cache key is malformed. */
        }
        const locals = new Set(
          readChatGPTBrowserSessions(targetEnvironment).map((entry) => entry.id),
        );
        let appliedAny = false;
        for (const row of remote.value.sessions) {
          const revision = row.metadataRevision ?? 0;
          if (!revision || revision <= (applied[row.sessionId] ?? 0) || !locals.has(row.sessionId))
            continue;
          const patch = row.metadataPatch;
          if (!patch) continue;
          if (patch.title !== undefined) renameSession(row.sessionId, patch.title);
          if (patch.project !== undefined) setSessionProject(row.sessionId, patch.project);
          if (patch.snoozedUntil !== undefined)
            setSessionSnooze([row.sessionId], patch.snoozedUntil);
          applied[row.sessionId] = revision;
          lastHashes.delete(row.sessionId);
          appliedAny = true;
        }
        if (appliedAny) {
          try {
            window.localStorage.setItem(revisionKey, JSON.stringify(applied));
          } catch {
            /* A duplicate metadata merge is safer than dropping the edit. */
          }
        }

        // The mobile AI screen receives a bounded, read-only Caffy projection.
        // Do not serialize prompts or pending message bodies into the registry.
        const caffyState: unknown = await window.desktopBridge?.caffyControl?.({ action: "list" })
          .catch(() => null);
        const monitorsById = new Map<string, CaffyReadout>();
        const agentStopsById = new Map<string, number>();
        if (caffyState && typeof caffyState === "object") {
          const state = caffyState as {
            entries?: readonly Record<string, unknown>[];
            agentStops?: readonly Record<string, unknown>[];
          };
          for (const value of state.entries ?? []) {
            const monitor = readCaffyRecord(value);
            if (!monitor) continue;
            const safe: CaffyReadout = {
              mode: monitor.mode, paused: monitor.paused, onceOnly: monitor.onceOnly,
              intervalMinutes: monitor.intervalMinutes, respectSlots: monitor.respectSlots,
              startup: monitor.startup, beginAt: monitor.beginAt, expiresAt: monitor.expiresAt,
              createdAt: monitor.createdAt, nextDueAt: monitor.nextDueAt,
              lastWakeAt: monitor.lastWakeAt, lastCheckedAt: monitor.lastCheckedAt,
              nextCheckAt: monitor.nextCheckAt, pendingWake: monitor.pendingWake,
              lastCheckResult: monitor.lastCheckResult?.slice(0, 120),
              lastDeliveryResult: monitor.lastDeliveryResult?.slice(0, 120),
              lastError: monitor.lastError?.slice(0, 160),
              deliveryStatus: monitor.deliveryStatus?.slice(0, 60),
              autoRebootMinutes: monitor.autoRebootMinutes,
              autoRebootEveryRuns: monitor.autoRebootEveryRuns,
              rebootOperationId: monitor.rebootOperationId,
              wakePhase: monitor.wakePhase,
              admissionReason: monitor.admissionReason?.slice(0, 120),
            };
            for (const id of [value.sessionId, value.browserSessionId, value.publicSessionId]) {
              if (typeof id === "string" && id) monitorsById.set(id, safe);
            }
          }
          for (const value of state.agentStops ?? []) {
            if (typeof value.stoppedAt !== "number" || !Number.isFinite(value.stoppedAt)) continue;
            for (const id of [value.sessionId, value.browserSessionId, value.publicSessionId]) {
              if (typeof id === "string" && id) agentStopsById.set(id, value.stoppedAt);
            }
          }
        }
        const current = registryChangesFromStore(targetEnvironment, applied).map((entry) => {
          const monitor = monitorsById.get(entry.sessionId);
          const stoppedAt = monitor ? undefined : agentStopsById.get(entry.sessionId);
          return {
            ...entry,
            record: {
              ...entry.record,
              ...(monitor ? { caffyStatus: monitor } : {}),
              ...(stoppedAt !== undefined ? { caffyStoppedAt: stoppedAt } : {}),
            },
          };
        });
        const revisionHash = (entry: SyncRecord) =>
          JSON.stringify([
            entry.record,
            entry.snapshot,
            entry.timeline,
            entry.appliedMetadataRevision,
          ]);
        // New task workers must become addressable before a large migration of
        // idle historical sessions. Otherwise a failed first prompt can leave
        // a TaskBoard-claimed guest absent from the recovery registry.
        const changed = current.filter(
          (entry) => lastHashes.get(entry.sessionId) !== revisionHash(entry),
        ).sort((a, b) => {
          const urgent = (entry: SyncRecord) => entry.record.spawnRequestId ? 1 : 0;
          const created = (entry: SyncRecord) =>
            typeof entry.record.createdAt === "number" ? entry.record.createdAt : 0;
          return urgent(b) - urgent(a) || created(b) - created(a);
        });
        if (changed.length) {
          const known = new Set(remote.value.sessions.map((row) => row.sessionId));
          // Existing rows MUST receive the desktop's latest snapshot on
          // reconnect. The one-time INSERT OR IGNORE migration is for unknown
          // identities only; otherwise it silently loses all subsequent edits.
          const groups = migrating
            ? [
                { initial: true, entries: changed.filter((entry) => !known.has(entry.sessionId)) },
                { initial: false, entries: changed.filter((entry) => known.has(entry.sessionId)) },
              ]
            : [{ initial: false, entries: changed }];
          for (const group of groups) {
            for (let i = 0; i < group.entries.length; i += 30) {
              if (disposed) return;
              const batch = group.entries.slice(i, i + 30);
              const publish = async (entries: SyncRecord[]): Promise<boolean> => {
                const response = await sync({
                  environmentId: targetEnvironment,
                  input: { driverId, initial: group.initial, changes: entries },
                });
                if (response._tag !== "Success") return false;
                if (response.value.ok) {
                  entries.forEach((entry) => lastHashes.set(entry.sessionId, revisionHash(entry)));
                  return true;
                }
                // One invalid legacy entry must not prevent every other session
                // from being registered. Server writes are idempotent per ID.
                if (entries.length === 1) {
                  console.warn("[ChatGPT registry] Rejected session sync", entries[0]?.sessionId);
                  return true;
                }
                const mid = Math.floor(entries.length / 2);
                return (
                  (await publish(entries.slice(0, mid))) && (await publish(entries.slice(mid)))
                );
              };
              if (!(await publish(batch))) return;
            }
          }
        }
        migrating = false;
        // Publish only explicit local removal receipts. Keep closed history
        // server-side but refuse any later send/reload for those T3 IDs.
        const toClose = audit.filter(
          (item) => !reportedRemovals.has(`${item.sessionId}:${item.removedAt}`),
        );
        if (toClose.length) {
          const response = await closeRegistry({
            environmentId: targetEnvironment,
            input: { environmentId: targetEnvironment, driverId, receipts: toClose },
          });
          if (response._tag !== "Success" || !response.value.ok) return;
          for (const receipt of toClose)
            reportedRemovals.add(`${receipt.sessionId}:${receipt.removedAt}`);
        }
        // Action draining has its own interval: neither this migration nor a
        // slow registry read can hold external notifications hostage.
      } catch {
        // Loss of connection never authorizes resubmission of a taken action.
        registered = false;
      } finally {
        running = false;
        if (!disposed) next = setTimeout(() => void tick(), TICK_MS);
      }
    };
    void tick();
    return () => {
      disposed = true;
      clearInterval(keepLeaseAlive);
      clearInterval(actionTimer);
      if (next) clearTimeout(next);
      if (registered)
        void disconnect({
          environmentId: targetEnvironment,
          input: { environmentId: targetEnvironment, driverId },
        });
    };
  }, [
    canOperate,
    closeRegistry,
    disconnect,
    driverId,
    environmentId,
    finish,
    heartbeat,
    readRegistry,
    register,
    renameSession,
    setSessionCompletion,
    setSessionProject,
    setSessionSnooze,
    sync,
    take,
  ]);

  return null;
}
