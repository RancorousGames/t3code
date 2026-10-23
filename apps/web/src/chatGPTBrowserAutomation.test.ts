// @vitest-environment node
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./chatGPTBrowserSessions", () => ({
  chatGPTBrowserThreadRef: () => ({ threadId: "session" }),
  readChatGPTBrowserSessions: () => [{ id: "session", title: "Worker" }],
}));
vi.mock("./browser/previewRuntimeTabId", () => ({ previewRuntimeTabId: () => "runtime" }));
vi.mock("./browser/browserSurfaceStore", () => ({
  acquireBrowserSurfaceActivity: () => () => {},
}));
vi.mock("./browser/chatGPTGuestHibernation", () => ({ wakeChatGPTGuest: () => {} }));
vi.mock("./components/preview/previewBridge", () => ({ previewBridge: null }));
vi.mock("./chatGPTWebviewAutomation", () => ({ chatGPTWebviewAutomation: {} }));
vi.mock("./previewStateStore", () => ({ readThreadPreviewState: () => ({}) }));

import { sendInitialChatGPTPrompt } from "./chatGPTBrowserAutomation";

function fixture() {
  let clock = 0;
  const automation = {
    status: vi.fn(async () => ({
      url: "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      available: true,
      loading: false,
    })),
    waitFor: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => false),
  };
  const input = {
    environmentId: EnvironmentId.make("local"),
    sessionId: "session",
    prompt: "Do exactly one job",
    automation: automation as never,
    readSessions: (() => [{ id: "session", title: "Worker" }]) as never,
    readState: (() => ({ activeTabId: "tab", serverEpoch: "epoch" })) as never,
    now: () => clock,
    pause: async (ms: number) => {
      clock += ms;
    },
    timeoutMs: 700,
    acquireActivity: () => () => {},
  };
  return { input, automation };
}

describe("initial ChatGPT prompt delivery receipt", () => {
  it("does not interpret /c/ URL navigation as a sent user turn or retry Enter", async () => {
    const { input, automation } = fixture();
    const result = await sendInitialChatGPTPrompt(input);
    expect(result).toMatchObject({ delivery: "unknown", sendAttempted: true });
    expect(automation.press).toHaveBeenCalledTimes(1);
    expect(automation.evaluate).toHaveBeenCalled();
  });

  it("preserves UNKNOWN when Enter rejects after it may have been accepted", async () => {
    const { input, automation } = fixture();
    automation.press.mockRejectedValueOnce(new Error("renderer detached"));
    const result = await sendInitialChatGPTPrompt(input);
    expect(result).toEqual({
      delivery: "unknown",
      sendAttempted: true,
      reason: "renderer detached",
    });
    expect(automation.press).toHaveBeenCalledTimes(1);
  });

  it("returns not_sent before any send attempt and keeps the session addressable", async () => {
    const { input, automation } = fixture();
    automation.waitFor.mockRejectedValue(new Error("composer unavailable"));
    const result = await sendInitialChatGPTPrompt(input);
    expect(result.delivery).toBe("not_sent");
    expect(result.sendAttempted).toBe(false);
    expect(automation.press).not.toHaveBeenCalled();
  });

  it("delivers only after exact user-turn verification responds true", async () => {
    const { input, automation } = fixture();
    automation.evaluate.mockResolvedValueOnce(true);
    const result = await sendInitialChatGPTPrompt(input);
    expect(result).toEqual({ delivery: "user_turn_observed", sendAttempted: true });
    expect(automation.press).toHaveBeenCalledTimes(1);
    const expression = (
      automation.evaluate.mock.calls as unknown as Array<[string, { expression: string }]>
    )[0]?.[1]?.expression;
    expect(expression).toContain("data-message-author-role");
    expect(expression).not.toContain("window.location.pathname");
  });
});
