// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import {
  CHATGPT_PREWARM_READY_EXPRESSION,
  chatGPTPrewarmKey,
  isChatGPTHomeUrl,
  markChatGPTSpareReady,
  releaseChatGPTSpare,
  takeChatGPTSpare,
} from "./chatGPTBrowserPrewarm";

const env = EnvironmentId.make("prewarm-test");

beforeEach(() => {
  document.body.replaceChildren();
  vi.stubGlobal("location", { hostname: "chatgpt.com", pathname: "/" });
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
});
afterEach(() => {
  releaseChatGPTSpare(env, "slot-1");
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("prepared ChatGPT guest", () => {
  it("requires an interactive composer, not just document readiness", () => {
    expect(window.eval(CHATGPT_PREWARM_READY_EXPRESSION)).toBe(false);
    document.body.innerHTML = '<div id="prompt-textarea"></div>';
    expect(window.eval(CHATGPT_PREWARM_READY_EXPRESSION)).toBe(true);
    vi.stubGlobal("location", { hostname: "example.com", pathname: "/" });
    expect(window.eval(CHATGPT_PREWARM_READY_EXPRESSION)).toBe(false);
    vi.stubGlobal("location", { hostname: "chatgpt.com", pathname: "/c/old" });
    expect(window.eval(CHATGPT_PREWARM_READY_EXPRESSION)).toBe(false);
  });

  it("only accepts the new-chat home page and not an existing conversation", () => {
    expect(isChatGPTHomeUrl("https://chatgpt.com/")).toBe(true);
    expect(isChatGPTHomeUrl("https://chatgpt.com/?model=auto")).toBe(true);
    expect(isChatGPTHomeUrl("https://chatgpt.com/c/a-conversation")).toBe(false);
    expect(isChatGPTHomeUrl("https://malicious.example/")).toBe(false);
    expect(isChatGPTHomeUrl("not a URL")).toBe(false);
  });

  it("uses a single ready spare once, isolated by environment", () => {
    expect(chatGPTPrewarmKey(env)).toContain("prewarm:prewarm-test");
    expect(takeChatGPTSpare(env, "slot-1")).toBe(false);
    markChatGPTSpareReady(env, "slot-1");
    expect(takeChatGPTSpare(EnvironmentId.make("other"), "slot-1")).toBe(false);
    expect(takeChatGPTSpare(env, "slot-2")).toBe(false);
    expect(takeChatGPTSpare(env, "slot-1")).toBe(true);
    expect(takeChatGPTSpare(env, "slot-1")).toBe(false);
    markChatGPTSpareReady(env, "slot-1");
    releaseChatGPTSpare(env, "slot-1");
    expect(takeChatGPTSpare(env, "slot-1")).toBe(false);
  });
});
