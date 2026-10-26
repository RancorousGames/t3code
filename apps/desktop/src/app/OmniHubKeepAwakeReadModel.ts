// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Desktop reads the OmniHub-owned local snapshot.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Read-only local projection of OmniHub Tools' temporary keep-awake store.
 * It never invokes a scheduler tool or returns control/ack tokens, receipts or events.
 * T3 scheduled tasks are separate and must never be mixed into this source.
 */
export const OMNIHUB_KEEP_AWAKE_SOURCE = "omnihub-temporary-keep-awake" as const;

export type KeepAwakeTarget = {
  id: string;
  kind: "t3/chatgpt_browser" | "t3/native_thread" | "unknown";
  title: string;
  url: string | null;
  visibility: "visible" | "hidden" | "missing" | "unchecked";
};

export type KeepAwakeMonitorStatus =
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

export type KeepAwakeMonitor = {
  source: typeof OMNIHUB_KEEP_AWAKE_SOURCE;
  id: string;
  mandateId: string;
  target: KeepAwakeTarget;
  status: KeepAwakeMonitorStatus;
  activeOrPending: boolean;
  finalWakePending: boolean;
  oneShot: boolean;
  intervalMinutes: number | null;
  createdAtMs: number | null;
  endAtMs: number | null;
  nextAttemptAtMs: number | null;
  lastSchedulerTickAtMs: number | null;
  lastWakeUserTurnAtMs: number | null;
  lastAssistantAckAtMs: number | null;
  finalDeliveredAtMs: number | null;
  wakeAttempts: number;
  lastDelivery: string | null;
  lastOutcome: string | null;
  explanation: string;
};

export type KeepAwakeTargetSession = {
  id: string;
  kind: "t3/chatgpt_browser" | "t3/native_thread";
  title?: string | null;
  url?: string | null;
  hidden?: boolean;
};

/** Never describe an unavailable or malformed monitor store as "all done". */
export type KeepAwakeReadResult =
  | {
      source: typeof OMNIHUB_KEEP_AWAKE_SOURCE;
      availability: "ok";
      observedAtMs: number;
      monitors: KeepAwakeMonitor[];
    }
  | {
      source: typeof OMNIHUB_KEEP_AWAKE_SOURCE;
      availability: "unavailable";
      observedAtMs: number;
      monitors: [];
      error: string;
    };

type ObjectValue = Record<string, unknown>;
const record = (value: unknown): ObjectValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : null;
const string = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const bounded = (value: unknown): string | null => string(value)?.slice(0, 400) ?? null;
const pastDue = (nowMs: number, expiresAtMs: number | null, finalStartedAtMs: number | null) =>
  finalStartedAtMs !== null || (expiresAtMs !== null && nowMs >= expiresAtMs);
const issue = (value: string | null) =>
  value !== null &&
  /not_ready|retry|unknown|unsafe|unavailable|error|mismatch|blocked|fail|transport|attention/i.test(
    value,
  );

/** Normalizes only the established persisted v1 fields; no terminal state is inferred from time. */
export function projectOmniHubKeepAwakeSnapshot(
  source: unknown,
  nowMs: number,
  sessions?: readonly KeepAwakeTargetSession[],
): KeepAwakeReadResult {
  const base = { source: OMNIHUB_KEEP_AWAKE_SOURCE, observedAtMs: nowMs };
  const store = record(source);
  const monitors = record(store?.monitors);
  if (store?.version !== 1 || !monitors) {
    return {
      ...base,
      availability: "unavailable",
      monitors: [],
      error: "OmniHub keep-awake snapshot is missing or incompatible.",
    };
  }

  const projected: KeepAwakeMonitor[] = [];
  for (const [id, raw] of Object.entries(monitors)) {
    const monitor = record(raw);
    const target = record(monitor?.target);
    if (!monitor || !target || !string(monitor.id) || !string(target.sessionId)) {
      return {
        ...base,
        availability: "unavailable",
        monitors: [],
        error: "OmniHub keep-awake snapshot contains an invalid monitor.",
      };
    }
    if (monitor.id !== id) {
      return {
        ...base,
        availability: "unavailable",
        monitors: [],
        error: "OmniHub keep-awake monitor identity mismatch.",
      };
    }

    const targetId = string(target.sessionId)!;
    const kind =
      target.kind === "t3/chatgpt_browser" || target.kind === "t3/native_thread"
        ? target.kind
        : "unknown";
    const match = sessions?.find((s) => s.id === targetId && s.kind === kind);
    const visibility: KeepAwakeTarget["visibility"] =
      sessions === undefined
        ? "unchecked"
        : !match
          ? "missing"
          : match.hidden
            ? "hidden"
            : "visible";

    // Link only a previously observed T3 URL, never a guessed URL from the target UUID.
    const url =
      match?.url &&
      kind === "t3/chatgpt_browser" &&
      /^https:\/\/chatgpt\.com\/c\/[0-9a-z-]+(?:[?#].*)?$/i.test(match.url)
        ? match.url
        : null;
    const state = string(monitor.state) ?? "unknown";
    const endAtMs = number(monitor.expiresAtMs);
    const finalWakePending =
      (state === "active" || state === "paused_indeterminate") &&
      pastDue(nowMs, endAtMs, number(monitor.finalStartedAtMs));
    const activeOrPending = !["completed", "cancelled", "canceled", "expired", "failed"].includes(
      state,
    );
    const lastOutcome = bounded(monitor.lastOutcome);
    const lastDelivery = bounded(monitor.lastDelivery);
    const observation = record(monitor.lastObservation);
    const observationReason = bounded(observation?.reason);
    const hasIssue = issue(lastOutcome) || issue(lastDelivery) || issue(observationReason);
    const attention = state === "paused_indeterminate" || number(monitor.attentionSinceMs) !== null;
    const status: KeepAwakeMonitorStatus =
      state === "completed"
        ? "completed"
        : state === "cancelled" || state === "canceled"
          ? "cancelled"
          : state === "expired" || state === "failed"
            ? "history"
            : state === "paused_indeterminate"
              ? "needs_attention"
              : state !== "active"
                ? "unknown"
                : finalWakePending
                  ? hasIssue || attention
                    ? "final_retrying"
                    : "final_pending"
                  : monitor.inFlight === true
                    ? "attempting"
                    : hasIssue || attention
                      ? "retrying"
                      : "active";

    let explanation: string;
    if (visibility === "missing")
      explanation =
        "Exact target session is absent from the current T3 list; delivery cannot be confirmed.";
    else if (visibility === "hidden")
      explanation =
        "Target session is hidden/unloaded; readiness must be rechecked before delivery.";
    else if (state === "paused_indeterminate")
      explanation =
        "Delivery is indeterminate; the scheduler is paused for reconciliation, not completed.";
    else if (finalWakePending)
      explanation = hasIssue
        ? "Requested duration ended; final wake remains pending and retries/readiness checks continue."
        : "Requested duration ended; final wake remains pending until acknowledged or explicitly stopped.";
    else if (state === "completed") explanation = "Monitor completed according to OmniHub.";
    else if (state === "cancelled" || state === "canceled")
      explanation = "Monitor explicitly cancelled.";
    else if (!activeOrPending) explanation = `OmniHub reported terminal state: ${state}.`;
    else if (hasIssue)
      explanation = "Last readiness or delivery check failed; monitor remains active.";
    else if (state === "active") explanation = "Monitor remains scheduled in OmniHub.";
    else explanation = `Unrecognized OmniHub state: ${state}; completion is unverified.`;

    // Never spread raw monitor, target, receipts or token-bearing source objects.
    projected.push({
      source: OMNIHUB_KEEP_AWAKE_SOURCE,
      id,
      mandateId: string(monitor.mandateId) ?? "",
      target: { id: targetId, kind, title: string(match?.title) ?? targetId, url, visibility },
      status,
      activeOrPending,
      finalWakePending,
      oneShot: monitor.oneShot === true,
      intervalMinutes: number(monitor.intervalMinutes),
      createdAtMs: number(monitor.createdAtMs),
      endAtMs,
      nextAttemptAtMs: state === "active" ? number(monitor.nextDueMs) : null,
      lastSchedulerTickAtMs: number(monitor.lastSchedulerTickAtMs),
      lastWakeUserTurnAtMs: number(monitor.lastWakeUserTurnAtMs),
      lastAssistantAckAtMs: number(monitor.lastAssistantAckAtMs),
      finalDeliveredAtMs: number(monitor.finalDeliveredAtMs),
      wakeAttempts: number(monitor.wakeAttempts) ?? 0,
      lastDelivery,
      lastOutcome,
      explanation: observationReason
        ? `${explanation} Last check: ${observationReason}`
        : explanation,
    });
  }
  projected.sort(
    (a, b) =>
      Number(b.activeOrPending) - Number(a.activeOrPending) ||
      Number(b.finalWakePending) - Number(a.finalWakePending) ||
      (a.nextAttemptAtMs ?? Infinity) - (b.nextAttemptAtMs ?? Infinity) ||
      (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0),
  );
  return { ...base, availability: "ok", monitors: projected };
}

/**
 * Desktop-only, one-shot, read-only file adapter. Refresh by calling again.
 * The JSON stays owned by OmniHub Tools. No file watching, locks, scheduler loops,
 * IPC mutation, token access or changes to the scheduled actions occur here.
 * A remote T3 host must query its own owner host rather than this caller's disk.
 */
export async function readLocalOmniHubKeepAwake(
  options: {
    localAppData?: string;
    sessions?: readonly KeepAwakeTargetSession[];
    nowMs?: number;
    readText?: (path: string) => Promise<string>;
  } = {},
): Promise<KeepAwakeReadResult> {
  const nowMs = options.nowMs ?? Date.now();
  const base = {
    source: OMNIHUB_KEEP_AWAKE_SOURCE,
    availability: "unavailable" as const,
    observedAtMs: nowMs,
    monitors: [] as [],
  };
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  if (!localAppData) return { ...base, error: "OmniHub local store is unavailable on this host." };
  try {
    const path = join(localAppData, "OmniHub", "temporary-keep-awake-v1.json");
    const content = await (options.readText ?? ((p: string) => readFile(p, "utf8")))(path);
    if (content.length > 5_000_000)
      return { ...base, error: "OmniHub keep-awake snapshot exceeds the size limit." };
    return projectOmniHubKeepAwakeSnapshot(JSON.parse(content) as unknown, nowMs, options.sessions);
  } catch {
    return {
      ...base,
      error: "Unable to read OmniHub keep-awake snapshot; monitor status is unknown.",
    };
  }
}
