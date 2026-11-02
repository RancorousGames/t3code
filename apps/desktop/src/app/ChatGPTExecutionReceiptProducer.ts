// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off -- Desktop MAIN owns its on-disk receipt outbox.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  OpenRigExecutionReceiptJournal,
  drainOpenRigExecutionReceipts,
  toVerifiedExecutionReceipt,
  type ExecutionReceiptInput,
  type KeyValueStorage,
} from "@t3tools/shared/openRigExecutionReceiptBridge";
import type { DeliveryRecord } from "./ChatGPTDeliveryQueue.ts";

type SafeDelivery = Omit<DeliveryRecord, "body">;

type Binding = { seatId: string; environmentId: string; generation: string };

/** Source states are distinct from external delivery acknowledgment. */
export function chatGPTDeliveryReceipts(record: SafeDelivery, binding: Binding): ExecutionReceiptInput[] {
  const origin = { kind: "chatgpt" as const, environmentId: binding.environmentId,
    browserSessionId: record.sessionId, conversationId: record.conversationId,
    generation: binding.generation };
  const base = { seatId: binding.seatId, origin };
  const events: ExecutionReceiptInput[] = [{ ...base, sourceEventId: record.messageId,
    phase: "accepted-intent", at: new Date(record.createdAt).toISOString() }];
  if (record.lastSubmissionAt !== undefined) events.push({ ...base,
    sourceEventId: `${record.messageId}:send:${record.lastSubmissionAt}`,
    phase: "run-started", at: new Date(record.lastSubmissionAt).toISOString() });
  if (record.status === "uncertain") events.push({ ...base,
    sourceEventId: `${record.messageId}:unknown:${record.updatedAt}`,
    phase: "unknown", at: new Date(record.updatedAt).toISOString() });
  if (record.status === "delivered" && record.observedDeliveryId) events.push({ ...base,
    sourceEventId: `${record.messageId}:observed`, phase: "delivery-observed",
    at: new Date(record.updatedAt).toISOString(), observedDeliveryId: record.observedDeliveryId });
  if (record.status === "cancelled") events.push({ ...base,
    sourceEventId: `${record.messageId}:cancel:${record.updatedAt}`,
    phase: "terminal", at: new Date(record.updatedAt).toISOString() });
  return events;
}

/** Persist receipt evidence atomically before attempting the external POST. */
function receiptStorage(directory: string): KeyValueStorage {
  const file = NodePath.join(directory, "openrig-execution-receipts-v1.json");
  NodeFS.mkdirSync(directory, { recursive: true });
  return {
    getItem: () => NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : null,
    setItem: (_key, value) => {
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        NodeFS.writeFileSync(tmp, value, { encoding: "utf8", flag: "w", flush: true });
        NodeFS.renameSync(tmp, file);
      } finally { if (NodeFS.existsSync(tmp)) NodeFS.unlinkSync(tmp); }
    },
  };
}

export class ChatGPTExecutionReceiptProducer {
  private readonly journal: OpenRigExecutionReceiptJournal;
  private chain: Promise<void> = Promise.resolve();
  constructor(directory: string) {
    this.journal = new OpenRigExecutionReceiptJournal(receiptStorage(directory), "desktop");
  }
  /** Receipt telemetry never holds up the actual ChatGPT message queue. */
  observe(record: SafeDelivery): void {
    this.chain = this.chain.then(() => this.record(record)).catch(error => {
      console.warn("OpenRig execution receipt producer:", error);
    });
  }
  private async record(record: SafeDelivery): Promise<void> {
    // Deferred import avoids a MAIN startup cycle: openRig.ts also reads DesktopAppActivation.
    const bridge = await import("../ipc/methods/openRig.ts");
    const binding = await bridge.resolveOpenRigChatGPTReceiptBinding(record.sessionId, record.conversationId);
    if (!binding) return; // No guessed or stale seat ownership.
    for (const event of chatGPTDeliveryReceipts(record, binding))
      this.journal.append(toVerifiedExecutionReceipt(event, new Set([binding.seatId])));
    await drainOpenRigExecutionReceipts(this.journal, "desktop", receipt =>
      bridge.postOpenRigExecutionReceipt(receipt));
  }
  /** Call on startup to replay only locally pending (never UNKNOWN) evidence. */
  resumePending(): void {
    this.chain = this.chain.then(async () => {
      const bridge = await import("../ipc/methods/openRig.ts");
      for (const receipt of this.journal.unknown()) {
        await this.journal.reconcileUnknown(receipt.receiptId,
          candidate => bridge.lookupOpenRigExecutionReceipt(candidate));
      }
      await drainOpenRigExecutionReceipts(this.journal, "desktop",
        receipt => bridge.postOpenRigExecutionReceipt(receipt));
    }).catch(error => console.warn("OpenRig receipt reconciliation:", error));
  }
}
