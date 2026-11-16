import { describe, expect, it } from "vite-plus/test";

import {
  completedAttentionTransition,
  isSelectedChatGPTAttentionSession,
} from "./chatGPTProviderActivity";

describe("attention completion transitions", () => {
  it("activates on working -> idle and each recognized error -> idle", () => {
    for (const state of ["working", "invalid", "interrupted", "delivery-timeout"] as const)
      expect(completedAttentionTransition(state, "idle")).toBe(true);
  });

  it("does not activate from startup, unknown, or repeated idle probes", () => {
    for (const state of [undefined, "unknown", "idle"] as const)
      expect(completedAttentionTransition(state, "idle")).toBe(false);
    expect(completedAttentionTransition("working", "invalid")).toBe(false);
    expect(completedAttentionTransition("invalid", "working")).toBe(false);
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
