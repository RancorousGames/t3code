import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  activeChatGPTRecoveryMutation,
  tryAcquireChatGPTRecoveryMutation,
} from "./chatGPTRecoveryMutationGate";

describe("global manual/background ChatGPT mutation reservation", () => {
  const leases: Array<{ release(): void }> = [];
  afterEach(() => {
    for (const lease of leases) lease.release();
    leases.length = 0;
  });
  const acquire = (
    env: string,
    id: string,
    origin: "manual" | "automatic",
    action: "reload" | "stop" | "continue" | "navigate" | "reset" = "reload",
  ) => {
    const lease = tryAcquireChatGPTRecoveryMutation(env, id, origin, action);
    if (lease) leases.push(lease);
    return lease;
  };
  it("serializes automatic refresh and manual forced reload across all sessions in one environment", () => {
    const auto = acquire("local", "a", "automatic");
    expect(auto).not.toBeNull();
    expect(acquire("local", "a", "manual")).toBeNull();
    expect(acquire("local", "different", "manual")).toBeNull();
    expect(activeChatGPTRecoveryMutation("local")).toEqual({
      sessionId: "a",
      origin: "automatic",
      action: "reload",
    });
    auto!.release();
    const manual = acquire("local", "different", "manual", "navigate");
    expect(manual).not.toBeNull();
    expect(acquire("local", "a", "automatic")).toBeNull();
    manual!.release();
    expect(activeChatGPTRecoveryMutation("local")).toBeNull();
  });
  it("does not serialize unrelated environments", () => {
    expect(acquire("one", "a", "manual")).not.toBeNull();
    expect(acquire("two", "b", "automatic", "stop")).not.toBeNull();
    expect(activeChatGPTRecoveryMutation("two")?.action).toBe("stop");
  });
  it("makes release idempotent and cannot remove an unrelated future reservation", () => {
    const previous = acquire("local", "a", "automatic")!;
    previous.release();
    const newer = acquire("local", "b", "manual")!;
    previous.release();
    expect(activeChatGPTRecoveryMutation("local")?.sessionId).toBe("b");
    newer.release();
    expect(activeChatGPTRecoveryMutation("local")).toBeNull();
  });
  it("fails closed on missing environment or session identity", () => {
    expect(acquire("", "a", "manual")).toBeNull();
    expect(acquire("local", "", "automatic")).toBeNull();
  });
});
