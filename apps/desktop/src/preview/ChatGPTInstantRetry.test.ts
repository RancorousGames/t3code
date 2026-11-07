// @vitest-environment node
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { installChatGPTInstantRetry } from "./ChatGPTInstantRetry.ts";

const windows: JSDOM[] = [];
const create = (html: string) => {
  const dom = new JSDOM(html, {
    url: "https://chatgpt.com/c/6aebed4b-c768-83ed-825b-6dbdc5a6f469",
  });
  windows.push(dom);
  vi.spyOn(dom.window.Element.prototype, "getClientRects")
    .mockReturnValue([{}] as unknown as DOMRectList);
  return dom;
};

afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close();
  vi.restoreAllMocks();
});

describe("instant ChatGPT provider Retry", () => {
  it("clicks a newly visible timeout Retry button without waiting for the recovery queue", async () => {
    const dom = create('<div role="alert">Message delivery timed out. Please <button>Try again</button>.</div>');
    const button = dom.window.document.querySelector("button")!;
    const click = vi.spyOn(button, "click");
    const watcher = installChatGPTInstantRetry(
      dom.window as unknown as Window & typeof globalThis, dom.window.document,
    );
    await Promise.resolve();
    expect(click).toHaveBeenCalledOnce();
    button.setAttribute("style", "color: red");
    await Promise.resolve();
    expect(click).toHaveBeenCalledOnce();
    watcher.dispose();
  });

  it("detects an inline provider status, but ignores quoted conversation prose", async () => {
    const dom = create(
      '<div data-content-search-unit-key="x:assistant"><div class="markdown">' +
      'Message delivery timed out. Please <button>Try again</button>.</div></div>',
    );
    const doc = dom.window.document;
    const quoted = doc.querySelector("button")!;
    const quotedClick = vi.spyOn(quoted, "click");
    const watcher = installChatGPTInstantRetry(
      dom.window as unknown as Window & typeof globalThis, doc,
    );
    await Promise.resolve();
    expect(quotedClick).not.toHaveBeenCalled();
    doc.body.insertAdjacentHTML(
      "beforeend",
      '<div data-content-search-unit-key="y:assistant"><div role="alert">' +
      'Message delivery timed out. Please <button>Try again</button>.</div></div>',
    );
    const actualClick = vi.spyOn(doc.querySelectorAll("button")[1]!, "click");
    await Promise.resolve();
    await Promise.resolve();
    expect(actualClick).toHaveBeenCalledOnce();
    watcher.dispose();
  });

  it("also clicks the provider's dedicated conversation-load Retry button", async () => {
    const dom = create('<section><h2>Could not load this ChatGPT conversation</h2><button>Retry</button></section>');
    const click = vi.spyOn(dom.window.document.querySelector("button")!, "click");
    const watcher = installChatGPTInstantRetry(
      dom.window as unknown as Window & typeof globalThis, dom.window.document,
    );
    await Promise.resolve();
    expect(click).toHaveBeenCalledOnce();
    watcher.dispose();
  });

  it("clicks an aria-labelled retry on a generic provider error", async () => {
    const dom = create('<div role="alert">Something went wrong <button aria-label="Retry"><svg></svg></button></div>');
    const button = dom.window.document.querySelector("button")!;
    const click = vi.spyOn(button, "click");
    const watcher = installChatGPTInstantRetry(
      dom.window as unknown as Window & typeof globalThis, dom.window.document,
    );
    await Promise.resolve();
    expect(click).toHaveBeenCalledOnce();
    watcher.dispose();
  });

  it("ignores other Retry buttons and hidden timeout notices", async () => {
    const dom = create(
      '<div role="alert" hidden>Message delivery timed out. Please <button>Try again</button>.</div>' +
      '<div role="alert">Session expired <button>Try again</button></div>',
    );
    const buttons = [...dom.window.document.querySelectorAll("button")];
    const clicks = buttons.map((button) => vi.spyOn(button, "click"));
    const watcher = installChatGPTInstantRetry(
      dom.window as unknown as Window & typeof globalThis, dom.window.document,
    );
    await Promise.resolve();
    expect(clicks.every((click) => click.mock.calls.length === 0)).toBe(true);
    watcher.dispose();
  });
});
