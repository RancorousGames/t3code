// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";

import { chatGPTRecoveryHoverDetails } from "./chatGPTRecoveryHoverDetails";

const now = new Date("2026-10-25T05:00:00+01:00").getTime();
const state = {
  lastAttemptAt: now - 60_000,
  retryCount: 2,
  nextRetryAt: now + 60_000,
  orangeStage: null,
};

describe("ChatGPT recovery hover", () => {
  it("uses live phase, recorded cooldown and safe recent events for red sessions", () => {
    const lines = chatGPTRecoveryHoverDetails({
      age: "invalid",
      label: "ChatGPT page unavailable: conversation failed to load",
      phase: "checking",
      state,
      now,
      events: [
        {
          at: now - 30_000,
          sessionId: "s",
          event: "refresh-timeout",
          detail: "secret composer draft text",
        },
        {
          at: now - 10_000,
          sessionId: "s",
          event: "diagnostic",
          detail: "secret user content",
        },
      ],
    });
    expect(lines?.join(" ")).toContain("Current phase: Verifying the error");
    expect(lines?.join(" ")).toContain("Saved retry cooldown");
    expect(lines?.join(" ")).toContain("Refresh timed out");
    expect(lines?.join(" ")).not.toContain("secret");
  });

  it("does not represent persisted orange stages as live or promise another destructive action", () => {
    const lines = chatGPTRecoveryHoverDetails({
      age: "interrupted",
      label: "ChatGPT connection interrupted",
      phase: null,
      state: { ...state, orangeStage: "continue_issued" },
      now,
      events: [],
    });
    expect(lines).toContain("Current phase: No active recovery step reported");
    expect(lines?.join(" ")).toContain("Last saved interruption stage: Continue attempted");
    expect(lines?.join(" ")).toContain("draft safety");
    expect(lines?.join(" ")).not.toContain("Saved retry cooldown");
  });

  it("omits stale events, future dates and healthy sessions", () => {
    const lines = chatGPTRecoveryHoverDetails({
      age: "invalid",
      label: "ChatGPT page unavailable",
      phase: null,
      state: { ...state, lastAttemptAt: now + 1000, nextRetryAt: null },
      now,
      events: [
        { at: now - 3 * 60 * 60_000, sessionId: "s", event: "refresh-finished" },
        { at: now + 2000, sessionId: "s", event: "refresh-timeout" },
      ],
    });
    expect(lines?.join(" ")).not.toContain("History");
    expect(lines?.join(" ")).not.toContain("Last recorded recovery action");
    expect(
      chatGPTRecoveryHoverDetails({
        age: "working",
        label: "ChatGPT is working",
        phase: null,
        state,
        events: [],
        now,
      }),
    ).toBeNull();
  });
});
