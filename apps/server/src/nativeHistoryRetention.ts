import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { threadHasQueuedTurnStart } from "./orchestration-v2/ThreadSettlementService.ts";

export const NATIVE_HISTORY_RETENTION_DAYS = 180;
const DAY_MS = 86_400_000;

type Exclusion = "recent" | "active" | "pending" | "pinned" | "referenced" | "unverifiedClientState";
const EXCLUSIONS: readonly Exclusion[] = [
  "recent", "active", "pending", "pinned", "referenced", "unverifiedClientState",
];

export interface NativeHistoryRetentionDryRun {
  readonly mode: "dry-run";
  readonly retentionDays: number;
  readonly scannedThreads: number;
  /** Age-qualified, internally unblocked threads; NOT authorized for deletion. */
  readonly provisionalCandidates: number;
  readonly pruneEligible: 0;
  /** Projection shells contain no attributable SQLite bytes; unknown is not zero. */
  readonly estimatedReclaimBytes: null;
  readonly exclusions: Readonly<Record<Exclusion, number>>;
  readonly samples: ReadonlyArray<{
    readonly threadId: string;
    readonly exclusion: Exclusion;
    readonly ageDays: number;
  }>;
}

function meaningfulActivityAt(thread: OrchestrationV2ThreadShell): number {
  // updatedAt/archivedAt/lastVisitedAt are metadata, not conversation activity.
  return Math.max(
    ...[
      thread.createdAt,
      thread.latestUserMessageAt,
      thread.latestUserAuthoredMessageAt,
      thread.latestRunRequestedAt,
      thread.latestRunStartedAt,
      thread.latestRunCompletedAt,
    ].flatMap((value) => (value == null ? [] : [DateTime.toEpochMillis(value)])),
  );
}

/**
 * Inventory only. Native drafts live in client-local storage and references or
 * UNKNOWN sends can exist outside projection shells. No shell alone can prove
 * deletion safety, so every otherwise-qualified thread remains provisional.
 *
 * Both active and archived snapshots are necessary to detect lineage references.
 * This function performs no database writes, provider operations, or compaction.
 */
export function previewNativeHistoryRetention(
  active: ReadonlyArray<OrchestrationV2ThreadShell>,
  archived: ReadonlyArray<OrchestrationV2ThreadShell>,
  now: number,
  retentionDays = NATIVE_HISTORY_RETENTION_DAYS,
): NativeHistoryRetentionDryRun {
  if (!Number.isFinite(now) || !Number.isFinite(retentionDays) || retentionDays < 1) {
    throw new Error("Invalid native-history preview clock or retention period");
  }
  const threads = new Map<string, { shell: OrchestrationV2ThreadShell; archive: boolean }>();
  for (const shell of archived) threads.set(shell.id, { shell, archive: true });
  // Fail closed on inconsistent locations: an active shell takes precedence.
  for (const shell of active) threads.set(shell.id, { shell, archive: false });

  const referenced = new Set<string>();
  for (const { shell } of threads.values()) {
    if (shell.lineage.parentThreadId) referenced.add(shell.lineage.parentThreadId);
    if (shell.lineage.rootThreadId !== shell.id) referenced.add(shell.lineage.rootThreadId);
    if (shell.forkedFrom?.type === "run") referenced.add(shell.forkedFrom.threadId);
  }

  const exclusions = Object.fromEntries(EXCLUSIONS.map((reason) => [reason, 0])) as Record<
    Exclusion,
    number
  >;
  const samples: Array<{ threadId: string; exclusion: Exclusion; ageDays: number }> = [];
  let provisionalCandidates = 0;
  for (const { shell, archive } of threads.values()) {
    const ageDays = Math.max(0, Math.floor((now - meaningfulActivityAt(shell)) / DAY_MS));
    // A settled native thread can be dormant without being in the Archive view.
    // An inconsistent active/archive snapshot stays excluded.
    const dormant = archive
      ? shell.archivedAt !== null
      : shell.archivedAt === null &&
        (shell.settledAt !== null || shell.settledOverride === "settled");
    let exclusion: Exclusion;
    if (meaningfulActivityAt(shell) >= now - retentionDays * DAY_MS) {
      exclusion = "recent";
    } else if (
      !dormant ||
      shell.deletedAt !== null ||
      shell.settledOverride === "active" ||
      shell.autoSettleDisabledAt != null ||
      shell.snoozedUntil != null ||
      shell.worktreePath !== null
    ) {
      exclusion = "active";
    } else if (
      shell.activeRunId !== null ||
      !["idle", "completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
        shell.status,
      ) ||
      (shell.pendingBackgroundTasks?.length ?? 0) > 0 ||
      shell.pendingRuntimeRequest !== null ||
      shell.hasActionableProposedPlan ||
      shell.titleRegeneration != null ||
      threadHasQueuedTurnStart(shell, now) ||
      (shell.latestRunRequestedAt != null &&
        (shell.latestRunCompletedAt == null ||
          DateTime.toEpochMillis(shell.latestRunRequestedAt) >
            DateTime.toEpochMillis(shell.latestRunCompletedAt)))
    ) {
      exclusion = "pending";
    } else if (shell.pinnedAt != null || shell.pinOrderKey != null) {
      exclusion = "pinned";
    } else if (
      referenced.has(shell.id) ||
      shell.lineage.parentThreadId !== null ||
      shell.lineage.rootThreadId !== shell.id ||
      shell.forkedFrom !== null ||
      shell.linkedPullRequest != null ||
      shell.branchPullRequest != null ||
      (shell.pullRequests?.length ?? 0) > 0
    ) {
      exclusion = "referenced";
    } else {
      exclusion = "unverifiedClientState";
      provisionalCandidates++;
    }
    exclusions[exclusion]++;
    if (exclusion !== "recent" && samples.length < 30) {
      samples.push({ threadId: shell.id, exclusion, ageDays });
    }
  }

  return {
    mode: "dry-run",
    retentionDays,
    scannedThreads: threads.size,
    provisionalCandidates,
    pruneEligible: 0,
    estimatedReclaimBytes: null,
    exclusions,
    samples,
  };
}
