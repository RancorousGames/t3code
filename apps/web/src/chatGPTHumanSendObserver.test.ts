// @vitest-environment node
// @ts-expect-error jsdom test runtime is installed without its type declarations.
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vite-plus/test";

// @ts-ignore Cross-project Electron preload tested here because jsdom is provided by web.
import * as humanSend from "../../desktop/src/preview/ChatGPTHumanSendObserver.ts";
const { installChatGPTHumanSendObserver, VERIFIED_HUMAN_SEND_ATTRIBUTE } = humanSend;

const doms: JSDOM[] = [];
function setup() {
  const dom = new JSDOM(
    '<form><div id="prompt-textarea" contenteditable="true" role="textbox">Hello</div>' +
      '<button data-testid="send-button" type="button"><span>Send</span></button></form>',
    { url: "https://chatgpt.com/c/example" },
  );
  doms.push(dom);
  const doc = dom.window.document;
  const observer = installChatGPTHumanSendObserver(
    dom.window as unknown as Window & typeof globalThis,
    doc,
  );
  const composer = doc.querySelector("#prompt-textarea")!;
  const button = doc.querySelector("button span")!;
  const click = (trusted: boolean, target: Element = button) =>
    observer.onClick({ isTrusted: trusted, target } as unknown as MouseEvent);
  const key = (trusted: boolean, target: Element = composer) =>
    observer.onKeyDown({
      isTrusted: trusted,
      target,
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    } as unknown as KeyboardEvent);
  const addTurn = (key: string) => {
    const wrapper = doc.createElement("div");
    wrapper.setAttribute("data-turn-key", key);
    const node = doc.createElement("div");
    node.setAttribute("data-message-author-role", "user");
    wrapper.appendChild(node);
    doc.body.appendChild(wrapper);
    return wrapper;
  };
  const verified = () =>
    Number(doc.documentElement.getAttribute(VERIFIED_HUMAN_SEND_ATTRIBUTE)) > 0;
  return { observer, doc, click, key, addTurn, verified };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
afterEach(() => {
  for (const dom of doms.splice(0)) dom.window.close();
});

describe("trusted ChatGPT human-turn promotion proof", () => {
  it("confirms a physical keyboard submission only after a new rendered user turn", async () => {
    const test = setup();
    test.key(true);
    expect(test.verified()).toBe(false);
    test.addTurn("human-turn-1");
    await flush();
    expect(test.verified()).toBe(true);
    test.observer.dispose();
  });

  it("accepts a genuine send-button click, including nested icon targets and attachment-only sends", async () => {
    const test = setup();
    test.click(true);
    test.addTurn("human-click-1");
    await flush();
    expect(test.verified()).toBe(true);
    test.observer.dispose();
  });

  it("recognizes the modern composer-submit-button control", async () => {
    const test = setup();
    test.doc.querySelector("button")!.setAttribute("data-testid", "composer-submit-button");
    test.click(true);
    test.addTurn("modern-human-click");
    await flush();
    expect(test.verified()).toBe(true);
    test.observer.dispose();
  });

  it("does not promote on injected keyboard events, DOM click(), or programmatic user turns", async () => {
    const test = setup();
    test.key(false);
    test.click(false);
    (test.doc.querySelector("button") as HTMLElement).click();
    test.addTurn("automated-1");
    await flush();
    expect(test.verified()).toBe(false);
    test.observer.dispose();
  });

  it("does not mistake navigation, unrelated clicks or other DOM updates for a human send", async () => {
    const test = setup();
    test.click(true, test.doc.body);
    test.key(true, test.doc.body);
    test.doc.body.appendChild(test.doc.createElement("div"));
    await flush();
    expect(test.verified()).toBe(false);
    test.observer.dispose();
  });

  it("recognizes a new stable turn key when virtualization keeps the visible user count unchanged", async () => {
    const test = setup();
    const previous = test.addTurn("old-turn");
    test.click(true);
    previous.remove();
    test.addTurn("new-turn");
    await flush();
    expect(test.verified()).toBe(true);
    test.observer.dispose();
  });

  it("supports ChatGPT's newer content-search user units without role wrappers", async () => {
    const test = setup();
    test.addTurn("initial").remove();
    test.click(true);
    const unit = test.doc.createElement("div");
    unit.setAttribute("data-content-search-unit-key", "new-turn:user");
    test.doc.body.appendChild(unit);
    await flush();
    expect(test.verified()).toBe(true);
    test.observer.dispose();
  });

  it("ignores stale/empty attempts until a new user message really appears", async () => {
    const test = setup();
    const original = test.addTurn("prior-turn");
    test.click(true);
    original.appendChild(test.doc.createElement("span"));
    await flush();
    expect(test.verified()).toBe(false);
    test.observer.dispose();
  });
});
