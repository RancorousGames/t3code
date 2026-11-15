/** Portable, read-only Caffy projection for desktop badges and the Android AI screen.
 * Never treat the absence of a scheduler record as an active wake rule. */
export interface CaffyReadout {
  mode: "idle" | "periodic" | "startup";
  paused: boolean;
  onceOnly: boolean;
  intervalMinutes: number;
  respectSlots?: boolean;
  startup?: boolean;
  beginAt?: number | null;
  expiresAt?: number | null;
  createdAt?: number;
  nextDueAt?: number | null;
  lastWakeAt?: number | null;
  lastCheckedAt?: number | null;
  nextCheckAt?: number | null;
  lastCheckResult?: string | null;
  lastDeliveryResult?: string | null;
  lastError?: string | null;
  pendingWake?: boolean;
  pendingMessageId?: string | null;
  deliveryStatus?: string | null;
  autoRebootMinutes?: number | null;
  autoRebootEveryRuns?: number | null;
  rebootOperationId?: string | null;
  wakePhase?: string | null;
  admissionReason?: string | null;
}

export type CaffyColor = "green" | "purple" | "cyan" | "blue" | "orange" | "red";

function shortInterval(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 1) return "?";
  if (minutes % 10080 === 0) return `${minutes / 10080}w`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function caffyBadge(
  entry: CaffyReadout,
  now: number,
): {
  color: CaffyColor;
  code: string;
  label: string;
  sentence: string;
} {
  const interval =
    entry.mode === "periodic"
      ? `every ${entry.intervalMinutes} ${entry.intervalMinutes === 1 ? "minute" : "minutes"}`
      : entry.mode === "startup"
        ? "when T3 starts"
        : "whenever it becomes idle";
  const slotClause = entry.respectSlots ? ", respecting working slots" : "";
  const baseline =
    entry.mode === "periodic"
      ? `Caffy wakes this session ${interval}${slotClause}.`
      : entry.mode === "startup"
        ? "Caffy wakes this session when T3 starts."
        : `Caffy wakes this session whenever it becomes idle${slotClause}.`;

  if (entry.paused)
    return {
      color: "orange",
      code: entry.mode === "periodic" ? shortInterval(entry.intervalMinutes) : "Ⅱ",
      label: "Caffy paused",
      sentence: `Caffy is paused. Its ${entry.mode === "periodic" ? `${shortInterval(entry.intervalMinutes)} interval` : "wake-on-idle rule"} will resume when unpaused.`,
    };
  if (entry.beginAt && entry.beginAt > now) {
    const ahead = Math.max(1, Math.ceil((entry.beginAt - now) / 60_000));
    return {
      color: "blue",
      code: `+${shortInterval(ahead)}`,
      label: "Caffy delayed start",
      sentence: `Caffy starts this session ${new Date(entry.beginAt).toLocaleString()}, then wakes it ${interval}${slotClause}.`,
    };
  }
  if (entry.onceOnly)
    return {
      color: "cyan",
      code: "1×",
      label: "Caffy continue once",
      sentence: `Caffy will continue this session once ${entry.mode === "periodic" ? `after ${shortInterval(entry.intervalMinutes)}` : "when it becomes idle"}${slotClause}, then stop.`,
    };
  return {
    color: entry.mode === "periodic" ? "purple" : "green",
    code:
      entry.mode === "periodic"
        ? shortInterval(entry.intervalMinutes)
        : entry.mode === "startup"
          ? "↻"
          : "∞",
    label:
      entry.mode === "periodic"
        ? `Caffy interval ${shortInterval(entry.intervalMinutes)}`
        : entry.mode === "startup"
          ? "Caffy on startup"
          : "Caffy keep running",
    sentence: baseline,
  };
}

export function caffyStoppedBadge(): {
  color: CaffyColor;
  code: string;
  label: string;
  sentence: string;
} {
  return {
    color: "red",
    code: "×",
    label: "Caffy stopped by agent",
    sentence: "The agent stopped Caffy. No more automatic wakes are scheduled.",
  };
}

export function caffyNextWake(entry: CaffyReadout, now: number): string {
  if (entry.paused) return "Paused · no wake scheduled";
  if (entry.beginAt != null && entry.beginAt > now) return new Date(entry.beginAt).toLocaleString();
  if (entry.pendingMessageId) return "Delivery pending";
  if (entry.pendingWake) return "Waiting for dispatch";
  if (entry.mode === "startup") return "When T3 next starts";
  if (entry.mode === "periodic")
    return entry.nextDueAt != null
      ? new Date(entry.nextDueAt).toLocaleString()
      : "After the last wake completes";
  return entry.respectSlots
    ? "When idle and a working slot is free"
    : "As soon as the session is idle";
}

export function caffyRecentEvents(entry: CaffyReadout): readonly {
  time: number;
  label: string;
}[] {
  return [
    ...(entry.lastWakeAt != null && Number.isFinite(entry.lastWakeAt)
      ? [{ time: entry.lastWakeAt, label: `Continuation ${entry.lastDeliveryResult ?? "sent"}` }]
      : []),
    ...(entry.lastCheckedAt != null && Number.isFinite(entry.lastCheckedAt)
      ? [
          {
            time: entry.lastCheckedAt,
            label: `Scheduler checked${entry.lastCheckResult ? ` · ${entry.lastCheckResult}` : ""}`,
          },
        ]
      : []),
    ...(entry.createdAt != null && Number.isFinite(entry.createdAt)
      ? [{ time: entry.createdAt, label: "Caffy configured" }]
      : []),
  ]
    .sort((a, b) => b.time - a.time)
    .slice(0, 4);
}

/** Narrow read of persisted server registry metadata; malformed/stale records show no badge. */
export function readCaffyRecord(value: unknown): CaffyReadout | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (
    !(obj.mode === "idle" || obj.mode === "periodic" || obj.mode === "startup") ||
    typeof obj.paused !== "boolean" ||
    typeof obj.onceOnly !== "boolean" ||
    typeof obj.intervalMinutes !== "number" ||
    !Number.isFinite(obj.intervalMinutes)
  )
    return null;
  return obj as unknown as CaffyReadout;
}
