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
): readonly WorkerCleanupPreviewRow[] {
  const parents = chatGPTParentIndex(sessions);
  const receipts = new Set(spawnReceipts.map((receipt) => receipt.sessionId));

  return sessions.flatMap((session) => {
    const parentSessionId = parents.get(session.id);
    if (!parentSessionId || session.id === "chatgpt") return [];
    const hasManagedSpawnReceipt = receipts.has(session.id);
    return [
      {
        sessionId: session.id,
        title: session.title,
        parentSessionId,
        hasManagedSpawnReceipt,
        blockReason: hasManagedSpawnReceipt
          ? "Spawn receipt does not attest parent provenance or owner completion."
          : "No managed spawn receipt; parent link alone is not verified ownership.",
      },
    ];
  });
}
