// @vitest-environment node
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./chatGPTBrowserSessions", () => ({
  CHATGPT_DEFAULT_URL: "https://chatgpt.com/",
  chatGPTBrowserThreadRef: () => ({ threadId: "session" }),
  readChatGPTBrowserSessions: () => [],
}));
vi.mock("./browser/previewRuntimeTabId", () => ({ previewRuntimeTabId: () => "runtime" }));
vi.mock("./browser/browserSurfaceStore", () => ({ acquireBrowserSurfaceActivity: () => () => {} }));
vi.mock("./browser/chatGPTGuestHibernation", () => ({ wakeChatGPTGuest: () => {} }));
vi.mock("./components/preview/previewBridge", () => ({ previewBridge: null }));
vi.mock("./chatGPTWebviewAutomation", () => ({ chatGPTWebviewAutomation: {} }));
vi.mock("./previewStateStore", () => ({ readThreadPreviewState: () => ({}) }));

import { sendInitialChatGPTPrompt } from "./chatGPTBrowserAutomation";

function fixture() {
  let clock = 0;
  let delivered = false;
  const automation = {
    status: vi.fn(async () => ({
      url: "https://chatgpt.com/", available: true, loading: false,
    })),
    waitFor: vi.fn(async () => undefined),
    type: vi.fn(),
    press: vi.fn(),
    evaluate: vi.fn(async (_runtime: string, { expression }: { expression: string }) => {
      if (expression.includes("const fresh = true")) return { submitted: true };
      if (expression.includes("data-message-author-role")) return delivered;
      return null;
    }),
  };
  const session = { id: "session", title: "Worker", spawnRequestId: "backend-spawn" };
  const input = {
    environmentId: EnvironmentId.make("local"),
    sessionId: session.id,
    requestId: session.spawnRequestId,
    prompt: "Do exactly one job",
    automation: automation as never,
    readSessions: (() => [session]) as never,
    readState: (() => ({ activeTabId: "tab", serverEpoch: "epoch" })) as never,
    now: () => clock,
    pause: async (ms: number) => { clock += ms; },
    timeoutMs: 700,
    acquireActivity: () => () => {},
  };
  return { input, automation, session, setDelivered: (value: boolean) => { delivered = value; } };
}

describe("fresh ChatGPT session direct-submit delivery", () => {
  it("uses only React's explicit-text callback; never edits a restored draft", async () => {
    const { input, automation } = fixture();
    const result = await sendInitialChatGPTPrompt(input);
    expect(result).toMatchObject({ delivery: "unknown", sendAttempted: true });
    expect(automation.type).not.toHaveBeenCalled();
    expect(automation.press).not.toHaveBeenCalled();
    const expressions = automation.evaluate.mock.calls.map(([, arg]) => arg.expression);
    const submitted = expressions.filter((x) => x.includes("const fresh = true"));
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toContain("Do exactly one job");
    expect(submitted[0]).toContain("preserveDraft: true");
    expect(submitted[0]).not.toContain("execCommand");
    expect(submitted[0]).not.toContain("editor.focus");
  });

  it("keeps UNKNOWN and does not resubmit after IPC failure at callback invocation", async () => {
    const { input, automation } = fixture();
    automation.evaluate.mockRejectedValueOnce(new Error("bridge disconnected"));
    const result = await sendInitialChatGPTPrompt(input);
    expect(result).toMatchObject({
      delivery: "unknown", sendAttempted: true, reason: "bridge disconnected",
    });
    expect(automation.evaluate).toHaveBeenCalledTimes(1);
  });

  it("returns not_sent when the composer never becomes ready", async () => {
    const { input, automation } = fixture();
    automation.waitFor.mockRejectedValue(new Error("composer unavailable"));
    const result = await sendInitialChatGPTPrompt(input);
    expect(result).toMatchObject({ delivery: "not_sent", sendAttempted: false });
    expect(automation.evaluate).not.toHaveBeenCalled();
  });

  it("never touches a manual session without an exact spawn reservation", async () => {
    const { input, automation } = fixture();
    input.readSessions = (() => [{ id: "session", title: "Manual" }]) as never;
    const result = await sendInitialChatGPTPrompt(input);
    expect(result).toMatchObject({ delivery: "not_sent", sendAttempted: false });
    expect(automation.evaluate).not.toHaveBeenCalled();
  });

  it("waits for React callback readiness but submits exactly once", async () => {
    const { input, automation, setDelivered } = fixture();
    let attempts = 0;
    automation.evaluate.mockImplementation(async (_runtime, { expression }) => {
      if (expression.includes("const fresh = true")) {
        attempts++;
        return { submitted: attempts > 1 };
      }
      if (expression.includes("data-message-author-role")) return true;
      return null;
    });
    setDelivered(true);
    const result = await sendInitialChatGPTPrompt(input);
    expect(result).toEqual({ delivery: "user_turn_observed", sendAttempted: true });
    expect(attempts).toBe(2);
  });

  it("does not send into a previous conversation and reports not_sent", async () => {
    const { input, automation } = fixture();
    automation.status.mockResolvedValue({
      url: "https://chatgpt.com/c/01234567-1111-4111-8111-0123456789ab",
      available: true, loading: false,
    });
    const result = await sendInitialChatGPTPrompt(input);
    expect(result).toMatchObject({ delivery: "not_sent", sendAttempted: false });
    expect(automation.evaluate).not.toHaveBeenCalled();
  });

  it("guards against a replaced reservation just before dispatch", async () => {
    const { input, automation, session } = fixture();
    let reads = 0;
    input.readSessions = (() => ++reads <= 1 ? [session] : []) as never;
    const result = await sendInitialChatGPTPrompt(input);
    expect(result).toMatchObject({ delivery: "not_sent", sendAttempted: false });
    expect(automation.evaluate).not.toHaveBeenCalled();
  });

  it("confirms only an actual rendered user turn, never a bare callback acknowledgement", async () => {
    const { input, automation, setDelivered } = fixture();
    setDelivered(true);
    const result = await sendInitialChatGPTPrompt(input);
    expect(result).toEqual({ delivery: "user_turn_observed", sendAttempted: true });
    expect(automation.evaluate.mock.calls.filter(([, arg]) =>
      arg.expression.includes("const fresh = true"))).toHaveLength(1);
  });
});
