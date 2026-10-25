import type { ChatGPTRecoveryEvent } from "../../chatGPTRecoveryDiagnostics";
import type { ChatGPTRecoveryPhase } from "./ChatGPTBrowserRecoveryCoordinator";
import type { ChatGPTActivityAge } from "./chatGPTActivity";

interface HoverRecoveryState {
  readonly lastAttemptAt: number | null;
  readonly retryCount: number;
  readonly nextRetryAt: number | null;
  readonly orangeStage: string | null;
}

interface RecoveryHoverInput {
  readonly age: ChatGPTActivityAge;
  readonly label: string;
  readonly phase: ChatGPTRecoveryPhase | null;
  readonly state: HoverRecoveryState;
  readonly events: readonly ChatGPTRecoveryEvent[];
  readonly now: number;
}

const recentWindowMs = 2 * 60 * 60_000;
const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// Only describe known diagnostic event codes. Never surface raw event detail,
// which can contain browser errors or incidental page text.
function safeEventDescription(event: ChatGPTRecoveryEvent): string | null {
  switch (event.event) {
    case "refresh-finished":
      return "Refresh finished (result not yet verified)";
    case "refresh-timeout":
      return "Refresh timed out";
    case "refresh-failed":
      return "Refresh failed";
    case "browser-reset-requested":
      return "Browser reset requested";
    case "browser-reset-attached":
      return "Browser reset attached";
    case "browser-reset-unconfirmed":
      return "Browser reset not confirmed";
    case "retry-scheduled":
      return "Recovery retry recorded";
    case "healthy":
      return "Healthy page observed";
    case "blocked":
      switch (event.detail) {
        case "preview-not-ready":
          return "Waiting for preview";
        case "guest-not-attached":
          return "Browser guest not attached";
        case "guest-hibernated":
          return "Browser guest unloaded";
        case "probe-unverifiable":
          return "Page check inconclusive";
        default:
          return null;
      }
    default:
      return null;
  }
}

/** Hover text is a snapshot: live phase is distinct from saved recovery history. */
export function chatGPTRecoveryHoverDetails(input: RecoveryHoverInput): string[] | null {
  const { age, label, phase, state, events, now } = input;
  if (age !== "invalid" && age !== "interrupted" && age !== "delivery-timeout") return null;
  const lines = [
    `Observed: ${label}`,
    `Current phase: ${
      phase === "refreshing"
        ? "Refreshing"
        : phase === "checking"
          ? "Verifying the error"
          : phase === "queued"
            ? "Queued for automatic checks"
            : "No active recovery step reported"
    }`,
  ];

  if (age === "invalid") {
    if (state.lastAttemptAt !== null && state.lastAttemptAt > 0 && state.lastAttemptAt <= now) {
      lines.push(`Last recorded recovery action: ${time(state.lastAttemptAt)}`);
    }
    if (
      state.nextRetryAt !== null &&
      state.nextRetryAt > now &&
      state.lastAttemptAt !== null &&
      state.lastAttemptAt > 0 &&
      state.lastAttemptAt <= now &&
      now - state.lastAttemptAt < recentWindowMs
    ) {
      lines.push(
        `Saved retry cooldown until ${time(state.nextRetryAt)} (if the same error persists; queue and safety checks may delay)`,
      );
    } else {
      lines.push("Next: pending page verification and recovery queue; no fixed attempt time");
    }
    if (state.retryCount > 0) lines.push(`Recorded load-error retries: ${state.retryCount}`);
  } else {
    const stageLabels: Record<string, string> = {
      grace: "Waiting for the interrupted answer to reconnect",
      reloaded: "Refresh issued; result not yet verified",
      stop_issued: "Stop attempted; waiting to verify a safe continuation",
      continue_issued: "Continue attempted; delivery not yet verified",
      observe_only: "Passive checks only; an uncertain action will not be repeated",
    };
    if (state.orangeStage && stageLabels[state.orangeStage]) {
      lines.push(`Last saved interruption stage: ${stageLabels[state.orangeStage]}`);
    }
    lines.push("Next: automatic action only after checking the same stalled turn and draft safety");
    if (state.orangeStage === "observe_only" || state.orangeStage === "continue_issued") {
      lines.push("Manual review: inspect delivery and draft before any session-control reload");
    }
  }

  const recent = events
    .filter(
      (event) => Number.isFinite(event.at) && event.at <= now && now - event.at <= recentWindowMs,
    )
    .map((event) => ({ event, description: safeEventDescription(event) }))
    .filter(
      (item): item is { event: ChatGPTRecoveryEvent; description: string } =>
        item.description !== null,
    )
    .slice(-2);
  for (const { event, description } of recent) {
    lines.push(`History · ${time(event.at)}: ${description}`);
  }
  return lines;
}
