import type { AgentProviderV1Operation, AgentProviderV1SessionRef } from "@t3tools/contracts";
import { agentProviderEpoch } from "./agentProviderBridge.ts";

/**
 * Browser handoff does not have a durable send ledger. Keep a per-process
 * no-replay fence, even after an ambiguous timeout. After server restart a
 * browser operation is UNKNOWN; this is not browser-side idempotency.
 */
const browserOperations = new Map<string, AgentProviderV1Operation>();
const browserKeys = new Map<string, { operationId: string; fingerprint: string }>();
let browserOperationCounter = 0;
const MAX_BROWSER_ATTEMPTS = 20_000;

export function browserOperationKey(
  environmentId: string,
  browserSessionId: string,
  clientRequestId: string,
): string {
  return JSON.stringify([environmentId, browserSessionId, clientRequestId]);
}

export function beginBrowserSubmission(input: {
  environmentId: string;
  session: AgentProviderV1SessionRef;
  clientRequestId: string;
  expectedConversation: string;
  text: string;
  observedAt: string;
}):
  | { kind: "new" | "duplicate"; operation: AgentProviderV1Operation }
  | { kind: "conflict" | "capacity" } {
  const key = browserOperationKey(input.environmentId, input.session.id, input.clientRequestId);
  const fingerprint = JSON.stringify([input.expectedConversation, input.text]);
  const existing = browserKeys.get(key);
  if (existing) {
    if (existing.fingerprint !== fingerprint) return { kind: "conflict" };
    const prior = browserOperations.get(existing.operationId)!;
    return prior.receiptBasis?.startsWith("browser_enqueue_unconfirmed;")
      ? { kind: "new", operation: prior }
      : { kind: "duplicate", operation: prior };
  }
  // Never evict a tombstone while this process can still receive retries.
  if (browserKeys.size >= MAX_BROWSER_ATTEMPTS) return { kind: "capacity" };
  const operation: AgentProviderV1Operation = {
    operationId: `browser:${agentProviderEpoch}:${++browserOperationCounter}`,
    clientRequestId: input.clientRequestId,
    state: "Unknown",
    session: input.session,
    observedAt: input.observedAt,
    receiptBasis: "browser_submit_reserved;outcome_not_yet_observed;never_auto_replay",
  };
  browserKeys.set(key, { operationId: operation.operationId, fingerprint });
  browserOperations.set(operation.operationId, operation);
  return { kind: "new", operation };
}

export function recordBrowserSubmission(
  operationId: string,
  state: "Delivered" | "Unknown" | "Queued",
  observedAt: string,
  receiptBasis: string,
): AgentProviderV1Operation {
  const previous = browserOperations.get(operationId)!;
  const operation: AgentProviderV1Operation = {
    ...previous,
    state,
    ...(state === "Delivered" ? { confirmedStage: "Delivered" as const } : {}),
    observedAt,
    receiptBasis,
  };
  browserOperations.set(operationId, operation);
  return operation;
}

export function readBrowserSubmission(input: {
  operationId: string;
  session: AgentProviderV1SessionRef;
  clientRequestId: string;
  observedAt: string;
}): AgentProviderV1Operation | null {
  const existing = browserOperations.get(input.operationId);
  if (existing) {
    if (
      existing.session.provider !== input.session.provider ||
      existing.session.id !== input.session.id ||
      existing.clientRequestId !== input.clientRequestId
    )
      return null;
    return existing;
  }
  // A prior server/renderer may have sent the message. A missing volatile
  // receipt is not evidence of failure, nor permission to replay.
  if (!input.operationId.startsWith("browser:")) return null;
  return {
    operationId: input.operationId,
    session: input.session,
    clientRequestId: input.clientRequestId,
    state: "Unknown",
    observedAt: input.observedAt,
    receiptBasis: "browser_receipt_not_durable;manual_reconcile;never_auto_replay",
  };
}

/** Native cursors are event-store watermarks, not browser DOM cursors. */
export function nativeUpdateCursor(environmentId: string, sequence: number): string {
  return `native-v1:${encodeURIComponent(environmentId)}:${sequence}`;
}

export function parseNativeUpdateCursor(environmentId: string, cursor: string): number | null {
  const prefix = `native-v1:${encodeURIComponent(environmentId)}:`;
  if (!cursor.startsWith(prefix)) return null;
  const suffix = cursor.slice(prefix.length);
  if (!/^(0|[1-9][0-9]*)$/.test(suffix)) return null;
  const sequence = Number(suffix);
  return Number.isSafeInteger(sequence) ? sequence : null;
}
