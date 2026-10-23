// @effect-diagnostics nodeBuiltinImport:off -- The Windows OS HANDLE and entry bytes use Node's native adapter.
/**
 * INACTIVE Windows Desktop MAIN child-process observation primitive.
 *
 * OS proof here covers the process HANDLE, raw creation FILETIME and image,
 * NOT the Node entry script or argv. The latter are trusted MAIN launch
 * provenance, captured and hashed before spawn. Nothing in this module
 * enrolls a provider, issues a lease, starts a host or enables a native gate.
 *
 * The API seam is injected explicitly into DesktopBackendManager for tests
 * and a future separately approved MAIN owner. Production does not inject it.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as HostProcess from "@t3tools/shared/HostProcess";

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x0010_0000;
const WAIT_TIMEOUT = 0x0000_0102;
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;
const TICKS_PER_MILLISECOND = 10_000n;
const UINT32_MAX = 0xffff_ffff;

export interface WindowsBackendLaunchInput {
  readonly executablePath: string;
  readonly entryPath: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly bootstrapDelivery: "fd3" | "stdin";
  readonly runningDistro?: string;
}

export interface TrustedWindowsBackendLaunchProvenance {
  /** MAIN supplied executable path; compare independently to OS image. */
  readonly expectedExecutablePath: string;
  /** Trusted original MAIN launch record, NOT an OS-observed entry script. */
  readonly entryPath: string;
  readonly entrySha256: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly electronRunAsNode: true;
  readonly capturedBeforeSpawn: true;
}

/** Win32 FILETIME is unsigned 64-bit 100ns ticks since 1601, not epoch-ms. */
export function fileTimeFromHighLow(high: number, low: number): bigint {
  if (
    !Number.isInteger(high) ||
    high < 0 ||
    high > UINT32_MAX ||
    !Number.isInteger(low) ||
    low < 0 ||
    low > UINT32_MAX
  ) {
    throw new Error("Invalid unsigned Win32 FILETIME halves.");
  }
  return (BigInt(high) << 32n) | BigInt(low);
}

/** Only for informational reporting; never use this rounded value for identity. */
export function fileTimeEpochMs(raw: bigint): number {
  if (raw < FILETIME_UNIX_EPOCH || raw > 0xffff_ffff_ffff_ffffn) {
    throw new Error("Invalid Win32 process creation FILETIME.");
  }
  const ms = (raw - FILETIME_UNIX_EPOCH) / TICKS_PER_MILLISECOND;
  if (ms > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Win32 FILETIME cannot be represented as safe epoch milliseconds.");
  }
  return Number(ms);
}

export function canonicalWindowsImagePath(path: string): string {
  if (typeof path !== "string" || !/^[a-z]:[\\/]/i.test(path)) {
    throw new Error("Expected a fully qualified Windows executable path.");
  }
  return path.replace(/\//g, "\\").toLowerCase();
}

export async function captureTrustedWindowsBackendLaunch(
  input: WindowsBackendLaunchInput,
  readEntry: (path: string) => Promise<Uint8Array> = NodeFSP.readFile,
): Promise<TrustedWindowsBackendLaunchProvenance> {
  if (
    input.bootstrapDelivery !== "fd3" ||
    input.runningDistro !== undefined ||
    input.env.ELECTRON_RUN_AS_NODE !== "1" ||
    (input.args.length !== 3 && input.args.length !== 5) ||
    input.args.filter((arg) => arg === input.entryPath).length !== 1 ||
    input.args.at(-3) !== input.entryPath ||
    input.args.at(-2) !== "--bootstrap-fd" ||
    input.args.at(-1) !== "3" ||
    (input.args.length === 5 && (input.args[0] !== "--require" || !input.args[1]))
  ) {
    throw new Error("Refusing non-Windows, non-primary or unrecognized MAIN launch provenance.");
  }
  canonicalWindowsImagePath(input.executablePath);
  if (!input.entryPath || !input.cwd || input.args.length > 8) {
    throw new Error("Incomplete trusted backend launch provenance.");
  }
  const entrySha256 = NodeCrypto.createHash("sha256")
    .update(await readEntry(input.entryPath))
    .digest("hex");
  return Object.freeze({
    expectedExecutablePath: input.executablePath,
    entryPath: input.entryPath,
    entrySha256,
    args: Object.freeze([...input.args]),
    cwd: input.cwd,
    electronRunAsNode: true,
    capturedBeforeSpawn: true,
  } satisfies TrustedWindowsBackendLaunchProvenance);
}

export interface WindowsReadOnlyProcessApi {
  /** PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE; never PROCESS_ALL_ACCESS. */
  readonly openProcess: (pid: number) => bigint;
  /** True only for WAIT_TIMEOUT (still running); WAIT_FAILED must throw. */
  readonly isRunning: (handle: bigint) => boolean;
  /** Raw unswizzled FILETIME; must not truncate to JS Number / epoch-ms. */
  readonly creationFileTime: (handle: bigint) => bigint;
  readonly imagePath: (handle: bigint) => string;
  readonly closeHandle: (handle: bigint) => void;
}

export interface WindowsBackendProcessWitnessSnapshot {
  readonly pid: number;
  /** Exact unsigned decimal 100ns FILETIME ticks; never compare only milliseconds. */
  readonly processCreationFiletimeTicks: string;
  /** Always 16 lower-case hex digits of the original 64-bit Win32 creation time. */
  readonly creationFileTimeHex: string;
  /** Informational only; NEVER identity comparison. */
  readonly createdAtEpochMs: number;
  /** OS QueryFullProcessImageNameW observation, not the caller's path. */
  readonly osExecutablePath: string;
  /** Recorded trusted MAIN entrypoint/argv/hash, NOT OS command-line proof. */
  readonly launch: TrustedWindowsBackendLaunchProvenance;
}

export interface RetainedWindowsBackendProcessWitness {
  /** Re-check same retained HANDLE and freshly opened PID handle. Fail-closed. */
  readonly readCurrent: () => WindowsBackendProcessWitnessSnapshot | null;
  /** Idempotent. Closes the retained OS handle and invalidates all snapshots. */
  readonly revoke: (reason: string) => void;
}

export function observeWindowsBackendProcess(input: {
  readonly pid: number;
  readonly launch: TrustedWindowsBackendLaunchProvenance;
  readonly api: WindowsReadOnlyProcessApi;
}): RetainedWindowsBackendProcessWitness {
  const { pid, launch, api } = input;
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > UINT32_MAX) {
    throw new Error("Invalid Windows child process ID.");
  }
  const expectedImage = canonicalWindowsImagePath(launch.expectedExecutablePath);
  if (
    launch.capturedBeforeSpawn !== true ||
    launch.electronRunAsNode !== true ||
    !/^[0-9a-f]{64}$/.test(launch.entrySha256)
  ) {
    throw new Error("Missing trusted MAIN pre-spawn launch provenance.");
  }
  const retained = api.openProcess(pid);
  if (retained === 0n) throw new Error("OpenProcess refused the backend child.");
  let revoked = false;
  const revoke = (_reason: string): void => {
    if (revoked) return;
    revoked = true;
    api.closeHandle(retained);
  };

  let createdAtRaw: bigint;
  let osImage: string;
  try {
    if (!api.isRunning(retained)) throw new Error("Backend already exited.");
    createdAtRaw = api.creationFileTime(retained);
    fileTimeEpochMs(createdAtRaw);
    osImage = api.imagePath(retained);
    if (canonicalWindowsImagePath(osImage) !== expectedImage) {
      throw new Error("OS process image does not match trusted MAIN executable.");
    }
  } catch (error) {
    try {
      revoke("initial-observation-failed");
    } catch {
      /* preserve the original observation failure */
    }
    throw error;
  }

  const snapshot = Object.freeze({
    pid,
    processCreationFiletimeTicks: createdAtRaw.toString(10),
    creationFileTimeHex: createdAtRaw.toString(16).padStart(16, "0"),
    createdAtEpochMs: fileTimeEpochMs(createdAtRaw),
    osExecutablePath: osImage,
    launch,
  } satisfies WindowsBackendProcessWitnessSnapshot);

  const readCurrent = (): WindowsBackendProcessWitnessSnapshot | null => {
    if (revoked) return null;
    try {
      if (
        !api.isRunning(retained) ||
        api.creationFileTime(retained) !== createdAtRaw ||
        canonicalWindowsImagePath(api.imagePath(retained)) !== expectedImage
      ) {
        revoke("retained-handle-mismatch");
        return null;
      }
      // A retained handle alone proves the original instance, but checking
      // the current PID occupant catches an unexpected PID-reuse race.
      const current = api.openProcess(pid);
      if (current === 0n) {
        revoke("current-pid-unavailable");
        return null;
      }
      let valid = false;
      try {
        valid =
          api.isRunning(current) &&
          api.creationFileTime(current) === createdAtRaw &&
          canonicalWindowsImagePath(api.imagePath(current)) === expectedImage;
      } finally {
        api.closeHandle(current);
      }
      if (!valid) {
        revoke("pid-reused-or-identity-drift");
        return null;
      }
      return snapshot;
    } catch {
      try {
        revoke("windows-process-api-error");
      } catch {
        /* fail-closed */
      }
      return null;
    }
  };
  return Object.freeze({ readCurrent, revoke } satisfies RetainedWindowsBackendProcessWitness);
}

/** Inactive injection contract. MAIN invokes this only when explicitly passed. */

/**
 * W2-B INACTIVE ONLY. A pair of independently retained Windows process
 * witnesses, never a host launcher or an enrolled provider identity.
 * Only a future MAIN owner can supply two handles observed by its own process
 * boundary; injectable fake handles in tests provide NO operating-system proof.
 */
export interface InactiveDualWindowsProcessSnapshot {
  readonly backend: WindowsBackendProcessWitnessSnapshot;
  readonly host: WindowsBackendProcessWitnessSnapshot;
}
export interface InactiveDualWindowsProcessWitness {
  readonly readCurrent: () => InactiveDualWindowsProcessSnapshot | null;
  readonly revoke: (reason: string) => void;
}
export function createInactiveDualWindowsProcessWitness(input: {
  readonly backend: RetainedWindowsBackendProcessWitness;
  readonly host: RetainedWindowsBackendProcessWitness;
}): InactiveDualWindowsProcessWitness {
  let revoked = false;
  const revoke = (reason: string): void => {
    if (revoked) return;
    revoked = true;
    for (const witness of [input.backend, input.host]) {
      try {
        witness.revoke(reason);
      } catch {
        /* irrevocable in this wrapper */
      }
    }
  };
  const originalBackend = input.backend.readCurrent();
  const originalHost = input.host.readCurrent();
  const same = (a: WindowsBackendProcessWitnessSnapshot, b: WindowsBackendProcessWitnessSnapshot) =>
    a.pid === b.pid &&
    a.processCreationFiletimeTicks === b.processCreationFiletimeTicks &&
    canonicalWindowsImagePath(a.osExecutablePath) ===
      canonicalWindowsImagePath(b.osExecutablePath) &&
    a.launch.capturedBeforeSpawn === true &&
    b.launch.capturedBeforeSpawn === true &&
    a.launch.entryPath === b.launch.entryPath &&
    a.launch.entrySha256 === b.launch.entrySha256 &&
    a.launch.expectedExecutablePath === b.launch.expectedExecutablePath &&
    a.launch.cwd === b.launch.cwd &&
    a.launch.electronRunAsNode === true &&
    b.launch.electronRunAsNode === true &&
    a.launch.args.length === b.launch.args.length &&
    a.launch.args.every((arg, index) => arg === b.launch.args[index]);
  if (
    !originalBackend ||
    !originalHost ||
    originalBackend.pid === originalHost.pid ||
    originalBackend.launch.entryPath === originalHost.launch.entryPath ||
    originalBackend.launch.entrySha256 === originalHost.launch.entrySha256
  ) {
    revoke("independent-process-handle-missing");
  }
  return Object.freeze({
    readCurrent(): InactiveDualWindowsProcessSnapshot | null {
      if (revoked || !originalBackend || !originalHost) return null;
      try {
        const backend = input.backend.readCurrent();
        const host = input.host.readCurrent();
        if (
          !backend ||
          !host ||
          backend.pid === host.pid ||
          !same(originalBackend, backend) ||
          !same(originalHost, host)
        ) {
          revoke("dual-process-handle-changed");
          return null;
        }
        return Object.freeze({ backend, host });
      } catch {
        revoke("dual-process-handle-error");
        return null;
      }
    },
    revoke,
  });
}

export interface InactiveWindowsBackendProcessWitnessSeam {
  readonly prepareLaunch: (
    input: WindowsBackendLaunchInput,
  ) => Promise<TrustedWindowsBackendLaunchProvenance>;
  readonly observeStarted: (input: {
    readonly pid: number;
    readonly runId: number;
    readonly launch: TrustedWindowsBackendLaunchProvenance;
  }) => Promise<RetainedWindowsBackendProcessWitness>;
}

/**
 * Load Win32 read-only APIs only when an explicit future MAIN owner injects
 * this factory; never at module import or in the current production default.
 * Query and synchronize handles, never elevation/termination/access changes.
 */
export async function loadWindowsReadOnlyProcessApi(): Promise<WindowsReadOnlyProcessApi> {
  if (HostProcess.Platform.defaultValue() !== "win32")
    throw new Error("Windows backend witness is Windows-only.");
  const { DataType, load, open } = await import("ffi-rs");
  const library = "t3-backend-process-witness-kernel32";
  open({ library, path: "kernel32.dll" });
  return {
    openProcess: (pid) =>
      load({
        library,
        funcName: "OpenProcess",
        retType: DataType.BigInt,
        paramsType: [DataType.U32, DataType.Boolean, DataType.U32],
        paramsValue: [PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, pid],
      }) as bigint,
    isRunning: (handle) => {
      const wait = load({
        library,
        funcName: "WaitForSingleObject",
        retType: DataType.U32,
        paramsType: [DataType.BigInt, DataType.U32],
        paramsValue: [handle, 0],
      }) as number;
      if (wait === WAIT_TIMEOUT) return true;
      if (wait === 0) return false;
      throw new Error("WaitForSingleObject failed to observe process liveness.");
    },
    creationFileTime: (handle) => {
      const creation = Buffer.alloc(8);
      const exit = Buffer.alloc(8);
      const kernel = Buffer.alloc(8);
      const user = Buffer.alloc(8);
      const ok = load({
        library,
        funcName: "GetProcessTimes",
        retType: DataType.Boolean,
        paramsType: [
          DataType.BigInt,
          DataType.U8Array,
          DataType.U8Array,
          DataType.U8Array,
          DataType.U8Array,
        ],
        paramsValue: [handle, creation, exit, kernel, user],
      });
      if (!ok) throw new Error("GetProcessTimes failed.");
      return fileTimeFromHighLow(creation.readUInt32LE(4), creation.readUInt32LE(0));
    },
    imagePath: (handle) => {
      const buffer = Buffer.alloc(2 * 32_768);
      const size = Buffer.alloc(4);
      size.writeUInt32LE(buffer.length / 2);
      const ok = load({
        library,
        funcName: "QueryFullProcessImageNameW",
        retType: DataType.Boolean,
        paramsType: [DataType.BigInt, DataType.U32, DataType.U8Array, DataType.U8Array],
        paramsValue: [handle, 0, buffer, size],
      });
      if (!ok || size.readUInt32LE(0) < 1) throw new Error("QueryFullProcessImageNameW failed.");
      return buffer.subarray(0, size.readUInt32LE(0) * 2).toString("utf16le");
    },
    closeHandle: (handle) => {
      if (
        !load({
          library,
          funcName: "CloseHandle",
          retType: DataType.Boolean,
          paramsType: [DataType.BigInt],
          paramsValue: [handle],
        })
      )
        throw new Error("CloseHandle failed.");
    },
  };
}

export function createInactiveWindowsBackendProcessWitnessSeam(
  apiProvider: () => Promise<WindowsReadOnlyProcessApi> = loadWindowsReadOnlyProcessApi,
): InactiveWindowsBackendProcessWitnessSeam {
  return {
    prepareLaunch: (input) => captureTrustedWindowsBackendLaunch(input),
    observeStarted: async (input) =>
      observeWindowsBackendProcess({
        pid: input.pid,
        launch: input.launch,
        api: await apiProvider(),
      }),
  };
}
