import {
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
  DesktopTelemetryControlMessage,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopApp from "../app/DesktopApp.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import type {
  InactiveDualWindowsProcessWitness,
  InactiveWindowsBackendProcessWitnessSeam,
} from "../electron/DesktopBackendProcessWitness.ts";

const decodeDesktopBackendBootstrap = Schema.decodeEffect(
  Schema.fromJsonString(DesktopBackendBootstrap),
);
const isBackendProcessError = Schema.is(DesktopBackendManager.BackendProcessError);
const encodeDesktopTelemetryControl = Schema.encodeSync(
  Schema.fromJsonString(DesktopTelemetryControlMessage),
);

const baseConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "/electron",
  args: ["/server/bin.mjs", "--bootstrap-fd", "3"],
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: { ELECTRON_RUN_AS_NODE: "1" },
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    t3Home: "/tmp/t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    desktopTelemetryFd: 4,
    desktopTelemetryControlFd: 5,
  },
  bootstrapDelivery: "fd3",
  extendEnv: true,
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
  preflightFailure: Option.none(),
};

const configWithObservability: DesktopBackendBootstrapValue = {
  ...baseConfig.bootstrap,
  tailscaleServeEnabled: true,
  desktopTelemetryFd: 4,
  otlpTracesUrl: "http://127.0.0.1:4318/v1/traces",
};

function makeProcess(options?: {
  readonly stdout?: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly stderr?: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>;
  readonly kill?: ChildProcessSpawner.ChildProcessHandle["kill"];
  readonly getOutputFd?: ChildProcessSpawner.ChildProcessHandle["getOutputFd"];
}): ChildProcessSpawner.ChildProcessHandle {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: options?.stdout ?? Stream.empty,
    stderr: options?.stderr ?? Stream.empty,
    all: Stream.merge(options?.stdout ?? Stream.empty, options?.stderr ?? Stream.empty),
    exitCode: options?.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: options?.kill ?? (() => Effect.void),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: options?.getOutputFd ?? (() => Stream.empty),
    unref: Effect.succeed(Effect.void),
  });
}

function responseForRequest(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
): HttpClientResponse.HttpClientResponse {
  return HttpClientResponse.fromWeb(request, new Response(null, { status }));
}

function layerHttpClient(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

const layerHealthyHttpClient = layerHttpClient((request) =>
  Effect.succeed(responseForRequest(request, 200)),
);

function decodeBootstrap(raw: string) {
  return decodeDesktopBackendBootstrap(raw);
}

interface MakeInstanceInput {
  readonly spawnerLayer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly backendOutputLog?: Partial<DesktopObservability.DesktopBackendOutputLogShape>;
  readonly onReady?: Effect.Effect<void>;
  readonly onShutdown?: Effect.Effect<void>;
  readonly onPreflightFailed?: (
    failure: DesktopBackendManager.PreflightFailure,
  ) => Effect.Effect<boolean>;
  readonly config?: DesktopBackendManager.DesktopBackendStartConfig;
  readonly configResolve?: Effect.Effect<
    DesktopBackendManager.DesktopBackendStartConfig,
    PlatformError.PlatformError
  >;
  readonly desktopTelemetryStream?: Stream.Stream<Uint8Array>;
  readonly desktopTelemetryPublisher?: Partial<
    DesktopTelemetryPublisher.DesktopTelemetryPublisher["Service"]
  >;
  readonly pruneRuntimes?: (distro: string | null, runtimeId: string) => Effect.Effect<void>;
  readonly inactiveWindowsProcessWitness?: InactiveWindowsBackendProcessWitnessSeam;
}

// Helper that constructs a primary backend instance using the factory
// directly. The factory's deps (FileSystem, ChildProcessSpawner,
// HttpClient, DesktopBackendOutputLogFactory) are provided per-test via
// a scoped layer; tests yield the returned Effect inside `Effect.scoped`
// to drive the instance's lifecycle.
function makeTestInstance(input: MakeInstanceInput) {
  const stubLog: DesktopObservability.DesktopBackendOutputLogShape = {
    beginSession: () => Effect.void,
    writeOutputChunk: () => Effect.void,
    persistFailureSnapshot: () => Effect.void,
    persistFailure: () => Effect.void,
    discardSession: Effect.void,
    ...input.backendOutputLog,
  };
  const layerServices = Layer.mergeAll(
    FileSystem.layerNoop({
      exists: () => Effect.succeed(true),
    }),
    input.spawnerLayer,
    input.httpClientLayer ?? layerHealthyHttpClient,
    Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
      forInstance: () => Effect.succeed(stubLog),
    } satisfies DesktopObservability.DesktopBackendOutputLogFactory["Service"]),
    Layer.succeed(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {
      latest: Effect.succeedNone,
      changes: Stream.empty,
      encoded: input.desktopTelemetryStream ?? Stream.empty,
      handleControlForSource: () => Effect.void,
      removeControlSource: () => Effect.void,
      publishUpdateReport: () => Effect.void,
      updateRequests: Stream.empty,
      updateCommits: Stream.empty,
      updateCancellations: Stream.empty,
      ...input.desktopTelemetryPublisher,
    }),
    DesktopBrowserHost.layer,
    DesktopWslEnvironment.layerTest(
      input.pruneRuntimes === undefined ? {} : { pruneRuntimes: input.pruneRuntimes },
    ),
  );

  const instance = DesktopBackendManager.makeBackendInstance({
    id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Windows"),
    configResolve: input.configResolve ?? Effect.succeed(input.config ?? baseConfig),
    ...(input.onReady ? { onReady: () => input.onReady! } : {}),
    ...(input.onShutdown ? { onShutdown: () => input.onShutdown! } : {}),
    ...(input.onPreflightFailed ? { onPreflightFailed: input.onPreflightFailed } : {}),
    ...(input.inactiveWindowsProcessWitness
      ? { inactiveWindowsProcessWitness: input.inactiveWindowsProcessWitness }
      : {}),
  });

  return instance.pipe(Effect.provide(layerServices));
}

/** Synthetic source/pipe capabilities; no real Windows HANDLE or host is created. */
function makeInactiveDualLegFixture(
  options: Partial<
    Parameters<typeof DesktopBackendManager.createInactiveMainDualLegIssuer>[0]
  > = {},
) {
  const serverPipe = Symbol("server-owned-pipe");
  const hostPipe = Symbol("host-owned-pipe");
  const processLaunch = {
    expectedExecutablePath: "C:\\\\Apps\\\\T3.exe",
    entryPath: "C:\\\\T3\\\\server.mjs",
    entrySha256: "a".repeat(64),
    args: ["C:\\\\T3\\\\server.mjs", "--bootstrap-fd", "3"],
    cwd: "C:\\\\T3",
    electronRunAsNode: true as const,
    capturedBeforeSpawn: true as const,
  };
  const backend = {
    pid: 4242,
    processCreationFiletimeTicks: "116444736000123456",
    creationFileTimeHex: "019db1ded53f0940",
    createdAtEpochMs: 12_345,
    osExecutablePath: "C:\\\\Apps\\\\T3.exe",
    launch: processLaunch,
  };
  const host = {
    ...backend,
    pid: 5252,
    launch: {
      ...processLaunch,
      entryPath: "C:\\\\T3\\\\host.mjs",
      entrySha256: "b".repeat(64),
    },
  };
  const state = {
    processAlive: true,
    serverAlive: true,
    hostAlive: true,
    serverPipe,
    hostPipe,
    serverPid: 4242,
    hostPid: 5252,
    backend,
    host,
    wall: 20_000,
    monotonic: 50_000,
    serverAckReady: true,
    hostAckReady: true,
    overrideServerAck: null as Uint8Array | null,
    overrideHostAck: null as Uint8Array | null,
  };
  const events: string[] = [];
  const bytes = (value: Record<string, unknown>) =>
    new TextEncoder().encode(JSON.stringify(value) + "\n");
  const processes: InactiveDualWindowsProcessWitness = {
    readCurrent: () => {
      events.push("process-check");
      return state.processAlive ? { backend: { ...state.backend }, host: { ...state.host } } : null;
    },
    revoke: () => {
      state.processAlive = false;
      events.push("process-revoked");
    },
  };
  const serverLeg: DesktopBackendManager.InactiveMainOwnedPrivateLeg = {
    readOwnedCurrent: () => {
      events.push("server-pipe-check");
      return state.serverAlive
        ? {
            pipeIdentity: state.serverPipe,
            processId: state.serverPid,
            channelIncarnationId: "server-inc",
          }
        : null;
    },
    consumeOneUseAckBytes: () => {
      events.push("server-ack");
      if (!state.serverAckReady) return null;
      state.serverAckReady = false;
      return (
        state.overrideServerAck ??
        bytes({
          type: "challenge_ack",
          version: 1,
          mainRunId: "main-run",
          serverGenerationId: "server-gen",
          serverChannelIncarnationId: "server-inc",
          challengeId: "server-challenge",
          nonce: "s".repeat(32),
        })
      );
    },
  };
  const hostLeg: DesktopBackendManager.InactiveMainOwnedPrivateLeg = {
    readOwnedCurrent: () => {
      events.push("host-pipe-check");
      return state.hostAlive
        ? {
            pipeIdentity: state.hostPipe,
            processId: state.hostPid,
            channelIncarnationId: "host-inc",
          }
        : null;
    },
    consumeOneUseAckBytes: () => {
      events.push("host-ack");
      if (!state.hostAckReady) return null;
      state.hostAckReady = false;
      return (
        state.overrideHostAck ??
        bytes({
          type: "host_challenge_ack",
          version: 1,
          role: "provider-only",
          mainRunId: "main-run",
          serverInstanceId: "server-instance",
          serverGenerationId: "server-gen",
          serverChannelIncarnationId: "server-inc",
          hostChannelIncarnationId: "host-inc",
          serverHandshakeChallengeId: "server-challenge",
          challengeId: "host-challenge",
          nonce: "h".repeat(32),
        })
      );
    },
  };
  const issuer = DesktopBackendManager.createInactiveMainDualLegIssuer({
    processes,
    serverLeg,
    hostLeg,
    mainRunId: "main-run",
    serverInstanceId: "server-instance",
    serverGenerationId: "server-gen",
    leaseId: "lease-id",
    serverChannelIncarnationId: "server-inc",
    hostChannelIncarnationId: "host-inc",
    serverChallengeId: "server-challenge",
    serverNonce: "s".repeat(32),
    hostChallengeId: "host-challenge",
    hostNonce: "h".repeat(32),
    earlierRetirementCutoffEpochMs: null,
    clock: {
      epochMs: () => {
        events.push("wall-clock");
        return state.wall;
      },
      monotonicMs: () => {
        events.push("monotonic-clock");
        return state.monotonic;
      },
    },
    ...options,
  });
  return { issuer, state, events, bytes };
}

describe("inactive W2-B MAIN dual-handshake issuer fixture", () => {
  it("requires independently retained processes/pipes and both ACKs before sampling birth", () => {
    const f = makeInactiveDualLegFixture();
    assert.isNull(f.issuer.readInactiveEvidence());
    assert.deepEqual(f.events, []);
    assert.isTrue(f.issuer.begin());
    const firstClock = f.events.indexOf("wall-clock");
    assert.isAbove(firstClock, f.events.indexOf("server-ack"));
    assert.isAbove(firstClock, f.events.indexOf("host-ack"));
    assert.isTrue(f.events.slice(0, firstClock).filter((x) => x === "process-check").length >= 2);
    const v = f.issuer.readInactiveEvidence();
    assert.equal(v?.notEnrolled, true);
    assert.equal(v?.serverHandshakeChallengeId, "server-challenge");
    assert.equal(v?.hostHandshakeChallengeId, "host-challenge");
    assert.equal(v?.backend.pid, 4242);
    assert.equal(v?.host.pid, 5252);
    assert.equal(v?.host.launch.entrySha256, "b".repeat(64));
    assert.equal(v?.leaseBirthEpochMs, 20_000);
    assert.equal(v?.leaseExpiresAtEpochMs, 320_000);
    assert.equal(v?.leaseElapsedMonotonicMs, 0);
    assert.isFrozen(v);
    assert.isFalse(f.issuer.begin(), "one-use cannot create a second lease");
    assert.isTrue(f.issuer.revoked);
    assert.isNull(f.issuer.readInactiveEvidence());
  });

  it("rejects missing/foreign process or pipe before any ACK/birth", () => {
    for (const fault of [
      "process-exit",
      "server-pipe",
      "host-pipe",
      "same-pipe",
      "foreign-server-pid",
      "foreign-host-pid",
    ] as const) {
      const f = makeInactiveDualLegFixture();
      if (fault === "process-exit") f.state.processAlive = false;
      if (fault === "server-pipe") f.state.serverAlive = false;
      if (fault === "host-pipe") f.state.hostAlive = false;
      if (fault === "same-pipe") f.state.hostPipe = f.state.serverPipe;
      if (fault === "foreign-server-pid") f.state.serverPid = 5252;
      if (fault === "foreign-host-pid") f.state.hostPid = 4242;
      assert.isFalse(f.issuer.begin(), fault);
      assert.isTrue(f.issuer.revoked, fault);
      assert.isNull(f.issuer.readInactiveEvidence(), fault);
      assert.isFalse(f.events.includes("wall-clock"), fault);
    }
  });

  it("rejects server-only ACK, mismatched challenge, hostRole alias and wrong provider role", () => {
    for (const fault of [
      "no-server",
      "no-host",
      "wrong-role",
      "hostRole",
      "wrong-server-challenge",
      "reused-host-challenge",
    ] as const) {
      const f = makeInactiveDualLegFixture();
      if (fault === "no-server") f.state.serverAckReady = false;
      if (fault === "no-host") f.state.hostAckReady = false;
      if (fault !== "no-server" && fault !== "no-host") {
        const ack: Record<string, unknown> = {
          type: "host_challenge_ack",
          version: 1,
          role: "provider-only",
          mainRunId: "main-run",
          serverInstanceId: "server-instance",
          serverGenerationId: "server-gen",
          serverChannelIncarnationId: "server-inc",
          hostChannelIncarnationId: "host-inc",
          serverHandshakeChallengeId: "server-challenge",
          challengeId: "host-challenge",
          nonce: "h".repeat(32),
        };
        if (fault === "wrong-role") ack.role = "operator";
        if (fault === "hostRole") {
          delete ack.role;
          ack.hostRole = "provider-only";
        }
        if (fault === "wrong-server-challenge") ack.serverHandshakeChallengeId = "stale";
        if (fault === "reused-host-challenge") ack.challengeId = "server-challenge";
        f.state.overrideHostAck = f.bytes(ack);
      }
      assert.isFalse(f.issuer.begin(), fault);
      assert.isTrue(f.issuer.revoked, fault);
      assert.isNull(f.issuer.readInactiveEvidence(), fault);
    }
  });

  it("fails closed on malformed, oversize, coalesced and noncanonical private host ACKs", () => {
    const encoder = new TextEncoder();
    const valid = {
      type: "host_challenge_ack",
      version: 1,
      role: "provider-only",
      mainRunId: "main-run",
      serverInstanceId: "server-instance",
      serverGenerationId: "server-gen",
      serverChannelIncarnationId: "server-inc",
      hostChannelIncarnationId: "host-inc",
      serverHandshakeChallengeId: "server-challenge",
      challengeId: "host-challenge",
      nonce: "h".repeat(32),
    };
    const canonical = JSON.stringify(valid);
    for (const raw of [
      encoder.encode(canonical + "\r\n"),
      encoder.encode(canonical + "\n" + canonical + "\n"),
      encoder.encode(canonical.slice(0, -1) + ', "role":"provider-only"}\n'),
      encoder.encode(canonical.slice(0, -1) + ',"role":"provider-only"}\n'),
      encoder.encode(canonical.slice(0, -1) + ',"unexpected":1}\n'),
      encoder.encode(" ".repeat(2049) + "\n"),
      new Uint8Array([0xff, 0x0a]),
      encoder.encode(canonical),
    ]) {
      const f = makeInactiveDualLegFixture();
      f.state.overrideHostAck = raw;
      assert.isFalse(f.issuer.begin());
      assert.isTrue(f.issuer.revoked);
      assert.isNull(f.issuer.readInactiveEvidence());
    }
  });

  it("pins an immutable earlier cutoff and enforces both 300000ms expiry clocks", () => {
    const earlier = makeInactiveDualLegFixture({ earlierRetirementCutoffEpochMs: 20_150 });
    assert.isTrue(earlier.issuer.begin());
    assert.equal(earlier.issuer.readInactiveEvidence()?.leaseExpiresAtEpochMs, 20_150);
    earlier.state.wall += 149;
    earlier.state.monotonic += 149;
    assert.equal(earlier.issuer.readInactiveEvidence()?.leaseElapsedMonotonicMs, 149);
    earlier.state.monotonic += 1;
    assert.isNull(earlier.issuer.readInactiveEvidence());
    assert.isTrue(earlier.issuer.revoked);
    const max = makeInactiveDualLegFixture();
    assert.isTrue(max.issuer.begin());
    max.state.monotonic += 299_999;
    assert.equal(max.issuer.readInactiveEvidence()?.leaseElapsedMonotonicMs, 299_999);
    max.state.monotonic += 1;
    assert.isNull(max.issuer.readInactiveEvidence());
    const wall = makeInactiveDualLegFixture();
    assert.isTrue(wall.issuer.begin());
    wall.state.wall += 300_000;
    assert.isNull(wall.issuer.readInactiveEvidence());
    assert.isTrue(wall.issuer.revoked);
  });

  it("rejects invalid immutable cutoff and birth clock overflow", () => {
    for (const cutoff of [-1, 0, 20_000, 19_999, Number.MAX_SAFE_INTEGER + 1]) {
      const f = makeInactiveDualLegFixture({ earlierRetirementCutoffEpochMs: cutoff });
      assert.isFalse(f.issuer.begin(), String(cutoff));
      assert.isTrue(f.issuer.revoked);
    }
    const overflow = makeInactiveDualLegFixture({
      clock: { epochMs: () => Number.MAX_SAFE_INTEGER - 1, monotonicMs: () => 10 },
    });
    assert.isFalse(overflow.issuer.begin());
  });

  it("irrevocably revokes after clock regression, EOF, OS exit, pipe or raw ticks drift", () => {
    for (const fault of [
      "wall-rollback",
      "monotonic-rollback",
      "host-exit",
      "server-EOF",
      "host-EOF",
      "host-pipe-change",
      "backend-raw-same-ms",
      "host-raw-same-ms",
      "host-entry-change",
      "host-image-change",
      "host-entrypath-change",
    ] as const) {
      const f = makeInactiveDualLegFixture();
      assert.isTrue(f.issuer.begin(), fault);
      assert.isNotNull(f.issuer.readInactiveEvidence());
      if (fault === "wall-rollback") f.state.wall -= 1;
      if (fault === "monotonic-rollback") f.state.monotonic -= 1;
      if (fault === "host-exit") f.state.processAlive = false;
      if (fault === "server-EOF") f.state.serverAlive = false;
      if (fault === "host-EOF") f.state.hostAlive = false;
      if (fault === "host-pipe-change") f.state.hostPipe = Symbol("new-pipe");
      if (fault === "backend-raw-same-ms")
        f.state.backend.processCreationFiletimeTicks = "116444736000123457";
      if (fault === "host-raw-same-ms")
        f.state.host.processCreationFiletimeTicks = "116444736000123457";
      if (fault === "host-entry-change")
        f.state.host.launch = {
          ...f.state.host.launch,
          entrySha256: "f".repeat(64),
        };
      if (fault === "host-image-change") f.state.host.osExecutablePath = "C:\\Other\\host.exe";
      if (fault === "host-entrypath-change")
        f.state.host.launch = {
          ...f.state.host.launch,
          entryPath: "C:\\Untrusted\\host.mjs",
        };
      assert.isNull(f.issuer.readInactiveEvidence(), fault);
      assert.isTrue(f.issuer.revoked, fault);
      assert.isNull(f.issuer.readInactiveEvidence(), fault);
    }
  });

  it("is unmounted by production defaults and never spawns a child by itself", () => {
    const f = makeInactiveDualLegFixture();
    assert.isNull(f.issuer.readInactiveEvidence());
    assert.deepEqual(f.events, []);
    assert.isUndefined(
      (baseConfig as unknown as Record<string, unknown>).inactiveMainDualLegIssuer,
    );
  });
});

describe("DesktopBackendManager", () => {
  it.effect("spawns the backend with fd3 bootstrap and fd4 telemetry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let spawnedCommand: ChildProcess.Command | undefined;
        let bootstrapJson = "";
        let telemetryJson = "";
        let readyCount = 0;
        const ready = yield* Deferred.make<void>();
        const exited = yield* Queue.unbounded<void>();

        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              spawnedCommand = command;
              if (command._tag === "StandardCommand") {
                const fd3 = command.options.additionalFds?.fd3;
                if (fd3?.type === "input" && fd3.stream) {
                  bootstrapJson = yield* fd3.stream.pipe(Stream.decodeText(), Stream.mkString);
                }
                const fd4 = command.options.additionalFds?.fd4;
                if (fd4?.type === "input" && fd4.stream) {
                  telemetryJson = yield* fd4.stream.pipe(Stream.decodeText(), Stream.mkString);
                }
              }

              return makeProcess({
                exitCode: Deferred.await(ready).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          config: {
            ...baseConfig,
            bootstrap: configWithObservability,
          },
          spawnerLayer: layerSpawner,
          desktopTelemetryStream: Stream.encodeText(
            Stream.make('{"version":1,"type":"desktopTelemetryHello","electronPid":123}\n'),
          ),
          onReady: Effect.sync(() => {
            readyCount += 1;
          }).pipe(Effect.andThen(Deferred.succeed(ready, void 0)), Effect.asVoid),
          backendOutputLog: {
            persistFailure: () => Queue.offer(exited, void 0).pipe(Effect.asVoid),
          },
        });

        yield* instance.start;
        yield* Queue.take(exited);

        assert.equal(readyCount, 1);
        assert.isDefined(spawnedCommand);
        if (spawnedCommand._tag !== "StandardCommand") {
          throw new Error("Expected backend to spawn a standard command.");
        }

        assert.equal(spawnedCommand.command, "/electron");
        assert.deepEqual(spawnedCommand.args, ["/server/bin.mjs", "--bootstrap-fd", "3"]);
        assert.equal(spawnedCommand.options.cwd, "/server");
        assert.equal(spawnedCommand.options.extendEnv, true);
        assert.equal(spawnedCommand.options.stdout, "pipe");
        assert.equal(spawnedCommand.options.stderr, "pipe");
        assert.equal(spawnedCommand.options.killSignal, "SIGTERM");
        assert.isDefined(spawnedCommand.options.forceKillAfter);
        assert.equal(spawnedCommand.options.additionalFds?.fd4?.type, "input");
        assert.equal(spawnedCommand.options.additionalFds?.fd5?.type, "output");
        assert.equal(
          Duration.toMillis(Duration.fromInputUnsafe(spawnedCommand.options.forceKillAfter)),
          2_000,
        );

        assert.deepEqual(yield* decodeBootstrap(bootstrapJson), configWithObservability);
        assert.equal(
          telemetryJson,
          '{"version":1,"type":"desktopTelemetryHello","electronPid":123}\n',
        );
      }),
    ),
  );

  it.effect("W2-A: only an explicitly paired synthetic fd8 output/fd9 input reaches child", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let command: ChildProcess.Command | undefined;
        const acceptedLine = yield* Deferred.make<string>();
        const exit = yield* Deferred.make<void>();
        const layer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((value) =>
            Effect.sync(() => {
              command = value;
              return makeProcess({
                getOutputFd: (fd) =>
                  fd === 8 ? Stream.make(Buffer.from('{"type":"challenge_ack"}\n')) : Stream.empty,
                exitCode: Deferred.await(exit).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
          ),
        );
        const result = DesktopBackendManager.runBackendProcess({
          ...baseConfig,
          captureOutput: false,
          bootstrap: {
            ...baseConfig.bootstrap,
            desktopPrivateAuthorityOutputFd: 8,
            desktopPrivateAuthorityInputFd: 9,
            desktopTelemetryFd: 4,
            desktopTelemetryControlFd: 5,
            desktopBrowserFd: 6,
            desktopBrowserControlFd: 7,
          },
          desktopTelemetryStream: Stream.empty,
          desktopBrowserStream: Stream.empty,
          onDesktopBrowserCommand: () => Effect.void,
          inactiveMainToServerStream: Stream.make(Buffer.from('{"type":"challenge"}\n')),
          onInactiveServerLine: (line) => Deferred.succeed(acceptedLine, line).pipe(Effect.asVoid),
        }).pipe(Effect.provide(Layer.merge(layer, layerHealthyHttpClient)), Effect.forkScoped);
        const fiber = yield* result;
        assert.equal(yield* Deferred.await(acceptedLine), '{"type":"challenge_ack"}');
        assert.isDefined(command);
        if (command._tag !== "StandardCommand") return assert.fail("expected standard child");
        assert.equal(command.options.additionalFds?.fd8?.type, "output");
        assert.equal(command.options.additionalFds?.fd9?.type, "input");
        for (const index of [3, 4, 5, 6, 7]) {
          assert.notEqual(command.options.additionalFds?.[`fd${index}`]?.type, undefined);
        }
        yield* Deferred.succeed(exit, void 0);
        yield* Fiber.join(fiber);
      }),
    ),
  );

  it("W2-A MAIN challenge ACK is one-use, exact-correlated, and never authorizes a host", () => {
    const base = {
      mainRunId: "main-run-1",
      serverGenerationId: "generation-1",
      serverChannelIncarnationId: "server-channel-1",
      challengeId: "challenge-1",
      nonce: "X".repeat(43),
      begunAtMs: 1000,
      now: () => 1000,
    };
    const gate = DesktopBackendManager.makeInactiveMainChallengeGate(base);
    assert.isTrue(gate.challengeLine.endsWith("\\n"));
    const ack = {
      type: "challenge_ack",
      version: 1,
      mainRunId: base.mainRunId,
      serverGenerationId: base.serverGenerationId,
      serverChannelIncarnationId: base.serverChannelIncarnationId,
      challengeId: base.challengeId,
      nonce: base.nonce,
    };
    assert.isTrue(gate.acceptAckLine(JSON.stringify(ack)));
    assert.isTrue(gate.acknowledged);
    assert.isFalse(gate.acceptAckLine(JSON.stringify(ack)));
    assert.isTrue(gate.revoked);
    for (const wrong of [
      { ...ack, mainRunId: "other" },
      { ...ack, serverGenerationId: "other" },
      { ...ack, nonce: "N".repeat(43) },
      { ...ack, extra: true },
    ]) {
      const attempt = DesktopBackendManager.makeInactiveMainChallengeGate(base);
      assert.isFalse(attempt.acceptAckLine(JSON.stringify(wrong)));
      assert.isTrue(attempt.revoked);
    }
    const expired = DesktopBackendManager.makeInactiveMainChallengeGate({
      ...base,
      now: () => 6000,
    });
    assert.isFalse(expired.acceptAckLine(JSON.stringify(ack)));
    assert.isTrue(expired.revoked);
    const closed = DesktopBackendManager.makeInactiveMainChallengeGate(base);
    closed.close();
    assert.isFalse(closed.acceptAckLine(JSON.stringify(ack)));
  });

  it.effect("W2-A: missing pair, callbacks or WSL refuses before spawn", () =>
    Effect.gen(function* () {
      let spawned = 0;
      const layer = Layer.merge(
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => {
            spawned++;
            return Effect.succeed(makeProcess());
          }),
        ),
        layerHealthyHttpClient,
      );
      const invalid: Array<DesktopBackendManager.DesktopBackendStartConfig> = [
        {
          ...baseConfig,
          bootstrap: {
            ...baseConfig.bootstrap,
            desktopPrivateAuthorityOutputFd: 8,
            desktopPrivateAuthorityInputFd: 9,
          },
        },
        {
          ...baseConfig,
          runningDistro: "Ubuntu",
          bootstrap: {
            ...baseConfig.bootstrap,
            desktopPrivateAuthorityOutputFd: 8,
            desktopPrivateAuthorityInputFd: 9,
          },
        },
        {
          ...baseConfig,
          bootstrap: {
            ...baseConfig.bootstrap,
            desktopPrivateAuthorityOutputFd: 8,
          },
        },
      ];
      for (const config of invalid) {
        const error = yield* DesktopBackendManager.runBackendProcess({
          ...config,
          desktopTelemetryStream: Stream.empty,
        }).pipe(Effect.flip, Effect.scoped, Effect.provide(layer));
        assert.equal(error._tag, "BackendProcessBootstrapEncodeError");
      }
      assert.equal(spawned, 0);
    }),
  );

  it.effect("preserves the readiness timeout cause and process context", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<HttpClientRequest.HttpClientRequest>();
      const layer = Layer.merge(
        TestClock.layer(),
        layerHttpClient((request) =>
          Deferred.succeed(requested, request).pipe(Effect.andThen(Effect.never)),
        ),
      );

      yield* Effect.gen(function* () {
        const readiness = yield* DesktopBackendManager.waitForHttpReady({
          executablePath: baseConfig.executablePath,
          entryPath: baseConfig.entryPath,
          cwd: baseConfig.cwd,
          httpBaseUrl: baseConfig.httpBaseUrl,
          timeout: Duration.millis(50),
        }).pipe(Effect.flip, Effect.forkChild);

        const request = yield* Deferred.await(requested);
        assert.equal(request.url, "http://127.0.0.1:3773/.well-known/t3/environment");

        yield* TestClock.adjust(Duration.millis(50));
        const error = yield* Fiber.join(readiness);

        assert.instanceOf(error, DesktopBackendManager.BackendReadinessTimeoutError);
        assert.equal(error.executablePath, "/electron");
        assert.equal(error.entryPath, "/server/bin.mjs");
        assert.equal(error.cwd, "/server");
        assert.equal(error.httpBaseUrl.href, "http://127.0.0.1:3773/");
        assert.equal(error.readinessUrl.href, "http://127.0.0.1:3773/.well-known/t3/environment");
        assert.equal(error.timeoutMs, 50);
        assert.isDefined(error.cause);
        assert.equal(
          error.message,
          "Timed out after 50ms waiting for desktop backend readiness at http://127.0.0.1:3773/.well-known/t3/environment.",
        );
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("reports bootstrap encoding failures with stable process context", () =>
    Effect.gen(function* () {
      const layerSpawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("unexpected backend spawn")),
      );
      const error = yield* DesktopBackendManager.runBackendProcess({
        ...baseConfig,
        desktopTelemetryStream: Stream.empty,
        bootstrap: {
          ...baseConfig.bootstrap,
          port: 0,
        },
      }).pipe(
        Effect.flip,
        Effect.scoped,
        Effect.provide(Layer.merge(layerSpawner, layerHealthyHttpClient)),
      );

      if (error._tag !== "BackendProcessBootstrapEncodeError") {
        return assert.fail(`Expected bootstrap encode error, received ${error._tag}`);
      }
      assert.equal(error.executablePath, "/electron");
      assert.equal(error.entryPath, "/server/bin.mjs");
      assert.equal(error.cwd, "/server");
      assert.equal(error.httpBaseUrl.href, "http://127.0.0.1:3773/");
      assert.isDefined(error.cause);
      assert.equal(
        error.message,
        "Failed to encode the desktop backend bootstrap payload for /server/bin.mjs.",
      );
      assert.isTrue(isBackendProcessError(error));
    }),
  );

  it.effect("preserves spawn failures without deriving their message from the cause", () =>
    Effect.gen(function* () {
      const spawnCause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "ChildProcessSpawner",
        method: "spawn",
        pathOrDescriptor: baseConfig.executablePath,
        description: "low-level detail that must not become the public message",
      });
      const layerSpawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.fail(spawnCause)),
      );
      const error = yield* DesktopBackendManager.runBackendProcess({
        ...baseConfig,
        desktopTelemetryStream: Stream.empty,
      }).pipe(
        Effect.flip,
        Effect.scoped,
        Effect.provide(Layer.merge(layerSpawner, layerHealthyHttpClient)),
      );

      if (error._tag !== "BackendProcessSpawnError") {
        return assert.fail(`Expected backend spawn error, received ${error._tag}`);
      }
      assert.equal(error.executablePath, "/electron");
      assert.equal(error.entryPath, "/server/bin.mjs");
      assert.equal(error.cwd, "/server");
      assert.equal(error.httpBaseUrl.href, "http://127.0.0.1:3773/");
      assert.strictEqual(error.cause, spawnCause);
      assert.equal(
        error.message,
        "Failed to spawn desktop backend entry /server/bin.mjs with /electron.",
      );
      assert.notInclude(error.message, spawnCause.message);
      assert.isTrue(isBackendProcessError(error));
    }),
  );

  it.effect("preserves exit-status failures without copying their detail into the message", () =>
    Effect.gen(function* () {
      const exitCause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "ChildProcess",
        method: "exitCode",
        description: "exit-status-secret-sentinel",
      });
      const layerSpawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeProcess({
              exitCode: Effect.fail(exitCause),
            }),
          ),
        ),
      );
      const error = yield* DesktopBackendManager.runBackendProcess({
        ...baseConfig,
        desktopTelemetryStream: Stream.empty,
      }).pipe(
        Effect.flip,
        Effect.scoped,
        Effect.provide(Layer.merge(layerSpawner, layerHealthyHttpClient)),
      );

      if (error._tag !== "BackendProcessExitStatusError") {
        return assert.fail(`Expected backend exit-status error, received ${error._tag}`);
      }
      assert.equal(error.pid, 123);
      assert.equal(error.executablePath, "/electron");
      assert.equal(error.entryPath, "/server/bin.mjs");
      assert.equal(error.cwd, "/server");
      assert.equal(error.httpBaseUrl.href, "http://127.0.0.1:3773/");
      assert.strictEqual(error.cause, exitCause);
      assert.equal(error.message, "Failed to read the exit status of desktop backend process 123.");
      assert.notInclude(error.message, "exit-status-secret-sentinel");
      assert.isTrue(isBackendProcessError(error));
    }),
  );

  it.effect("reports output stream failures with process and stream context", () =>
    Effect.gen(function* () {
      const outputCause = PlatformError.systemError({
        _tag: "BadResource",
        module: "ChildProcess",
        method: "stdout",
        description: "output-stream-secret-sentinel",
      });
      const reported = yield* Deferred.make<DesktopBackendManager.BackendProcessOutputError>();
      const layerSpawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeProcess({
              stdout: Stream.fail(outputCause),
              exitCode: Deferred.await(reported).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
            }),
          ),
        ),
      );

      const exit = yield* DesktopBackendManager.runBackendProcess({
        ...baseConfig,
        desktopTelemetryStream: Stream.empty,
        onOutputFailure: (error) => Deferred.succeed(reported, error).pipe(Effect.asVoid),
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerSpawner, layerHealthyHttpClient)));
      const error = yield* Deferred.await(reported);

      assert.equal(exit.code.pipe(Option.getOrUndefined), 0);
      if (error._tag !== "BackendProcessOutputReadError") {
        return assert.fail(`Expected output read error, received ${error._tag}`);
      }
      assert.equal(error.executablePath, "/electron");
      assert.equal(error.entryPath, "/server/bin.mjs");
      assert.equal(error.cwd, "/server");
      assert.equal(error.httpBaseUrl.href, "http://127.0.0.1:3773/");
      assert.equal(error.pid, 123);
      assert.equal(error.streamName, "stdout");
      assert.strictEqual(error.cause, outputCause);
      assert.equal(error.message, "Failed to read stdout from desktop backend process 123.");
      assert.notInclude(error.message, "output-stream-secret-sentinel");
    }),
  );

  it.effect("reports output handler failures separately from stream read failures", () =>
    Effect.gen(function* () {
      const chunk = new TextEncoder().encode("backend output");
      const nextChunk = new TextEncoder().encode("still draining");
      const outputCause = new Error("output-handler-secret-sentinel");
      const reported = yield* Deferred.make<DesktopBackendManager.BackendProcessOutputError>();
      const drained = yield* Deferred.make<void>();
      let outputCount = 0;
      const layerSpawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeProcess({
              stdout: Stream.make(chunk, nextChunk),
              exitCode: Deferred.await(drained).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
            }),
          ),
        ),
      );

      const exit = yield* DesktopBackendManager.runBackendProcess({
        ...baseConfig,
        desktopTelemetryStream: Stream.empty,
        onOutput: () => {
          outputCount += 1;
          return outputCount === 1
            ? Effect.fail(outputCause)
            : Deferred.succeed(drained, void 0).pipe(Effect.asVoid);
        },
        onOutputFailure: (error) => Deferred.succeed(reported, error).pipe(Effect.asVoid),
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerSpawner, layerHealthyHttpClient)));
      const error = yield* Deferred.await(reported);

      assert.equal(exit.code.pipe(Option.getOrUndefined), 0);
      if (error._tag !== "BackendProcessOutputHandlingError") {
        return assert.fail(`Expected output handling error, received ${error._tag}`);
      }
      assert.equal(error.executablePath, "/electron");
      assert.equal(error.entryPath, "/server/bin.mjs");
      assert.equal(error.cwd, "/server");
      assert.equal(error.httpBaseUrl.href, "http://127.0.0.1:3773/");
      assert.equal(error.pid, 123);
      assert.equal(error.streamName, "stdout");
      assert.equal(error.chunkByteLength, chunk.byteLength);
      assert.strictEqual(error.cause, outputCause);
      assert.equal(
        error.message,
        `Failed to handle ${chunk.byteLength} bytes from stdout of desktop backend process 123.`,
      );
      assert.notInclude(error.message, "output-handler-secret-sentinel");
      assert.equal(outputCount, 2);
    }),
  );

  it.effect("reports child exit before waiting for trailing output to drain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const exitObserved = yield* Deferred.make<void>();
        const finishOutputDrain = yield* Deferred.make<void>();
        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeProcess({
                stdout: Stream.fromEffect(
                  Deferred.await(finishOutputDrain).pipe(
                    Effect.as(new TextEncoder().encode("trailing output\n")),
                  ),
                ),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
              }),
            ),
          ),
        );

        const runFiber = yield* DesktopBackendManager.runBackendProcess({
          ...baseConfig,
          desktopTelemetryStream: Stream.empty,
          onExitObserved: () => Deferred.succeed(exitObserved, void 0).pipe(Effect.asVoid),
        }).pipe(
          Effect.provide(Layer.merge(layerSpawner, layerHealthyHttpClient)),
          Effect.forkChild,
        );

        yield* Deferred.await(exitObserved);
        assert.isUndefined(runFiber.pollUnsafe());

        yield* Deferred.succeed(finishOutputDrain, void 0);
        assert.equal((yield* Fiber.join(runFiber)).code.pipe(Option.getOrUndefined), 1);
      }),
    ),
  );

  it.effect("continues routing desktop telemetry control messages after an invalid line", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handled = yield* Deferred.make<boolean>();
        const controlMessage = encodeDesktopTelemetryControl({
          version: 1,
          type: "setDiagnosticsDemand",
          enabled: true,
        });
        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeProcess({
                getOutputFd: (fd) =>
                  fd === 5
                    ? Stream.encodeText(Stream.make(`not-json\n${controlMessage}\n`))
                    : Stream.empty,
                exitCode: Deferred.await(handled).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              }),
            ),
          ),
        );
        const instance = yield* makeTestInstance({
          spawnerLayer: layerSpawner,
          desktopTelemetryPublisher: {
            handleControlForSource: (_sourceId, message) =>
              message.type === "setDiagnosticsDemand"
                ? Deferred.succeed(handled, message.enabled).pipe(Effect.asVoid)
                : Effect.void,
          },
        });

        yield* instance.start;
        assert.isTrue(yield* Deferred.await(handled));
      }),
    ),
  );

  it.effect("drains trailing child output before persisting an unexpected exit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const persistedOutput = yield* Deferred.make<ReadonlyArray<string>>();
        const outputDrainStarted = yield* Deferred.make<void>();
        const outputChunks = yield* Ref.make<Array<string>>([]);
        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeProcess({
                stdout: Stream.fromEffect(
                  Deferred.succeed(outputDrainStarted, void 0).pipe(
                    Effect.andThen(Effect.sleep(Duration.seconds(1))),
                    Effect.as(new TextEncoder().encode("trailing output\n")),
                  ),
                ),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
              }),
            ),
          ),
        );
        const instance = yield* makeTestInstance({
          spawnerLayer: layerSpawner,
          httpClientLayer: layerHttpClient(() => Effect.never),
          backendOutputLog: {
            writeOutputChunk: (_streamName, chunk) =>
              Ref.update(outputChunks, (current) => [...current, new TextDecoder().decode(chunk)]),
            persistFailure: () =>
              Ref.get(outputChunks).pipe(
                Effect.flatMap((chunks) => Deferred.succeed(persistedOutput, chunks)),
                Effect.asVoid,
              ),
          },
        });

        yield* instance.start;
        yield* Deferred.await(outputDrainStarted);
        yield* TestClock.adjust(Duration.seconds(1));

        assert.deepEqual(yield* Deferred.await(persistedOutput), ["trailing output\n"]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("retries HTTP readiness before reporting the backend ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requestUrls: Array<string> = [];
        const prunedRuntimes: Array<[string | null, string]> = [];
        const statuses = [503, 200];
        let readyCount = 0;
        const firstRequest = yield* Deferred.make<void>();
        const backendReady = yield* Deferred.make<void>();
        const processExit = yield* Deferred.make<void>();
        const pruneComplete = yield* Deferred.make<void>();
        const exited = yield* Queue.unbounded<void>();

        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeProcess({
                exitCode: Deferred.await(processExit).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(0)),
                ),
              }),
            ),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer: layerSpawner,
          config: {
            ...baseConfig,
            runningDistro: "Ubuntu",
            wslRuntimeId: "1.2.3-x64",
          },
          pruneRuntimes: (distro, runtimeId) =>
            Effect.sync(() => {
              prunedRuntimes.push([distro, runtimeId]);
            }).pipe(Effect.andThen(Deferred.succeed(pruneComplete, void 0)), Effect.asVoid),
          httpClientLayer: layerHttpClient((request) =>
            Effect.gen(function* () {
              const status = statuses.shift();
              assert.isDefined(status);
              requestUrls.push(request.url);
              yield* Deferred.succeed(firstRequest, void 0);
              return responseForRequest(request, status);
            }),
          ),
          onReady: Effect.sync(() => {
            readyCount += 1;
          }).pipe(Effect.andThen(Deferred.succeed(backendReady, void 0)), Effect.asVoid),
          backendOutputLog: {
            persistFailure: () => Queue.offer(exited, void 0).pipe(Effect.asVoid),
          },
        });

        yield* instance.start;
        yield* Deferred.await(firstRequest);

        assert.equal(readyCount, 0);
        assert.deepEqual(prunedRuntimes, []);
        assert.deepEqual(requestUrls, ["http://127.0.0.1:3773/.well-known/t3/environment"]);

        yield* TestClock.adjust(Duration.millis(100));
        yield* Deferred.await(backendReady);
        yield* Deferred.await(pruneComplete);
        yield* Deferred.succeed(processExit, void 0);
        yield* Queue.take(exited);

        assert.equal(readyCount, 1);
        assert.deepEqual(prunedRuntimes, [["Ubuntu", "1.2.3-x64"]]);
        assert.deepEqual(requestUrls, [
          "http://127.0.0.1:3773/.well-known/t3/environment",
          "http://127.0.0.1:3773/.well-known/t3/environment",
        ]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect(
    "re-probes readiness after the first budget expires while the backend is still alive",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const requestUrls: Array<string> = [];
          let requestCount = 0;
          let readyCount = 0;
          let readinessTimeoutCount = 0;
          const firstProbe = yield* Deferred.make<void>();
          const childExit = yield* Deferred.make<void>();

          const layerSpawner = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.succeed(
                makeProcess({
                  exitCode: Deferred.await(childExit).pipe(
                    Effect.as(ChildProcessSpawner.ExitCode(0)),
                  ),
                }),
              ),
            ),
          );

          // The backend stays 503 through the first *two* readiness budgets
          // and only becomes healthy (200) for the third round, i.e. it comes
          // up well after the initial 50ms budget has expired.
          const layerHttp = layerHttpClient((request) =>
            Effect.gen(function* () {
              requestCount += 1;
              requestUrls.push(request.url);
              yield* Deferred.succeed(firstProbe, void 0);
              return responseForRequest(request, requestCount <= 2 ? 503 : 200);
            }),
          );

          const runFiber = yield* DesktopBackendManager.runBackendProcess({
            ...baseConfig,
            desktopTelemetryStream: Stream.empty,
            readinessTimeout: Duration.millis(50),
            onReady: () =>
              Effect.sync(() => {
                readyCount += 1;
              }),
            onReadinessFailure: () =>
              Effect.sync(() => {
                readinessTimeoutCount += 1;
              }),
          }).pipe(Effect.provide(Layer.merge(layerSpawner, layerHttp)), Effect.forkChild);

          yield* Deferred.await(firstProbe);
          assert.equal(readyCount, 0);
          assert.equal(readinessTimeoutCount, 0);

          // The first 50ms readiness budget expires while the backend still
          // answers 503. The child is alive and may yet become healthy, so the
          // probe must start a fresh round instead of stopping permanently —
          // the pre-fix behavior left the app stuck on "Connecting to WSL…"
          // forever even though the backend kept running.
          yield* TestClock.adjust(Duration.millis(50));
          assert.equal(readinessTimeoutCount, 1);
          assert.equal(readyCount, 0);

          // The second budget also expires (backend still 503), then the third
          // round connects. The point is the probe persisted across budgets
          // while the process was alive instead of giving up after the first.
          yield* TestClock.adjust(Duration.millis(100));
          assert.equal(readinessTimeoutCount, 2);
          assert.equal(readyCount, 1);
          assert.equal(requestUrls.length, 3);

          yield* Deferred.succeed(childExit, void 0);
          assert.equal((yield* Fiber.join(runFiber)).code.pipe(Option.getOrUndefined), 0);
        }).pipe(Effect.provide(TestClock.layer())),
      ),
  );

  it.effect("starts the configured backend and closes the scoped process on stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let startCount = 0;
        let closedCount = 0;
        const closed = yield* Deferred.make<void>();
        const teardownStarted = yield* Deferred.make<void>();
        const finishTeardown = yield* Deferred.make<void>();
        const startedPids = yield* Queue.unbounded<number>();
        const ready = yield* Deferred.make<void>();
        const backendReadyFlag = yield* Ref.make(false);
        let shutdownCount = 0;
        let persistedFailureCount = 0;
        let discardedSessionCount = 0;
        let removedTelemetrySources = 0;

        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              startCount += 1;
              yield* Queue.offer(startedPids, 123);
              const close = Deferred.succeed(teardownStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishTeardown)),
                Effect.andThen(
                  Effect.sync(() => {
                    closedCount += 1;
                  }),
                ),
                Effect.andThen(Deferred.succeed(closed, void 0)),
                Effect.asVoid,
              );

              yield* Scope.addFinalizer(scope, close);

              return makeProcess({
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
                kill: () => close,
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer: layerSpawner,
          onReady: Ref.set(backendReadyFlag, true).pipe(
            Effect.andThen(Deferred.succeed(ready, void 0)),
            Effect.asVoid,
          ),
          onShutdown: Ref.set(backendReadyFlag, false).pipe(
            Effect.andThen(
              Effect.sync(() => {
                shutdownCount += 1;
              }),
            ),
          ),
          backendOutputLog: {
            persistFailure: () =>
              Effect.sync(() => {
                persistedFailureCount += 1;
              }),
            discardSession: Effect.sync(() => {
              discardedSessionCount += 1;
            }),
          },
          desktopTelemetryPublisher: {
            removeControlSource: () =>
              Effect.sync(() => {
                removedTelemetrySources += 1;
              }),
          },
        });
        assert.isTrue(Option.isNone(yield* instance.currentConfig));

        yield* instance.start;
        assert.equal(yield* Queue.take(startedPids), 123);
        yield* Deferred.await(ready);
        assert.isTrue(yield* Ref.get(backendReadyFlag));
        assert.deepEqual(yield* instance.currentConfig, Option.some(baseConfig));

        const runningSnapshot = yield* instance.snapshot;
        assert.equal(runningSnapshot.ready, true);
        assert.deepEqual(runningSnapshot.activePid, Option.some(123));

        const stopFiber = yield* instance.stop().pipe(Effect.forkChild);
        yield* Deferred.await(teardownStarted).pipe(Effect.timeout("1 second"));
        assert.isFalse(yield* Ref.get(backendReadyFlag));
        assert.equal(shutdownCount, 1);
        yield* Deferred.succeed(finishTeardown, undefined);
        yield* Fiber.join(stopFiber).pipe(Effect.timeout("1 second"));
        assert.equal(startCount, 1);
        assert.equal(closedCount, 1);
        assert.equal(persistedFailureCount, 0);
        assert.equal(discardedSessionCount, 1);
        assert.equal(removedTelemetrySources, 1);

        const stoppedSnapshot = yield* instance.snapshot;
        assert.isFalse(yield* Ref.get(backendReadyFlag));
        assert.equal(shutdownCount, 1);
        assert.equal(stoppedSnapshot.desiredRunning, false);
        assert.equal(stoppedSnapshot.ready, false);
        assert.equal(Option.isNone(stoppedSnapshot.activePid), true);
      }),
    ),
  );

  it.effect("restarts when start is requested during stop teardown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        const teardownStarted = yield* Deferred.make<void>();
        const finishTeardown = yield* Deferred.make<void>();
        let startCount = 0;

        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              const closed = yield* Deferred.make<void>();
              startCount += 1;
              yield* Queue.offer(starts, startCount);
              if (startCount === 1) {
                yield* Scope.addFinalizer(
                  scope,
                  Deferred.succeed(teardownStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(finishTeardown)),
                    Effect.andThen(Deferred.succeed(closed, undefined)),
                    Effect.asVoid,
                  ),
                );
              } else {
                yield* Scope.addFinalizer(
                  scope,
                  Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
                );
              }
              return makeProcess({
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer: layerSpawner,
          httpClientLayer: layerHttpClient(() => Effect.never),
        });

        yield* instance.start;
        assert.equal(yield* Queue.take(starts), 1);

        const stopFiber = yield* instance.stop().pipe(Effect.forkChild);
        yield* Deferred.await(teardownStarted).pipe(Effect.timeout("1 second"));
        yield* instance.start;
        assert.equal((yield* instance.snapshot).desiredRunning, true);

        yield* Deferred.succeed(finishTeardown, undefined);
        yield* Fiber.join(stopFiber).pipe(Effect.timeout("1 second"));
        yield* TestClock.adjust(Duration.millis(500));

        assert.equal(yield* Queue.take(starts).pipe(Effect.timeout("1 second")), 2);
        const restarted = yield* instance.snapshot;
        assert.equal(restarted.desiredRunning, true);
        assert.deepEqual(restarted.activePid, Option.some(123));
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("retries config resolution after a start request during stop teardown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        const teardownStarted = yield* Deferred.make<void>();
        const finishTeardown = yield* Deferred.make<void>();
        const configAttempts = yield* Ref.make(0);
        let startCount = 0;

        const configFailure = PlatformError.systemError({
          _tag: "Unknown",
          module: "DesktopBackendManager",
          method: "configResolve",
          description: "transient configuration failure",
        });
        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              const closed = yield* Deferred.make<void>();
              startCount += 1;
              yield* Queue.offer(starts, startCount);
              if (startCount === 1) {
                yield* Scope.addFinalizer(
                  scope,
                  Deferred.succeed(teardownStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(finishTeardown)),
                    Effect.andThen(Deferred.succeed(closed, undefined)),
                    Effect.asVoid,
                  ),
                );
              } else {
                yield* Scope.addFinalizer(
                  scope,
                  Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
                );
              }
              return makeProcess({
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
          ),
        );
        const configResolve = Ref.updateAndGet(configAttempts, (attempt) => attempt + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 2 ? Effect.fail(configFailure) : Effect.succeed(baseConfig),
          ),
        );
        const instance = yield* makeTestInstance({
          spawnerLayer: layerSpawner,
          configResolve,
          httpClientLayer: layerHttpClient(() => Effect.never),
        });

        yield* instance.start;
        assert.equal(yield* Queue.take(starts), 1);

        const stopFiber = yield* instance.stop().pipe(Effect.forkChild);
        yield* Deferred.await(teardownStarted).pipe(Effect.timeout("1 second"));
        yield* instance.start;
        yield* Deferred.succeed(finishTeardown, undefined);
        yield* Fiber.join(stopFiber).pipe(Effect.timeout("1 second"));

        const pendingRestart = yield* instance.snapshot;
        assert.equal(pendingRestart.desiredRunning, true);
        assert.equal(pendingRestart.restartScheduled, true);

        yield* TestClock.adjust(Duration.seconds(2));

        assert.equal(yield* Queue.take(starts).pipe(Effect.timeout("1 second")), 2);
        assert.equal(yield* Ref.get(configAttempts), 3);
        assert.equal((yield* instance.snapshot).desiredRunning, true);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("keeps a timed-out run active until its process exits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        const teardownStarted = yield* Deferred.make<void>();
        const finishTeardown = yield* Deferred.make<void>();
        let startCount = 0;

        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              const closed = yield* Deferred.make<void>();
              startCount += 1;
              yield* Queue.offer(starts, startCount);
              if (startCount === 1) {
                yield* Scope.addFinalizer(
                  scope,
                  Deferred.succeed(teardownStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(finishTeardown)),
                    Effect.andThen(Deferred.succeed(closed, undefined)),
                    Effect.asVoid,
                  ),
                );
              } else {
                yield* Scope.addFinalizer(
                  scope,
                  Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
                );
              }
              return makeProcess({
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer: layerSpawner,
          httpClientLayer: layerHttpClient(() => Effect.never),
        });

        yield* instance.start;
        assert.equal(yield* Queue.take(starts), 1);

        const stopFiber = yield* instance
          .stop({ timeout: Duration.millis(100) })
          .pipe(Effect.forkChild);
        yield* Deferred.await(teardownStarted).pipe(Effect.timeout("1 second"));
        yield* instance.start;
        yield* TestClock.adjust(Duration.millis(100));
        yield* Fiber.join(stopFiber).pipe(Effect.timeout("1 second"));

        assert.equal(startCount, 1);
        const timedOut = yield* instance.snapshot;
        assert.equal(timedOut.desiredRunning, true);
        assert.deepEqual(timedOut.activePid, Option.some(123));

        yield* Deferred.succeed(finishTeardown, undefined);
        yield* TestClock.adjust(Duration.millis(500));

        assert.equal(yield* Queue.take(starts).pipe(Effect.timeout("1 second")), 2);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("does not notify shutdown before the first start has prior state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let shutdownCount = 0;
        const closed = yield* Deferred.make<void>();
        const startedPids = yield* Queue.unbounded<number>();

        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              yield* Queue.offer(startedPids, 123);
              const close = Deferred.succeed(closed, void 0).pipe(Effect.asVoid);
              return makeProcess({
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
                kill: () => close,
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer: layerSpawner,
          httpClientLayer: layerHttpClient(() => Effect.never),
          onShutdown: Effect.sync(() => {
            shutdownCount += 1;
          }),
        });

        yield* instance.start;
        assert.equal(yield* Queue.take(startedPids), 123);
        assert.equal(shutdownCount, 0);
      }),
    ),
  );

  it.effect("restarts an unexpectedly exited backend with the Effect clock", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        const failures = yield* Queue.unbounded<string>();
        let startCount = 0;

        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.sync(() => {
              startCount += 1;
              return makeProcess({
                exitCode: Queue.offer(starts, startCount).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(1)),
                ),
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer: layerSpawner,
          httpClientLayer: layerHttpClient(() => Effect.never),
          backendOutputLog: {
            persistFailure: ({ details }) => Queue.offer(failures, details).pipe(Effect.asVoid),
          },
        });

        yield* instance.start;

        assert.equal(yield* Queue.take(starts), 1);
        assert.equal(yield* Queue.take(failures), "pid=123 code=1");

        yield* TestClock.adjust(Duration.millis(499));
        assert.equal(yield* Queue.size(starts), 0);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(yield* Queue.take(starts), 2);

        yield* TestClock.adjust(Duration.millis(999));
        assert.equal(yield* Queue.size(starts), 0);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(yield* Queue.take(starts), 3);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("does not notify shutdown when a scheduled restart starts from non-ready state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let shutdownCount = 0;

        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected backend spawn")),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer: layerSpawner,
          config: {
            ...baseConfig,
            preflightFailure: Option.some({ reason: "preflight failed", fatal: false }),
          },
          onShutdown: Effect.sync(() => {
            shutdownCount += 1;
          }),
        });

        yield* instance.start;
        assert.equal(shutdownCount, 0);

        yield* TestClock.adjust(Duration.millis(500));
        assert.equal(shutdownCount, 0);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("surfaces a fatal preflight failure once and stops looping after the cap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failures: string[] = [];
        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected backend spawn")),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer: layerSpawner,
          config: {
            ...baseConfig,
            preflightFailure: Option.some({ reason: "Node.js not found", fatal: true }),
          },
          onPreflightFailed: (failure) =>
            Effect.sync(() => {
              failures.push(failure.reason);
            }).pipe(Effect.as(false)),
        });

        yield* instance.start;
        assert.deepEqual(failures, []);

        // Five fatal attempts with exponential backoff (500ms, 1s, 2s, 4s) reach
        // the cap, at which point the failure is surfaced exactly once.
        yield* TestClock.adjust(Duration.millis(500));
        yield* TestClock.adjust(Duration.seconds(1));
        yield* TestClock.adjust(Duration.seconds(2));
        yield* TestClock.adjust(Duration.seconds(4));
        assert.deepEqual(failures, ["Node.js not found"]);

        // Past the cap the loop stops and nothing else is surfaced.
        yield* TestClock.adjust(Duration.seconds(8));
        yield* TestClock.adjust(Duration.seconds(30));
        assert.deepEqual(failures, ["Node.js not found"]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("can be started again after a fatal preflight cap once config recovers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failing = yield* Ref.make(true);
        const starts = yield* Queue.unbounded<number>();
        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Queue.offer(starts, 123).pipe(
              Effect.as(
                makeProcess({
                  exitCode: Effect.never,
                }),
              ),
            ),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer: layerSpawner,
          configResolve: Ref.get(failing).pipe(
            Effect.map((isFailing) =>
              isFailing
                ? {
                    ...baseConfig,
                    preflightFailure: Option.some({
                      reason: "Node.js not found",
                      fatal: true,
                    }),
                  }
                : baseConfig,
            ),
          ),
        });

        yield* instance.start;
        yield* TestClock.adjust(Duration.millis(500));
        yield* TestClock.adjust(Duration.seconds(1));
        yield* TestClock.adjust(Duration.seconds(2));
        yield* TestClock.adjust(Duration.seconds(4));
        yield* TestClock.adjust(Duration.seconds(8));

        const parked = yield* instance.snapshot;
        assert.equal(parked.desiredRunning, false);
        assert.equal(parked.ready, false);
        assert.isTrue(Option.isNone(parked.activePid));
        assert.equal(parked.restartScheduled, false);
        assert.equal(yield* Queue.size(starts), 0);

        yield* Ref.set(failing, false);
        yield* instance.start;

        assert.equal(yield* Queue.take(starts), 123);
        const running = yield* instance.snapshot;
        assert.equal(running.desiredRunning, true);
        assert.deepEqual(running.activePid, Option.some(123));
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("keeps retrying a transient (non-fatal) preflight failure without surfacing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failures: string[] = [];
        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected backend spawn")),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer: layerSpawner,
          config: {
            ...baseConfig,
            preflightFailure: Option.some({ reason: "wslpath conversion failed", fatal: false }),
          },
          onPreflightFailed: (failure) =>
            Effect.sync(() => {
              failures.push(failure.reason);
            }).pipe(Effect.as(false)),
        });

        yield* instance.start;
        // Well beyond the fatal cap's worth of time: a transient failure must
        // keep retrying (self-heal) and never surface.
        yield* TestClock.adjust(Duration.minutes(2));
        assert.deepEqual(failures, []);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("surfaces a bounded transient preflight failure after its retry limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failures: string[] = [];
        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected backend spawn")),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer: layerSpawner,
          config: {
            ...baseConfig,
            preflightFailure: Option.some({
              reason: "WSL toolchain probe timed out",
              fatal: false,
              retryLimit: 3,
            }),
          },
          onPreflightFailed: (failure) =>
            Effect.sync(() => {
              failures.push(failure.reason);
            }).pipe(Effect.as(false)),
        });

        yield* instance.start;
        yield* TestClock.adjust(Duration.millis(500));
        assert.deepEqual(failures, []);

        yield* TestClock.adjust(Duration.seconds(1));
        assert.deepEqual(failures, ["WSL toolchain probe timed out"]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("cancels a scheduled restart when start is requested manually", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        const secondClosed = yield* Deferred.make<void>();
        let startCount = 0;

        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              startCount += 1;
              yield* Queue.offer(starts, startCount);

              if (startCount === 1) {
                return makeProcess({
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                });
              }

              const scope = yield* Scope.Scope;
              const close = Deferred.succeed(secondClosed, void 0).pipe(Effect.asVoid);
              yield* Scope.addFinalizer(scope, close);
              return makeProcess({
                exitCode: Deferred.await(secondClosed).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(0)),
                ),
                kill: () => close,
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer: layerSpawner,
          httpClientLayer: layerHttpClient(() => Effect.never),
        });

        yield* instance.start;

        assert.equal(yield* Queue.take(starts), 1);
        let restartScheduled = false;
        while (!restartScheduled) {
          restartScheduled = (yield* instance.snapshot).restartScheduled;
          if (!restartScheduled) {
            yield* Effect.yieldNow;
          }
        }

        yield* instance.start;
        assert.equal(yield* Queue.take(starts), 2);

        yield* instance.stop();
        yield* TestClock.adjust(Duration.millis(500));

        assert.equal(yield* Queue.size(starts), 0);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("does not restart after stop cancels a scheduled restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        let startCount = 0;

        const layerSpawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.sync(() => {
              startCount += 1;
              return makeProcess({
                exitCode: Queue.offer(starts, startCount).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(1)),
                ),
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer: layerSpawner,
          httpClientLayer: layerHttpClient(() => Effect.never),
        });

        yield* instance.start;
        assert.equal(yield* Queue.take(starts), 1);

        let restartScheduled = false;
        while (!restartScheduled) {
          restartScheduled = (yield* instance.snapshot).restartScheduled;
          if (!restartScheduled) {
            yield* Effect.yieldNow;
          }
        }

        yield* instance.stop();
        yield* TestClock.adjust(Duration.millis(500));

        assert.equal(yield* Queue.size(starts), 0);
        assert.equal((yield* instance.snapshot).desiredRunning, false);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect(
    "inactive Windows MAIN witness is injected only, retains raw identity, and revokes on stop",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const exited = yield* Deferred.make<void>();
          const launch = {
            expectedExecutablePath: "C:\\Apps\\t3.exe",
            entryPath: "C:\\Server\\bin.mjs",
            entrySha256: "a".repeat(64),
            args: ["C:\\Server\\bin.mjs", "--bootstrap-fd", "3"],
            cwd: "C:\\Server",
            electronRunAsNode: true as const,
            capturedBeforeSpawn: true as const,
          };
          let prepareCount = 0;
          let observeCount = 0;
          let revoked = 0;
          const seam: InactiveWindowsBackendProcessWitnessSeam = {
            prepareLaunch: async (input) => {
              prepareCount++;
              assert.equal(input.entryPath, launch.entryPath);
              return launch;
            },
            observeStarted: async ({ pid, runId, launch: startedLaunch }) => {
              observeCount++;
              assert.equal(pid, 123);
              assert.equal(runId, 1);
              assert.equal(startedLaunch, launch);
              let closed = false;
              return {
                readCurrent: () =>
                  closed
                    ? null
                    : {
                        pid,
                        processCreationFiletimeTicks: "133700000000000009",
                        creationFileTimeHex: "01db1cbb9a101109",
                        createdAtEpochMs: 1_725_526_400_000,
                        osExecutablePath: "C:\\Apps\\t3.exe",
                        launch,
                      },
                revoke: () => {
                  if (!closed) {
                    closed = true;
                    revoked++;
                  }
                },
              };
            },
          };
          const instance = yield* makeTestInstance({
            config: {
              ...baseConfig,
              executablePath: launch.expectedExecutablePath,
              entryPath: launch.entryPath,
              cwd: launch.cwd,
              args: [...launch.args],
            },
            inactiveWindowsProcessWitness: seam,
            spawnerLayer: Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() =>
                Effect.gen(function* () {
                  const scope = yield* Scope.Scope;
                  yield* Scope.addFinalizer(
                    scope,
                    Deferred.succeed(exited, void 0).pipe(Effect.asVoid),
                  );
                  return makeProcess({
                    exitCode: Deferred.await(exited).pipe(
                      Effect.as(ChildProcessSpawner.ExitCode(0)),
                    ),
                  });
                }),
              ),
            ),
            onReady: Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
          });
          // No W1 observer is called on construction, before child spawn.
          assert.equal(prepareCount, 0);
          assert.isNull(yield* instance.inactiveWindowsWitnessSnapshot!);
          yield* instance.start;
          yield* Deferred.await(ready);
          const current = yield* instance.inactiveWindowsWitnessSnapshot!;
          assert.equal(prepareCount, 1);
          assert.equal(observeCount, 1);
          assert.equal(current?.processCreationFiletimeTicks, "133700000000000009");
          assert.equal(current?.launch.entrySha256, "a".repeat(64));
          yield* instance.stop();
          assert.isNull(yield* instance.inactiveWindowsWitnessSnapshot!);
          assert.equal(revoked, 1);
          yield* Deferred.succeed(exited, undefined);
        }),
      ),
  );

  it.effect("inactive witness rejects WSL without spawning, and remains absent by default", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let spawned = 0;
        let prepared = 0;
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => {
            spawned++;
            return Effect.succeed(makeProcess());
          }),
        );
        const seam: InactiveWindowsBackendProcessWitnessSeam = {
          prepareLaunch: async () => {
            prepared++;
            throw new Error("should reject WSL before provenance");
          },
          observeStarted: async () => {
            throw new Error("should never run");
          },
        };
        const unsupported = yield* makeTestInstance({
          config: { ...baseConfig, runningDistro: "Ubuntu", bootstrapDelivery: "stdin" },
          inactiveWindowsProcessWitness: seam,
          spawnerLayer,
        });
        yield* unsupported.start;
        assert.equal(spawned, 0);
        assert.equal(prepared, 0);
        assert.isFalse((yield* unsupported.snapshot).desiredRunning);
        assert.isNull(yield* unsupported.inactiveWindowsWitnessSnapshot!);
        const normal = yield* makeTestInstance({
          spawnerLayer: Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.succeed(makeProcess({ exitCode: Effect.never }))),
          ),
        });
        assert.isNull(yield* normal.inactiveWindowsWitnessSnapshot!);
      }),
    ),
  );

  it.effect("stopAllPoolInstances bounds the quit finalizer when backends hang", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Each backend's process-scope finalizer reports when it starts and
        // when it finishes, keyed by instance name, so the test can prove
        // both backends reached each milestone instead of inferring it from
        // a shared flag or a clock advance.
        const teardownStarted = yield* Queue.unbounded<string>();
        const teardownFinished = yield* Queue.unbounded<string>();
        const allowTeardown = yield* Deferred.make<void>();

        const makeInstance = (name: string) =>
          makeTestInstance({
            spawnerLayer: Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() =>
                Effect.gen(function* () {
                  const scope = yield* Scope.Scope;
                  yield* Scope.addFinalizer(
                    scope,
                    Queue.offer(teardownStarted, name).pipe(
                      Effect.andThen(Deferred.await(allowTeardown)),
                      Effect.andThen(Queue.offer(teardownFinished, name)),
                      Effect.asVoid,
                    ),
                  );
                  return makeProcess({ exitCode: Effect.never });
                }),
              ),
            ),
            httpClientLayer: layerHttpClient(() => Effect.never),
          });

        const instance1 = yield* makeInstance("instance1");
        const instance2 = yield* makeInstance("instance2");

        yield* instance1.start;
        yield* instance2.start;

        const layerMockPool = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
          list: Effect.succeed([instance1, instance2]),
          get: () => Effect.succeedNone,
          primary: Effect.die(new Error("primary not implemented")),
          register: () => Effect.die(new Error("register not implemented")),
          unregister: () => Effect.die(new Error("unregister not implemented")),
        });

        // Mirror the quit path: register stopAllPoolInstances as a scope
        // finalizer and let the scope close run it, rather than calling it
        // as an ordinary interruptible effect.
        const quitFiber = yield* Effect.scoped(
          Effect.addFinalizer(() => DesktopApp.stopAllPoolInstances()),
        ).pipe(Effect.provide(layerMockPool), Effect.forkChild);

        const started = yield* Queue.takeN(teardownStarted, 2);
        assert.deepEqual(started.toSorted(), ["instance1", "instance2"]);

        // Both backends are now hung in teardown. Advancing past the 5s
        // budget must let the quit finalizer return without them.
        yield* TestClock.adjust(Duration.seconds(5));
        yield* Fiber.join(quitFiber);
        assert.equal(yield* Queue.size(teardownFinished), 0);

        // The timed-out closes keep running in the background and finish
        // once the backends unblock.
        yield* Deferred.succeed(allowTeardown, undefined);
        const finished = yield* Queue.takeN(teardownFinished, 2);
        assert.deepEqual(finished.toSorted(), ["instance1", "instance2"]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );
});
