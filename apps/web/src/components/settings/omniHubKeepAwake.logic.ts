/**
 * View model for OmniHub temporary Keep Awake monitors.
 *
 * These are OmniHub keep-awake wakes for agent sessions, not T3 scheduled
 * tasks. The page reads snapshots and can request the two real scheduler
 * controls (wake in one minute, cancel) by exact monitor ID through trusted
 * desktop main. It never sees scheduler control tokens.
 *
 * The types below are a structural mirror of `DesktopOmniHubKeepAwakeReadResult`
 * in `packages/contracts` (desktop IPC `readOmniHubKeepAwakeMonitors`). The
 * desktop result is consumed as-is; keep these in lockstep with that schema
 * rather than normalizing in the reader.
 */

export type OmniHubKeepAwakeMonitorStatus =
  | "active"
  | "attempting"
  | "retrying"
  | "final_pending"
  | "final_retrying"
  | "needs_attention"
  | "completed"
  | "cancelled"
  | "history"
  | "unknown";

export interface OmniHubKeepAwakeTarget {
  readonly id: string;
  readonly kind: "t3/chatgpt_browser" | "t3/native_thread" | "unknown";
  /** Projected title; equals `id` when T3 has no verified title for the session. */
  readonly title: string;
  /** Only a previously observed, verified T3 URL; never guessed. */
  readonly url: string | null;
  readonly visibility: "visible" | "hidden" | "missing" | "unchecked";
}

export interface OmniHubKeepAwakeMonitor {
  readonly source: "omnihub-temporary-keep-awake";
  readonly id: string;
  readonly mandateId: string;
  readonly target: OmniHubKeepAwakeTarget;
  readonly status: OmniHubKeepAwakeMonitorStatus;
  readonly activeOrPending: boolean;
  readonly finalWakePending: boolean;
  readonly oneShot: boolean;
  readonly intervalMinutes: number | null;
  readonly createdAtMs: number | null;
  readonly endAtMs: number | null;
  readonly nextAttemptAtMs: number | null;
  readonly lastSchedulerTickAtMs: number | null;
  readonly lastWakeUserTurnAtMs: number | null;
  readonly lastAssistantAckAtMs: number | null;
  readonly finalDeliveredAtMs: number | null;
  readonly wakeAttempts: number;
  readonly lastDelivery: string | null;
  readonly lastOutcome: string | null;
  readonly explanation: string;
}

export type OmniHubKeepAwakeReadResult =
  | {
      readonly source: "omnihub-temporary-keep-awake";
      readonly availability: "ok";
      readonly observedAtMs: number;
      readonly monitors: ReadonlyArray<OmniHubKeepAwakeMonitor>;
    }
  | {
      readonly source: "omnihub-temporary-keep-awake";
      readonly availability: "unavailable";
      readonly observedAtMs: number;
      readonly monitors: readonly [];
      readonly error: string;
    };

/**
 * Async source of snapshots. Resolves `null` when this client has no desktop
 * keep-awake bridge (web, mobile, older desktop builds), which the page shows
 * as unavailable rather than as an empty list.
 */
export type OmniHubKeepAwakeReader = () => Promise<OmniHubKeepAwakeReadResult | null>;

/**
 * Splits monitors by the projection's own `activeOrPending` flag, so nothing is
 * filed as done unless OmniHub said so. Order is preserved: the projection
 * already sorts pending/final wakes first.
 */
export function groupKeepAwakeMonitors(monitors: ReadonlyArray<OmniHubKeepAwakeMonitor>) {
  const active: OmniHubKeepAwakeMonitor[] = [];
  const history: OmniHubKeepAwakeMonitor[] = [];
  for (const monitor of monitors) (monitor.activeOrPending ? active : history).push(monitor);
  return { active, history };
}

/** A final wake that is still pending after the requested end time. */
export function isFinalWakeOverdue(monitor: OmniHubKeepAwakeMonitor, nowMs: number): boolean {
  return (
    monitor.activeOrPending &&
    (monitor.finalWakePending ||
      monitor.status === "final_pending" ||
      monitor.status === "final_retrying") &&
    monitor.endAtMs !== null &&
    monitor.endAtMs <= nowMs
  );
}

export type KeepAwakeTone = "success" | "warning" | "error" | "info" | "outline";

export function keepAwakeStatusPresentation(
  monitor: OmniHubKeepAwakeMonitor,
  nowMs: number,
): { label: string; tone: KeepAwakeTone } {
  const overdue = isFinalWakeOverdue(monitor, nowMs);
  switch (monitor.status) {
    case "active":
      return { label: "Active", tone: "success" };
    case "attempting":
      return { label: "Sending wake", tone: "info" };
    case "retrying":
      return { label: "Retrying", tone: "warning" };
    case "final_pending":
      return overdue
        ? { label: "Final wake overdue", tone: "error" }
        : { label: "Final wake pending", tone: "warning" };
    case "final_retrying":
      return overdue
        ? { label: "Final wake overdue · retrying", tone: "error" }
        : { label: "Final wake retrying", tone: "warning" };
    case "needs_attention":
      return { label: "Needs attention", tone: "error" };
    case "completed":
      return { label: "Completed", tone: "outline" };
    case "cancelled":
      return { label: "Cancelled", tone: "outline" };
    case "history":
      return { label: "Ended", tone: "outline" };
    default:
      // Unknown never reads as done; history placement still follows activeOrPending.
      return { label: "Unverified state", tone: "warning" };
  }
}

const ISSUE_STATUSES: ReadonlySet<OmniHubKeepAwakeMonitorStatus> = new Set([
  "retrying",
  "final_retrying",
  "needs_attention",
  "unknown",
]);
const ISSUE_TEXT = /not_ready|retry|unknown|unsafe|unavailable|error|mismatch|blocked|fail|transport|attention|indeterminate/i;

/**
 * True when the monitor's explanation describes something the user should
 * notice: a failed/blocked delivery, a missing/hidden target, an indeterminate
 * or unknown state, or an overdue final wake.
 */
export function keepAwakeHasIssue(monitor: OmniHubKeepAwakeMonitor, nowMs: number): boolean {
  return (
    ISSUE_STATUSES.has(monitor.status) ||
    monitor.target.visibility === "missing" ||
    monitor.target.visibility === "hidden" ||
    isFinalWakeOverdue(monitor, nowMs) ||
    ISSUE_TEXT.test(monitor.lastOutcome ?? "") ||
    ISSUE_TEXT.test(monitor.lastDelivery ?? "")
  );
}

/** `user_turn_observed` -> `User turn observed`. Raw value stays available as a tooltip. */
export function formatKeepAwakeRawValue(value: string): string {
  const spaced = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : value;
}

/** `90` -> `1h 30m`; `20` -> `20m`; null/invalid -> `Not set`. */
export function formatKeepAwakeInterval(intervalMinutes: number | null): string {
  if (intervalMinutes === null || !Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    return "Not set";
  }
  const total = Math.round(intervalMinutes);
  if (total < 1) return "<1m";
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : ""].filter(Boolean).join(" ");
}

export type KeepAwakeControlAction = "wake_in_one_minute" | "cancel";

/** Mirror of `DesktopOmniHubKeepAwakeControlReceipt` in `packages/contracts`. */
export interface OmniHubKeepAwakeControlReceipt {
  readonly ok: boolean;
  readonly monitorId: string;
  readonly action: KeepAwakeControlAction;
  readonly clientRequestId: string;
  readonly code: "applied" | "unavailable" | "denied" | "conflict" | "unknown";
  readonly detail: string;
  readonly state?: string | undefined;
  readonly nextDueMs?: number | undefined;
  readonly sendMayAlreadyBeInFlight?: boolean | undefined;
}

/** Exact-monitor control. Resolves `null` when the desktop control bridge is missing. */
export type OmniHubKeepAwakeController = (query: {
  monitorId: string;
  action: KeepAwakeControlAction;
  clientRequestId: string;
  confirmedTargetId?: string | undefined;
}) => Promise<OmniHubKeepAwakeControlReceipt | null>;

/** Why mutating controls are disabled for this monitor; `null` when they may be offered. */
export function keepAwakeControlBlockedReason(monitor: OmniHubKeepAwakeMonitor): string | null {
  if (!monitor.activeOrPending) return "This keep-awake has already ended.";
  if (monitor.status === "unknown") return "Monitor state is unverified. Refresh first.";
  return null;
}

const ACTION_LABEL: Record<KeepAwakeControlAction, string> = {
  wake_in_one_minute: "Wake sooner",
  cancel: "Cancel",
};

/**
 * One visible receipt line per invocation. Only an ok `applied` reads as
 * success; `unknown` is never auto-retried and asks the user to verify.
 */
export function describeKeepAwakeControlOutcome(
  action: KeepAwakeControlAction,
  outcome:
    | { kind: "receipt"; receipt: OmniHubKeepAwakeControlReceipt | null }
    | { kind: "error"; message: string },
): { tone: "success" | "warning" | "error"; message: string } {
  const label = ACTION_LABEL[action];
  if (outcome.kind === "error") {
    return {
      tone: "warning",
      message: `${label}: outcome unknown (${outcome.message}). Not retried; check the refreshed state.`,
    };
  }
  const receipt = outcome.receipt;
  if (!receipt) {
    return { tone: "error", message: `${label}: keep-awake controls are unavailable here.` };
  }
  const detail = receipt.detail ? ` ${receipt.detail}` : "";
  const inFlight = receipt.sendMayAlreadyBeInFlight
    ? " A wake may already be in flight; it was not stopped."
    : "";
  switch (receipt.code) {
    case "applied":
      return receipt.ok
        ? { tone: "success", message: `${label}: applied.${detail}${inFlight}` }
        : {
            tone: "warning",
            message: `${label}: not confirmed.${detail} Check the refreshed state.${inFlight}`,
          };
    case "unknown":
      return {
        tone: "warning",
        message: `${label}: outcome unknown.${detail} Not retried; check the refreshed state.${inFlight}`,
      };
    case "denied":
    case "conflict":
    case "unavailable":
      return { tone: "error", message: `${label}: ${receipt.code}.${detail}${inFlight}` };
  }
}
