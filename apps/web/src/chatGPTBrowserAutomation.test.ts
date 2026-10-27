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
      url: "https://chatgpt.com/",
      available: true,
      loading: false,
    })),
    waitFor: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    evaluate: vi.fn(async (_runtime: string, { expression }: { expression: string }) =>
      expression.includes("const draftEditor =") || expression.includes("const expectedDraft =")
        ? { ok: true }
        : expression.includes("const el = document.querySelector")
          ? true
          : false,
    ),
  };
  const input = {
    environmentId: EnvironmentId.make("local"),
    sessionId: "session",
    requestId: "backend-spawn",
    prompt: "Do exactly one job",
    automation: automation as never,
    readSessions: (() => [
      { id: "session", title: "Worker", spawnRequestId: "backend-spawn" },
    ]) as never,
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
  it("does not interpret an empty composer or lack of rendered user turn as delivery or retry Enter", async () => {
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

  it("will not type or send into a manual guest lacking the matching spawn reservation", async () => {
    const { input, automation } = fixture();
    input.readSessions = (() => [{ id: "session", title: "User's manual new chat" }]) as never;
    const result = await sendInitialChatGPTPrompt(input);
    expect(result).toMatchObject({ delivery: "not_sent", sendAttempted: false });
    expect(automation.type).not.toHaveBeenCalled();
    expect(automation.press).not.toHaveBeenCalled();
  });

  it("replaces a restored draft when starting an automated worker or reboot", async () => {
    for (const newManagedWorker of [true, false]) {
      const { input, automation } = fixture();
      const result = await sendInitialChatGPTPrompt({ ...input, newManagedWorker });
      // No user turn is rendered in this fixture, so the submission is UNKNOWN.
      expect(result).toMatchObject({ delivery: "unknown", sendAttempted: true });
      expect(automation.evaluate).toHaveBeenCalledWith(
        "runtime",
        expect.objectContaining({
          expression: expect.stringContaining("document.execCommand('delete', false)"),
        }),
      );
      const clearedAt = automation.evaluate.mock.invocationCallOrder[0];
      const typedAt = automation.type.mock.invocationCallOrder[0];
      const verifiedAt = automation.evaluate.mock.invocationCallOrder[1];
      const pressedAt = automation.press.mock.invocationCallOrder[0];
      expect(clearedAt).toBeLessThan(typedAt!);
      expect(typedAt).toBeLessThan(verifiedAt!);
      expect(verifiedAt).toBeLessThan(pressedAt!);
      expect(automation.type).toHaveBeenCalledWith(
        "runtime",
        expect.objectContaining({
          clear: true,
          text: expect.stringContaining("Do exactly one job"),
        }),
      );
      expect(automation.press).toHaveBeenCalledWith(
        "runtime",
        expect.objectContaining({
          key: "Enter",
          expectedComposerText: expect.stringContaining("Do exactly one job"),
        }),
      );
    }
  });
  it("never types or sends when an inherited draft could not be cleared", async () => {
    const { input, automation } = fixture();
    automation.evaluate.mockResolvedValueOnce({
      ok: false,
      reason: "Could not clear restored ChatGPT draft.",
    });
    const result = await sendInitialChatGPTPrompt(input);
    expect(result.delivery).toBe("not_sent");
    expect(result.reason).toContain("Could not clear restored ChatGPT draft");
    expect(automation.type).not.toHaveBeenCalled();
    expect(automation.press).not.toHaveBeenCalled();
  });

  it("never sends if stale text reappears after typing the startup prompt", async () => {
    const { input, automation } = fixture();
    automation.evaluate.mockImplementation(
      async (_runtime: string, { expression }: { expression: string }) =>
        expression.includes("const draftEditor =")
          ? { ok: true }
          : expression.includes("const expectedDraft =")
            ? { ok: false, reason: "Automatic startup composer differs from intended prompt." }
            : false,
    );
    const result = await sendInitialChatGPTPrompt(input);
    expect(result.delivery).toBe("not_sent");
    expect(result.reason).toContain("composer differs from intended prompt");
    expect(automation.type).toHaveBeenCalledTimes(1);
    expect(automation.press).not.toHaveBeenCalled();
  });

  it("refuses to type into an already opened conversation instead of assuming it is fresh", async () => {
    const { input, automation } = fixture();
    automation.status.mockResolvedValue({
      url: "https://chatgpt.com/c/existing",
      available: true,
      loading: false,
    });
    const result = await sendInitialChatGPTPrompt(input);
    expect(result).toMatchObject({ delivery: "not_sent", sendAttempted: false });
    expect(automation.type).not.toHaveBeenCalled();
    expect(automation.press).not.toHaveBeenCalled();
  });

  it("delivers only after exact user-turn verification responds true", async () => {
    const { input, automation } = fixture();
    automation.evaluate.mockImplementation(
      async (_runtime: string, { expression }: { expression: string }) =>
        expression.includes("const draftEditor =") || expression.includes("const expectedDraft =")
          ? { ok: true }
          : expression.includes("const el = document.querySelector") ||
            expression.includes("data-message-author-role"),
    );
    const result = await sendInitialChatGPTPrompt(input);
    expect(result).toEqual({ delivery: "user_turn_observed", sendAttempted: true });
    expect(automation.press).toHaveBeenCalledTimes(1);
    const expression = (
      automation.evaluate.mock.calls as unknown as Array<[string, { expression: string }]>
    ).find(([, args]) => args.expression.includes("data-message-author-role"))?.[1]?.expression;
    expect(expression).toContain("data-message-author-role");
    expect(expression).not.toContain("window.location.pathname");
  });
});
