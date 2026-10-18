import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { inspectChatGPTPage } from "./chatGPTSessionDom.ts";

function inspect(content) {
  const dom = new JSDOM(`<!doctype html><body><div id="prompt-textarea"></div>${content}</body>`, {
    url: "https://chatgpt.com/c/test",
    runScripts: "outside-only",
  });
  // jsdom has no layout engine; simulate visible nodes for the injected guest.
  dom.window.Element.prototype.getClientRects = () => ({ length: 1 });
  const probe = dom.window.eval(`(${inspectChatGPTPage.toString()})`);
  const result = probe({ from: "end", count: 1, includeMessages: false });
  dom.window.close();
  return result;
}

test("extracts turns when role attributes are absent", () => {
  const dom = new JSDOM(
    '<!doctype html><body><div data-testid="conversation-turn-0"><div data-testid="user-message">Question</div></div><div data-testid="conversation-turn-1"><div class="markdown">Answer</div></div></body>',
    { url: "https://chatgpt.com/c/test", runScripts: "outside-only" },
  );
  dom.window.Element.prototype.getClientRects = () => ({ length: 1 });
  const probe = dom.window.eval(`(${inspectChatGPTPage.toString()})`);
  const result = probe({ from: "end", count: 2, includeMessages: true });
  assert.equal(
    JSON.stringify(result.messages.map((m) => [m.role, m.text])),
    JSON.stringify([
      ["user", "Question"],
      ["assistant", "Answer"],
    ]),
  );
  dom.window.close();
});

test("interruptions are reported even if a Stop button is still visible", () => {
  assert.equal(
    inspect(
      '<button data-testid="stop-button">Stop</button>' +
        '<div role="status">Connection interrupted. Waiting for the complete answer</div>',
    ).connectionInterrupted,
    true,
  );
});

test("split notice across spans is detected", () => {
  assert.equal(
    inspect(
      '<div role="status"><span>Connection interrupted.</span>' +
        "<span> Waiting for the complete answer</span></div>",
    ).connectionInterrupted,
    true,
  );
});

test("recovering clears the interruption status on subsequent inspections", () => {
  assert.equal(inspect('<div role="status">Reconnected</div>').connectionInterrupted, false);
});

test("quoted user message is not mistaken for connection loss", () => {
  assert.equal(
    inspect(
      '<div data-message-author-role="user">Connection interrupted. Waiting for the complete answer</div>',
    ).connectionInterrupted,
    false,
  );
});

test("a long explanation mentioning the notice is not classified as broken", () => {
  assert.equal(
    inspect(
      '<div data-message-author-role="assistant">The UI sometimes says ' +
        "Connection interrupted. Waiting for the complete answer but it can reconnect.</div>",
    ).connectionInterrupted,
    false,
  );
});
