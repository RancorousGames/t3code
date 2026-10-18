import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "../apps/web/node_modules/jsdom/lib/api.js";
import { inspectChatGPTPage } from "../apps/web/src/chatGPTSessionDom.ts";

function inDom(html, fn) {
  const dom = new JSDOM("<!doctype html><html><body>" + html + "</body></html>", {
    url: "https://chatgpt.com/c/test",
  });
  const old = {
    document: globalThis.document,
    location: globalThis.location,
    Element: globalThis.Element,
    NodeFilter: globalThis.NodeFilter,
  };
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.Element = dom.window.Element;
  globalThis.NodeFilter = dom.window.NodeFilter;
  dom.window.Element.prototype.getClientRects = () => ({ length: 1 });
  try {
    return fn();
  } finally {
    Object.assign(globalThis, old);
    dom.window.close();
  }
}

test("modern data-content-search-unit-key wrappers allow ordered message extraction", () => {
  const html =
    '<div id="prompt-textarea" contenteditable="true"></div>' +
    '<main><div data-turn-key="t0">' +
    '<div data-content-search-unit-key="fallback-turn-0:0:user"><p>first request</p></div>' +
    '<div data-content-search-unit-key="fallback-turn-0:2:assistant">' +
    '<div data-markdown-text-style="assistant-message"><p>first answer</p></div><button>Copy</button></div></div>' +
    '<div data-turn-key="t1">' +
    '<div data-content-search-unit-key="fallback-turn-1:0:user"><p>second request</p></div>' +
    '<div data-content-search-unit-key="fallback-turn-1:2:assistant">' +
    '<div data-markdown-text-style="assistant-message"><p>second answer</p></div><button>Copy</button></div></div></main>';
  inDom(html, () => {
    const start = inspectChatGPTPage({ from: "start", count: 1, includeMessages: true });
    assert.equal(start.totalTurns, 2);
    assert.equal(start.lastRole, "assistant");
    assert.deepEqual(start.messages, [
      { role: "user", text: "first request", turn: 0, turnKey: "t0" },
      { role: "assistant", text: "first answer", turn: 0, turnKey: "t0" },
    ]);
    assert.equal(start.diagnostics.turnElements, 4);
    assert.deepEqual(
      inspectChatGPTPage({ from: "end", count: 1, includeMessages: true }).messages,
      [
        { role: "user", text: "second request", turn: 1, turnKey: "t1" },
        { role: "assistant", text: "second answer", turn: 1, turnKey: "t1" },
      ],
    );
  });
});

test("archive reads up to 24000 characters without inflating default message responses", () => {
  inDom('<div data-message-author-role="assistant"><p>' + "x".repeat(30_000) + "</p></div>", () => {
    const ordinary = inspectChatGPTPage({ from: "end", count: 1, includeMessages: true });
    const archive = inspectChatGPTPage({
      from: "end",
      count: 1,
      includeMessages: true,
      maxMessageChars: 24_000,
    });
    assert.equal(ordinary.messages[0].text.length, 6000);
    assert.equal(archive.messages[0].text.length, 24_000);
    const absurd = inspectChatGPTPage({
      from: "end",
      count: 1,
      includeMessages: true,
      maxMessageChars: 1e8,
    });
    assert.equal(absurd.messages[0].text.length, 24_000);
  });
});

test("legacy selector remains preferred when both formats exist", () => {
  inDom(
    '<div data-content-search-unit-key="fallback-turn-0:0:user">' +
      '<div data-message-author-role="user"><p>legacy value</p></div></div>',
    () => {
      assert.deepEqual(
        inspectChatGPTPage({ from: "end", count: 1, includeMessages: true }).messages,
        [{ role: "user", text: "legacy value", turn: 0 }],
      );
    },
  );
});
