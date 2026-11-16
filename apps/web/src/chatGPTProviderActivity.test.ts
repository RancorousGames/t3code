import { describe, expect, it } from "vite-plus/test";

import { isSelectedChatGPTAttentionSession } from "./chatGPTProviderActivity";
import {
  completedAttentionTransition,
  markChatGPTAttentionVisited,
  observeChatGPTAttentionCompletion,
} from "./chatGPTAttentionWorkCycle";

describe("attention completion transitions", () => {
  it("requires previously observed, unvisited work even for error -> idle", () => {
    for (const state of ["working", "invalid", "interrupted", "delivery-timeout"] as const) {
      expect(completedAttentionTransition(state, "idle", true)).toBe(true);
      expect(completedAttentionTransition(state, "idle", false)).toBe(false);
    }
    for (const state of [undefined, "unknown", "idle"] as const)
      expect(completedAttentionTransition(state, "idle", true)).toBe(false);
    expect(completedAttentionTransition("working", "invalid", true)).toBe(false);
  });

  it("activates after working -> error -> idle", () => {
    const env = "active-error-idle";
    const id = "one";
    expect(observeChatGPTAttentionCompletion(env, id, undefined, "working")).toBe(false);
    expect(observeChatGPTAttentionCompletion(env, id, "working", "interrupted")).toBe(false);
    expect(observeChatGPTAttentionCompletion(env, id, "interrupted", "idle")).toBe(true);
  });

  it("keeps unvisited work eligible across idle -> error -> idle", () => {
    const env = "unvisited-idle-error-idle";
    const id = "two";
    expect(observeChatGPTAttentionCompletion(env, id, undefined, "working")).toBe(false);
    expect(observeChatGPTAttentionCompletion(env, id, "working", "idle")).toBe(true);
    expect(observeChatGPTAttentionCompletion(env, id, "idle", "invalid")).toBe(false);
    expect(observeChatGPTAttentionCompletion(env, id, "invalid", "idle")).toBe(true);
  });

  it("does not re-alert after the finished output was visited or acknowledged", () => {
    const env = "visited-idle-error-idle";
    const id = "three";
    observeChatGPTAttentionCompletion(env, id, undefined, "working");
    expect(observeChatGPTAttentionCompletion(env, id, "working", "idle")).toBe(true);
    markChatGPTAttentionVisited(env, id, "idle");
    observeChatGPTAttentionCompletion(env, id, "idle", "delivery-timeout");
    expect(observeChatGPTAttentionCompletion(env, id, "delivery-timeout", "idle")).toBe(false);

    // A genuinely new working turn makes that same session eligible again.
    observeChatGPTAttentionCompletion(env, id, "idle", "working");
    markChatGPTAttentionVisited(env, id, "working"); // Not a final-output visit.
    observeChatGPTAttentionCompletion(env, id, "working", "invalid");
    expect(observeChatGPTAttentionCompletion(env, id, "invalid", "idle")).toBe(true);
  });

  it("does not create attention from an unrelated error with no observed work", () => {
    const env = "unrelated-error-idle";
    const id = "four";
    expect(observeChatGPTAttentionCompletion(env, id, undefined, "invalid")).toBe(false);
    expect(observeChatGPTAttentionCompletion(env, id, "invalid", "idle")).toBe(false);
    expect(observeChatGPTAttentionCompletion(env, id, "idle", "delivery-timeout")).toBe(false);
    expect(observeChatGPTAttentionCompletion(env, id, "delivery-timeout", "idle")).toBe(false);
  });

  it("automatically acknowledges only the currently selected hash-route session", () => {
    expect(isSelectedChatGPTAttentionSession("selected", "#/browser/selected")).toBe(true);
    expect(isSelectedChatGPTAttentionSession("selected", "#/browser/selected/")).toBe(true);
    expect(isSelectedChatGPTAttentionSession("selected", "#/browser/selected?x=1")).toBe(true);
    expect(isSelectedChatGPTAttentionSession("selected", "#/browser/other")).toBe(false);
    expect(isSelectedChatGPTAttentionSession("selected", "#/settings")).toBe(false);
    expect(isSelectedChatGPTAttentionSession("selected", "#/browser/selected-extra")).toBe(false);
    expect(isSelectedChatGPTAttentionSession("selected", "#/browser/%ZZ")).toBe(false);
  });
});
