import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  hasHostedBrowserGuestTab,
  subscribeHostedBrowserGuestPresence,
} from "./browser/hostedBrowserGuestPresence";
import { chatGPTBrowserThreadRef } from "./chatGPTBrowserSessions";
import type { EnvironmentId } from "@t3tools/contracts";
import type { BrowserSession } from "./chatGPTBrowserSessions";
import { useChatGPTBrowserSessions } from "./chatGPTBrowserSessions";
import {
  readChatGPTRecoveryEvents,
  readChatGPTRecoveryState,
  type ChatGPTRecoveryEvent,
} from "./chatGPTRecoveryDiagnostics";
import { readChatGPTSessionTimeline } from "./chatGPTSessionTimestamps";
import { useThreadPreviewState } from "./previewStateStore";
import { previewRuntimeTabId } from "./browser/previewRuntimeTabId";
import type { ChatGPTActivityAge } from "./components/sidebar/chatGPTActivity";

export type ChatGPTSessionActivity = "working" | "idle" | "interrupted" | "failed" | "unknown";
export type ChatGPTSessionAttention =
  | "none"
  | "question"
  | "error"
  | "recovery_stopped"
  | "unconfirmed_send"
  | "conversation_full"
  | "needs_browser";
export type ChatGPTSessionResidency =
  | "loaded"
  | "warm"
  | "loading"
  | "hibernated"
  | "unloaded"
  | "snoozed"
  | "hidden";
export type ChatGPTSessionBucket =
  | "needs_you"
  | "working"
  | "recently_stopped"
  | "idle"
  | "snoozed"
  | "completed";

export interface ChatGPTSessionRecovery {
  phase: "checking" | "refreshing" | "queued" | null;
  attempts: number;
  nextAttemptAt: number | null;
  lastAttemptAt: number | null;
  lastOutcome: string | null;
  orangeStage: string | null;
  stoppedReason: string | null;
}
export interface ChatGPTSessionTimeline {
  createdAt: number | null;
  lastActiveAt: number | null;
  lastRefreshAt: number | null;
  lastRebootAt: number | null;
}

/** Raw observations stay independent: a failed page can also have an unconfirmed send. */
export interface RawChatGPTSessionSignals {
  age?: ChatGPTActivityAge | undefined;
  attached?: boolean | undefined;
  status?: string | null | undefined;
  label?: string | undefined;
  lastWorkingAt?: number | undefined;
  hidden?: boolean | undefined;
  snoozedUntil?: number | null | undefined;
  hibernated?: boolean | undefined;
  warm?: boolean | undefined;
  loading?: boolean | undefined;
  unloaded?: boolean | undefined;
  browserUnavailable?: boolean | undefined;
  uncertainSend?: boolean | undefined;
  completionValid?: boolean | undefined;
  recovery?: Partial<ChatGPTSessionRecovery> | undefined;
  timeline?: ChatGPTSessionTimeline | null | undefined;
  events?: readonly ChatGPTRecoveryEvent[] | undefined;
}

export interface ChatGPTSessionModel {
  activity: ChatGPTSessionActivity;
  attention: ChatGPTSessionAttention;
  residency: ChatGPTSessionResidency;
  bucket: ChatGPTSessionBucket | null;
  statusLine: string;
  primaryAction:
    | "open"
    | "answer"
    | "retry_recovery"
    | "check_delivery"
    | "open_browser"
    | "unsnooze"
    | "archive"
    | null;
  lastWorkingAt: number;
  recovery: ChatGPTSessionRecovery;
  timeline: ChatGPTSessionTimeline | null;
  recoveryEvents: readonly ChatGPTRecoveryEvent[];
  /** Original sidebar/MCP age, retained for status-colour and which-filter compatibility. */
  compatibilityAge: ChatGPTActivityAge;
}

const EMPTY_RECOVERY: ChatGPTSessionRecovery = {
  phase: null,
  attempts: 0,
  nextAttemptAt: null,
  lastAttemptAt: null,
  lastOutcome: null,
  orangeStage: null,
  stoppedReason: null,
};

/** One authoritative, side-effect-free mapping. Never validates a completion marker itself. */
export function deriveChatGPTSession(
  raw: RawChatGPTSessionSignals,
  now: number,
): ChatGPTSessionModel {
  const originalAge = raw.age ?? "unknown";
  const loading = raw.loading || raw.status === "loading";
  const absent =
    raw.attached === false &&
    ["recent", "inactive", "unknown"].includes(originalAge) &&
    !["working", "stuck", "unavailable", "stuck_connecting"].includes(raw.status ?? "");
  // Only actual guest attachment can invalidate an unloaded observation.
  // A cached Loading overlay can outlive the browser tab it belonged to.
  const staleUnloaded =
    raw.attached === true &&
    ["unloaded", "unloaded-recent", "unloaded-working"].includes(originalAge);
  const status = raw.status;
  const age =
    status === "settings"
      ? "unknown"
      : absent
        ? "unloaded"
        : staleUnloaded
          ? "unknown"
          : originalAge;
  let activity: ChatGPTSessionActivity =
    status === "settings"
      ? "unknown"
      : age === "working" || status === "working"
        ? "working"
        : age === "interrupted" || status === "stuck_connecting"
          ? "interrupted"
          : age === "invalid" || status === "stuck" || status === "unavailable"
            ? "failed"
            : age === "recent" ||
                age === "unloaded-recent" ||
                age === "unloaded-working" ||
                age === "inactive" ||
                status === "done_or_idle" ||
                status === "waiting_for_input" ||
                status === "conversation_full"
              ? "idle"
              : "unknown";

  const recovery = { ...EMPTY_RECOVERY, ...raw.recovery };
  let attention: ChatGPTSessionAttention =
    raw.uncertainSend || age === "delivery-timeout"
      ? "unconfirmed_send"
      : recovery.stoppedReason
        ? "recovery_stopped"
        : status === "conversation_full"
          ? "conversation_full"
          : raw.browserUnavailable
            ? "needs_browser"
            : status === "waiting_for_input"
              ? "question"
              : activity === "failed"
                ? "error"
                : "none";

  // The browser can have a recoverable transport error and a simultaneous
  // uncertain send. Never let a lower-priority DOM observation hide the send.
  if (raw.uncertainSend) attention = "unconfirmed_send";
  if (status === "conversation_full" && activity !== "working") activity = "idle";

  const residency: ChatGPTSessionResidency = raw.hidden
    ? "hidden"
    : (raw.snoozedUntil ?? 0) > now || age === "snoozed"
      ? "snoozed"
      : raw.attached === true
        ? "loaded"
        : raw.hibernated || status === "hibernated"
          ? "hibernated"
          : raw.unloaded ||
              ["unloaded", "unloaded-recent", "unloaded-working"].includes(age) ||
              status === "unloaded"
            ? "unloaded"
            : loading
              ? "loading"
              : raw.warm
                ? "warm"
                : "loaded";

  const lastWorkingAt =
    Number.isFinite(raw.lastWorkingAt) && (raw.lastWorkingAt ?? 0) > 0 ? raw.lastWorkingAt! : 0;
  const bucket: ChatGPTSessionBucket | null =
    residency === "hidden"
      ? null
      : raw.completionValid
        ? "completed"
        : attention !== "none" || activity === "interrupted" || activity === "failed"
          ? "needs_you"
          : residency === "snoozed"
            ? "snoozed"
            : activity === "working"
              ? "working"
              : activity === "idle" && lastWorkingAt <= now && now - lastWorkingAt < 15 * 60_000
                ? "recently_stopped"
                : "idle";
  const primaryAction: ChatGPTSessionModel["primaryAction"] =
    bucket === null
      ? null
      : bucket === "completed"
        ? "archive"
        : attention === "unconfirmed_send"
          ? "check_delivery"
          : attention === "question"
            ? "answer"
            : attention === "needs_browser"
              ? "open_browser"
              : attention === "error" ||
                  attention === "recovery_stopped" ||
                  activity === "interrupted"
                ? "retry_recovery"
                : bucket === "snoozed"
                  ? "unsnooze"
                  : "open";
  const statusLine =
    (status === "settings"
      ? "ChatGPT settings open"
      : absent
        ? "ChatGPT browser unloaded"
        : residency === "loading" && activity === "unknown"
          ? "ChatGPT is loading"
          : staleUnloaded
            ? undefined
            : raw.label) ||
    (attention === "unconfirmed_send"
      ? "Delivery needs confirmation"
      : attention === "question"
        ? "Waiting for your answer"
        : attention === "conversation_full"
          ? "Conversation full"
          : attention === "needs_browser"
            ? "ChatGPT browser needs attention"
            : residency === "loading"
              ? "ChatGPT is loading"
              : activity === "working"
                ? "ChatGPT is working"
                : activity === "interrupted"
                  ? "ChatGPT connection interrupted"
                  : activity === "failed"
                    ? "ChatGPT is unavailable"
                    : residency === "snoozed"
                      ? "Snoozed"
                      : activity === "idle"
                        ? "ChatGPT is idle"
                        : "ChatGPT status unknown");
  return {
    activity,
    attention,
    residency,
    bucket,
    statusLine,
    primaryAction,
    lastWorkingAt,
    recovery,
    timeline: raw.timeline ?? null,
    recoveryEvents: raw.events ?? [],
    compatibilityAge: age,
  };
}

/** Legacy MCP which values remain exact views of the common model. */
export function matchesChatGPTSessionWhich(
  which: "visible" | "recent" | "working" | "blocked" | "all",
  model: ChatGPTSessionModel,
): boolean {
  if (model.residency === "hidden") return false;
  switch (which) {
    case "visible":
    case "all":
      return true;
    case "recent":
      return ["recent", "unloaded-recent", "unloaded-working"].includes(model.compatibilityAge);
    case "working":
      return model.compatibilityAge === "working";
    case "blocked":
      return model.compatibilityAge === "invalid" || model.compatibilityAge === "interrupted";
  }
}

type ActivityObservation = {
  age: ChatGPTActivityAge;
  label: string;
  lastWorkingAt: number;
  /** Independent Chromium host presence; null means checking. */
  resident?: boolean | null;
};
type SessionOptions = {
  now?: number;
  phase?: ChatGPTSessionRecovery["phase"];
  verifiedSpawnCreatedAt?: number;
  status?: string;
  hibernated?: boolean;
  loading?: boolean;
  warm?: boolean;
  uncertainSend?: boolean;
  completionValid?: boolean;
};

function readSavedSignals(
  environmentId: EnvironmentId,
  session: BrowserSession,
  lastWorkingAt: number,
  createdAt?: number,
) {
  const state = readChatGPTRecoveryState(environmentId, session.id);
  const events = readChatGPTRecoveryEvents(environmentId, session.id, 25);
  return {
    recovery: {
      attempts: state.retryCount,
      nextAttemptAt: state.nextRetryAt,
      lastAttemptAt: state.lastAttemptAt,
      lastOutcome: events.at(-1)?.event ?? null,
      orangeStage: state.orangeStage,
      stoppedReason: state.escalationReason,
    },
    timeline: readChatGPTSessionTimeline(environmentId, session, lastWorkingAt, createdAt),
    events,
  };
}

/** Persisted snapshots are read in effects, never during a sidebar row render. */
export function useChatGPTSession(
  environmentId: EnvironmentId,
  session: BrowserSession,
  observation: ActivityObservation,
  options: SessionOptions = {},
): ChatGPTSessionModel {
  const [saved, setSaved] = useState<ReturnType<typeof readSavedSignals> | null>(null);
  const createdAt = options.verifiedSpawnCreatedAt;
  const threadRef = useMemo(
    () => chatGPTBrowserThreadRef(environmentId, session.id),
    [environmentId, session.id],
  );
  const preview = useThreadPreviewState(threadRef);
  const runtimeTabId = preview.activeTabId
    ? previewRuntimeTabId(threadRef, preview.serverEpoch, preview.activeTabId)
    : null;
  const attached = useSyncExternalStore(
    subscribeHostedBrowserGuestPresence,
    () => runtimeTabId !== null && hasHostedBrowserGuestTab(threadRef, runtimeTabId),
    () => false,
  );
  // A persistent Chromium page can remain loaded without any T3 webview.
  // Tri-state null must remain unknown, not turn into a false unloaded claim.
  const actualResidency = observation.resident === undefined ? attached : observation.resident;
  const loading =
    options.loading ??
    (preview.snapshot?.navStatus._tag === "Loading" || preview.desktopOverlay?.loading === true);
  useEffect(() => {
    const refresh = () =>
      setSaved(readSavedSignals(environmentId, session, observation.lastWorkingAt, createdAt));
    refresh();
    window.addEventListener("chatgpt-recovery-queue-updated", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("chatgpt-recovery-queue-updated", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [environmentId, session, observation.lastWorkingAt, createdAt, options.phase]);
  return useMemo(
    () =>
      deriveChatGPTSession(
        {
          age: observation.age,
          ...(actualResidency !== null ? { attached: actualResidency } : {}),
          label: observation.label,
          lastWorkingAt: observation.lastWorkingAt,
          hidden: session.hidden,
          snoozedUntil: session.snoozedUntil,
          status: options.status,
          hibernated: options.hibernated,
          loading,
          warm: options.warm,
          uncertainSend: options.uncertainSend,
          completionValid: options.completionValid,
          recovery: { ...saved?.recovery, phase: options.phase ?? null },
          timeline: saved?.timeline,
          events: saved?.events,
        },
        options.now ?? Date.now(),
      ),
    [
      observation.age,
      observation.label,
      observation.lastWorkingAt,
      actualResidency,
      session.hidden,
      session.snoozedUntil,
      options.status,
      options.hibernated,
      loading,
      options.warm,
      options.uncertainSend,
      options.completionValid,
      options.phase,
      options.now,
      saved,
    ],
  );
}

const EMPTY_OBSERVATIONS: Readonly<Record<string, ActivityObservation>> = {};

/** List view shares the pure derivation, without one recovery poll per hidden row. */
export function useChatGPTSessions(
  environmentId: EnvironmentId | null,
  observations: Readonly<Record<string, ActivityObservation>> = EMPTY_OBSERVATIONS,
  now = Date.now(),
): readonly (ChatGPTSessionModel & { session: BrowserSession })[] {
  const { sessions } = useChatGPTBrowserSessions(environmentId);
  return useMemo(
    () =>
      sessions.map((session) => ({
        session,
        ...deriveChatGPTSession(
          {
            age: observations[session.id]?.age,
            label: observations[session.id]?.label,
            lastWorkingAt: observations[session.id]?.lastWorkingAt,
            hidden: session.hidden,
            snoozedUntil: session.snoozedUntil,
          },
          now,
        ),
      })),
    [sessions, observations, now],
  );
}
