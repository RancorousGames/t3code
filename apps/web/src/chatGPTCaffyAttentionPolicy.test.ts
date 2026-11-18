import { describe, expect, it } from "vite-plus/test";
import { isCaffyIdleContinuationActive, CaffyDeferredAttention } from "./chatGPTCaffyAttentionPolicy";

const session = { id: "browser", bootstrapIdentity: { publicId: "public" } };
const entry = {
  sessionId: "other", browserSessionId: "browser", publicSessionId: "public",
  mode: "idle" as const, onceOnly: false, paused: false, expiresAt: null,
};

describe("persistent attention with Caffy auto-continue", () => {
  it("does not mark work complete while active idle auto-continue owns the session", () => {
    expect(isCaffyIdleContinuationActive({ entries: [entry] }, session, 100)).toBe(true);
    expect(isCaffyIdleContinuationActive({ entries: [{ ...entry, sessionId: "public", browserSessionId: undefined }] }, session, 100)).toBe(true);
  });

  it("ignores paused, expired, periodic, and unrelated Caffy schedules", () => {
    for (const changed of [
      { paused: true }, { expiresAt: 90 }, { mode: "periodic" as const },
      { sessionId: "unrelated", browserSessionId: "different", publicSessionId: "other" },
    ]) {
      expect(isCaffyIdleContinuationActive({ entries: [{ ...entry, ...changed }] }, session, 100))
        .toBe(false);
    }
    expect(isCaffyIdleContinuationActive(null, session, 100)).toBe(false);
  });

  it("defers unvisited completion until Caffy stops, once only", () => {
    const tracker = new CaffyDeferredAttention();
    tracker.defer("env", "browser");
    expect(tracker.isDeferred("env", "browser")).toBe(true);
    expect(tracker.takeIfReady("env", "browser", true, "idle")).toBe(false);
    expect(tracker.takeIfReady("env", "browser", false, "working")).toBe(false);
    expect(tracker.takeIfReady("env", "browser", false, "idle")).toBe(true);
    expect(tracker.takeIfReady("env", "browser", false, "idle")).toBe(false);
  });

  it("does not notify after the user visits the deferred result", () => {
    const tracker = new CaffyDeferredAttention();
    tracker.defer("env", "browser");
    tracker.clear("env", "browser");
    expect(tracker.takeIfReady("env", "browser", false, "idle")).toBe(false);
  });
});
