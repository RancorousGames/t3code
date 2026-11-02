// @vitest-environment node
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  readChatGPTSpawnReceipts, recordChatGPTSpawnCreated,
  startChatGPTSpawnDelivery, chatGPTSpawnDeliveryStatus,
} from "./chatGPTSpawnReceipts";

describe("durable ChatGPT spawn correlation", () => {
  it("returns an addressable reservation while initial delivery is still pending", async () => {
    const env = EnvironmentId.make("spawn-early-return");
    recordChatGPTSpawnCreated(env, "request-early", "child-early");
    let finish!: (value: { delivery: "user_turn_observed"; sendAttempted: true }) => void;
    const send = vi.fn(() => new Promise<{ delivery: "user_turn_observed"; sendAttempted: true }>((resolve) => { finish = resolve; }));
    const pending = startChatGPTSpawnDelivery(env, "request-early", "child-early", send);
    const receipt = readChatGPTSpawnReceipts(env)[0]!;
    expect(receipt.sessionId).toBe("child-early");
    expect(receipt.initialDelivery?.delivery).toBe("unknown");
    expect(chatGPTSpawnDeliveryStatus(env, receipt).promptDelivery).toBe("pending");
    expect(startChatGPTSpawnDelivery(env, "request-early", "child-early", send)).toBe(pending);
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    finish({ delivery: "user_turn_observed", sendAttempted: true });
    await pending;
    expect(chatGPTSpawnDeliveryStatus(env, readChatGPTSpawnReceipts(env)[0]!).messageSent).toBe(true);
    await startChatGPTSpawnDelivery(env, "request-early", "child-early", send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retains UNKNOWN after a lost send receipt and never replays it", async () => {
    const env = EnvironmentId.make("spawn-lost-receipt");
    recordChatGPTSpawnCreated(env, "request-lost", "child-lost");
    const send = vi.fn(async () => { throw new Error("Renderer disconnected after submit"); });
    await startChatGPTSpawnDelivery(env, "request-lost", "child-lost", send);
    const receipt = readChatGPTSpawnReceipts(env)[0]!;
    expect(chatGPTSpawnDeliveryStatus(env, receipt)).toEqual({
      promptDelivery: "unknown", messageSent: false, sendAttempted: null,
    });
    expect(receipt.initialDelivery?.reason).toContain("Renderer disconnected");
    await startChatGPTSpawnDelivery(env, "request-lost", "child-lost", send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("persists the created UUID by original request id across subsequent reads", () => {
    const environmentId = EnvironmentId.make("spawn-receipts-test");
    recordChatGPTSpawnCreated(environmentId, "first-request", "created-uuid");
    const first = readChatGPTSpawnReceipts(environmentId);
    expect(first).toContainEqual({
      environmentId,
      requestId: "first-request",
      sessionId: "created-uuid",
      createdAt: expect.any(Number),
    });
    expect(() => recordChatGPTSpawnCreated(environmentId, "first-request", "corrected-uuid"))
      .toThrow("already belongs to another session");
    recordChatGPTSpawnCreated(environmentId, "first-request", "created-uuid");
    const second = readChatGPTSpawnReceipts(environmentId);
    expect(second.filter((receipt) => receipt.requestId === "first-request")).toHaveLength(1);
    expect(second[0]?.sessionId).toBe("created-uuid");
    expect(readChatGPTSpawnReceipts(EnvironmentId.make("other-environment"))).toEqual([]);
  });
});
