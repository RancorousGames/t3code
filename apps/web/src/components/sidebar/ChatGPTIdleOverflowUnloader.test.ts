import { describe, expect, it } from "vite-plus/test";
import type { ChatGPTPageSnapshot } from "../../chatGPTPageSnapshot";
import { safeToUnload } from "./ChatGPTIdleOverflowUnloader";

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
});
