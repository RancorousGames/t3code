import { describe, expect, it } from "vite-plus/test";
import type { BrowserSession } from "./chatGPTBrowserSessions";
import type { SpawnReceipt } from "./chatGPTSpawnReceipts";
import { BLANK_CHATGPT_SESSION_GRACE_MS, blankChatGPTSessionCandidate } from "./chatGPTBlankSessionCleanupPolicy";

const now = 2_000_000;
const root: BrowserSession = { id: "blank-guest", title: "ChatGPT 4", createdAt: now - 121_000 };
const managers = new Set<string>();
const input = (session: BrowserSession = root, receipt?: SpawnReceipt) => ({
  session, sessions: [session], selectedId: undefined, managerIds: managers,
  receipt, now, lastTouchedAt: 0, hasConversationUrl: false, hasPendingSend: false,
});

describe("blank ChatGPT homepage cleanup", () => {
  it("requires two minutes without selection or user interaction", () => {
    expect(BLANK_CHATGPT_SESSION_GRACE_MS).toBe(120_000);
    expect(blankChatGPTSessionCandidate(input())).toBe(true);
    expect(blankChatGPTSessionCandidate({ ...input(), selectedId: root.id })).toBe(false);
    expect(blankChatGPTSessionCandidate(input({ ...root, createdAt: now - 119_000 }))).toBe(false);
    expect(blankChatGPTSessionCandidate({ ...input(), lastTouchedAt: now - 100_000 })).toBe(false);
    expect(blankChatGPTSessionCandidate(input({ ...root, lastDirectInteractionAt: now - 1_000 }))).toBe(false);
  });

  it("retains sessions with conversation ownership, protected roles or active sends", () => {
    expect(blankChatGPTSessionCandidate({ ...input(), hasConversationUrl: true })).toBe(false);
    expect(blankChatGPTSessionCandidate({ ...input(), hasPendingSend: true })).toBe(false);
    expect(blankChatGPTSessionCandidate(input({ ...root, bootstrapIdentity: { state: "registered" } }))).toBe(false);
    expect(blankChatGPTSessionCandidate(input({ ...root, borderColor: "yellow" }))).toBe(false);
    expect(blankChatGPTSessionCandidate({ ...input(), managerIds: new Set([root.id]) })).toBe(false);
    expect(blankChatGPTSessionCandidate({ ...input(), managerIds: null })).toBe(false);
    expect(blankChatGPTSessionCandidate({ ...input(), sessions: [root, { id: "child", title: "Worker", parentSessionId: root.id }] })).toBe(false);
  });

  it("does not close during uncertain first-message delivery", () => {
    const session = { ...root, spawnRequestId: "reservation" };
    const receipt: SpawnReceipt = {
      environmentId: "pc", sessionId: root.id, requestId: "reservation", createdAt: now - 121_000,
      initialDelivery: { delivery: "unknown", sendAttempted: null, reason: "Initial delivery has not been confirmed" },
    };
    expect(blankChatGPTSessionCandidate(input(session))).toBe(false);
    expect(blankChatGPTSessionCandidate(input(session, receipt))).toBe(false);
    expect(blankChatGPTSessionCandidate(input(session, { ...receipt,
      initialDelivery: { delivery: "unknown", sendAttempted: true, reason: "ChatGPT direct callback rejected" },
    }))).toBe(true);
    expect(blankChatGPTSessionCandidate(input(session, { ...receipt,
      initialDelivery: { delivery: "user_turn_observed", sendAttempted: true },
    }))).toBe(false); // A confirmed first turn is not an unused chat.
  });
});
