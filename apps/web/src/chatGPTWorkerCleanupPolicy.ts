import type { BrowserSession } from "./chatGPTBrowserSessions";
import { chatGPTConversationIdFromUrl } from "./chatGPTConversationIdentity";
import { chatGPTParentIndex } from "./chatGPTSessionLineage";
import { assertArchivableSession, descendantSessions } from "./chatGPTSessionArchivePolicy";

/**
 * This module plans cleanup only. The desktop owner must inspect the guest, persist
 * the intent BEFORE invoking the existing archive/close commands, and reconcile
 * persisted results before committing a receipt. Never execute plans on mount.
 */
export interface WorkerCleanupSettings {
  enabled: boolean;
  closeEnabled: boolean;
  /** Persisted time the user opted in. Earlier completions never sweep en masse. */
  enabledAtMs: number | null;
  archiveGraceMs: number;
  closeRetentionMs: number;
}

export const DEFAULT_WORKER_CLEANUP_SETTINGS: Readonly<WorkerCleanupSettings> = {
  enabled: false,
  closeEnabled: false,
  enabledAtMs: null,
  archiveGraceMs: 60 * 60_000,
  closeRetentionMs: 7 * 24 * 60 * 60_000,
};

/** Verified by the caller against the original managed-worker spawn receipt. */
export interface VerifiedWorkerLink {
  sessionId: string;
  parentSessionId: string;
  spawnRequestId: string;
}

/** Verified by the completion owner, NOT inferred from idle or released claims. */
export interface WorkerDoneReceipt {
  sessionId: string;
  declaredAt: string;
  source: "verified_worker_done" | "verified_manager_done";
}

/** Spawn receipts come from readChatGPTSpawnReceipts for the CURRENT environment. */
export interface WorkerSpawnReceipt {
  sessionId: string;
  requestId: string;
}

/**
 * A fresh, guest-backed inspection. These extra facts are NOT in a sessions.list
 * response: the integration must separately verify composer drafts, uncertain
 * sends and recovery state before issuing an archive command.
 */
export interface WorkerCleanupInspection {
  sessionId: string;
  observedAtMs: number;
  idleSinceMs: number | null;
  hidden: boolean;
  status: string;
  activity: string;
  uiColor: string;
  observedGuestUrl: string | null;
  totalTurns: number;
  completion: BrowserSession["completion"] | null;
  composer: "empty" | "nonempty" | "unknown";
  send: "clear" | "unresolved" | "unknown";
  recovery: "clear" | "recovering" | "interrupted" | "unknown";
}

export type WorkerCleanupPhase = "archive_pending" | "archived" | "close_pending" | "closed";

export interface WorkerCleanupRecord {
  sessionId: string;
  parentSessionId: string;
  spawnRequestId: string;
  declaredAt: string;
  conversationUrl: string;
  phase: WorkerCleanupPhase;
  /** Exact persisted archive timestamp; retained for restore/audit after close. */
  archivedAt?: string;
  updatedAtMs: number;
}

export type WorkerCleanupAction = "archive" | "close";

export interface WorkerCleanupDecision {
  sessionId: string;
  proposedAction: WorkerCleanupAction | null;
  /** Empty means eligible; otherwise the item is preview-only/blocked. */
  reasons: readonly string[];
}

export interface WorkerCleanupPlan {
  preview: readonly WorkerCleanupDecision[];
  /** No side effects: caller must record intent, recheck, then execute. */
  actions: ReadonlyArray<{ sessionId: string; action: WorkerCleanupAction }>;
}

export interface WorkerCleanupInput {
  sessions: readonly BrowserSession[];
  links: readonly VerifiedWorkerLink[];
  spawnReceipts: readonly WorkerSpawnReceipt[];
  doneReceipts: readonly WorkerDoneReceipt[];
  inspections: readonly WorkerCleanupInspection[];
  ledger: readonly WorkerCleanupRecord[];
  settings: WorkerCleanupSettings;
  nowMs: number;
  /** Only a deliberate post-startup call may produce executable actions. */
  mode?: "preview" | "execute";
  startupReconciled?: boolean;
}

const MIN_ARCHIVE_GRACE_MS = 60 * 60_000;
const MIN_CLOSE_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MIN_OBSERVED_IDLE_MS = 10 * 60_000;
const MAX_OBSERVATION_AGE_MS = 30_000;

function parsedMs(value: string): number | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function canonicalConversation(url: string | null): string | null {
  const id = chatGPTConversationIdFromUrl(url);
  return id && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) ? id : null;
}

export function planChatGPTWorkerCleanup(input: WorkerCleanupInput): WorkerCleanupPlan {
  const { sessions, settings, nowMs } = input;
  if (!Number.isFinite(nowMs) || nowMs <= 0) throw new Error("Invalid cleanup clock.");
  const byId = new Map(sessions.map((entry) => [entry.id, entry]));
  const parents = chatGPTParentIndex(sessions);
  const links = new Map(input.links.map((link) => [link.sessionId, link]));
  const spawnReceipts = new Map(input.spawnReceipts.map((receipt) => [receipt.sessionId, receipt]));
  const doneReceipts = new Map(input.doneReceipts.map((receipt) => [receipt.sessionId, receipt]));
  const inspections = new Map(
    input.inspections.map((inspection) => [inspection.sessionId, inspection]),
  );
  const ledger = new Map(input.ledger.map((record) => [record.sessionId, record]));
  const preview: WorkerCleanupDecision[] = [];
  const actions: Array<{ sessionId: string; action: WorkerCleanupAction }> = [];

  for (const entry of sessions) {
    // Roots, detached sessions and legacy inferred/unverified children must
    // never become cleanup candidates, even in a dry run.
    const link = links.get(entry.id);
    if (!link || !entry.parentSessionId) continue;
    const reasons: string[] = [];
    const spawn = spawnReceipts.get(entry.id);
    if (
      link.sessionId !== entry.id ||
      link.parentSessionId !== entry.parentSessionId ||
      !link.spawnRequestId ||
      spawn?.requestId !== link.spawnRequestId ||
      parents.get(entry.id) !== entry.parentSessionId ||
      !byId.has(entry.parentSessionId)
    ) {
      reasons.push("unverified child provenance");
    }
    if (descendantSessions(sessions, entry.id).length > 0) {
      // Conservative: do not orphan even an archived/unknown descendant.
      reasons.push("descendant sessions still exist");
    }
    if (entry.id === "chatgpt") reasons.push("root session");

    const done = doneReceipts.get(entry.id);
    const declaredAtMs = parsedMs(entry.completion?.declaredAt ?? "");
    const enabledAtMs = settings.enabledAtMs;
    if (
      !entry.completion ||
      !done ||
      done.declaredAt !== entry.completion.declaredAt ||
      done.sessionId !== entry.id ||
      declaredAtMs === null ||
      declaredAtMs > nowMs ||
      enabledAtMs === null ||
      !Number.isFinite(enabledAtMs) ||
      enabledAtMs <= 0 ||
      declaredAtMs < enabledAtMs
    ) {
      reasons.push("missing post-opt-in persisted completion and verified owner receipt");
    }
    const record = ledger.get(entry.id);
    if (
      record &&
      (record.parentSessionId !== entry.parentSessionId ||
        record.spawnRequestId !== link.spawnRequestId ||
        record.declaredAt !== entry.completion?.declaredAt ||
        record.conversationUrl !== entry.completion?.observedUrl)
    ) {
      reasons.push("cleanup receipt does not match current session identity");
    }

    let proposedAction: WorkerCleanupAction | null = null;
    if (record?.phase === "archive_pending" || record?.phase === "close_pending") {
      reasons.push("prior cleanup intent unresolved; reconcile before retry");
    } else if (record?.phase === "closed") {
      reasons.push("already closed");
    } else if (entry.hidden) {
      // An archived webview has no live DOM to inspect. Closing is safe only
      // after a previously CONFIRMED archive, with no subsequent restore.
      if (
        record?.phase === "archived" &&
        entry.archive?.basis === "completion" &&
        !entry.archive.restoredAt &&
        record.archivedAt === entry.archive.archivedAt &&
        canonicalConversation(entry.archive.conversationUrl) &&
        entry.archive.conversationUrl === record.conversationUrl &&
        settings.closeEnabled &&
        Number.isFinite(settings.closeRetentionMs) &&
        settings.closeRetentionMs >= MIN_CLOSE_RETENTION_MS &&
        (parsedMs(entry.archive.archivedAt) ?? -Infinity) >= (declaredAtMs ?? Infinity) &&
        (parsedMs(entry.archive.archivedAt) ?? Infinity) + settings.closeRetentionMs <= nowMs
      ) {
        proposedAction = "close";
      } else {
        reasons.push("archived/hidden, unconfirmed, or not beyond close retention");
      }
    } else if (record?.phase === "archived") {
      reasons.push("previously archived session was restored; do not rearchive automatically");
    } else {
      const observed = inspections.get(entry.id);
      if (!observed) {
        reasons.push("fresh guest inspection unavailable");
      } else {
        if (
          observed.sessionId !== entry.id ||
          !Number.isFinite(observed.observedAtMs) ||
          observed.observedAtMs > nowMs ||
          nowMs - observed.observedAtMs > MAX_OBSERVATION_AGE_MS
        )
          reasons.push("stale or mismatched observation");
        if (
          observed.send !== "clear" ||
          observed.composer !== "empty" ||
          observed.recovery !== "clear" ||
          !["recent", "idle"].includes(observed.uiColor)
        )
          reasons.push("draft, unresolved send, recovery or activity state unknown");
        if (
          observed.idleSinceMs === null ||
          !Number.isFinite(observed.idleSinceMs) ||
          observed.idleSinceMs > observed.observedAtMs ||
          nowMs - observed.idleSinceMs < MIN_OBSERVED_IDLE_MS
        )
          reasons.push("idle interval not independently verified");
        try {
          assertArchivableSession(
            entry,
            { ...observed },
            false, // Never use the manual manager-decision bypass for automation.
          );
        } catch {
          reasons.push("not a verified idle conversation with persisted completion");
        }
        if (
          canonicalConversation(observed.observedGuestUrl) === null ||
          observed.observedGuestUrl !== entry.completion?.observedUrl
        )
          reasons.push("conversation identity changed");
      }
      if (
        declaredAtMs === null ||
        !Number.isFinite(settings.archiveGraceMs) ||
        settings.archiveGraceMs < MIN_ARCHIVE_GRACE_MS ||
        declaredAtMs + settings.archiveGraceMs > nowMs
      )
        reasons.push("completion grace not elapsed");
      proposedAction = "archive";
    }

    const uniqueReasons = [...new Set(reasons)];
    if (
      proposedAction &&
      uniqueReasons.length === 0 &&
      input.mode === "execute" &&
      input.startupReconciled === true &&
      settings.enabled === true
    ) {
      actions.push({ sessionId: entry.id, action: proposedAction });
    }
    if (!settings.enabled) uniqueReasons.push("automatic cleanup disabled");
    if (input.mode !== "execute" || input.startupReconciled !== true)
      uniqueReasons.push("preview only; startup execution not armed");
    preview.push({ sessionId: entry.id, proposedAction, reasons: uniqueReasons });
  }
  return { preview, actions };
}

/** Persist this intent before ANY async archive/close action. Never retry an unresolved intent. */
export function recordWorkerCleanupIntent(
  records: readonly WorkerCleanupRecord[],
  entry: BrowserSession,
  action: WorkerCleanupAction,
  link: VerifiedWorkerLink,
  nowMs: number,
): WorkerCleanupRecord[] {
  if (
    records.some(
      (record) =>
        record.sessionId === entry.id &&
        (record.phase.endsWith("_pending") || record.phase === "closed"),
    )
  )
    throw new Error("Previous intent must be reconciled before another action.");
  const existing = records.find((record) => record.sessionId === entry.id);
  if ((action === "close") !== (existing?.phase === "archived"))
    throw new Error("Close requires a completed archive; archive requires no prior archive.");
  if (
    !entry.parentSessionId ||
    entry.parentSessionId !== link.parentSessionId ||
    !entry.completion ||
    !canonicalConversation(entry.completion.observedUrl ?? null) ||
    !Number.isFinite(nowMs)
  )
    throw new Error("Cleanup identity is invalid.");
  const next: WorkerCleanupRecord = {
    sessionId: entry.id,
    parentSessionId: link.parentSessionId,
    spawnRequestId: link.spawnRequestId,
    declaredAt: entry.completion.declaredAt,
    conversationUrl: entry.completion.observedUrl!,
    phase: action === "archive" ? "archive_pending" : "close_pending",
    ...(existing?.archivedAt ? { archivedAt: existing.archivedAt } : {}),
    updatedAtMs: nowMs,
  };
  return [...records.filter((record) => record.sessionId !== entry.id), next];
}

/**
 * Called after restart AND after a command receipt. Only observed, durable
 * results advance intents. Absence of an acknowledgment never triggers retry.
 * guestReleasedIds must come from the preview owner, not an inferred hidden flag.
 */
export function reconcileWorkerCleanupLedger(
  records: readonly WorkerCleanupRecord[],
  sessions: readonly BrowserSession[],
  guestReleasedIds: ReadonlySet<string>,
  nowMs: number,
): WorkerCleanupRecord[] {
  const byId = new Map(sessions.map((entry) => [entry.id, entry]));
  return records.map((record) => {
    const entry = byId.get(record.sessionId);
    if (!guestReleasedIds.has(record.sessionId)) return record;
    if (
      record.phase === "archive_pending" &&
      entry?.hidden === true &&
      entry.archive?.basis === "completion" &&
      !entry.archive.restoredAt &&
      canonicalConversation(entry.archive.conversationUrl) &&
      entry.archive.conversationUrl === record.conversationUrl &&
      entry.completion?.declaredAt === record.declaredAt &&
      entry.parentSessionId === record.parentSessionId &&
      parsedMs(entry.archive.archivedAt) !== null &&
      (parsedMs(entry.archive.archivedAt) ?? -Infinity) >= (parsedMs(record.declaredAt) ?? Infinity)
    ) {
      return {
        ...record,
        phase: "archived" as const,
        archivedAt: entry.archive.archivedAt,
        updatedAtMs: nowMs,
      };
    }
    if (record.phase === "close_pending" && !entry && record.archivedAt) {
      return { ...record, phase: "closed" as const, updatedAtMs: nowMs };
    }
    return record;
  });
}
