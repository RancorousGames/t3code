import { describe, expect, it } from "vite-plus/test";
import {
  claimRecoveryExperimentSampler,
  releaseRecoveryExperimentSampler,
} from "./chatGPTRecoveryExperimentLease";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear() { data.clear(); },
    getItem(key: string) { return data.get(key) ?? null; },
    key(index: number) { return [...data.keys()][index] ?? null; },
    removeItem(key: string) { data.delete(key); },
    setItem(key: string, value: string) { data.set(key, value); },
  };
}

describe("recovery experiment sampler lease", () => {
  it("allows one observer at a time and expires crashed observers", () => {
    const storage = memoryStorage();
    expect(claimRecoveryExperimentSampler(storage, "env-1", "first", 1_000)).toBe(true);
    expect(claimRecoveryExperimentSampler(storage, "env-1", "second", 2_000)).toBe(false);
    expect(claimRecoveryExperimentSampler(storage, "env-1", "first", 40_000)).toBe(true);
    expect(claimRecoveryExperimentSampler(storage, "env-1", "second", 120_000)).toBe(false);
    expect(claimRecoveryExperimentSampler(storage, "env-1", "second", 131_000)).toBe(true);
    releaseRecoveryExperimentSampler(storage, "env-1", "first");
    expect(claimRecoveryExperimentSampler(storage, "env-1", "first", 132_000)).toBe(false);
    releaseRecoveryExperimentSampler(storage, "env-1", "second");
    expect(claimRecoveryExperimentSampler(storage, "env-1", "first", 133_000)).toBe(true);
  });

  it("prevents different environments from editing the same global experiment", () => {
    const storage = memoryStorage();
    expect(claimRecoveryExperimentSampler(storage, "env-1", "desktop-1", 1000)).toBe(true);
    expect(claimRecoveryExperimentSampler(storage, "env-2", "desktop-2", 1000)).toBe(false);
    expect(claimRecoveryExperimentSampler(storage, "env-1", "desktop-2", 2000)).toBe(false);
    releaseRecoveryExperimentSampler(storage, "env-2", "desktop-2");
    expect(claimRecoveryExperimentSampler(storage, "env-2", "desktop-2", 2100)).toBe(false);
    releaseRecoveryExperimentSampler(storage, "env-1", "desktop-1");
    expect(claimRecoveryExperimentSampler(storage, "env-2", "desktop-2", 2200)).toBe(true);
  });

  it("recovers from implausibly far-future leases after a wall-clock rollback", () => {
    const storage = memoryStorage();
    expect(claimRecoveryExperimentSampler(storage, "env-1", "first", 1_000_000)).toBe(true);
    expect(claimRecoveryExperimentSampler(storage, "env-2", "second", 0)).toBe(true);
    expect(claimRecoveryExperimentSampler(storage, "env-1", "first", 10)).toBe(false);
  });
  it("fails closed when storage is unavailable", () => {
    const storage = memoryStorage();
    storage.setItem = () => { throw new Error("blocked"); };
    expect(claimRecoveryExperimentSampler(storage, "env-1", "first", 2_000)).toBe(false);
  });
});
