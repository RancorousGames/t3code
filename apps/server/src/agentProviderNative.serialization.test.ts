import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { nativeHistoryItems } from "./agentProviderNative.ts";

describe("t3 v1 native history JSON boundary", () => {
  it("exposes actual user/assistant text and serializes DateTime-rich items", () => {
    const stamp = Effect.runSync(DateTime.now);
    const base = {
      id: "item-1", threadId: "thread-1",
      runId: null, nodeId: null, providerThreadId: null, providerTurnId: null,
      nativeItemRef: null, parentItemId: null,
      ordinal: 0, status: "completed", title: null,
      startedAt: stamp, completedAt: stamp, updatedAt: stamp,
    };
    const input = [
      { sourceThreadId: "thread-1", sourceItemId: "msg-user", visibility: "visible",
        item: {
          ...base, type: "user_message", messageId: "msg-user",
          inputIntent: "turn_start", text: "Hello from native queue",
          attachments: [], createdBy: "user", creationSource: "mcp",
        },
      },
      { sourceThreadId: "thread-1", sourceItemId: "msg-assistant", visibility: "visible",
        item: {
          ...base, id: "item-2", type: "assistant_message", messageId: "msg-assistant",
          text: "Native answer confirmed", streaming: false,
        },
      },
    ] as unknown as ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
    const output = nativeHistoryItems(input, 123);
    expect(output).toHaveLength(2);
    expect(output[0]?.author).toBe("user");
    expect(output[1]?.author).toBe("assistant");
    expect(output[0]?.parts[0]).toEqual({ type: "text", text: "Hello from native queue" });
    expect(output[1]?.parts[0]).toEqual({ type: "text", text: "Native answer confirmed" });
    expect(() => JSON.stringify(output)).not.toThrow();
    expect((output[0]?.parts[1] as { item?: { updatedAt?: unknown } }).item?.updatedAt)
      .toEqual({ epochMilliseconds: expect.any(Number) });
  });
});
