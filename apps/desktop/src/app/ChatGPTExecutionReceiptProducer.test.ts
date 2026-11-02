import { describe, expect, it } from "vite-plus/test";
import { chatGPTDeliveryReceipts } from "./ChatGPTExecutionReceiptProducer.ts";
import type { DeliveryRecord } from "./ChatGPTDeliveryQueue.ts";

const base: Omit<DeliveryRecord, "body"> = {
  messageId: "01234567-89ab-4cde-8fab-0123456789ab",
  sessionId: "tab-1", conversationId: "conversation-1", status: "queued",
  attempts: 0, createdAt: 1793220000000, updatedAt: 1793220000000,
};
const binding = { seatId: "seat-1", environmentId: "chatgpt-browser", generation: "managed-session-1" };

describe("ChatGPT execution receipt producer", () => {
  it("never confuses accepted intent with a confirmed user-turn delivery", () => {
    expect(chatGPTDeliveryReceipts(base, binding).map(row => row.phase)).toEqual(["accepted-intent"]);
    const uncertain = chatGPTDeliveryReceipts({ ...base, status: "uncertain", attempts: 1,
      lastSubmissionAt: 1793220000100, updatedAt: 1793220000200 }, binding);
    expect(uncertain.map(row => row.phase)).toEqual(["accepted-intent", "run-started", "unknown"]);
    expect(uncertain.every(row => row.observedDeliveryId === undefined)).toBe(true);
    const delivered = chatGPTDeliveryReceipts({ ...base, status: "delivered", attempts: 1,
      lastSubmissionAt: 1793220000100, updatedAt: 1793220000300,
      observedDeliveryId: "[T3-MSG:01234567-89ab-4cde-8fab-0123456789ab]:user_turn_observed" }, binding);
    expect(delivered.map(row => row.phase)).toEqual(["accepted-intent", "run-started", "delivery-observed"]);
    expect(delivered[2]?.observedDeliveryId).toContain("user_turn_observed");
    expect(chatGPTDeliveryReceipts({ ...base, status: "delivered" }, binding).map(row => row.phase)).toEqual(["accepted-intent"]);
  });
});
