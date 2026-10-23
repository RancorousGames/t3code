// Per-instance backend factory. Replaces the legacy singleton
// `DesktopBackendManager` Context.Service: each call to
// `makeBackendInstance(spec)` constructs an isolated backend lifecycle —
// its own state Ref, mutex, restart loop, and active child process. The
// returned `DesktopBackendInstance` exposes start/stop/snapshot/wait
// methods that operate on that single backend.
//
// The pool layer (`DesktopBackendPool.ts`) calls this factory once per
// backend it wants to run. Today that's the Windows primary; follow-up
// commits add a second call for the WSL instance.
//
// Singleton couplings that the legacy service held inline are now
// parameterized via the spec:
//   - configResolve replaces the legacy `DesktopBackendConfiguration.resolve`
//     so each instance can resolve its own start config — the primary wires
//     `configuration.resolvePrimary`, the WSL orchestrator wires a
//     `configuration.resolveWsl({ port, distro })` closure.
//   - onReady / onShutdown drive UI side effects (window auto-open,
//     readiness latch) only for instances that want them — the primary's
//     spec passes the window's handleBackendReady/handleBackendNotReady,
//     other pool instances pass nothing.
//   - log writes go through a per-instance writer that the factory
//     pulls from `DesktopBackendOutputLogFactory.forInstance(spec.id)`,
//     so each instance lands in its own rotating file.

import * as Brand from "effect/Brand";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  DesktopTelemetryControlMessage,
  inactivePrivateAuthorityFdPair,
  type DesktopTelemetryControlMessage as DesktopTelemetryControlMessageValue,
} from "@t3tools/contracts";
import { waitForHttpReady as waitForHttpReadyShared } from "@t3tools/shared/httpReadiness";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import type {
  InactiveWindowsBackendProcessWitnessSeam,
  InactiveDualWindowsProcessWitness,
  RetainedWindowsBackendProcessWitness,
  TrustedWindowsBackendLaunchProvenance,
  WindowsBackendProcessWitnessSnapshot,
} from "../electron/DesktopBackendProcessWitness.ts";

const INITIAL_RESTART_DELAY = Duration.millis(500);
const MAX_RESTART_DELAY = Duration.seconds(10);
// After this many consecutive fatal preflight failures, stop the silent
// restart loop and surface the reason via onPreflightFailed. Transient
// failures may instead provide their own larger retryLimit when they should
// self-heal for a while but must not leave the app connecting forever.
const MAX_PREFLIGHT_FAILURE_ATTEMPTS = 5;
const DEFAULT_BACKEND_READINESS_TIMEOUT = Duration.minutes(1);
const DEFAULT_BACKEND_READINESS_INTERVAL = Duration.millis(100);
const DEFAULT_BACKEND_READINESS_REQUEST_TIMEOUT = Duration.seconds(1);
const DEFAULT_BACKEND_TERMINATE_GRACE = Duration.seconds(2);
const DEFAULT_BACKEND_OUTPUT_DRAIN_TIMEOUT = Duration.seconds(5);
const BACKEND_READINESS_PATH = "/.well-known/t3/environment";
const { logWarning: logBackendProcessWarning } =
  DesktopObservability.makeComponentLogger("desktop-backend-process");

type BackendProcessLayerServices = ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient;

type BackendProcessRunRequirements = BackendProcessLayerServices | Scope.Scope;

export type BackendProcessOutputStream = "stdout" | "stderr";

export interface BackendProcessContext {
  readonly executablePath: string;
  readonly entryPath: string;
  readonly cwd: string;
  readonly httpBaseUrl: URL;
}

export type DesktopBackendBootstrapDelivery = "fd3" | "stdin";

export interface DesktopBackendStartConfig extends BackendProcessContext {
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string | undefined>;
  // When true the spawner merges the desktop process.env on top of `env`;
  // when false `env` is passed verbatim. WSL mode opts out so a leaking
  // T3CODE_HOME can't pin the WSL backend to /mnt/c/...\.t3.
  readonly extendEnv: boolean;
  readonly bootstrap: DesktopBackendBootstrapValue;
  readonly bootstrapDelivery: DesktopBackendBootstrapDelivery;
  readonly httpBaseUrl: URL;
  readonly captureOutput: boolean;
  readonly preflightFailure: Option.Option<PreflightFailure>;
  // Present for a WSL run after the configured/default distro has been
  // resolved to the concrete distro passed to wsl.exe.
  readonly runningDistro?: string;
  // Present only when this run launched from a staged WSL-local runtime.
  // Once HTTP readiness succeeds, the manager uses it to retain this cache
  // plus the newest previous cache and prune older versions.
  readonly wslRuntimeId?: string;
}

// A preflight failure records whether it is fatal. Transient failures (WSL
// cold-starting, wslpath while the VM boots) keep retrying so the backend can
// self-heal; fatal ones (no node, wrong version, missing build tools) are
// surfaced via onPreflightFailed and stop the restart loop after
// MAX_PREFLIGHT_FAILURE_ATTEMPTS.
export interface PreflightFailure {
  readonly reason: string;
  readonly fatal: boolean;
  readonly retryLimit?: number;
}

interface BackendProcessExit {
  readonly code: Option.Option<number>;
  readonly reason: string;
}

const backendProcessContextSchema = {
  executablePath: Schema.String,
  entryPath: Schema.String,
  cwd: Schema.String,
  httpBaseUrl: Schema.URL,
};

export class BackendReadinessTimeoutError extends Schema.TaggedError<BackendReadinessTimeoutError>()(
  "BackendReadinessTimeoutError",
  {
    ...backendProcessContextSchema,
    readinessUrl: Schema.URL,
    timeoutMs: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Timed out after ${this.timeoutMs}ms waiting for desktop backend readiness at ${this.readinessUrl.href}.`;
  }
}

export class BackendProcessBootstrapEncodeError extends Schema.TaggedError<BackendProcessBootstrapEncodeError>()(
  "BackendProcessBootstrapEncodeError",
  {
    ...backendProcessContextSchema,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to encode the desktop backend bootstrap payload for ${this.entryPath}.`;
  }
}

export class BackendProcessSpawnError extends Schema.TaggedError<BackendProcessSpawnError>()(
  "BackendProcessSpawnError",
  {
    ...backendProcessContextSchema,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to spawn desktop backend entry ${this.entryPath} with ${this.executablePath}.`;
  }
}

export class BackendProcessOutputReadError extends Schema.TaggedError<BackendProcessOutputReadError>()(
  "BackendProcessOutputReadError",
  {
    ...backendProcessContextSchema,
    pid: Schema.Number,
    streamName: Schema.Literals(["stdout", "stderr"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read ${this.streamName} from desktop backend process ${this.pid}.`;
  }
}

export class BackendProcessOutputHandlingError extends Schema.TaggedError<BackendProcessOutputHandlingError>()(
  "BackendProcessOutputHandlingError",
  {
    ...backendProcessContextSchema,
    pid: Schema.Number,
    streamName: Schema.Literals(["stdout", "stderr"]),
    chunkByteLength: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to handle ${this.chunkByteLength} bytes from ${this.streamName} of desktop backend process ${this.pid}.`;
  }
}

export type BackendProcessOutputError =
  | BackendProcessOutputReadError
  | BackendProcessOutputHandlingError;

export class BackendProcessExitStatusError extends Schema.TaggedError<BackendProcessExitStatusError>()(
  "BackendProcessExitStatusError",
  {
    ...backendProcessContextSchema,
    pid: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read the exit status of desktop backend process ${this.pid}.`;
  }
}

export const BackendProcessError = Schema.Union([
  BackendProcessBootstrapEncodeError,
  BackendProcessSpawnError,
  BackendProcessExitStatusError,
]);
export type BackendProcessError = typeof BackendProcessError.Type;

interface RunBackendProcessOptions extends DesktopBackendStartConfig {
  readonly desktopTelemetryStream: Stream.Stream<Uint8Array>;
  /** Events for the desktop's browser tabs, written to `desktopBrowserFd`. */
  readonly desktopBrowserStream?: Stream.Stream<Uint8Array>;
  /** W2-A inactive only. Never installed by production; server reads fd9. */
  readonly inactiveMainToServerStream?: Stream.Stream<Uint8Array>;
  /** W2-A inactive synthetic server->MAIN fd8 lines, NOT provider authority. */
  readonly onInactiveServerLine?: (line: string) => Effect.Effect<void>;
  /** W2-A terminal callback for EOF/read/decode failure. No positive host. */
  readonly onInactiveServerChannelClosed?: () => Effect.Effect<void>;
  /** Each line the backend writes to `desktopBrowserControlFd`. */
  readonly onDesktopBrowserCommand?: (line: string) => Effect.Effect<void>;
  readonly onDesktopTelemetryControl?: (
    message: DesktopTelemetryControlMessageValue,
  ) => Effect.Effect<void>;
  readonly readinessTimeout?: Duration.Duration;
  readonly outputDrainTimeout?: Duration.Duration;
  readonly onStarted?: (pid: number) => Effect.Effect<void>;
  readonly onExitObserved?: () => Effect.Effect<void>;
  readonly onReady?: () => Effect.Effect<void>;
  readonly onReadinessFailure?: (error: BackendReadinessTimeoutError) => Effect.Effect<void>;
  readonly onOutput?: (
    streamName: BackendProcessOutputStream,
    chunk: Uint8Array,
  ) => Effect.Effect<void, Error>;
  readonly onOutputFailure?: (error: BackendProcessOutputError) => Effect.Effect<void>;
}

export interface DesktopBackendSnapshot {
  readonly desiredRunning: boolean;
  readonly ready: boolean;
  readonly activePid: Option.Option<number>;
  readonly restartAttempt: number;
  readonly restartScheduled: boolean;
}

// Opaque identifier for one backend process inside the pool. Today only
// PRIMARY_INSTANCE_ID is registered. Follow-up commits add WSL distros
// under ids derived from the distro name (e.g. "wsl:ubuntu"). Eventually
// these map 1:1 with environment ids on the frontend; keeping them
// desktop-local for now avoids leaking the contracts dependency.
export type BackendInstanceId = string & Brand.Brand<"BackendInstanceId">;
export const BackendInstanceId = Brand.nominal<BackendInstanceId>();

export const PRIMARY_INSTANCE_ID: BackendInstanceId = BackendInstanceId(
  PRIMARY_LOCAL_ENVIRONMENT_ID,
);

// One pooled backend instance. Same lifecycle surface as the legacy
// `DesktopBackendManagerShape`; the id and label give the pool registry
// + UI something to route on.
export interface DesktopBackendInstance {
  readonly id: BackendInstanceId;
  readonly label: Effect.Effect<string>;
  readonly start: Effect.Effect<void>;
  readonly stop: (options?: { readonly timeout?: Duration.Duration }) => Effect.Effect<void>;
  readonly currentConfig: Effect.Effect<Option.Option<DesktopBackendStartConfig>>;
  readonly snapshot: Effect.Effect<DesktopBackendSnapshot>;
  /** Diagnostic-only Win32 witness; no enrolled lease, generation or authority. */
  readonly inactiveWindowsWitnessSnapshot?: Effect.Effect<WindowsBackendProcessWitnessSnapshot | null>;
  // Polls desiredRunning + the instance's own ready flag until the
  // backend reports ready, or the timeout elapses. Returns true on
  // ready, false on timeout. Used by the WSL backend swap to drive its
  // rollback path.
  readonly waitForReady: (timeout: Duration.Duration) => Effect.Effect<boolean>;
}

// Spec describing one backend instance to spawn. The configResolve
// effect is awaited each time the instance is (re)started so live
// settings changes are picked up on the next start cycle. onReady and
// onShutdown let the primary instance trigger UI side effects (window
// open, global readiness flag) without coupling the factory to those
// concerns; other instances pass them as undefined.
export interface BackendInstanceSpec {
  readonly id: BackendInstanceId;
  readonly label: Effect.Effect<string>;
  // configResolve can now fail with PlatformError because the
  // bootstrap-token closure inside DesktopBackendConfiguration uses
  // crypto.randomBytes (Effect 4 beta.73 migration).
  readonly configResolve: Effect.Effect<DesktopBackendStartConfig, PlatformError.PlatformError>;
  // Receives the *resolved* httpBaseUrl of the run that just became
  // ready. The window service uses this to decide what URL to load
  // (the WSL backend reports its distro IP, the Windows backend reports
  // 127.0.0.1). Splitting this off from configResolve avoids races
  // between "fired onReady" and "currentConfig already advanced".
  readonly onReady?: (httpBaseUrl: URL) => Effect.Effect<void>;
  readonly onShutdown?: () => Effect.Effect<void>;
  // Fired once when a fatal or bounded preflight failure has exhausted its
  // retries. Returns true when the callback changed configuration and the
  // manager should resolve once more; false stops the failed instance.
  readonly onPreflightFailed?: (failure: PreflightFailure) => Effect.Effect<boolean>;
  /** Optional inactive source-only seam; no production MAIN/pool spec injects it. */
  readonly inactiveWindowsProcessWitness?: InactiveWindowsBackendProcessWitnessSeam;
  /** Explicit inactive private fd8/fd9 opt-in. Production never supplies this. */
  readonly inactivePrivateAuthority?: {
    readonly prepareConfig: (
      original: DesktopBackendStartConfig,
    ) => DesktopBackendStartConfig | null;
    readonly mainToServer: Stream.Stream<Uint8Array>;
    readonly onServerLine: (line: string) => Effect.Effect<void>;
    readonly onRevoked?: () => Effect.Effect<void>;
  };
}

interface ActiveBackendRun {
  readonly id: number;
  readonly scope: Scope.Closeable;
  readonly fiber: Option.Option<Fiber.Fiber<void, never>>;
  readonly pid: Option.Option<number>;
  readonly exitObserved: boolean;
  readonly stopRequested: boolean;
  readonly inactiveWindowsWitness?: RetainedWindowsBackendProcessWitness;
}

interface BackendManagerState {
  readonly desiredRunning: boolean;
  readonly ready: boolean;
  readonly config: Option.Option<DesktopBackendStartConfig>;
  readonly active: Option.Option<ActiveBackendRun>;
  readonly restartAttempt: number;
  // Consecutive bounded/fatal preflight failures, reset on a clean or
  // unbounded-transient preflight. restartAttempt counts all restarts.
  readonly preflightFailureAttempt: number;
  readonly restartFiber: Option.Option<Fiber.Fiber<void, never>>;
  readonly nextRunId: number;
}

const initialState: BackendManagerState = {
  desiredRunning: false,
  ready: false,
  config: Option.none(),
  active: Option.none(),
  restartAttempt: 0,
  preflightFailureAttempt: 0,
  restartFiber: Option.none(),
  nextRunId: 1,
};

const activePid = (active: Option.Option<ActiveBackendRun>): Option.Option<number> =>
  Option.flatMap(active, (run) => run.pid);

const withActiveRun =
  (runId: number, f: (run: ActiveBackendRun) => ActiveBackendRun) =>
  (state: BackendManagerState): BackendManagerState => ({
    ...state,
    active: Option.map(state.active, (run) => (run.id === runId ? f(run) : run)),
  });

const calculateRestartDelay = (attempt: number): Duration.Duration =>
  Duration.min(Duration.times(INITIAL_RESTART_DELAY, 2 ** attempt), MAX_RESTART_DELAY);

const closeRun = (
  run: ActiveBackendRun,
  parentScope: Scope.Scope,
  options?: { readonly timeout?: Duration.Duration },
): Effect.Effect<boolean> => {
  const waitForFiber = Option.match(run.fiber, {
    onNone: () => Effect.void,
    onSome: (fiber) => Fiber.await(fiber).pipe(Effect.asVoid),
  });
  const close = Scope.close(run.scope, Exit.void).pipe(Effect.andThen(waitForFiber));
  const timeout = options?.timeout;

  if (!timeout) {
    return close.pipe(Effect.as(true));
  }

  return Effect.forkIn(close, parentScope).pipe(
    Effect.flatMap((closeFiber) =>
      Fiber.await(closeFiber).pipe(Effect.timeoutOption(timeout), Effect.map(Option.isSome)),
    ),
  );
};

export const waitForHttpReady = (
  options: BackendProcessContext & { readonly timeout: Duration.Duration },
): Effect.Effect<void, BackendReadinessTimeoutError, HttpClient.HttpClient> => {
  const readinessUrl = new URL(BACKEND_READINESS_PATH, options.httpBaseUrl);
  return waitForHttpReadyShared({
    baseUrl: options.httpBaseUrl.href,
    path: BACKEND_READINESS_PATH,
    timeoutMs: Duration.toMillis(options.timeout),
    intervalMs: Duration.toMillis(DEFAULT_BACKEND_READINESS_INTERVAL),
    probeTimeoutMs: Duration.toMillis(DEFAULT_BACKEND_READINESS_REQUEST_TIMEOUT),
    makeError: ({ cause }) =>
      new BackendReadinessTimeoutError({
        executablePath: options.executablePath,
        entryPath: options.entryPath,
        cwd: options.cwd,
        httpBaseUrl: options.httpBaseUrl,
        readinessUrl,
        timeoutMs: Duration.toMillis(options.timeout),
        cause,
      }),
  });
};

function drainBackendOutput(
  context: BackendProcessContext & { readonly pid: number },
  streamName: BackendProcessOutputStream,
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  onOutput: (
    streamName: BackendProcessOutputStream,
    chunk: Uint8Array,
  ) => Effect.Effect<void, Error>,
  onOutputFailure: (error: BackendProcessOutputError) => Effect.Effect<void>,
): Effect.Effect<void> {
  return stream.pipe(
    Stream.mapError(
      (cause) =>
        new BackendProcessOutputReadError({
          ...context,
          streamName,
          cause,
        }),
    ),
    Stream.runForEach((chunk) =>
      onOutput(streamName, chunk).pipe(
        Effect.mapError(
          (cause) =>
            new BackendProcessOutputHandlingError({
              ...context,
              streamName,
              chunkByteLength: chunk.byteLength,
              cause,
            }),
        ),
        Effect.catchTags({ BackendProcessOutputHandlingError: onOutputFailure }),
      ),
    ),
    Effect.catchTags({
      BackendProcessOutputReadError: onOutputFailure,
    }),
  );
}

const encodeBootstrapJson = Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap));
const decodeDesktopTelemetryControlLine = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopTelemetryControlMessage),
);

/**
 * W2-A *negative-only* MAIN-side one-use server challenge/ACK verification.
 * This is NOT an enrolled lease or OpenRig host witness. MAIN will need to
 * bind an independently held W1 child HANDLE and inherited FD channel before
 * ever using a positive bridge; no production caller instantiates this gate.
 */
export function makeInactiveMainChallengeGate(input: {
  readonly mainRunId: string;
  readonly serverGenerationId: string;
  readonly serverChannelIncarnationId: string;
  readonly challengeId: string;
  readonly nonce: string;
  readonly begunAtMs: number;
  readonly now: () => number;
}) {
  if (
    ![
      input.mainRunId,
      input.serverGenerationId,
      input.serverChannelIncarnationId,
      input.challengeId,
    ].every((value) => /^[A-Za-z0-9_:-]{1,128}$/.test(value)) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(input.nonce) ||
    !Number.isSafeInteger(input.begunAtMs)
  )
    throw new Error("Invalid W2-A challenge correlation");
  let state: "pending" | "acknowledged" | "revoked" = "pending";
  const challenge = {
    type: "challenge" as const,
    version: 1 as const,
    mainRunId: input.mainRunId,
    serverGenerationId: input.serverGenerationId,
    serverChannelIncarnationId: input.serverChannelIncarnationId,
    challengeId: input.challengeId,
    nonce: input.nonce,
  };
  const expected = {
    ...challenge,
    type: "challenge_ack" as const,
  };
  const outbound = JSON.stringify(challenge) + "\\n";
  if (Buffer.byteLength(outbound, "utf8") > 4096) throw new Error("Oversized W2-A challenge");
  return {
    challengeLine: outbound,
    get acknowledged() {
      return state === "acknowledged";
    },
    get revoked() {
      return state === "revoked";
    },
    close() {
      state = "revoked";
    },
    acceptAckLine(line: string): boolean {
      if (state !== "pending") {
        state = "revoked";
        return false;
      }
      if (
        input.now() < input.begunAtMs ||
        input.now() - input.begunAtMs >= 5000 ||
        Buffer.byteLength(line, "utf8") > 4096 ||
        line.includes("\\r") ||
        line.includes("\\n")
      ) {
        state = "revoked";
        return false;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        state = "revoked";
        return false;
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        JSON.stringify(parsed) !== line
      ) {
        state = "revoked";
        return false;
      }
      const obj = parsed as Record<string, unknown>;
      const valid =
        Object.keys(obj).length === Object.keys(expected).length &&
        Object.entries(expected).every(([key, value]) => obj[key] === value);
      state = valid ? "acknowledged" : "revoked";
      return valid;
    },
  };
}

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

export const runBackendProcess = Effect.fn("runBackendProcess")(function* (
  options: RunBackendProcessOptions,
): Effect.fn.Return<BackendProcessExit, BackendProcessError, BackendProcessRunRequirements> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const claimedPrivateFds =
    options.bootstrap.desktopPrivateAuthorityOutputFd !== undefined ||
    options.bootstrap.desktopPrivateAuthorityInputFd !== undefined;
  const privatePair = inactivePrivateAuthorityFdPair(options.bootstrap);
  if (
    claimedPrivateFds &&
    (options.bootstrapDelivery !== "fd3" ||
      options.runningDistro !== undefined ||
      privatePair === null ||
      options.inactiveMainToServerStream === undefined ||
      options.onInactiveServerLine === undefined)
  ) {
    return yield* new BackendProcessBootstrapEncodeError({
      executablePath: options.executablePath,
      entryPath: options.entryPath,
      cwd: options.cwd,
      httpBaseUrl: options.httpBaseUrl,
      cause: "Invalid W2-A private fd8/9 opt-in; child was not spawned.",
    });
  }
  const bootstrapJson = yield* encodeBootstrapJson(options.bootstrap).pipe(
    Effect.mapError(
      (cause) =>
        new BackendProcessBootstrapEncodeError({
          executablePath: options.executablePath,
          entryPath: options.entryPath,
          cwd: options.cwd,
          httpBaseUrl: options.httpBaseUrl,
          cause,
        }),
    ),
  );
  const onOutput = options.onOutput ?? (() => Effect.void);
  const bootstrapStream = Stream.encodeText(Stream.make(`${bootstrapJson}\n`));
  const additionalFds: Record<`fd${number}`, ChildProcess.AdditionalFdConfig> = {};
  if (options.bootstrapDelivery === "fd3") {
    additionalFds.fd3 = {
      type: "input",
      stream: bootstrapStream,
    };
    if (options.bootstrap.desktopTelemetryFd !== undefined) {
      additionalFds[`fd${options.bootstrap.desktopTelemetryFd}`] = {
        type: "input",
        stream: options.desktopTelemetryStream,
      };
    }
    if (options.bootstrap.desktopTelemetryControlFd !== undefined) {
      additionalFds[`fd${options.bootstrap.desktopTelemetryControlFd}`] = {
        type: "output",
      };
    }
    if (
      options.bootstrap.desktopBrowserFd !== undefined &&
      options.desktopBrowserStream !== undefined
    ) {
      additionalFds[`fd${options.bootstrap.desktopBrowserFd}`] = {
        type: "input",
        stream: options.desktopBrowserStream,
      };
    }
    if (options.bootstrap.desktopBrowserControlFd !== undefined) {
      additionalFds[`fd${options.bootstrap.desktopBrowserControlFd}`] = { type: "output" };
    }
    // privatePair is validated before any child is spawned.
    if (privatePair && options.inactiveMainToServerStream && options.onInactiveServerLine) {
      // W2-A: injected synthetic pipe ONLY; no production source/host binding.
      additionalFds.fd8 = { type: "output" };
      additionalFds.fd9 = { type: "input", stream: options.inactiveMainToServerStream };
    }
  }
  const command = ChildProcess.make(options.executablePath, options.args, {
    cwd: options.cwd,
    env: options.env,
    extendEnv: options.extendEnv,
    // In Electron main, process.execPath points to the Electron binary.
    // Run the child in Node mode so this backend process does not become a GUI app instance.
    stdin: options.bootstrapDelivery === "stdin" ? bootstrapStream : "ignore",
    stdout: options.captureOutput ? "pipe" : "inherit",
    stderr: options.captureOutput ? "pipe" : "inherit",
    killSignal: "SIGTERM",
    forceKillAfter: DEFAULT_BACKEND_TERMINATE_GRACE,
    // wsl.exe drops additional file descriptors when forwarding to the Linux
    // side, so the WSL spawn path delivers the bootstrap envelope via stdin
    // (`--bootstrap-fd 0`) instead.
    ...(options.bootstrapDelivery === "fd3" ? { additionalFds } : {}),
  });

  const handle = yield* spawner.spawn(command).pipe(
    Effect.mapError(
      (cause) =>
        new BackendProcessSpawnError({
          executablePath: options.executablePath,
          entryPath: options.entryPath,
          cwd: options.cwd,
          httpBaseUrl: options.httpBaseUrl,
          cause,
        }),
    ),
  );
  const outputFibers: Array<Fiber.Fiber<void, never>> = [];

  yield* options.onStarted?.(handle.pid) ?? Effect.void;
  if (
    options.bootstrap.desktopTelemetryControlFd !== undefined &&
    options.onDesktopTelemetryControl !== undefined
  ) {
    const controlFd = options.bootstrap.desktopTelemetryControlFd;
    const handleControl = options.onDesktopTelemetryControl;
    yield* handle.getOutputFd(controlFd).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.trim().length > 0),
      Stream.runForEach((line) =>
        decodeDesktopTelemetryControlLine(line).pipe(
          Effect.flatMap(handleControl),
          Effect.catchCause((cause) =>
            logBackendProcessWarning("ignored invalid desktop telemetry control message", {
              fd: controlFd,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        logBackendProcessWarning("desktop telemetry control stream stopped", {
          fd: controlFd,
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.ensuring(
        handleControl({
          version: 1,
          type: "setDiagnosticsDemand",
          enabled: false,
        }),
      ),
      Effect.forkScoped,
    );
  }
  if (
    options.bootstrap.desktopBrowserControlFd !== undefined &&
    options.onDesktopBrowserCommand !== undefined
  ) {
    const browserFd = options.bootstrap.desktopBrowserControlFd;
    const handleCommand = options.onDesktopBrowserCommand;
    yield* handle.getOutputFd(browserFd).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.length > 0),
      Stream.runForEach(handleCommand),
      Effect.catchCause((cause) =>
        logBackendProcessWarning("desktop browser command stream stopped", {
          fd: browserFd,
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.forkScoped,
    );
  }
  if (privatePair && options.inactiveMainToServerStream && options.onInactiveServerLine) {
    const onLine = options.onInactiveServerLine;
    let partial = Buffer.alloc(0);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    // Byte-guard BEFORE UTF8/JSON; no unbounded Stream.splitLines buffering.
    // LF only; CRLF intentionally invalid. This is control-only, NOT an
    // OpenRig compact provider response or source/material observation cap.
    yield* handle.getOutputFd(privatePair.outputFd).pipe(
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          if (chunk.byteLength > 4096 || partial.byteLength + chunk.byteLength > 4096)
            return yield* Effect.die("W2-A FD8 input exceeds bounded cap");
          partial = Buffer.concat([partial, Buffer.from(chunk)]);
          let end: number;
          while ((end = partial.indexOf(10)) !== -1) {
            const raw = partial.subarray(0, end);
            partial = partial.subarray(end + 1);
            if (raw.byteLength === 0 || raw.includes(13))
              return yield* Effect.die("W2-A FD8 empty/CR frame");
            const line = decoder.decode(raw);
            yield* onLine(line);
          }
        }),
      ),
      Effect.ignoreCause, // a broken synthetic channel never authorizes.
      Effect.ensuring(options.onInactiveServerChannelClosed?.() ?? Effect.void),
      Effect.forkScoped,
    );
  }
  if (options.captureOutput) {
    const outputContext = {
      executablePath: options.executablePath,
      entryPath: options.entryPath,
      cwd: options.cwd,
      httpBaseUrl: options.httpBaseUrl,
      pid: Number(handle.pid),
    };
    const onOutputFailure = options.onOutputFailure ?? (() => Effect.void);
    outputFibers.push(
      yield* drainBackendOutput(
        outputContext,
        "stdout",
        handle.stdout,
        onOutput,
        onOutputFailure,
      ).pipe(Effect.forkScoped),
      yield* drainBackendOutput(
        outputContext,
        "stderr",
        handle.stderr,
        onOutput,
        onOutputFailure,
      ).pipe(Effect.forkScoped),
    );
  }
  // Probe readiness in a loop while the backend process is still alive
  // instead of giving up after the first budget. A slow cold boot (the
  // WSL bundle loading across /mnt/c, or a first launch right after an
  // update) can exceed the initial readiness budget while the backend is
  // about to come up moments later; a one-shot probe left the app stuck
  // on "Connecting to WSL…" forever even though the backend kept running
  // and became healthy. Each round gets a fresh budget, and the forked
  // loop is torn down with the run scope once the child exits.
  const probeReadiness = Effect.fn("desktop.backendProcess.probeReadiness")(() =>
    waitForHttpReady({
      executablePath: options.executablePath,
      entryPath: options.entryPath,
      cwd: options.cwd,
      httpBaseUrl: options.httpBaseUrl,
      timeout: options.readinessTimeout ?? DEFAULT_BACKEND_READINESS_TIMEOUT,
    }).pipe(
      Effect.flatMap(() => options.onReady?.() ?? Effect.void),
      Effect.as(true),
      Effect.catchTags({
        BackendReadinessTimeoutError: (error) =>
          (options.onReadinessFailure?.(error) ?? Effect.void).pipe(Effect.as(false)),
      }),
    ),
  );

  yield* probeReadiness().pipe(Effect.repeat({ while: (ready) => !ready }), Effect.forkScoped);

  const exit = yield* handle.exitCode.pipe(
    Effect.mapError(
      (cause) =>
        new BackendProcessExitStatusError({
          executablePath: options.executablePath,
          entryPath: options.entryPath,
          cwd: options.cwd,
          httpBaseUrl: options.httpBaseUrl,
          pid: Number(handle.pid),
          cause,
        }),
    ),
    Effect.exit,
  );
  yield* options.onExitObserved?.() ?? Effect.void;
  yield* Effect.forEach(outputFibers, Fiber.await, {
    concurrency: "unbounded",
    discard: true,
  }).pipe(
    Effect.timeout(options.outputDrainTimeout ?? DEFAULT_BACKEND_OUTPUT_DRAIN_TIMEOUT),
    Effect.ignore,
  );
  if (Exit.isFailure(exit)) {
    return yield* Effect.failCause(exit.cause);
  }
  const exitCode = exit.value;
  return {
    code: Option.some(exitCode),
    reason: `code=${exitCode}`,
  } satisfies BackendProcessExit;
});

// Factory for one pooled backend instance. The returned instance owns
// its own state Ref, mutex, restart loop, and active child process;
// nothing is shared between instances created from separate
// makeBackendInstance calls. The instance shuts down automatically when
// the calling scope closes (typically the application scope).
export const makeBackendInstance = Effect.fn("makeBackendInstance")(function* (
  spec: BackendInstanceSpec,
): Effect.fn.Return<
  DesktopBackendInstance,
  never,
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
  | DesktopObservability.DesktopBackendOutputLogFactory
  | DesktopTelemetryPublisher.DesktopTelemetryPublisher
  | DesktopBrowserHost.DesktopBrowserHost
  | DesktopWslEnvironment.DesktopWslEnvironment
  | Scope.Scope
> {
  const parentScope = yield* Scope.Scope;
  const fileSystem = yield* FileSystem.FileSystem;
  const backendOutputLogFactory = yield* DesktopObservability.DesktopBackendOutputLogFactory;
  const backendOutputLog = yield* backendOutputLogFactory.forInstance(spec.id);
  const desktopTelemetryPublisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
  const desktopBrowserHost = yield* DesktopBrowserHost.DesktopBrowserHost;
  const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const state = yield* Ref.make(initialState);
  const mutex = yield* Semaphore.make(1);

  const { logWarning: logInstanceWarning, logError: logInstanceError } =
    DesktopObservability.makeComponentLogger(`desktop-backend-instance:${spec.id}`);

  const updateActiveRun = (runId: number, f: (run: ActiveBackendRun) => ActiveBackendRun) =>
    Ref.update(state, withActiveRun(runId, f));

  // The W1 seam is never installed by the production DesktopBackendPool.
  // A future provider-host lease needs an independently rechecked MAIN run,
  // live channel/host incarnations and source evidence; this value is NOT one.
  const inactiveWindowsWitnessSnapshot = Ref.get(state).pipe(
    Effect.map((current): WindowsBackendProcessWitnessSnapshot | null => {
      const active = Option.getOrUndefined(current.active);
      if (
        !current.desiredRunning ||
        !current.ready ||
        active === undefined ||
        active.stopRequested ||
        active.exitObserved
      )
        return null;
      return active.inactiveWindowsWitness?.readCurrent() ?? null;
    }),
  );

  const revokeInactiveWitness = (
    witness: RetainedWindowsBackendProcessWitness | undefined,
    reason: string,
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      if (witness) {
        try {
          witness.revoke(reason);
        } catch {
          /* The witness is irrevocably inactive even on CloseHandle error. */
        }
      }
    });

  const revokeActiveWitness = (runId: number, reason: string): Effect.Effect<void> =>
    Ref.get(state).pipe(
      Effect.flatMap((current) => {
        const active = Option.getOrUndefined(current.active);
        return revokeInactiveWitness(
          active?.id === runId ? active.inactiveWindowsWitness : undefined,
          reason,
        );
      }),
    );

  const snapshot = Ref.get(state).pipe(
    Effect.map((current): DesktopBackendSnapshot => ({
      desiredRunning: current.desiredRunning,
      ready: current.ready,
      activePid: activePid(current.active),
      restartAttempt: current.restartAttempt,
      restartScheduled: Option.isSome(current.restartFiber),
    })),
  );
  const currentConfig = Ref.get(state).pipe(Effect.map((current) => current.config));

  const cancelRestart = Effect.gen(function* () {
    const restartFiber = yield* Ref.modify(state, (current) => [
      current.restartFiber,
      {
        ...current,
        restartFiber: Option.none(),
      },
    ]);

    yield* Option.match(restartFiber, {
      onNone: () => Effect.void,
      onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
    });
  });

  const start: Effect.Effect<void> = Effect.suspend(() =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (Option.isSome(current.active)) {
          if (!current.desiredRunning) {
            yield* Ref.update(state, (latest) => ({
              ...latest,
              desiredRunning: true,
            }));
          }
          return;
        }

        if (current.ready) {
          yield* spec.onShutdown?.() ?? Effect.void;
          yield* Ref.update(state, (latest) =>
            latest.ready ? { ...latest, ready: false } : latest,
          );
        }
        const config = yield* spec.configResolve.pipe(
          Effect.tapError((error) =>
            logInstanceError("failed to generate desktop backend configuration", {
              cause: error.message,
            }),
          ),
          Effect.option,
        );
        if (Option.isNone(config)) {
          if (current.desiredRunning) {
            yield* scheduleRestart("failed to generate desktop backend configuration");
          }
          return;
        }
        const entryExists = yield* fileSystem
          .exists(config.value.entryPath)
          .pipe(Effect.orElseSucceed(() => false));

        const resetFatalPreflightCounter =
          !current.desiredRunning && current.preflightFailureAttempt > 0;
        yield* cancelRestart;
        yield* Ref.update(state, (latest) => ({
          ...latest,
          desiredRunning: true,
          ready: false,
          config: Option.some(config.value),
          preflightFailureAttempt: resetFatalPreflightCounter ? 0 : latest.preflightFailureAttempt,
        }));

        const preflightFailure = config.value.preflightFailure;
        if (Option.isSome(preflightFailure)) {
          const { reason, fatal, retryLimit } = preflightFailure.value;
          if (!fatal && retryLimit === undefined) {
            // Transient (WSL cold-starting, wslpath while the VM boots). Keep
            // retrying so the backend self-heals once WSL is ready. Reset a
            // prior bounded/fatal streak because this is a different failure.
            yield* Ref.update(state, (latest) =>
              latest.preflightFailureAttempt === 0
                ? latest
                : { ...latest, preflightFailureAttempt: 0 },
            );
            yield* scheduleRestart(reason);
            return;
          }
          const attemptLimit = retryLimit ?? MAX_PREFLIGHT_FAILURE_ATTEMPTS;
          const attempt = yield* Ref.modify(state, (latest) => {
            const next = latest.preflightFailureAttempt + 1;
            return [next, { ...latest, preflightFailureAttempt: next }] as const;
          });
          if (attempt > attemptLimit) {
            // We already surfaced and asked for the Windows fallback, yet we're
            // still resolving the WSL primary — the fallback didn't take (e.g.
            // the settings write failed). Stop rather than loop forever.
            yield* logInstanceError("backend preflight still failing after fallback; stopping", {
              reason,
              attempt,
            });
            yield* Ref.update(state, (latest) => ({
              ...latest,
              desiredRunning: false,
              ready: false,
            }));
            return;
          }
          if (attempt === attemptLimit) {
            // Fatal/bounded and out of retries. Surface the reason (onPreflightFailed,
            // on the primary, shows a dialog and persists Windows mode), then
            // schedule one more restart so the next resolve picks up the Windows
            // primary and a window can open.
            yield* logInstanceError(
              "backend preflight failed repeatedly; surfacing and falling back",
              { reason, attempt },
            );
            const shouldRestart = yield* (
              spec.onPreflightFailed?.(preflightFailure.value) ?? Effect.succeed(false)
            );
            if (shouldRestart) {
              yield* scheduleRestart(reason);
            } else {
              yield* Ref.update(state, (latest) => ({
                ...latest,
                desiredRunning: false,
                ready: false,
              }));
            }
            return;
          }
          yield* scheduleRestart(reason);
          return;
        }
        // Clean preflight — reset the fatal counter so a later failure gets a
        // fresh allowance.
        yield* Ref.update(state, (latest) =>
          latest.preflightFailureAttempt === 0 ? latest : { ...latest, preflightFailureAttempt: 0 },
        );

        if (!entryExists) {
          yield* scheduleRestart(`missing server entry at ${config.value.entryPath}`);
          return;
        }

        // INACTIVE: no production caller supplies this opt-in hook.
        // Trusted MAIN entry path/hash/argv are captured before any spawn.
        let preparedWindowsLaunch: TrustedWindowsBackendLaunchProvenance | undefined;
        const windowsSeam = spec.inactiveWindowsProcessWitness;
        if (windowsSeam !== undefined) {
          if (
            spec.id !== PRIMARY_INSTANCE_ID ||
            config.value.bootstrapDelivery !== "fd3" ||
            config.value.runningDistro !== undefined
          ) {
            yield* logInstanceWarning("inactive Windows witness only supports local primary");
            yield* Ref.update(state, (latest) => ({
              ...latest,
              desiredRunning: false,
              ready: false,
            }));
            return;
          }
          const prepared = yield* Effect.exit(
            Effect.promise(() => windowsSeam.prepareLaunch(config.value)),
          );
          if (Exit.isFailure(prepared)) {
            yield* logInstanceWarning("inactive Windows witness launch provenance unavailable");
            yield* Ref.update(state, (latest) => ({
              ...latest,
              desiredRunning: false,
              ready: false,
            }));
            return;
          }
          preparedWindowsLaunch = prepared.value;
        }
        // W2-A optional, source-only. A private fd must be explicitly supplied
        // *and* W1 witness opted in; otherwise there is no positive channel.
        let runStartConfig = config.value;
        const inactivePrivate = spec.inactivePrivateAuthority;
        if (inactivePrivate !== undefined) {
          const prepared =
            windowsSeam !== undefined &&
            spec.id === PRIMARY_INSTANCE_ID &&
            config.value.runningDistro === undefined &&
            config.value.bootstrapDelivery === "fd3"
              ? inactivePrivate.prepareConfig(config.value)
              : null;
          if (!prepared || inactivePrivateAuthorityFdPair(prepared.bootstrap) === null) {
            yield* logInstanceWarning("inactive W2-A private channel preflight refused");
            yield* Ref.update(state, (latest) => ({
              ...latest,
              desiredRunning: false,
              ready: false,
            }));
            return;
          }
          runStartConfig = prepared;
        }

        const runScope = yield* Scope.make("sequential");
        const runId = yield* Ref.modify(state, (latest) => [
          latest.nextRunId,
          {
            ...latest,
            active: Option.some({
              id: latest.nextRunId,
              scope: runScope,
              fiber: Option.none(),
              pid: Option.none(),
              exitObserved: false,
              stopRequested: false,
            } satisfies ActiveBackendRun),
            nextRunId: latest.nextRunId + 1,
          },
        ]);

        const finalizeRun = Effect.fn("desktop.backendInstance.finalizeRun")(function* (
          reason: string,
        ) {
          yield* revokeActiveWitness(runId, "backend-finalized");
          yield* inactivePrivate?.onRevoked?.() ?? Effect.void;
          yield* mutex.withPermits(1)(
            Effect.gen(function* () {
              const { isCurrentRun, nextState, pid, exitObserved, stopRequested, wasReady } =
                yield* Ref.modify(
                  state,
                  (
                    latest,
                  ): readonly [
                    {
                      readonly isCurrentRun: boolean;
                      readonly nextState: BackendManagerState;
                      readonly pid: Option.Option<number>;
                      readonly exitObserved: boolean;
                      readonly stopRequested: boolean;
                      readonly wasReady: boolean;
                    },
                    BackendManagerState,
                  ] => {
                    const currentRun = Option.getOrUndefined(latest.active);
                    if (currentRun?.id !== runId) {
                      return [
                        {
                          isCurrentRun: false,
                          nextState: latest,
                          pid: Option.none<number>(),
                          exitObserved: false,
                          stopRequested: false,
                          wasReady: false,
                        },
                        latest,
                      ] as const;
                    }

                    const next = {
                      ...latest,
                      active: Option.none<ActiveBackendRun>(),
                      ready: false,
                    };
                    return [
                      {
                        isCurrentRun: true,
                        nextState: next,
                        pid: currentRun.pid,
                        exitObserved: currentRun.exitObserved,
                        stopRequested: currentRun.stopRequested,
                        wasReady: latest.ready,
                      },
                      next,
                    ] as const;
                  },
                );

              if (isCurrentRun) {
                yield* desktopTelemetryPublisher.removeControlSource(spec.id);
                if (Option.isSome(pid)) {
                  if (exitObserved && !stopRequested) {
                    yield* backendOutputLog.persistFailure({
                      details: `pid=${pid.value} ${reason}`,
                    });
                  } else {
                    yield* backendOutputLog.discardSession;
                  }
                }
                if (wasReady) {
                  yield* spec.onShutdown?.() ?? Effect.void;
                }
              }

              if (isCurrentRun && nextState.desiredRunning) {
                yield* scheduleRestart(reason);
              }
            }),
          );
        });

        const program = runBackendProcess({
          ...runStartConfig,
          ...(inactivePrivate === undefined
            ? {}
            : {
                inactiveMainToServerStream: inactivePrivate.mainToServer,
                onInactiveServerLine: inactivePrivate.onServerLine,
                onInactiveServerChannelClosed: inactivePrivate.onRevoked,
              }),
          desktopTelemetryStream: desktopTelemetryPublisher.encoded,
          // Only a bootstrap that names the browser fds (the local primary) gets them.
          desktopBrowserStream: desktopBrowserHost.events,
          onDesktopBrowserCommand: desktopBrowserHost.handleCommandLine,
          onDesktopTelemetryControl: (message) =>
            desktopTelemetryPublisher.handleControlForSource(spec.id, message),
          onStarted: Effect.fn("desktop.backendInstance.onStarted")(function* (pid) {
            yield* updateActiveRun(runId, (run) => ({
              ...run,
              pid: Option.some(pid),
            }));
            if (windowsSeam !== undefined && preparedWindowsLaunch !== undefined) {
              const launch = preparedWindowsLaunch;
              const observed = yield* Effect.exit(
                Effect.promise(() => windowsSeam.observeStarted({ pid, runId, launch })),
              );
              if (Exit.isSuccess(observed)) {
                const witness = observed.value;
                const accepted = yield* Ref.modify(state, (current) => {
                  const active = Option.getOrUndefined(current.active);
                  if (
                    !current.desiredRunning ||
                    active?.id !== runId ||
                    active.stopRequested ||
                    active.exitObserved
                  )
                    return [false, current] as const;
                  return [
                    true,
                    {
                      ...current,
                      active: Option.some({ ...active, inactiveWindowsWitness: witness }),
                    },
                  ] as const;
                });
                if (!accepted) {
                  yield* revokeInactiveWitness(witness, "run-stopped-before-observation");
                }
              } else {
                yield* logInstanceWarning(
                  "inactive Windows process witness unavailable; no authority established",
                );
              }
            }
            yield* backendOutputLog.beginSession({
              details: `pid=${pid} port=${config.value.bootstrap.port} cwd=${config.value.cwd}`,
            });
          }),
          onExitObserved: () =>
            updateActiveRun(runId, (run) => ({
              ...run,
              exitObserved: true,
            })).pipe(Effect.andThen(revokeActiveWitness(runId, "process-exited"))),
          onReady: Effect.fn("desktop.backendInstance.onReady")(function* () {
            const isCurrentRun = yield* Ref.modify(state, (latest) => {
              const activeRun = Option.getOrUndefined(latest.active);
              if (activeRun?.id !== runId) {
                return [false, latest] as const;
              }

              return [
                true,
                {
                  ...latest,
                  restartAttempt: 0,
                  ready: true,
                },
              ] as const;
            });
            if (!isCurrentRun) {
              return;
            }

            yield* spec.onReady?.(config.value.httpBaseUrl) ?? Effect.void;
            if (
              config.value.runningDistro !== undefined &&
              config.value.wslRuntimeId !== undefined
            ) {
              yield* wslEnvironment.pruneRuntimes(
                config.value.runningDistro,
                config.value.wslRuntimeId,
              );
            }
          }),
          onReadinessFailure: Effect.fn("desktop.backendInstance.onReadinessFailure")(
            function* (error) {
              yield* revokeActiveWitness(runId, "backend-not-ready");
              yield* inactivePrivate?.onRevoked?.() ?? Effect.void;
              yield* logInstanceWarning("backend readiness check failed during bootstrap", {
                error: error.message,
              });
              yield* backendOutputLog.persistFailureSnapshot({
                details: error.message,
              });
            },
          ),
          onOutput: (streamName, chunk) => backendOutputLog.writeOutputChunk(streamName, chunk),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Scope.provide(runScope),
          Effect.matchEffect({
            onFailure: (error) => finalizeRun(error.message),
            onSuccess: (exit) => finalizeRun(exit.reason),
          }),
          Effect.ensuring(Scope.close(runScope, Exit.void).pipe(Effect.ignore)),
        );

        const fiber = yield* Effect.forkIn(program, parentScope);
        yield* updateActiveRun(runId, (run) => ({
          ...run,
          fiber: Option.some(fiber),
        }));
      }),
    ),
  ).pipe(Effect.withSpan("desktop.backendInstance.start", { attributes: { id: spec.id } }));

  const scheduleRestart = Effect.fn("desktop.backendInstance.scheduleRestart")(function* (
    reason: string,
  ) {
    const scheduled = yield* Ref.modify(state, (latest) => {
      if (!latest.desiredRunning || Option.isSome(latest.restartFiber)) {
        return [Option.none<Duration.Duration>(), latest] as const;
      }

      const delay = calculateRestartDelay(latest.restartAttempt);
      return [
        Option.some(delay),
        {
          ...latest,
          restartAttempt: latest.restartAttempt + 1,
        },
      ] as const;
    });

    yield* Option.match(scheduled, {
      onNone: () => Effect.void,
      onSome: Effect.fn("desktop.backendInstance.scheduleRestartFiber")(function* (delay) {
        yield* logInstanceError("backend exited unexpectedly; restart scheduled", {
          reason,
          delayMs: Duration.toMillis(delay),
        });
        const restartFiber = yield* Effect.forkIn(
          Effect.sleep(delay).pipe(
            Effect.andThen(
              Ref.modify(state, (latest) => {
                const shouldRestart = latest.desiredRunning;
                return [
                  shouldRestart,
                  {
                    ...latest,
                    restartFiber: Option.none(),
                  },
                ] as const;
              }),
            ),
            Effect.flatMap((shouldRestart) => (shouldRestart ? start : Effect.void)),
            Effect.catchCause((cause) =>
              logInstanceError("desktop backend restart fiber failed", {
                cause: Cause.pretty(cause),
              }),
            ),
          ),
          parentScope,
        );
        yield* Ref.update(state, (latest) =>
          Option.isNone(latest.restartFiber)
            ? {
                ...latest,
                restartFiber: Option.some(restartFiber),
              }
            : latest,
        );
      }),
    });
  });

  const stop = Effect.fn("desktop.backendInstance.stop")(function* (options?: {
    readonly timeout?: Duration.Duration;
  }) {
    const { active, restartFiber, notifyShutdown } = yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const result = yield* Ref.modify(state, (latest) => {
          const active = Option.map(latest.active, (run) =>
            run.exitObserved ? run : { ...run, stopRequested: true },
          );
          return [
            {
              active,
              restartFiber: latest.restartFiber,
              notifyShutdown: latest.ready,
            },
            {
              ...latest,
              desiredRunning: false,
              ready: false,
              active,
              restartFiber: Option.none<Fiber.Fiber<void, never>>(),
            },
          ] as const;
        });
        return result;
      }),
    );

    // Invalidate the retained HANDLE immediately after marking stopRequested,
    // before waiting for child teardown or possible backend restart.
    yield* Option.match(active, {
      onNone: () => Effect.void,
      onSome: (run) => revokeInactiveWitness(run.inactiveWindowsWitness, "stop-requested"),
    });
    if (notifyShutdown) {
      yield* (spec.onShutdown?.() ?? Effect.void).pipe(Effect.ignore);
    }
    yield* Option.match(restartFiber, {
      onNone: () => Effect.void,
      onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
    });
    yield* Option.match(active, {
      onNone: () => Effect.void,
      onSome: (run) =>
        Effect.gen(function* () {
          const closed = yield* closeRun(run, parentScope, options);
          if (!closed) {
            return;
          }
          const cleanup = yield* mutex.withPermits(1)(
            Ref.modify(
              state,
              (
                latest,
              ): readonly [
                {
                  readonly needsCleanup: boolean;
                  readonly shouldStart: boolean;
                },
                BackendManagerState,
              ] => {
                const current = Option.getOrUndefined(latest.active);
                if (current?.id !== run.id) {
                  return [
                    {
                      needsCleanup: false,
                      shouldStart:
                        latest.desiredRunning &&
                        Option.isNone(latest.active) &&
                        Option.isNone(latest.restartFiber),
                    },
                    latest,
                  ];
                }
                return [
                  {
                    needsCleanup: true,
                    shouldStart: latest.desiredRunning,
                  },
                  {
                    ...latest,
                    active: Option.none<ActiveBackendRun>(),
                  },
                ];
              },
            ),
          );
          if (cleanup.needsCleanup) {
            yield* desktopTelemetryPublisher.removeControlSource(spec.id);
            yield* backendOutputLog.discardSession;
          }
          if (cleanup.shouldStart) {
            yield* start;
          }
        }),
    });
  });

  const waitForReady = (timeout: Duration.Duration): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      // Return false early if an external `stop()` flipped desiredRunning off
      // — no point polling for a backend that is being torn down.
      if (!current.desiredRunning) return { done: true, ready: false };
      return current.ready ? { done: true, ready: true } : { done: false, ready: false };
    }).pipe(
      Effect.repeat({
        until: (status) => status.done,
        schedule: Schedule.spaced(Duration.millis(100)),
      }),
      Effect.map((status) => status.ready),
      Effect.timeoutOption(timeout),
      Effect.map(Option.getOrElse(() => false)),
    );

  yield* Effect.addFinalizer(() => stop());

  return {
    id: spec.id,
    label: spec.label,
    start,
    stop,
    currentConfig,
    snapshot,
    inactiveWindowsWitnessSnapshot,
    waitForReady,
  } satisfies DesktopBackendInstance;
});
