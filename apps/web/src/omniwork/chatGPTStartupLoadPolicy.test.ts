import { describe, expect, it } from "vite-plus/test";
import { getChatGPTStartupLoadPlan, isChatGPTStartupSessionDeferred, makeChatGPTStartupLoadPlan, shouldLoadChatGPTSession } from "./chatGPTStartupLoadPolicy";

describe("ChatGPT startup mass-loading control", () => {
  it("recognizes deferred status without creating another load plan", () => {
    expect(isChatGPTStartupSessionDeferred("not-created-for-status", "old")).toBe(false);
    const plan = getChatGPTStartupLoadPlan("status-only-plan", ["old", "worker"], false);
    expect(isChatGPTStartupSessionDeferred("status-only-plan", "old")).toBe(true);
    expect(isChatGPTStartupSessionDeferred("status-only-plan", "created-after-startup")).toBe(false);
    shouldLoadChatGPTSession(plan, "old", "old");
    expect(isChatGPTStartupSessionDeferred("status-only-plan", "old")).toBe(false);
    expect(isChatGPTStartupSessionDeferred("status-only-plan", "worker")).toBe(true);
  });

  it("defaults to no bulk loading: only selected restored session and newly created agents start", () => {
    const plan = makeChatGPTStartupLoadPlan(["manager", "old-worker", "old-manual"]);
    expect(shouldLoadChatGPTSession(plan, "manager", null)).toBe(false);
    expect(shouldLoadChatGPTSession(plan, "old-worker", null)).toBe(false);
    expect(shouldLoadChatGPTSession(plan, "old-manual", "old-manual")).toBe(true);
    expect(shouldLoadChatGPTSession(plan, "new-agent", "old-manual")).toBe(true);
  });

  it("opens deferred sessions on selection and never unloads them when focus moves", () => {
    const plan = makeChatGPTStartupLoadPlan(["manager", "old-worker"]);
    expect(shouldLoadChatGPTSession(plan, "old-worker", null)).toBe(false);
    expect(shouldLoadChatGPTSession(plan, "old-worker", "old-worker")).toBe(true);
    expect(shouldLoadChatGPTSession(plan, "old-worker", "manager")).toBe(true);
    expect(shouldLoadChatGPTSession(plan, "manager", "manager")).toBe(true);
    expect(shouldLoadChatGPTSession(plan, "manager", null)).toBe(true);
  });

  it("honors the explicit mass-load setting and leaves new creations unaffected", () => {
    const plan = makeChatGPTStartupLoadPlan(["manager", "worker"], true);
    expect(shouldLoadChatGPTSession(plan, "manager", null)).toBe(true);
    expect(shouldLoadChatGPTSession(plan, "worker", null)).toBe(true);
    expect(shouldLoadChatGPTSession(plan, "created-later", null)).toBe(true);
  });

  it("retains the initial session snapshot across sidebar remounts and settings changes", () => {
    const first = getChatGPTStartupLoadPlan("startup-test-unique-env", ["existing"], false);
    expect(shouldLoadChatGPTSession(first, "existing", null)).toBe(false);
    const remounted = getChatGPTStartupLoadPlan("startup-test-unique-env", ["existing", "new"], true);
    expect(remounted).toBe(first);
    expect(shouldLoadChatGPTSession(remounted, "new", null)).toBe(true);
    expect(shouldLoadChatGPTSession(remounted, "existing", null)).toBe(false);
  });

  it("does not confuse a metadata change with a new session after the initial snapshot", () => {
    const plan = makeChatGPTStartupLoadPlan(["manager"]);
    expect(shouldLoadChatGPTSession(plan, "manager", null)).toBe(false);
    expect(shouldLoadChatGPTSession(plan, "manager", undefined)).toBe(false);
    expect(shouldLoadChatGPTSession(plan, "genuinely-new", undefined)).toBe(true);
  });
});
