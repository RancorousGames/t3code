import type { T3CaffyEntry } from "../../hooks/useT3CaffyOverview";

const at = (timestamp: number) => new Date(timestamp).toLocaleString();

/** Scheduler diagnostics are keyed to a durable T3 session, not a ChatGPT thread. */
export function caffyDiagnosticLines(monitor: T3CaffyEntry, now: number): string[] {
  const nextWake = (() => {
    if (monitor.paused) return "Paused";
    if (monitor.beginAt != null && monitor.beginAt > now)
      return `At ${at(monitor.beginAt)} (delayed start)`;
    if (monitor.pendingMessageId) return "Delivery pending";
    if (monitor.pendingWake) return "Requested; awaiting dispatch";
    if (monitor.mode === "periodic")
      return monitor.nextDueAt != null
        ? `At ${at(monitor.nextDueAt)}`
        : "Waiting for periodic schedule";
    if (monitor.mode === "startup") return "Next T3 restart";
    if (monitor.mode === "queued") return "When eligible / free capacity";
    return "Event-driven: after the next verified idle event";
  })();

  const checkedAt = monitor.lastCheckedAt;
  const lastCheck = checkedAt != null && Number.isFinite(checkedAt)
    ? `${at(checkedAt)} (${Math.max(0, Math.round((now - checkedAt) / 1000))}s ago)`
    : "Not yet observed";

  const lines = [
    `Next wake: ${nextWake}`,
    `Last scheduler check: ${lastCheck}`,
    `Next scheduler check: ${monitor.nextCheckAt != null ? `${at(monitor.nextCheckAt)}${monitor.nextCheckAt < now ? " (overdue; scheduler may be unavailable)" : ""}` : "When T3 is ready"}`,
    `Last wake sent: ${monitor.lastWakeAt != null ? at(monitor.lastWakeAt) : "Never"}`,
  ];
  lines.push(`Mode: ${monitor.mode}; ${monitor.paused ? "paused" : "enabled"}`);
  if (monitor.wakePhase) lines.push(`State: ${monitor.wakePhase} (revision ${monitor.transitionVersion ?? 0})`);
  if (monitor.availability) lines.push(`Browser: ${monitor.availability}`);
  if (monitor.pendingMessageId) lines.push(`Receipt: ${monitor.pendingMessageId}; ${monitor.deliveryStatus ?? "pending journal"}${monitor.deliveryAwaitingGuest ? "; awaiting verified mount" : ""}`);
  if (monitor.lastDeliveryResult) lines.push(`Delivery result: ${monitor.lastDeliveryResult}`);
  if (monitor.admissionReason) lines.push(`Admission: ${monitor.admissionReason}`);
  if (monitor.lastCheckResult) lines.push(`Check result: ${monitor.lastCheckResult}`);
  if (monitor.lastError) lines.push(`Error: ${monitor.lastError}`);
  return lines;
}
