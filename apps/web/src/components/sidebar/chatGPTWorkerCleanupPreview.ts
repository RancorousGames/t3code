import type { BrowserSession } from "../../chatGPTBrowserSessions";
import { chatGPTParentIndex } from "../../chatGPTSessionLineage";
import type { WorkerSpawnReceipt } from "../../chatGPTWorkerCleanupPolicy";

export interface WorkerCleanupPreviewRow {
  sessionId: string;
  title: string;
  parentSessionId: string;
  hasManagedSpawnReceipt: boolean;
  /** This is informational, not an eligibility decision or a Done receipt. */
  blockReason: string;
}

/**
 * The current spawn receipt records the child but NOT its claimed parent.
 * Even a matching receipt cannot authenticate worker lineage, so the UI must
 * never construct VerifiedWorkerLink or WorkerDoneReceipt from this data.
 */
export function previewUnverifiedWorkerCleanup(
  sessions: readonly BrowserSession[],
  spawnReceipts: readonly WorkerSpawnReceipt[],
  verifiedWorkerIds: ReadonlySet<string>,
): readonly WorkerCleanupPreviewRow[] {
  const parents = chatGPTParentIndex(sessions);
  const receipts = new Map(spawnReceipts.map((receipt) => [receipt.sessionId, receipt.requestId]));

  return sessions.flatMap((session) => {
    const parentSessionId = parents.get(session.id);
    // Show only already classified worker rows, not managers or manually
    // linked sessions. This is a diagnostic list, never an action queue.
    if (!parentSessionId || !verifiedWorkerIds.has(session.id)) return [];
    const hasManagedSpawnReceipt = receipts.get(session.id) === session.spawnRequestId;
    return [
      {
        sessionId: session.id,
        title: session.title,
        parentSessionId,
        hasManagedSpawnReceipt,
        blockReason: hasManagedSpawnReceipt
          ? "Not eligible: spawn receipt lacks verified parent ownership and completion."
          : "Not eligible: durable spawn correlation exists, but no separate cleanup receipt.",
      },
    ];
  });
}
