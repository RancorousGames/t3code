import type {
  InactiveDualWindowsProcessWitness,
  WindowsBackendProcessWitnessSnapshot,
} from "../electron/DesktopBackendProcessWitness.ts";

/**
 * INACTIVE W2-B MAIN-only contract: the future owner must inject two actually
 * owned private-pipe capabilities. An opaque pipeIdentity is a locally held
 * capability token, NOT a JSON field, Win32 HANDLE proof or authentication.
 * Production DesktopBackendPool never injects this producer.
 */
export interface InactiveMainOwnedPrivateLeg {
  readonly readOwnedCurrent: () => {
    readonly pipeIdentity: symbol;
    readonly processId: number;
    readonly channelIncarnationId: string;
  } | null;
  /** Read exclusively from the previously owned child private pipe, once. */
  readonly consumeOneUseAckBytes: () => Uint8Array | null;
}
export interface InactiveMainDualLegEvidence {
  /** Deliberately unassignable to any positive OpenRig/Stage B issuer. */
  readonly notEnrolled: true;
  readonly mainRunId: string;
  readonly serverInstanceId: string;
  readonly serverGenerationId: string;
  readonly leaseId: string;
  readonly serverChannelIncarnationId: string;
  readonly hostChannelIncarnationId: string;
  readonly serverHandshakeChallengeId: string;
  readonly hostHandshakeChallengeId: string;
  readonly backend: WindowsBackendProcessWitnessSnapshot;
  readonly host: WindowsBackendProcessWitnessSnapshot;
  readonly leaseBirthEpochMs: number;
  readonly earlierRetirementCutoffEpochMs: number | null;
  readonly leaseExpiresAtEpochMs: number;
  /** MAIN monotonic clock since BOTH independent one-use ACKs and handle checks. */
  readonly leaseElapsedMonotonicMs: number;
}

const INACTIVE_DUAL_LEG_MAX_MS = 300_000;
const INACTIVE_CHALLENGE_ID = /^[A-Za-z0-9_:-]{1,128}$/;
const INACTIVE_NONCE = /^[A-Za-z0-9_-]{32,128}$/;
/** Exact compact UTF-8 and one LF; rejects duplicate/extra/aliased JSON keys. */
function decodeInactiveOwnedAck(
  raw: Uint8Array | null,
  expected: Readonly<Record<string, string | number>>,
  cap: number,
): boolean {
  if (
    !(raw instanceof Uint8Array) ||
    raw.byteLength < 3 ||
    raw.byteLength > cap + 1 ||
    raw[raw.length - 1] !== 10
  )
    return false;
  const payload = raw.subarray(0, -1);
  if (payload.includes(0) || payload.includes(10) || payload.includes(13)) return false;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    const parsed: unknown = JSON.parse(decoded);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      JSON.stringify(parsed) !== decoded
    )
      return false;
    const received = parsed as Record<string, unknown>;
    return (
      Object.keys(received).length === Object.keys(expected).length &&
      Object.entries(expected).every(([key, value]) => received[key] === value)
    );
  } catch {
    return false;
  }
}

/**
 * Unwired, fail-closed, one-incarnation issuer *fixture*. Neither returned
 * evidence nor booleans/nonce prove physical pipe/PROCESS_HANDLE ownership.
 * A separately owned future MAIN runner must wire real physical transport
 * and attest all OS facts BEFORE this ever becomes an enrolled source.
 */
export function createInactiveMainDualLegIssuer(input: {
  readonly processes: InactiveDualWindowsProcessWitness;
  readonly serverLeg: InactiveMainOwnedPrivateLeg;
  readonly hostLeg: InactiveMainOwnedPrivateLeg;
  readonly mainRunId: string;
  readonly serverInstanceId: string;
  readonly serverGenerationId: string;
  readonly leaseId: string;
  readonly serverChannelIncarnationId: string;
  readonly hostChannelIncarnationId: string;
  readonly serverChallengeId: string;
  readonly serverNonce: string;
  readonly hostChallengeId: string;
  readonly hostNonce: string;
  /** MAIN pinned immutable cutoff, known BEFORE dual-handshake birth. */
  readonly earlierRetirementCutoffEpochMs: number | null;
  /** MAIN-owned clock; no substitute Date.now-origin monotonic projection. */
  readonly clock: {
    readonly epochMs: () => number;
    readonly monotonicMs: () => number;
  };
}) {
  // Snapshot MAIN-owned immutable intent at construction. TypeScript readonly
  // alone does not prevent callers from mutating the original object later.
  input = Object.freeze({ ...input });
  let revoked = false;
  let attempted = false;
  let birthEpochMs: number | null = null;
  let birthMonotonicMs: number | null = null;
  let lastEpochMs: number | null = null;
  let lastMonotonicMs: number | null = null;
  let expiresAtEpochMs: number | null = null;
  let pinnedServer: ReturnType<InactiveMainOwnedPrivateLeg["readOwnedCurrent"]> = null;
  let pinnedHost: ReturnType<InactiveMainOwnedPrivateLeg["readOwnedCurrent"]> = null;
  let pinnedProcesses: ReturnType<InactiveDualWindowsProcessWitness["readCurrent"]> = null;
  const invalidate = (reason: string): void => {
    if (revoked) return;
    revoked = true;
    input.processes.revoke(reason);
  };
  const ids = [
    input.mainRunId,
    input.serverInstanceId,
    input.serverGenerationId,
    input.leaseId,
    input.serverChannelIncarnationId,
    input.hostChannelIncarnationId,
    input.serverChallengeId,
    input.hostChallengeId,
  ];
  const configured =
    ids.every((id) => typeof id === "string" && INACTIVE_CHALLENGE_ID.test(id)) &&
    input.serverChannelIncarnationId !== input.hostChannelIncarnationId &&
    input.serverChallengeId !== input.hostChallengeId &&
    INACTIVE_NONCE.test(input.serverNonce) &&
    INACTIVE_NONCE.test(input.hostNonce) &&
    (input.earlierRetirementCutoffEpochMs === null ||
      (Number.isSafeInteger(input.earlierRetirementCutoffEpochMs) &&
        input.earlierRetirementCutoffEpochMs > 0));
  if (!configured) invalidate("invalid-dual-leg-intent");

  const readBoth = () => {
    if (revoked) return null;
    try {
      const processes = input.processes.readCurrent();
      const server = input.serverLeg.readOwnedCurrent();
      const host = input.hostLeg.readOwnedCurrent();
      if (
        !processes ||
        !server ||
        !host ||
        processes.backend.pid === processes.host.pid ||
        processes.backend.launch.entryPath === processes.host.launch.entryPath ||
        processes.backend.launch.entrySha256 === processes.host.launch.entrySha256 ||
        server.processId !== processes.backend.pid ||
        host.processId !== processes.host.pid ||
        server.pipeIdentity === host.pipeIdentity ||
        server.channelIncarnationId !== input.serverChannelIncarnationId ||
        host.channelIncarnationId !== input.hostChannelIncarnationId ||
        (pinnedServer !== null &&
          (server.pipeIdentity !== pinnedServer.pipeIdentity ||
            server.processId !== pinnedServer.processId ||
            server.channelIncarnationId !== pinnedServer.channelIncarnationId)) ||
        (pinnedHost !== null &&
          (host.pipeIdentity !== pinnedHost.pipeIdentity ||
            host.processId !== pinnedHost.processId ||
            host.channelIncarnationId !== pinnedHost.channelIncarnationId)) ||
        (pinnedProcesses !== null &&
          (processes.backend.processCreationFiletimeTicks !==
            pinnedProcesses.backend.processCreationFiletimeTicks ||
            processes.host.processCreationFiletimeTicks !==
              pinnedProcesses.host.processCreationFiletimeTicks ||
            processes.backend.launch.entrySha256 !== pinnedProcesses.backend.launch.entrySha256 ||
            processes.host.launch.entrySha256 !== pinnedProcesses.host.launch.entrySha256 ||
            processes.backend.launch.entryPath !== pinnedProcesses.backend.launch.entryPath ||
            processes.host.launch.entryPath !== pinnedProcesses.host.launch.entryPath ||
            processes.backend.osExecutablePath !== pinnedProcesses.backend.osExecutablePath ||
            processes.host.osExecutablePath !== pinnedProcesses.host.osExecutablePath))
      ) {
        invalidate("owned-dual-leg-lost-or-drifted");
        return null;
      }
      return { processes, server, host };
    } catch {
      invalidate("owned-dual-leg-observation-error");
      return null;
    }
  };
  const readClock = () => {
    try {
      const wall = input.clock.epochMs();
      const monotonic = input.clock.monotonicMs();
      if (
        !Number.isSafeInteger(wall) ||
        wall <= 0 ||
        !Number.isSafeInteger(monotonic) ||
        monotonic < 0 ||
        (lastEpochMs !== null && wall < lastEpochMs) ||
        (lastMonotonicMs !== null && monotonic < lastMonotonicMs)
      ) {
        invalidate("main-clock-regressed-or-invalid");
        return null;
      }
      lastEpochMs = wall;
      lastMonotonicMs = monotonic;
      return { wall, monotonic };
    } catch {
      invalidate("main-clock-unavailable");
      return null;
    }
  };
  const begin = (): boolean => {
    if (attempted || revoked) {
      invalidate("reused-dual-leg-handshake");
      return false;
    }
    attempted = true;
    // First ensure BOTH independently owned handles and pipes are present.
    const initial = readBoth();
    if (!initial) return false;
    const serverExpected = {
      type: "challenge_ack",
      version: 1,
      mainRunId: input.mainRunId,
      serverGenerationId: input.serverGenerationId,
      serverChannelIncarnationId: input.serverChannelIncarnationId,
      challengeId: input.serverChallengeId,
      nonce: input.serverNonce,
    };
    const hostExpected = {
      type: "host_challenge_ack",
      version: 1,
      role: "provider-only",
      mainRunId: input.mainRunId,
      serverInstanceId: input.serverInstanceId,
      serverGenerationId: input.serverGenerationId,
      serverChannelIncarnationId: input.serverChannelIncarnationId,
      hostChannelIncarnationId: input.hostChannelIncarnationId,
      serverHandshakeChallengeId: input.serverChallengeId,
      challengeId: input.hostChallengeId,
      nonce: input.hostNonce,
    };
    // Each callback consumes bytes from a separately retained private child
    // pipe. A fabricated JSON ACK or caller flag must not be used as a proxy.
    let valid = false;
    try {
      const serverAck = input.serverLeg.consumeOneUseAckBytes();
      const hostAck = input.hostLeg.consumeOneUseAckBytes();
      valid =
        decodeInactiveOwnedAck(serverAck, serverExpected, 4096) &&
        decodeInactiveOwnedAck(hostAck, hostExpected, 2048);
    } catch {
      valid = false;
    }
    if (!valid) {
      invalidate("missing-or-mismatched-independent-ack");
      return false;
    }
    // Re-observe process and channel ownership AFTER both ACKs, BEFORE birth.
    const after = readBoth();
    if (
      !after ||
      initial.server.pipeIdentity !== after.server.pipeIdentity ||
      initial.host.pipeIdentity !== after.host.pipeIdentity ||
      initial.processes.backend.processCreationFiletimeTicks !==
        after.processes.backend.processCreationFiletimeTicks ||
      initial.processes.host.processCreationFiletimeTicks !==
        after.processes.host.processCreationFiletimeTicks
    ) {
      invalidate("dual-leg-changed-during-handshake");
      return false;
    }
    const clock = readClock();
    if (!clock) return false;
    const upper = clock.wall + INACTIVE_DUAL_LEG_MAX_MS;
    if (
      !Number.isSafeInteger(upper) ||
      (input.earlierRetirementCutoffEpochMs !== null &&
        input.earlierRetirementCutoffEpochMs <= clock.wall) ||
      after.processes.backend.createdAtEpochMs > clock.wall ||
      after.processes.host.createdAtEpochMs > clock.wall
    ) {
      invalidate("invalid-immutable-dual-leg-birth");
      return false;
    }
    birthEpochMs = clock.wall;
    birthMonotonicMs = clock.monotonic;
    expiresAtEpochMs = Math.min(upper, input.earlierRetirementCutoffEpochMs ?? upper);
    pinnedServer = after.server;
    pinnedHost = after.host;
    pinnedProcesses = after.processes;
    return true;
  };
  const readInactiveEvidence = (): InactiveMainDualLegEvidence | null => {
    if (revoked || birthEpochMs === null || birthMonotonicMs === null || expiresAtEpochMs === null)
      return null;
    const current = readBoth();
    const clock = readClock();
    if (!current || !clock) return null;
    const elapsed = clock.monotonic - birthMonotonicMs;
    if (
      !Number.isSafeInteger(elapsed) ||
      elapsed < 0 ||
      elapsed >= expiresAtEpochMs - birthEpochMs ||
      clock.wall >= expiresAtEpochMs
    ) {
      invalidate("dual-leg-lease-expired-or-regressed");
      return null;
    }
    return Object.freeze({
      notEnrolled: true as const,
      mainRunId: input.mainRunId,
      serverInstanceId: input.serverInstanceId,
      serverGenerationId: input.serverGenerationId,
      leaseId: input.leaseId,
      serverChannelIncarnationId: input.serverChannelIncarnationId,
      hostChannelIncarnationId: input.hostChannelIncarnationId,
      serverHandshakeChallengeId: input.serverChallengeId,
      hostHandshakeChallengeId: input.hostChallengeId,
      backend: current.processes.backend,
      host: current.processes.host,
      leaseBirthEpochMs: birthEpochMs,
      earlierRetirementCutoffEpochMs: input.earlierRetirementCutoffEpochMs,
      leaseExpiresAtEpochMs: expiresAtEpochMs,
      leaseElapsedMonotonicMs: elapsed,
    });
  };
  return Object.freeze({
    begin,
    readInactiveEvidence,
    revoke: invalidate,
    get revoked() {
      return revoked;
    },
  });
}
