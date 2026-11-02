// @vitest-environment node
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./chatGPTBrowserSessions", () => ({
  CHATGPT_DEFAULT_URL: "https://chatgpt.com/",
  chatGPTBrowserThreadRef: () => ({ threadId: "unused" }),
  readChatGPTBrowserSessions: () => [],
}));
vi.mock("./browser/browserSurfaceStore", () => ({
  acquireBrowserSurfaceActivity: () => {
    throw new Error("Legacy preview activity must not be used.");
  },
}));
vi.mock("./browser/chatGPTGuestHibernation", () => ({
  wakeChatGPTGuest: () => {
    throw new Error("Native guest must not be woken through preview.");
  },
}));
vi.mock("./components/preview/previewBridge", () => ({ previewBridge: null }));
vi.mock("./chatGPTWebviewAutomation", () => ({ chatGPTWebviewAutomation: {} }));

import { sendInitialChatGPTPrompt } from "./chatGPTBrowserAutomation";

const SESSION = "b9dcddb3-e874-4a31-a6b3-d8acbcd99fb4";
const REQUEST = "8b53ce0f-a020-4791-99dc-7cbb31644039";

afterEach(() => vi.unstubAllGlobals());

describe("new ChatGPT session native Chromium initial delivery", () => {
  it("attaches a fresh native guest and sends without any legacy preview tab", async () => {
    const operations: string[] = [];
    const bridge = vi.fn(async (request: { operation: string; expression?: string }) => {
      operations.push(request.operation);
      if (request.operation === "attach" || request.operation === "snapshot")
        return { url: "https://chatgpt.com/", destroyed: false };
      if (request.operation !== "evaluate") throw Error("Unexpected native operation");
      const expression = request.expression ?? "";
      const result =
        expression.includes("const draftEditor =") || expression.includes("const expectedDraft =")
          ? { ok: true }
          : expression.includes("const inserted =")
            ? { ok: true }
            : expression.includes("const controls =")
              ? { clicked: true }
              : true;
      return { result };
    });
    vi.stubGlobal("window", { desktopBridge: { stableChatGPTViewRequest: bridge } });
    const outcome = await sendInitialChatGPTPrompt({
      environmentId: EnvironmentId.make("local"),
      sessionId: SESSION,
      requestId: REQUEST,
      prompt: "Diagnostic native worker",
      readSessions: (() => [
        {
          id: SESSION,
          title: "Diagnostic",
          spawnRequestId: REQUEST,
        },
      ]) as never,
      readState: (() => {
        throw new Error("Native path incorrectly read legacy preview");
      }) as never,
      timeoutMs: 3_000,
    });
    expect(outcome).toEqual({ delivery: "user_turn_observed", sendAttempted: true });
    expect(operations[0]).toBe("attach");
    expect(operations).toContain("snapshot");
    expect(operations.filter((operation) => operation === "evaluate").length).toBeGreaterThan(3);
    expect(bridge.mock.calls[0]?.[0]).toMatchObject({
      identity: { sessionId: SESSION, environmentId: "local", profileId: "default" },
      url: "https://chatgpt.com/",
    });
  });
  it("never presses Send if the native composer cannot be verified", async () => {
    let sendClicked = false;
    const bridge = vi.fn(async (request: { operation: string; expression?: string }) => {
      if (request.operation === "attach" || request.operation === "snapshot")
        return { url: "https://chatgpt.com/", destroyed: false };
      const expression = request.expression ?? "";
      if (expression.includes("const controls =")) {
        sendClicked = true;
        return { result: { clicked: true } };
      }
      if (expression.includes("const expectedDraft =")) return { result: { ok: false } };
      if (expression.includes("const draftEditor =") || expression.includes("const inserted ="))
        return { result: { ok: true } };
      return { result: true };
    });
    vi.stubGlobal("window", { desktopBridge: { stableChatGPTViewRequest: bridge } });
    const outcome = await sendInitialChatGPTPrompt({
      environmentId: EnvironmentId.make("local"),
      sessionId: SESSION,
      requestId: REQUEST,
      prompt: "Never send unverified",
      readSessions: (() => [
        { id: SESSION, title: "Diagnostic", spawnRequestId: REQUEST },
      ]) as never,
      timeoutMs: 3_000,
    });
    expect(outcome).toMatchObject({ delivery: "not_sent", sendAttempted: false });
    expect(sendClicked).toBe(false);
  });
});
