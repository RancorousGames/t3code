// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { inspectChatGPTPage } from "./chatGPTSessionDom";
import { inspectChatGPTPageSnapshot } from "./chatGPTPageSnapshotInspection";

beforeEach(() => {
  vi.stubGlobal("location", new URL("https://chatgpt.com/c/6aff881b-67c8-83eb-9166-dde3a8a4d84e"));
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function detect(extraHtml: string): [boolean | undefined, boolean] {
  document.body.innerHTML =
    '<main><div data-message-author-role="user">A question</div></main>' +
    '<div id="prompt-textarea" contenteditable="true"></div>' +
    extraHtml;
  const snapshot = inspectChatGPTPageSnapshot("idle");
  const session = inspectChatGPTPage({ from: "end", count: 1, includeMessages: false });
  return [snapshot?.signals.conversationFull, session.conversationFull];
}

it("detects ChatGPT's maximum-length banner outside main without alert semantics", () => {
  expect(
    detect(
      `<div class="composer-footer"><span>You've reached the maximum length for this conversation, but you can keep talking by starting a new chat.</span><button>Start new chat</button></div>`,
    ),
  ).toEqual([true, true]);
});

it("detects split maximum-length banner outside main", () => {
  expect(
    detect(
      `<div class="composer-footer"><span>You've reached the maximum length</span><span> for this conversation</span><button>Start new chat</button></div>`,
    ),
  ).toEqual([true, true]);
});

it("does not mistake user-quoted limit text for a real system warning", () => {
  expect(
    detect(
      `<div data-message-author-role="user">You've reached the maximum length for this conversation</div>`,
    ),
  ).toEqual([false, false]);
});

it("does not confuse a temporary loading limit with permanent conversation exhaustion", () => {
  expect(
    detect("<div>A temporary limit is preventing this chat from loading. Try again later.</div>"),
  ).toEqual([false, false]);
});
