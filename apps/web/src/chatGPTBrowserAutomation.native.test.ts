// @vitest-environment node
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./chatGPTBrowserSessions", () => ({
  CHATGPT_DEFAULT_URL: "https://chatgpt.com/",
  chatGPTBrowserThreadRef: () => ({ threadId: "unused" }),
  readChatGPTBrowserSessions: () => [],
}));
vi.mock("./browser/browserSurfaceStore", () => ({
  acquireBrowserSurfaceActivity: () => { throw new Error("Legacy preview activity must not be used."); },
}));
vi.mock("./browser/chatGPTGuestHibernation", () => ({
  wakeChatGPTGuest: () => { throw new Error("Native guest must not be woken through preview."); },
}));
vi.mock("./components/preview/previewBridge", () => ({ previewBridge: null }));
vi.mock("./chatGPTWebviewAutomation", () => ({ chatGPTWebviewAutomation: {} }));

import { sendInitialChatGPTPrompt } from "./chatGPTBrowserAutomation";

const SESSION = "b9dcddb3-e874-4a31-a6b3-d8acbcd99fb4";
const REQUEST = "8b53ce0f-a020-4791-99dc-7cbb31644039";
const sessions = (() => [{
  id: SESSION, title: "Diagnostic", spawnRequestId: REQUEST,
}]) as never;

afterEach(() => vi.unstubAllGlobals());

describe("new ChatGPT native Chromium initial direct submit", () => {
  it("attaches only its own fresh guest and submits without the input box or preview tab", async () => {
    const operations: string[] = [];
    const bridge = vi.fn(async (request: { operation: string; expression?: string }) => {
      operations.push(request.operation);
      if (request.operation === "attach" || request.operation === "snapshot")
        return { url: "https://chatgpt.com/", destroyed: false };
      if (request.operation !== "evaluate") throw Error("Unexpected native operation");
      const expression = request.expression ?? "";
      if (expression.includes("const fresh = true")) return { result: { submitted: true } };
      if (expression.includes("data-message-author-role")) return { result: true };
      return { result: true }; // waitFor readiness
    });
    vi.stubGlobal("window", { desktopBridge: { stableChatGPTViewRequest: bridge } });
    const outcome = await sendInitialChatGPTPrompt({
      environmentId: EnvironmentId.make("local"), sessionId: SESSION, requestId: REQUEST,
      prompt: "Diagnostic native worker", readSessions: sessions,
      readState: (() => { throw new Error("Native path incorrectly read legacy preview"); }) as never,
      timeoutMs: 3_000,
    });
    expect(outcome).toEqual({ delivery: "user_turn_observed", sendAttempted: true });
    expect(operations[0]).toBe("attach");
    expect(operations).toContain("snapshot");
    expect(bridge.mock.calls.filter(([arg]) => arg.operation === "evaluate" &&
      arg.expression?.includes("const fresh = true"))).toHaveLength(1);
    expect(bridge.mock.calls[0]?.[0]).toMatchObject({
      identity: { sessionId: SESSION, environmentId: "local", profileId: "default" },
      url: "https://chatgpt.com/",
    });
  });

  it("does not claim a send when the React callback cannot be found", async () => {
    let clock = 0;
    let submissions = 0;
    const bridge = vi.fn(async (request: { operation: string; expression?: string }) => {
      if (request.operation === "attach" || request.operation === "snapshot")
        return { url: "https://chatgpt.com/", destroyed: false };
      const expression = request.expression ?? "";
      if (expression.includes("const fresh = true")) {
        submissions++;
        return { result: { submitted: false, reason: "callback_unavailable" } };
      }
      return { result: true };
    });
    vi.stubGlobal("window", { desktopBridge: { stableChatGPTViewRequest: bridge } });
    const outcome = await sendInitialChatGPTPrompt({
      environmentId: EnvironmentId.make("local"), sessionId: SESSION, requestId: REQUEST,
      prompt: "Never send unverified", readSessions: sessions,
      now: () => clock, pause: async (ms) => { clock += ms; }, timeoutMs: 700,
    });
    expect(outcome).toMatchObject({ delivery: "not_sent", sendAttempted: false });
    expect(submissions).toBeGreaterThan(0);
  });
});
