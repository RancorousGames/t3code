// @vitest-environment node
// @ts-expect-error jsdom is available for tests but its types are not declared here.
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  readWarmSessionClicks,
  recordWarmActivityObservation,
  recordWarmSessionClick,
  warmRecentClickRanks,
  wasWarmSessionActiveBeforeFailure,
} from "./chatGPTWarmPriorityHistory";

let dom: JSDOM;
beforeEach(() => {
  dom = new JSDOM("", { url: "https://localhost" });
  vi.stubGlobal("localStorage", dom.window.localStorage);
  vi.stubGlobal("sessionStorage", dom.window.sessionStorage);
});
afterEach(() => {
  vi.unstubAllGlobals();
  dom.window.close();
});

describe("warm priority evidence", () => {
  it("preserves green activity across an error and simulated T3 restart until verified idle", () => {
    recordWarmActivityObservation("env", "worker", "working");
    expect(wasWarmSessionActiveBeforeFailure("env", "worker")).toBe(true);
    recordWarmActivityObservation("env", "worker", "unknown");
    recordWarmActivityObservation("env", "worker", "invalid");
    expect(wasWarmSessionActiveBeforeFailure("env", "worker")).toBe(true);
    recordWarmActivityObservation("env", "worker", "interrupted");
    expect(wasWarmSessionActiveBeforeFailure("env", "worker")).toBe(true);
    recordWarmActivityObservation("env", "worker", "idle");
    expect(wasWarmSessionActiveBeforeFailure("env", "worker")).toBe(false);
  });

  it("does not infer prior green status from unrelated red or idle observations", () => {
    recordWarmActivityObservation("env", "already-red", "invalid");
    recordWarmActivityObservation("env", "idle", "idle");
    expect(wasWarmSessionActiveBeforeFailure("env", "already-red")).toBe(false);
    expect(wasWarmSessionActiveBeforeFailure("env", "idle")).toBe(false);
  });

  it("records only three post-startup clicks and includes the selected tab in those three", () => {
    const ids = ["a", "b", "c", "d", "e"];
    for (const id of ["a", "b", "c", "d"]) recordWarmSessionClick("env", id, ids);
    expect(readWarmSessionClicks("env")).toEqual(["d", "c", "b"]);
    expect([...warmRecentClickRanks("env", "a")]).toEqual([
      ["a", 0],
      ["d", 1],
      ["c", 2],
    ]);
    expect([...warmRecentClickRanks("env", "d")]).toEqual([
      ["d", 0],
      ["c", 1],
      ["b", 2],
    ]);
    expect([...warmRecentClickRanks("env", null)]).toEqual([
      ["d", 0],
      ["c", 1],
      ["b", 2],
    ]);
  });

  it("drops click history on a fresh window but retains working evidence", () => {
    recordWarmActivityObservation("env", "a", "working");
    recordWarmSessionClick("env", "a", ["a"]);
    sessionStorage.clear(); // New Electron window.
    expect(readWarmSessionClicks("env")).toEqual([]);
    expect(wasWarmSessionActiveBeforeFailure("env", "a")).toBe(true);
  });
});
