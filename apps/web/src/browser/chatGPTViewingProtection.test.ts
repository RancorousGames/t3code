import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { chatGPTBrowserThreadRef } from "../chatGPTBrowserSessions";
import { isChatGPTSessionViewed } from "./chatGPTViewingProtection";

const environmentId = "env" as EnvironmentId;
const sessionId = "reading";
const view = {
  pathname: "/browser/other",
  splitSessionIds: new Set<string>(),
  visibleRuntimeTabIds: [] as string[],
};

describe("automatic unload viewing protection", () => {
  it("protects a session opened while an asynchronous idle probe was in flight", () => {
    expect(isChatGPTSessionViewed(environmentId, sessionId, view)).toBe(false);
    expect(isChatGPTSessionViewed(environmentId, sessionId, {
      ...view, pathname: "/browser/reading",
    })).toBe(true);
  });

  it("protects secondary split panes even when they are not the selected route", () => {
    expect(isChatGPTSessionViewed(environmentId, sessionId, {
      ...view, splitSessionIds: new Set(["other", sessionId]),
    })).toBe(true);
  });

  it("protects a physically presented legacy guest independent of route bookkeeping", () => {
    const runtimeId = JSON.stringify([
      environmentId, chatGPTBrowserThreadRef(environmentId, sessionId).threadId, "epoch", "tab",
    ]);
    expect(isChatGPTSessionViewed(environmentId, sessionId, {
      ...view, pathname: "/settings", visibleRuntimeTabIds: [runtimeId],
    })).toBe(true);
    expect(isChatGPTSessionViewed(environmentId, "background", {
      ...view, visibleRuntimeTabIds: [runtimeId],
    })).toBe(false);
  });
});
