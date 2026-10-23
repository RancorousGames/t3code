// @vitest-environment node
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { readChatGPTSpawnReceipts, recordChatGPTSpawnCreated } from "./chatGPTSpawnReceipts";

describe("durable ChatGPT spawn correlation", () => {
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
    recordChatGPTSpawnCreated(environmentId, "first-request", "corrected-uuid");
    const second = readChatGPTSpawnReceipts(environmentId);
    expect(second.filter((receipt) => receipt.requestId === "first-request")).toHaveLength(1);
    expect(second[0]?.sessionId).toBe("corrected-uuid");
    expect(readChatGPTSpawnReceipts(EnvironmentId.make("other-environment"))).toEqual([]);
  });
});
