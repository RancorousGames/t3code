import type {
  DesktopOpenRigAgent,
  DesktopOpenRigExecutionProfile,
  DesktopOpenRigManagedSession,
  DesktopOpenRigSeatReport,
  DesktopOpenRigSeatSessions,
  DesktopOpenRigSessionTarget,
} from "@t3tools/contracts";

/**
 * Presentation-only helpers for OpenRig seats. Everything here reads fields
 * OpenRig actually returned; nothing infers progress, ownership or topology.
 */

export type SeatStatusTone = "working" | "waiting" | "blocked" | "idle" | "offline" | "unknown";

/** Colors a raw OpenRig status. The raw string is always what is displayed. */
export function seatStatusTone(status: string): SeatStatusTone {
  const value = status.trim().toLowerCase();
  if (/^(working|running|busy|active|in[-_ ]?progress|executing)$/u.test(value)) return "working";
  if (/^(waiting|pending|awaiting[-_ ]?input|queued|needs[-_ ]?input)$/u.test(value)) return "waiting";
  if (/^(blocked|error|failed|stuck)$/u.test(value)) return "blocked";
  if (/^(idle|ready|done|complete|completed)$/u.test(value)) return "idle";
  if (/^(disconnected|offline|stopped|unavailable|detached)$/u.test(value)) return "offline";
  return "unknown";
}

export const SEAT_STATUS_DOT: Record<SeatStatusTone, string> = {
  working: "bg-info",
  waiting: "bg-warning",
  blocked: "bg-destructive",
  idle: "bg-success",
  offline: "bg-muted-foreground/40",
  unknown: "border border-muted-foreground/60 bg-transparent",
};
export const SEAT_STATUS_BADGE = {
  working: "info",
  waiting: "warning",
  blocked: "error",
  idle: "success",
  offline: "outline",
  unknown: "outline",
} as const satisfies Record<SeatStatusTone, string>;

export const explanation = (error: unknown) =>
  error instanceof Error ? error.message.slice(0, 300) : "Unknown error";

/** Only local pre-POST failures have this marker; HTTP/transport failures remain indeterminate. */
export const sendDefinitelyNotSent = (reason: string): boolean =>
  reason.startsWith("OpenRig message not sent:") || reason === "OpenRig messaging is unavailable.";

// OpenRig rejects launch pre-intent with 400/404 and (except duplicate operations)
// 409. A 503, transport error or incomplete receipt is ambiguous: NEVER retry.
export function isPreIntentLaunchRejection(reason: string): boolean {
  return (
    /\bOpenRig bridge HTTP (400|404|409)(?::|\.)/iu.test(reason) &&
    !/operation already recorded|operation already exists|operation already recorded by another/iu.test(reason)
  );
}

export function historyHref(target: DesktopOpenRigSessionTarget | null): string | null {
  if (target?.kind === "t3-thread")
    return `/${encodeURIComponent(target.environmentId)}/${encodeURIComponent(target.threadId)}`;
  if (target?.kind === "chatgpt-conversation")
    return `https://chatgpt.com/c/${encodeURIComponent(target.conversationId)}`;
  return null; // A volatile browser UUID cannot open a durable conversation history.
}

function stringField(value: unknown, field: string): string | null {
  return typeof value === "object" && value !== null && field in value &&
    typeof (value as Record<string, unknown>)[field] === "string"
    ? ((value as Record<string, unknown>)[field] as string)
    : null;
}

export function sessionDisplayTitle(session: DesktopOpenRigManagedSession): string {
  return session.title ?? stringField(session.intent, "title") ?? `${session.mode} · ${session.id.slice(0, 12)}`;
}

/** The provider OpenRig recorded, else the exact intent instance, else the launch mode. */
export function sessionProviderLabel(session: DesktopOpenRigManagedSession): string {
  return session.provider ??
    (session.mode === "native" ? stringField(session.intent, "providerInstanceId") : null) ??
    session.mode;
}

export function sessionObservedStatus(session: DesktopOpenRigManagedSession): string | null {
  return stringField(session.observed, "status");
}

export function primarySession(ledger: DesktopOpenRigSeatSessions | null) {
  return ledger?.sessions.find((session) => session.id === ledger.primarySessionId) ?? null;
}

/** The backend routes exclusively via the active managed primary; legacy bindings never qualify. */
export function canMessagePrimary(primary: DesktopOpenRigManagedSession | null): boolean {
  return primary?.status === "active" &&
    (primary.target?.kind === "t3-thread" || primary.target?.kind === "chatgpt-conversation");
}

export function formatTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? value
    : time.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Operator-sent message recorded by this workspace only, for this app session. */
export interface WorkspaceSend {
  id: string;
  seatId: string;
  text: string;
  at: string;
  outcome: "accepted" | "unconfirmed" | "not_sent";
  detail: string | null;
}

export interface ActivityEntry {
  key: string;
  at: string;
  title: string;
  detail: string | null;
  source: "OpenRig ledger" | "OpenRig snapshot" | "Seat report (author unverified)" | "This workspace";
}

/** A timeline assembled only from timestamps OpenRig or this workspace recorded. */
export function buildActivity(
  agent: DesktopOpenRigAgent,
  snapshotAt: string | null,
  ledger: DesktopOpenRigSeatSessions | null,
  sends: readonly WorkspaceSend[],
  reports: readonly DesktopOpenRigSeatReport[] = [],
): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const report of reports)
    entries.push({
      key: `report:${report.reportId}`, at: report.timestamp, source: "Seat report (author unverified)",
      title: `Reported ${report.status}${report.progress !== null ? ` (${report.progress}% self-reported)` : ""}`,
      detail: report.summary + (report.blockedOn.length ? ` · blocked on ${report.blockedOn.join(", ")}` : ""),
    });
  if (snapshotAt)
    entries.push({
      key: "snapshot", at: snapshotAt, source: "OpenRig snapshot",
      title: `Seat status reported: ${agent.status}`,
      detail: agent.task ? `Task: ${agent.task}` : null,
    });
  for (const session of ledger?.sessions ?? []) {
    const title = sessionDisplayTitle(session);
    entries.push({
      key: `${session.id}:created`, at: session.createdAt, source: "OpenRig ledger",
      title: `Session created: ${title}`,
      detail: `${sessionProviderLabel(session)} · operation ${session.operationId.slice(0, 8)}`,
    });
    if (session.lastActivityAt)
      entries.push({
        key: `${session.id}:activity`, at: session.lastActivityAt, source: "OpenRig ledger",
        title: `Last recorded activity: ${title}`, detail: null,
      });
    if (session.updatedAt !== session.createdAt)
      entries.push({
        key: `${session.id}:updated`, at: session.updatedAt, source: "OpenRig ledger",
        title: `Ledger record updated: ${title}`,
        detail: `Status ${session.status}${session.error ? ` · ${session.error}` : ""}`,
      });
  }
  for (const send of sends)
    entries.push({
      key: `send:${send.id}`, at: send.at, source: "This workspace",
      title: send.outcome === "accepted" ? "Message delivered to T3" :
        send.outcome === "not_sent" ? "Message not sent" : "Message delivery unconfirmed",
      detail: send.text.length > 140 ? send.text.slice(0, 139) + "…" : send.text,
    });
  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export interface Blocker {
  key: string;
  text: string;
}

/** Conditions that verifiably stop work or delivery. Never guesses at agent intent. */
export function seatBlockers(
  agent: DesktopOpenRigAgent,
  ledger: DesktopOpenRigSeatSessions | null,
  profile: DesktopOpenRigExecutionProfile | null,
): Blocker[] {
  const blockers: Blocker[] = [];
  if (seatStatusTone(agent.status) === "blocked")
    blockers.push({ key: "status", text: `OpenRig reports this seat as ${agent.status}.` });
  if (ledger && !canMessagePrimary(primarySession(ledger)))
    blockers.push({ key: "primary", text: "No routable active managed primary; seat messages cannot be delivered." });
  if (ledger && ledger.pendingRecoveryCount > 0)
    blockers.push({ key: "recovery", text: `${ledger.pendingRecoveryCount} session(s) await recovery or reconciliation.` });
  for (const session of ledger?.sessions ?? [])
    if (session.error && session.status !== "detached")
      blockers.push({ key: `error:${session.id}`, text: `${sessionDisplayTitle(session)}: ${session.error}` });
  const runtime = profile?.rigSpec.runtime?.toLowerCase();
  if (profile && !profile.nativeLaunchReady && (runtime === "codex" || runtime === "claude"))
    blockers.push({ key: "native", text: "Native launch is not ready for this seat's execution profile." });
  return blockers;
}
