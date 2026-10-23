// @effect-diagnostics globalTimers:off -- Local synthetic observation deadlines, never ledger writes.
/**
 * W2-A SOURCE-ONLY / NEGATIVE-ONLY.
 * A bounded server-side decoder for a FUTURE Windows MAIN fd9 -> fd8
 * inherited anonymous-pipe challenge. No IO, no enrollment and no provider
 * admission is started by this file. No production caller instantiates it.
 * A challenge ACK proves only the synthetic channel protocol, not Win32
 * HANDLE/process or MAIN-host authenticity.
 */
/** Pinned W2-A negative control-only frame limit: bytes BEFORE JSON.parse, no CRLF. */
export const INACTIVE_CONTROL_FRAME_MAX_BYTES = 4096;
/** Pinned read-only timeout, never used around SQLite/effects. */
export const INACTIVE_READ_DEADLINE_MS = 5000;
/** No positive lease produced by this helper; expiry is immutable for an incarnation. */
export const INACTIVE_MAX_INCARNATION_LIFETIME_MS = 300000;
const MAX_FRAME_BYTES = INACTIVE_CONTROL_FRAME_MAX_BYTES;
const MAX_CHALLENGE_MS = INACTIVE_READ_DEADLINE_MS;
const MAX_PENDING_READS = 8; // local negative read concurrency, NOT writer admission

/** Future MAIN may compute a stable negative-only deadline at actual birth.
 * Never slides on read, never used to assert a positive enrolled lease.
 */
export function inactiveFixedIncarnationExpiry(
  birthEpochMs: number,
  earlierCutoffEpochMs?: number,
): number | null {
  if (
    !Number.isSafeInteger(birthEpochMs) ||
    birthEpochMs < 0 ||
    (earlierCutoffEpochMs !== undefined &&
      (!Number.isSafeInteger(earlierCutoffEpochMs) || earlierCutoffEpochMs <= birthEpochMs))
  )
    return null;
  const upper = birthEpochMs + INACTIVE_MAX_INCARNATION_LIFETIME_MS;
  if (!Number.isSafeInteger(upper)) return null;
  return Math.min(upper, earlierCutoffEpochMs ?? upper);
}
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const SAFE_ID = /^[a-zA-Z0-9_:-]{1,128}$/;

export type PrivateFrameFailure =
  | "closed"
  | "oversize"
  | "malformed"
  | "identity_mismatch"
  | "duplicate_challenge"
  | "deadline"
  | "exhausted"
  | "aborted";

export type PrivateReply =
  | {
      readonly type: "challenge_ack";
      readonly version: 1;
      readonly mainRunId: string;
      readonly serverGenerationId: string;
      readonly serverChannelIncarnationId: string;
      readonly challengeId: string;
      readonly nonce: string;
    }
  | {
      readonly type: "unavailable";
      readonly version: 1;
      readonly requestId: string;
      readonly operationId: string;
      readonly reason: "source_not_enrolled";
    }
  | {
      readonly type: "cancel_ack";
      readonly version: 1;
      readonly requestId: string;
      readonly targetRequestId: string;
      readonly operationId: string;
      /** W2-A never starts source reads. This is NOT a cancellation receipt. */
      readonly status: "not_pending";
    };

export interface InactivePrivateServerChannelOptions {
  /** Trusted test/producer injection ONLY. Never derived from an agent body. */
  readonly mainRunId: string;
  readonly serverGenerationId: string;
  readonly serverChannelIncarnationId: string;
  readonly openedAtMs: number;
  readonly now: () => number;
  /** Only a future MAIN-owned transport may send this output on fd8. */
  readonly output: (frame: PrivateReply) => void;
  readonly onRevoke?: (reason: PrivateFrameFailure) => void;
}

export interface InactivePrivateServerChannel {
  readonly ingest: (bytes: Uint8Array) => void;
  readonly close: () => void;
  readonly expire: () => void;
  readonly revoked: boolean;
  readonly challengeAcknowledged: boolean;
  readonly failure: PrivateFrameFailure | null;
}
const keysEqual = (value: Record<string, unknown>, fields: readonly string[]): boolean =>
  Object.keys(value).length === fields.length &&
  fields.every((field) => Object.hasOwn(value, field));

export function makeInactivePrivateServerChannel(
  options: InactivePrivateServerChannelOptions,
): InactivePrivateServerChannel {
  if (
    ![options.mainRunId, options.serverGenerationId, options.serverChannelIncarnationId].every(
      (id) => SAFE_ID.test(id),
    ) ||
    !Number.isSafeInteger(options.openedAtMs)
  ) {
    throw new Error("Invalid trusted private-channel identity.");
  }
  let buffer = Buffer.alloc(0);
  let closed = false;
  let acknowledged = false;
  let failure: PrivateFrameFailure | null = null;
  const seenReadIds = new Map<string, string>();
  const seenCancelIds = new Set<string>();
  let acceptedControls = 0;
  const revoke = (reason: PrivateFrameFailure): void => {
    if (closed) return;
    closed = true;
    failure = reason;
    buffer = Buffer.alloc(0);
    options.onRevoke?.(reason);
  };
  const expire = (): void => {
    if (!closed && !acknowledged && options.now() - options.openedAtMs >= MAX_CHALLENGE_MS)
      revoke("deadline");
  };
  const accept = (bytes: Uint8Array): void => {
    if (closed) return;
    expire();
    if (closed) return;
    if (
      bytes.byteLength > MAX_FRAME_BYTES ||
      buffer.byteLength + bytes.byteLength > MAX_FRAME_BYTES
    ) {
      revoke("oversize");
      return;
    }
    buffer = Buffer.concat([buffer, Buffer.from(bytes)]);
    // This decoder handles at most one accepted protocol challenge and
    // fail-closed unavailable read requests. Never dispatches provider work.
    for (;;) {
      const index = buffer.indexOf(10);
      if (index < 0 || closed) break;
      const line = buffer.subarray(0, index);
      buffer = buffer.subarray(index + 1);
      if (line.byteLength < 2 || line.byteLength > MAX_FRAME_BYTES || line.includes(13)) {
        revoke("malformed");
        break;
      }
      let raw: unknown;
      let inputText: string;
      try {
        inputText = new TextDecoder("utf-8", { fatal: true }).decode(line);
        raw = JSON.parse(inputText);
      } catch {
        revoke("malformed");
        break;
      }
      // Pinned canonical compact JSON-only control framing. Reject duplicates,
      // whitespace aliases and noncanonical escapes instead of silently normalizing.
      if (JSON.stringify(raw) !== inputText) {
        revoke("malformed");
        break;
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        revoke("malformed");
        break;
      }
      const v = raw as Record<string, unknown>;
      const identities =
        v.mainRunId === options.mainRunId &&
        v.serverGenerationId === options.serverGenerationId &&
        v.serverChannelIncarnationId === options.serverChannelIncarnationId;
      if (!identities) {
        revoke("identity_mismatch");
        break;
      }
      if (v.type === "challenge") {
        if (acknowledged) {
          revoke("duplicate_challenge");
          break;
        }
        if (
          !keysEqual(v, [
            "type",
            "version",
            "mainRunId",
            "serverGenerationId",
            "serverChannelIncarnationId",
            "challengeId",
            "nonce",
          ]) ||
          v.version !== 1 ||
          typeof v.challengeId !== "string" ||
          !SAFE_ID.test(v.challengeId) ||
          typeof v.nonce !== "string" ||
          !NONCE.test(v.nonce)
        ) {
          revoke("malformed");
          break;
        }
        acknowledged = true;
        try {
          options.output({
            type: "challenge_ack",
            version: 1,
            mainRunId: options.mainRunId,
            serverGenerationId: options.serverGenerationId,
            serverChannelIncarnationId: options.serverChannelIncarnationId,
            challengeId: v.challengeId,
            nonce: v.nonce,
          });
        } catch {
          revoke("closed");
        }
        continue;
      }
      // 512 is a conservative W2-A control-channel bound, not a simulation
      // of OpenRig's separate 512 ACCEPTED provider-frame replay quota.
      if (acceptedControls >= 512) {
        revoke("exhausted");
        break;
      }
      if (v.type === "read_only") {
        if (
          !acknowledged ||
          !keysEqual(v, [
            "type",
            "version",
            "mainRunId",
            "serverGenerationId",
            "serverChannelIncarnationId",
            "requestId",
            "operationId",
          ]) ||
          v.version !== 1 ||
          typeof v.requestId !== "string" ||
          !SAFE_ID.test(v.requestId) ||
          typeof v.operationId !== "string" ||
          !SAFE_ID.test(v.operationId)
        ) {
          revoke("malformed");
          break;
        }
        if (seenReadIds.has(v.requestId) || seenCancelIds.has(v.requestId)) {
          revoke("duplicate_challenge");
          break; // never replay any channel correlation
        }
        seenReadIds.set(v.requestId, v.operationId);
        acceptedControls++;
        // W4 T3 producer is absent: no source/read/material may be fabricated.
        try {
          options.output({
            type: "unavailable",
            version: 1,
            requestId: v.requestId,
            operationId: v.operationId,
            reason: "source_not_enrolled",
          });
        } catch {
          revoke("closed");
        }
        if (acceptedControls === 512) revoke("exhausted");
        continue;
      }
      if (v.type === "cancel") {
        if (
          !acknowledged ||
          !keysEqual(v, [
            "type",
            "version",
            "mainRunId",
            "serverGenerationId",
            "serverChannelIncarnationId",
            "requestId",
            "targetRequestId",
            "operationId",
          ]) ||
          v.version !== 1 ||
          typeof v.requestId !== "string" ||
          !SAFE_ID.test(v.requestId) ||
          typeof v.targetRequestId !== "string" ||
          !SAFE_ID.test(v.targetRequestId) ||
          typeof v.operationId !== "string" ||
          !SAFE_ID.test(v.operationId) ||
          seenReadIds.has(v.requestId) ||
          seenCancelIds.has(v.requestId) ||
          (seenReadIds.has(v.targetRequestId) &&
            seenReadIds.get(v.targetRequestId) !== v.operationId)
        ) {
          revoke("malformed");
          break;
        }
        seenCancelIds.add(v.requestId);
        acceptedControls++;
        try {
          options.output({
            type: "cancel_ack",
            version: 1,
            requestId: v.requestId,
            targetRequestId: v.targetRequestId,
            operationId: v.operationId,
            status: "not_pending", // W2-A has no active source observer.
          });
        } catch {
          revoke("closed");
        }
        if (acceptedControls === 512) revoke("exhausted");
        continue;
      }
      revoke("malformed");
      break;
    }
  };
  return {
    ingest: accept,
    close: () => revoke("closed"),
    expire,
    get revoked() {
      return closed;
    },
    get challengeAcknowledged() {
      return acknowledged && !closed;
    },
    get failure() {
      return failure;
    },
  };
}

/**
 * Local synthetic observation gate, never the OpenRig ledger/writer.
 * Abort is advisory: late completion is fenced and cannot change the answer.
 * No automatic retry; rejects new work before consuming an ingress slot.
 */
export function makeInactiveBoundedObservationGate(
  maxPending = MAX_PENDING_READS,
  deadlineMs = MAX_CHALLENGE_MS,
) {
  if (
    !Number.isSafeInteger(maxPending) ||
    maxPending < 1 ||
    maxPending > 8 ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 5000
  ) {
    throw new Error("Invalid negative-only observation bounds.");
  }
  let pending = 0;
  let closed = false;
  return {
    get pending() {
      return pending;
    },
    get closed() {
      return closed;
    },
    close() {
      closed = true;
    },
    async read<T>(
      work: (signal: AbortSignal) => Promise<T>,
    ): Promise<
      | { readonly kind: "value"; readonly value: T }
      | { readonly kind: "unavailable"; readonly reason: "busy" | "closed" | "timeout" | "failed" }
    > {
      if (closed) return { kind: "unavailable", reason: "closed" };
      if (pending >= maxPending) return { kind: "unavailable", reason: "busy" };
      pending++;
      const ctrl = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          Promise.resolve()
            .then(() => work(ctrl.signal))
            .then(
              (value) => ({ kind: "value" as const, value }),
              () => ({ kind: "unavailable" as const, reason: "failed" as const }),
            ),
          new Promise<{ kind: "unavailable"; reason: "timeout" }>((resolve) => {
            timer = setTimeout(() => {
              ctrl.abort(); // advisory; late callback cannot overwrite result
              resolve({ kind: "unavailable", reason: "timeout" });
            }, deadlineMs);
          }),
        ]);
        return closed ? { kind: "unavailable", reason: "closed" } : result;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        pending--;
      }
    },
  };
}
