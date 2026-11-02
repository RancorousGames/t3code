// @vitest-environment node
// @ts-expect-error JSDOM is available for these renderer tests.
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./browser/persistentChatGPTSessionMode", () => ({
  isPersistentChatGPTSessionOptedIn: () => true,
}));
import { runChatGPTSessionControl, resetUncertainChatGPTSendsForTests } from "./chatGPTSessionControl";

const SESSION = "8f9c3cc9-99f2-4c6a-9ed5-72bd6814ac44";
const OTHER = "51d6f799-bee5-4c2d-ad80-f1ee247b5a83";
const CONVERSATION = "7c50ebec-dc28-484c-8b7d-250515ad16ee";
const URL = `https://chatgpt.com/c/${CONVERSATION}`;
const MESSAGE = "[T3-MSG:2ea855d1-e466-4922-82c8-c08a6b4c3b03]\nNative Chromium queued-message regression";

let dom: JSDOM;
let sent: string;
let turns: number;
let drafts: string;
let pressed: number;
let evaluations: Array<{ sessionId: string; expression: string }>;
let liveUrl: string;
let blockSend: boolean;

beforeEach(() => {
  dom = new JSDOM("<div id='prompt-textarea' contenteditable='true'></div>", {
    url: URL,
  });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("localStorage", dom.window.localStorage);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("HTMLTextAreaElement", dom.window.HTMLTextAreaElement);
  vi.stubGlobal("Element", dom.window.Element);
  turns = 0;
  pressed = 0;
  sent = "";
  drafts = "";
  evaluations = [];
  liveUrl = URL;
  blockSend = false;
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      stableChatGPTViewRequest: async (request: {
        operation: string;
        identity: { sessionId: string; environmentId: string };
        expression?: string;
      }) => {
        if (request.identity.sessionId !== SESSION)
          throw new Error("Native command addressed wrong owner");
        if (request.identity.environmentId !== "local")
          throw new Error("Native command addressed wrong environment");
        if (request.operation === "snapshot" || request.operation === "probe")
          return { residency: "resident", url: liveUrl, destroyed: false, loading: false };
        if (request.operation !== "evaluate")
          throw new Error("Unexpected native operation");
        const expression = request.expression ?? "";
        evaluations.push({ sessionId: request.identity.sessionId, expression });
        if (expression.includes("const result =") && expression.includes("inspectChatGPTPage")) {
          return { result: {
            url: liveUrl, activity: "idle", uiActivity: "idle",
            totalTurns: turns ? 2 : 1,
            lastRole: turns ? "user" : "assistant",
            lastText: turns ? sent : "Old assistant reply",
            lastUserTurnKey: turns ? "new-turn" : "old-turn",
            lastUserTurn: turns ? 1 : 0,
            assistantHasContent: !turns,
            connectionInterrupted: false, stuck: false,
            messages: turns ? [{ role: "user", text: sent, turn: 1, turnKey: "new-turn" }] : [],
          } };
        }
        if (expression.includes("Array.from(document.querySelectorAll('[data-message-author-role"))
          return { result: turns > 0 };
        if (expression.includes("const el=document.querySelector("))
          return { result: drafts };
        if (expression.includes("inspectChatGPTComposer"))
          return { result: { status: drafts.trim() ? "nonempty" : "empty", text: drafts, url: liveUrl } };
        if (expression.includes("Boolean(document.querySelector("))
          return { result: true };
        if (expression.includes("Contenteditable rejected or changed text")) {
          drafts = MESSAGE;
          return { result: { ok: true } };
        }
        if (expression.includes("serialization_metadata") && expression.includes("callback(")) {
          if (blockSend) return { result: { submitted: false } };
          const match = /callback\(("(?:\\.|[^"\\])*"), performance/.exec(expression);
          sent = match ? JSON.parse(match[1]!) : MESSAGE;
          pressed++;
          turns++;
          return { result: { submitted: true } };
        }
        if (expression.includes("const selectors = [")) {
          if (blockSend) return { result: { composerMismatch: true } };
          sent = drafts;
          pressed++;
          turns++;
          return { result: { clicked: true } };
        }
        if (expression.includes("nodes = document.querySelectorAll"))
          return { result: turns ? sent : null };
        throw new Error("Unexpected native evaluation: " + expression.slice(0, 95));
      },
    },
  });
});

afterEach(() => {
  resetUncertainChatGPTSendsForTests();
  vi.unstubAllGlobals();
  dom.window.close();
});

describe("native queued ChatGPT injection", () => {
  it("delivers and acknowledges the exact queued message without a legacy webview", async () => {
    const result = await runChatGPTSessionControl({
      environmentId: "local" as never,
      sessions: [{ id: SESSION, title: "Native agent", hidden: false }] as never,
      sessionId: SESSION,
      action: "send",
      message: MESSAGE,
      expectedConversationId: CONVERSATION,
      sendExpiresAt: Date.now() + 40_000,
    }) as { delivery: string; messageSent: boolean };
    expect(result).toMatchObject({
      delivery: "user_turn_observed",
      messageSent: true,
    });
    expect(pressed).toBe(1);
    expect(sent).toBe(MESSAGE);
    expect(document.querySelectorAll("webview")).toHaveLength(0);
    expect(evaluations.length).toBeGreaterThan(3);
    expect(evaluations.every((x) => x.sessionId === SESSION)).toBe(true);
  });

  it("refuses a mismatched conversation before a native submit", async () => {
    liveUrl = `https://chatgpt.com/c/${OTHER}`;
    await expect(runChatGPTSessionControl({
      environmentId: "local" as never,
      sessions: [{ id: SESSION, title: "Native agent", hidden: false }] as never,
      sessionId: SESSION, action: "send",
      message: MESSAGE, expectedConversationId: CONVERSATION,
      sendExpiresAt: Date.now() + 40_000,
    })).rejects.toThrow(/guard mismatch/i);
    expect(pressed).toBe(0);
  });

  it("reconciles a submitted user turn without replaying the native send", async () => {
    const request = {
      environmentId: "local" as never,
      sessions: [{ id: SESSION, title: "Native agent", hidden: false }] as never,
      sessionId: SESSION,
      message: MESSAGE,
      expectedConversationId: CONVERSATION,
      sendExpiresAt: Date.now() + 40_000,
    };
    const first = await runChatGPTSessionControl({ ...request, action: "send" });
    expect(first).toMatchObject({ messageSent: true });
    expect(pressed).toBe(1);
    const result = await runChatGPTSessionControl({ ...request, action: "reconcile_send" });
    expect(result).toMatchObject({ delivery: "user_turn_observed" });
    expect(pressed).toBe(1);
  });

  it("backs up the exact native composer without requiring a preview mount", async () => {
    const save = vi.fn(async (_input: unknown) => ({ savedAt: Date.now() }));
    Object.defineProperty(window.desktopBridge, "savePrivateChatGPTDraftSnapshot", {
      configurable: true, value: save,
    });
    const result = await runChatGPTSessionControl({
      environmentId: "local" as never,
      sessions: [{ id: SESSION, title: "Native agent", hidden: false }] as never,
      sessionId: SESSION,
      action: "snapshot",
    });
    expect(result).toMatchObject({ status: "backed_up_empty" });
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      sessionId: SESSION, url: URL, draft: "",
    });
    expect(pressed).toBe(0);
  });

  it("does not click Send when the direct-submit callback is unavailable", async () => {
    blockSend = true;
    const result = await runChatGPTSessionControl({
      environmentId: "local" as never,
      sessions: [{ id: SESSION, title: "Native agent", hidden: false }] as never,
      sessionId: SESSION, action: "send", message: MESSAGE,
      expectedConversationId: CONVERSATION,
      sendExpiresAt: Date.now() + 40_000,
    }) as { delivery: string; messageSent: boolean; sendAttempted: boolean };
    expect(result.messageSent).toBe(false);
    expect(result.sendAttempted).toBe(false);
    expect(result.delivery).toBe("pre_submit_aborted");
    expect(pressed).toBe(0);
  });
});
