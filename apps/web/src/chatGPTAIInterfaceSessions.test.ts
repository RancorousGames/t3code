import { describe, expect, it } from "vite-plus/test";
import { aiInterfaceCloseDue, isAIInterfaceSession, AI_INTERFACE_IDLE_CLOSE_MS } from "./chatGPTAIInterfaceSessions";

const guest = { id: "api", title: "API session",
  spawnRequestId: "provider-v1:123", createdAt: 1000 };

describe("AI interface session provenance and idle expiry", () => {
  it("uses provider receipt, not title or worker/manager role", () => {
    expect(isAIInterfaceSession(guest)).toBe(true);
    expect(isAIInterfaceSession({ spawnRequestId: "abc" })).toBe(false);
    expect(isAIInterfaceSession({ spawnRequestId: undefined })).toBe(false);
  });
  it("only closes verified two-hour idle sessions", () => {
    const now = 1000 + AI_INTERFACE_IDLE_CLOSE_MS;
    expect(aiInterfaceCloseDue(guest, 1000, now, false)).toBe(true);
    expect(aiInterfaceCloseDue(guest, 1001, now, false)).toBe(false);
    expect(aiInterfaceCloseDue(guest, null, now, false)).toBe(false);
    expect(aiInterfaceCloseDue(guest, 1000, now, true)).toBe(false);
    expect(aiInterfaceCloseDue({ ...guest, autoCloseExempt: true }, 1000, now, false)).toBe(false);
    expect(aiInterfaceCloseDue({ ...guest, snoozedUntil: now + 1000 }, 1000, now, false)).toBe(false);
    expect(aiInterfaceCloseDue({ ...guest, spawnRequestId: "manual" }, 1000, now, false)).toBe(false);
  });
});
