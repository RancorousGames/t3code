import { describe, expect, it } from "vite-plus/test";
import type { ChatGPTPageSnapshot } from "../../chatGPTPageSnapshot";
import { canEvictChatGPTOverflowSession, safeToUnload } from "./ChatGPTIdleOverflowUnloader";

const url = "https://chatgpt.com/c/12345678-1234-4234-8234-123456789012";
const page: ChatGPTPageSnapshot = {
  observedAt: Date.now(),
  url,
  conversationId: "12345678-1234-4234-8234-123456789012",
  activity: "idle",
  signals: {
    stopButton: false, interruptedBanner: false, loadError: false,
    composerPresent: true, draftPresent: false, signInOrCaptcha: false, conversationFull: false,
  },
  turnCount: 2,
  contentHash: "12345678",
};

describe("soft ChatGPT residency maximum", () => {
  it("evicts only a verified idle conversation with an empty composer", () => {
    expect(safeToUnload({ activity: "idle", snapshot: page }, url)).toBe(true);
    expect(safeToUnload({ activity: "working", snapshot: page }, url)).toBe(false);
    expect(safeToUnload({ activity: "idle", snapshot: { ...page,
      signals: { ...page.signals, draftPresent: true } } }, url)).toBe(false);
    expect(safeToUnload({ activity: "idle", snapshot: { ...page,
      signals: { ...page.signals, stopButton: true } } }, url)).toBe(false);
    expect(safeToUnload({ activity: "idle", snapshot: page }, null)).toBe(false);
    expect(safeToUnload({ activity: "idle", snapshot: page },
      "https://chatgpt.com/c/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(false);
  });

  it("releases old user-opened and snoozed pages, but not recently used or pinned ones", () => {
    const now = 1_000_000;
    const eligible = {
      now,
      idleMs: 15 * 60_000,
      lastUsedAt: now - 20 * 60_000,
      selected: false,
      viewed: false,
      keepLoaded: false,
      caffySoon: false,
      deliveryPending: false,
      sendUncertain: false,
    };
    // A past explicit open no longer grants indefinite residency.
    expect(canEvictChatGPTOverflowSession(eligible)).toBe(true);
    expect(canEvictChatGPTOverflowSession({
      ...eligible, lastUsedAt: now - 5 * 60_000,
    })).toBe(false);
    expect(canEvictChatGPTOverflowSession({
      ...eligible, snoozedUntil: now + 60_000, lastUsedAt: now,
    })).toBe(true);
    expect(canEvictChatGPTOverflowSession({ ...eligible, keepLoaded: true })).toBe(false);
    expect(canEvictChatGPTOverflowSession({ ...eligible, selected: true })).toBe(false);
    expect(canEvictChatGPTOverflowSession({ ...eligible, viewed: true })).toBe(false);
    expect(canEvictChatGPTOverflowSession({ ...eligible, caffySoon: true })).toBe(false);
    expect(canEvictChatGPTOverflowSession({ ...eligible, deliveryPending: true })).toBe(false);
    expect(canEvictChatGPTOverflowSession({ ...eligible, sendUncertain: true })).toBe(false);
    expect(canEvictChatGPTOverflowSession({ ...eligible, idleMs: null })).toBe(false);
  });
});
