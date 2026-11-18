import { describe, expect, it } from "vite-plus/test";
import type { AgentAttention } from "./chatGPTAgentAttention";
import { captureHiddenAttention, retainHiddenAttention } from "./chatGPTAttentionToastVisibility";

function request(id: string, nextAt = 100): AgentAttention {
  return { id, sessionId: id, message: id, source: "agent",
    createdAt: 100, activatedAt: 100, status: "pending", nextAt };
}

describe("Hide attention toast", () => {
  it("hides the entire active queue without modifying any notification", () => {
    const stack = [request("a"), request("b"), request("c")];
    const original = structuredClone(stack);
    const hidden = captureHiddenAttention(stack);
    expect(retainHiddenAttention(hidden, stack)).toBe(hidden);
    expect(stack).toEqual(original);
    expect(retainHiddenAttention(hidden, [stack[2]!, stack[0]!])).toBe(hidden);
    expect(retainHiddenAttention(hidden, [])).toBe(hidden);
  });

  it("ignores delivery receipt updates and repeated polling", () => {
    const hidden = captureHiddenAttention([request("a")]);
    expect(retainHiddenAttention(hidden, [{ ...request("a"), notifiedAt: 200 }]))
      .toBe(hidden);
    expect(retainHiddenAttention(hidden, [{ ...request("a"), message: "renamed" }]))
      .toBe(hidden);
  });

  it("reveals the entire queue when a new request arrives", () => {
    const hidden = captureHiddenAttention([request("a"), request("b")]);
    expect(retainHiddenAttention(hidden, [
      request("new", 300), request("a"), request("b"),
    ])).toBeNull();
  });

  it("reveals the queue when a previously snoozed request resurfaces", () => {
    const hidden = captureHiddenAttention([request("a")]);
    // The same request ID has a new snooze deadline/appearance.
    expect(retainHiddenAttention(hidden, [request("a", 500)])).toBeNull();
    expect(retainHiddenAttention(hidden, [{ ...request("a"), activatedAt: 501 }]))
      .toBeNull();
  });

  it("stays visible after a fresh notification clears Hide", () => {
    const hidden = captureHiddenAttention([request("a")]);
    const cleared = retainHiddenAttention(hidden, [request("b"), request("a")]);
    expect(cleared).toBeNull();
    expect(retainHiddenAttention(cleared, [request("a")])).toBeNull();
  });
});
