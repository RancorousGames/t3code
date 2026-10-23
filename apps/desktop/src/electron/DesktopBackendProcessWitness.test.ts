// @effect-diagnostics nodeBuiltinImport:off -- Verify native Node hashing at the OS boundary.
import * as NodeCrypto from "node:crypto";
import { assert, describe, it } from "@effect/vitest";

import {
  captureTrustedWindowsBackendLaunch,
  createInactiveDualWindowsProcessWitness,
  fileTimeEpochMs,
  fileTimeFromHighLow,
  observeWindowsBackendProcess,
  type TrustedWindowsBackendLaunchProvenance,
  type WindowsReadOnlyProcessApi,
} from "./DesktopBackendProcessWitness.ts";

const initialRaw = 116_444_736_000_000_000n + 123_456_789n;
const launch: TrustedWindowsBackendLaunchProvenance = Object.freeze({
  expectedExecutablePath: "C:\\Apps\\T3 Code\\t3.exe",
  entryPath: "C:\\T3\\server\\bin.mjs",
  entrySha256: "a".repeat(64),
  args: ["C:\\T3\\server\\bin.mjs", "--bootstrap-fd", "3"],
  cwd: "C:\\T3",
  electronRunAsNode: true,
  capturedBeforeSpawn: true,
});
const hostLaunch: TrustedWindowsBackendLaunchProvenance = Object.freeze({
  ...launch,
  entryPath: "C:\\T3\\host\\main.mjs",
  entrySha256: "b".repeat(64),
  args: ["C:\\T3\\host\\main.mjs", "--bootstrap-fd", "3"],
});

function fakeWindows(expectedPid = 4242) {
  const original = { alive: true, creation: initialRaw, image: "c:/apps/t3 code/T3.EXE" };
  const current = { alive: true, creation: initialRaw, image: "C:\\Apps\\T3 Code\\t3.exe" };
  const closed: bigint[] = [];
  let opens = 0;
  let errorOn: "open" | "liveness" | "times" | "image" | "close" | null = null;
  const api: WindowsReadOnlyProcessApi = {
    openProcess(pid) {
      assert.equal(pid, expectedPid);
      if (errorOn === "open") throw new Error("OpenProcess");
      return BigInt(++opens);
    },
    isRunning(handle) {
      if (errorOn === "liveness") throw new Error("WaitForSingleObject");
      return handle === 1n ? original.alive : current.alive;
    },
    creationFileTime(handle) {
      if (errorOn === "times") throw new Error("GetProcessTimes");
      return handle === 1n ? original.creation : current.creation;
    },
    imagePath(handle) {
      if (errorOn === "image") throw new Error("QueryFullProcessImageNameW");
      return handle === 1n ? original.image : current.image;
    },
    closeHandle(handle) {
      closed.push(handle);
      if (errorOn === "close") throw new Error("CloseHandle");
    },
  };
  return {
    api,
    original,
    current,
    closed,
    get opens() {
      return opens;
    },
    errorOn(value: typeof errorOn) {
      errorOn = value;
    },
  };
}

describe("inactive Windows Desktop MAIN process witness", () => {
  it("reuses two separate retained OS HANDLE observers and rejects host same-ms raw tick drift", () => {
    const backend = fakeWindows(4242);
    const host = fakeWindows(5252);
    const pair = createInactiveDualWindowsProcessWitness({
      backend: observeWindowsBackendProcess({ pid: 4242, launch, api: backend.api }),
      host: observeWindowsBackendProcess({ pid: 5252, launch: hostLaunch, api: host.api }),
    });
    assert.deepEqual([pair.readCurrent()?.backend.pid, pair.readCurrent()?.host.pid], [4242, 5252]);
    host.current.creation = initialRaw + 1n;
    assert.equal(fileTimeEpochMs(host.current.creation), fileTimeEpochMs(initialRaw));
    assert.isNull(pair.readCurrent());
    assert.isNull(pair.readCurrent());
    assert.isTrue(host.closed.includes(1n));
    assert.isTrue(backend.closed.includes(1n));
  });

  it("rejects missing, same-PID, wrong-image and changed launch origin in dual witness fixtures", () => {
    const noWitness = { readCurrent: () => null, revoke: () => {} };
    const backend = fakeWindows(4242);
    const sole = observeWindowsBackendProcess({ pid: 4242, launch, api: backend.api });
    const missing = createInactiveDualWindowsProcessWitness({ backend: sole, host: noWitness });
    assert.isNull(missing.readCurrent());

    const one = fakeWindows(4242);
    const two = fakeWindows(4242);
    const samePid = createInactiveDualWindowsProcessWitness({
      backend: observeWindowsBackendProcess({ pid: 4242, launch, api: one.api }),
      host: observeWindowsBackendProcess({ pid: 4242, launch, api: two.api }),
    });
    assert.isNull(samePid.readCurrent());

    const old = fakeWindows(4242);
    const newHost = fakeWindows(5252);
    const dual = createInactiveDualWindowsProcessWitness({
      backend: observeWindowsBackendProcess({ pid: 4242, launch, api: old.api }),
      host: observeWindowsBackendProcess({ pid: 5252, launch: hostLaunch, api: newHost.api }),
    });
    newHost.current.image = "C:\\\\other\\\\wrong.exe";
    assert.isNull(dual.readCurrent());

    const backend2 = fakeWindows(4242);
    const host2 = fakeWindows(5252);
    const w1 = observeWindowsBackendProcess({ pid: 4242, launch, api: backend2.api });
    const w2 = observeWindowsBackendProcess({ pid: 5252, launch: hostLaunch, api: host2.api });
    let replacedEntrypoint = false;
    const changedLaunch = createInactiveDualWindowsProcessWitness({
      backend: w1,
      host: {
        readCurrent: () => {
          const original = w2.readCurrent();
          return original && replacedEntrypoint
            ? { ...original, launch: { ...original.launch, entrySha256: "f".repeat(64) } }
            : original;
        },
        revoke: w2.revoke,
      },
    });
    assert.isNotNull(changedLaunch.readCurrent());
    replacedEntrypoint = true;
    assert.isNull(changedLaunch.readCurrent());
  });

  it("recombines exact unsigned FILETIME halves without 53-bit truncation", () => {
    assert.equal(fileTimeFromHighLow(0xfedcba98, 0x76543210), 0xfedcba9876543210n);
    assert.throws(() => fileTimeFromHighLow(-1, 4), /FILETIME/);
    assert.throws(() => fileTimeFromHighLow(4.1, 3), /FILETIME/);
    assert.throws(() => fileTimeEpochMs(0n), /FILETIME/);
    assert.equal(fileTimeEpochMs(initialRaw), 12_345);
    assert.equal(fileTimeEpochMs(initialRaw), fileTimeEpochMs(initialRaw + 1n));
  });

  it("records OS image and raw decimal 100ns ticks separately from trusted MAIN argv", () => {
    const host = fakeWindows();
    const witness = observeWindowsBackendProcess({ pid: 4242, launch, api: host.api });
    const current = witness.readCurrent();
    assert.isNotNull(current);
    assert.equal(current?.pid, 4242);
    assert.equal(current?.processCreationFiletimeTicks, initialRaw.toString());
    assert.equal(current?.creationFileTimeHex, initialRaw.toString(16).padStart(16, "0"));
    assert.equal(current?.createdAtEpochMs, 12_345);
    assert.equal(current?.osExecutablePath, host.original.image);
    assert.equal(current?.launch.entryPath, launch.entryPath);
    assert.equal(current?.launch.entrySha256, "a".repeat(64));
    assert.equal(host.opens, 2);
    assert.deepEqual(host.closed, [2n]);
    witness.revoke("test-end");
    witness.revoke("duplicate");
    assert.isNull(witness.readCurrent());
    assert.deepEqual(host.closed, [2n, 1n]);
  });

  it("rejects PID reuse with same PID and same projected epoch ms but different raw FILETIME", () => {
    const host = fakeWindows();
    const witness = observeWindowsBackendProcess({ pid: 4242, launch, api: host.api });
    host.current.creation = initialRaw + 1n;
    assert.equal(fileTimeEpochMs(host.current.creation), fileTimeEpochMs(initialRaw));
    assert.isNull(witness.readCurrent());
    assert.deepEqual(host.closed, [2n, 1n]);
  });

  it("rejects exited original HANDLE and current occupant, image drift and API failure", () => {
    for (const fault of [
      "original-exit",
      "current-exit",
      "image",
      "times",
      "open",
      "wait",
    ] as const) {
      const host = fakeWindows();
      const witness = observeWindowsBackendProcess({ pid: 4242, launch, api: host.api });
      switch (fault) {
        case "original-exit":
          host.original.alive = false;
          break;
        case "current-exit":
          host.current.alive = false;
          break;
        case "image":
          host.current.image = "C:\\Other\\not-t3.exe";
          break;
        case "times":
          host.errorOn("times");
          break;
        case "open":
          host.errorOn("open");
          break;
        case "wait":
          host.errorOn("liveness");
          break;
      }
      assert.isNull(witness.readCurrent(), fault);
      assert.isNull(witness.readCurrent(), fault);
      assert.isTrue(host.closed.includes(1n), fault);
    }
  });

  it("fails closed on observation errors and initial image mismatch", () => {
    for (const fault of ["first-exit", "first-image", "first-times", "open"] as const) {
      const host = fakeWindows();
      if (fault === "first-exit") host.original.alive = false;
      if (fault === "first-image") host.original.image = "C:\\Other\\unknown.exe";
      if (fault === "first-times") host.errorOn("times");
      if (fault === "open") host.errorOn("open");
      assert.throws(() => observeWindowsBackendProcess({ pid: 4242, launch, api: host.api }));
      if (fault !== "open") assert.deepEqual(host.closed, [1n]);
    }
    const host = fakeWindows();
    assert.throws(() => observeWindowsBackendProcess({ pid: 0, launch, api: host.api }));
    assert.throws(() =>
      observeWindowsBackendProcess({
        pid: 4242,
        launch: { ...launch, entrySha256: "" },
        api: host.api,
      }),
    );
    assert.equal(host.opens, 0);
  });

  it("captures immutable entrypoint/argv/hash BEFORE spawn; never calls those OS observations", async () => {
    const args = ["--require", "C:\\T3\\cache.cjs", launch.entryPath, "--bootstrap-fd", "3"];
    const source = new TextEncoder().encode("actual entry source bytes");
    const recorded = await captureTrustedWindowsBackendLaunch(
      {
        executablePath: launch.expectedExecutablePath,
        entryPath: launch.entryPath,
        cwd: launch.cwd,
        env: { ELECTRON_RUN_AS_NODE: "1" },
        args,
        bootstrapDelivery: "fd3",
      },
      async (entry) => {
        assert.equal(entry, launch.entryPath);
        return source;
      },
    );
    args[0] = "malicious-change";
    assert.equal(recorded.args[0], "--require");
    assert.equal(
      recorded.entrySha256,
      NodeCrypto.createHash("sha256").update(source).digest("hex"),
    );
    assert.equal(recorded.capturedBeforeSpawn, true);
    assert.equal(recorded.electronRunAsNode, true);
    assert.isFrozen(recorded);
    assert.isFrozen(recorded.args);
    assert.equal(recorded.expectedExecutablePath, launch.expectedExecutablePath);
  });

  it("rejects WSL, arbitrary entry argv, missing node mode, wrong bootstrap fd and unknown image", async () => {
    const base = {
      executablePath: launch.expectedExecutablePath,
      entryPath: launch.entryPath,
      cwd: launch.cwd,
      args: [...launch.args],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      bootstrapDelivery: "fd3" as const,
    };
    const reader = async () => new Uint8Array([1]);
    for (const candidate of [
      { ...base, runningDistro: "Ubuntu" },
      { ...base, env: {} },
      { ...base, bootstrapDelivery: "stdin" as const },
      { ...base, args: ["node", launch.entryPath, "--bootstrap-fd", "3"] },
      { ...base, args: [launch.entryPath, "--bootstrap-fd", "0"] },
      { ...base, executablePath: "/usr/bin/node" },
    ]) {
      let rejected = false;
      try {
        await captureTrustedWindowsBackendLaunch(candidate, reader);
      } catch {
        rejected = true;
      }
      assert.isTrue(rejected);
    }
  });
});
