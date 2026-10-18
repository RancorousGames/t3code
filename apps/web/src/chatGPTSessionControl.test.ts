// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { inspectChatGPTPage } from "./chatGPTSessionDom";
import { hasChatGPTLoadFailure } from "./components/sidebar/chatGPTConversationRecovery";

beforeEach(() => {
  vi.stubGlobal("location", { hostname: "chatgpt.com", href: "https://chatgpt.com/c/test" });
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
  document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"></div>';
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const user = (text: string) => `<div data-message-author-role="user"><p>${text}</p></div>`;
const assistant = (text: string) =>
  `<div data-message-author-role="assistant"><p>${text}</p></div>`;
const scan = (from: "start" | "end", count: number, includeMessages = true) =>
  inspectChatGPTPage({ from, count, includeMessages });

describe("ChatGPT session guest inspection", () => {
  it("selects the first or last N full user/assistant turns", () => {
    document.body.innerHTML +=
      user("one") + assistant("A") + user("two") + assistant("B") + user("three") + assistant("C");
    expect(scan("start", 1).messages).toEqual([
      { role: "user", text: "one", turn: 0 },
      { role: "assistant", text: "A", turn: 0 },
    ]);
    expect(scan("end", 2).messages).toEqual([
      { role: "user", text: "two", turn: 1 },
      { role: "assistant", text: "B", turn: 1 },
      { role: "user", text: "three", turn: 2 },
      { role: "assistant", text: "C", turn: 2 },
    ]);
    expect(scan("end", 2).totalTurns).toBe(3);
  });

  it("detects active generation, and does not extract chat history for list status", () => {
    document.body.innerHTML +=
      user("input") + assistant("partial") + '<button data-testid="stop-button">Stop</button>';
    const snapshot = scan("end", 3, false);
    expect(snapshot).toMatchObject({
      activity: "working",
      totalTurns: 1,
      lastRole: "assistant",
      lastText: "partial",
      messages: [],
    });
  });

  it("does not mistake an error quoted in a user message for a stuck session", () => {
    document.body.innerHTML +=
      user("Could not load this ChatGPT conversation") + "<button>Retry</button>";
    expect(hasChatGPTLoadFailure()).toBe(false);
  });

  it("recognizes the interrupted connection notice despite a Stop control", () => {
    document.body.innerHTML +=
      '<button data-testid="stop-button">Stop</button>' +
      '<div role="status">Connection interrupted. Waiting for the complete answer</div>';
    expect(scan("end", 1, false)).toMatchObject({
      activity: "working",
      connectionInterrupted: true,
      messages: [],
    });
    document.querySelector('[role="status"]')?.remove();
    expect(scan("end", 1, false).connectionInterrupted).toBe(false);
  });

  it("recognizes a notice split across adjacent nodes", () => {
    document.body.innerHTML +=
      '<div role="status"><span>Connection interrupted.</span>' +
      "<span> Waiting for the complete answer</span></div>";
    expect(scan("end", 1, false).connectionInterrupted).toBe(true);
  });

  it("does not mistake a user's quotation for a connection interruption", () => {
    document.body.innerHTML += user("Connection interrupted. Waiting for the complete answer");
    expect(scan("end", 1, false).connectionInterrupted).toBe(false);
  });

  it("does not classify a long assistant passage quoting the notice as an outage", () => {
    document.body.innerHTML += assistant(
      "Here is what that banner means: " +
        "Connection interrupted. Waiting for the complete answer — but it may recover.",
    );
    expect(scan("end", 1, false).connectionInterrupted).toBe(false);
  });

  it("limits the returned text per message", () => {
    document.body.innerHTML += user("x".repeat(7000));
    expect(scan("start", 1).messages[0]?.text).toHaveLength(6000);
    expect(scan("start", 1).lastText).toHaveLength(400);
  });

  it("refuses to inspect arbitrary third-party domains", () => {
    vi.stubGlobal("location", { hostname: "example.com", href: "https://example.com/" });
    expect(scan("end", 1)).toMatchObject({
      activity: "unknown",
      messages: [],
      totalTurns: 0,
    });
  });
});
