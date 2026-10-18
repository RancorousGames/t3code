import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { COMPOSER_SELECTOR, sendInitialChatGPTPrompt } from "./chatGPTBrowserAutomation";

const environmentId = EnvironmentId.make("local");

function harness(
  options: {
    failType?: boolean;
    missingSelector?: boolean;
    readyAfter?: number;
    neverReady?: boolean;
    noDesktopOverlay?: boolean;
    neverConfirm?: boolean;
  } = {},
) {
  let clock = 1_000;
  let probes = 0;
  const events: string[] = [];
  const releaseActivity = vi.fn(() => events.push("guest-released"));
  const acquireActivity = vi.fn((_runtimeId: string) => {
    events.push("guest-background-active");
    return releaseActivity;
  });
  const automation = {
    status: vi.fn(async () => {
      probes++;
      return {
        available: !options.neverReady && probes > (options.readyAfter ?? 0),
        loading: false,
        url: "https://chatgpt.com/",
      };
    }),
    waitFor: vi.fn(async () => {
      events.push("composer-ready");
    }),
    type: vi.fn(async (_tabId: string, input: { text: string }) => {
      events.push(`typed:${input.text}`);
      if (options.failType) throw new Error("Cannot edit composer");
      if (options.missingSelector)
        throw new Error("PreviewAutomationTargetNotFoundError: no selector");
    }),
    press: vi.fn(async () => {
      events.push("pressed-enter");
    }),
    evaluate: vi.fn(async (_tabId: string, input: { expression: string }) =>
      input.expression.includes("Composer text mismatch")
        ? { ok: true }
        : input.expression.includes("data-message-author-role")
          ? !options.neverConfirm
          : true,
    ),
  };
  const readState = vi.fn(() => ({
    activeTabId: "tab-1",
    serverEpoch: "epoch-1",
    desktopByTabId: options.noDesktopOverlay ? {} : { "tab-1": { hasWebContents: true } },
  }));
  return {
    automation,
    readState,
    events,
    acquireActivity,
    releaseActivity,
    now: () => clock,
    pause: async (ms: number) => {
      clock += ms;
    },
  };
}

describe("ChatGPT initial prompt automation", () => {
  it("opens the existing session preview and sends exactly one first message", async () => {
    const h = harness({ readyAfter: 2 });
    await sendInitialChatGPTPrompt({
      environmentId,
      sessionId: "session-abc",
      prompt: "Review the combat spec",
      ...h,
      timeoutMs: 5_000,
    } as unknown as Parameters<typeof sendInitialChatGPTPrompt>[0]);
    expect(h.events).toEqual([
      "guest-background-active",
      "composer-ready",
      "typed:Review the combat spec",
      "pressed-enter",
      "guest-released",
    ]);
    expect(h.acquireActivity).toHaveBeenCalledOnce();
    expect(h.releaseActivity).toHaveBeenCalledOnce();
    expect(h.automation.type).toHaveBeenCalledOnce();
    expect(h.automation.type).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ selector: COMPOSER_SELECTOR, clear: true }),
    );
    expect(h.automation.press).toHaveBeenCalledWith(expect.any(String), { key: "Enter" });
    // Inspect the actual guest-side expression, not just the mocked boolean:
    // a broken escaped regex would make every real dispatch time out.
    const expression = h.automation.evaluate.mock.calls.find(([, input]) =>
      input.expression.includes("data-message-author-role"),
    )?.[1].expression;
    expect(expression).toBeDefined();
    const message = document.createElement("div");
    message.dataset.messageAuthorRole = "user";
    message.textContent = "Review the combat spec";
    document.body.appendChild(message);
    try {
      expect(window.eval(expression!)).toBe(true);
      message.remove();
      expect(window.eval(expression!)).toBe(false);
    } finally {
      message.remove();
    }
  });

  it("uses the actual guest before upstream's desktop overlay is synchronized", async () => {
    const h = harness({ noDesktopOverlay: true });
    await sendInitialChatGPTPrompt({
      environmentId,
      sessionId: "session-abc",
      prompt: "Start the subagent task",
      ...h,
      timeoutMs: 5_000,
    } as unknown as Parameters<typeof sendInitialChatGPTPrompt>[0]);
    expect(h.automation.type).toHaveBeenCalledOnce();
    expect(h.automation.press).toHaveBeenCalledOnce();
  });

  it("does not count merely pressing Enter as successful delivery", async () => {
    const h = harness({ neverConfirm: true });
    await expect(
      sendInitialChatGPTPrompt({
        environmentId,
        sessionId: "session-abc",
        prompt: "Confirm delivery",
        ...h,
        timeoutMs: 1_000,
      } as unknown as Parameters<typeof sendInitialChatGPTPrompt>[0]),
    ).rejects.toThrow("did not confirm the sent message");
    expect(h.automation.press).toHaveBeenCalledOnce();
  });

  it("falls back to native DOM when the preview's strict selector misses a ready composer", async () => {
    const h = harness({ missingSelector: true });
    await sendInitialChatGPTPrompt({
      environmentId,
      sessionId: "session-abc",
      prompt: "Please confirm receipt",
      ...h,
      timeoutMs: 5_000,
    } as unknown as Parameters<typeof sendInitialChatGPTPrompt>[0]);
    expect(h.automation.type).toHaveBeenCalledOnce();
    expect(h.automation.evaluate).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        expression: expect.stringContaining("Please confirm receipt"),
      }),
    );
    expect(h.automation.press).toHaveBeenCalledOnce();
  });

  it("never retries typing after input begins, avoiding duplicate sends", async () => {
    const h = harness({ failType: true });
    await expect(
      sendInitialChatGPTPrompt({
        environmentId,
        sessionId: "session-abc",
        prompt: "Run tests",
        ...h,
        timeoutMs: 5_000,
      } as unknown as Parameters<typeof sendInitialChatGPTPrompt>[0]),
    ).rejects.toThrow("Cannot edit composer");
    expect(h.automation.type).toHaveBeenCalledOnce();
    expect(h.automation.press).not.toHaveBeenCalled();
    expect(h.releaseActivity).toHaveBeenCalledOnce();
  });

  it("fails without sending when login or the page is unavailable", async () => {
    const h = harness({ neverReady: true });
    await expect(
      sendInitialChatGPTPrompt({
        environmentId,
        sessionId: "session-abc",
        prompt: "Run tests",
        ...h,
        timeoutMs: 1_000,
      } as unknown as Parameters<typeof sendInitialChatGPTPrompt>[0]),
    ).rejects.toThrow("message box was not ready");
    expect(h.automation.type).not.toHaveBeenCalled();
    expect(h.releaseActivity).toHaveBeenCalledOnce();
  });
});
