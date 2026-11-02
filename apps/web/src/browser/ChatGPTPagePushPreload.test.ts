// @vitest-environment node
// @ts-expect-error test installation has jsdom without its type declaration.
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
// @ts-ignore TS6307: this cross-package integration test imports desktop preview source.
import { installChatGPTPagePushObserver } from "../../../desktop/src/preview/ChatGPTPagePushPreload";

let dom: JSDOM;
beforeEach(() => {
  dom = new JSDOM("<html><body><main id='conversation'></main><nav></nav></body></html>", {
    url: "https://chatgpt.com/c/123",
  });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(10_000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  dom.window.close();
});

describe("read-only ChatGPT guest mutation watcher", () => {
  it("debounces conversation changes, throttles streaming and ignores navigation chrome", async () => {
    const send = vi.fn();
    const dispose = installChatGPTPagePushObserver(dom.window.document, dom.window.location, send);
    try {
      await vi.advanceTimersByTimeAsync(300);
      expect(send).toHaveBeenCalledTimes(1);
      const nav = dom.window.document.querySelector("nav")!;
      nav.appendChild(dom.window.document.createElement("span"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(send).toHaveBeenCalledTimes(1);
      const main = dom.window.document.querySelector("main")!;
      for (let index = 0; index < 10; index++) {
        main.appendChild(dom.window.document.createElement("span"));
      }
      await vi.advanceTimersByTimeAsync(300);
      expect(send).toHaveBeenCalledTimes(2);
      for (let index = 0; index < 10; index++) {
        main.appendChild(dom.window.document.createElement("span"));
      }
      await vi.advanceTimersByTimeAsync(500);
      expect(send).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(500);
      expect(send).toHaveBeenCalledTimes(3);
    } finally {
      dispose();
    }
  });

  it("does not watch unrelated origins or emit after disposal", async () => {
    const send = vi.fn();
    const noop = installChatGPTPagePushObserver(dom.window.document,
      { hostname: "example.com" }, send);
    noop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).not.toHaveBeenCalled();
    const dispose = installChatGPTPagePushObserver(dom.window.document,
      dom.window.location, send);
    dispose();
    dom.window.document.querySelector("main")!.appendChild(
      dom.window.document.createElement("span"),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send).not.toHaveBeenCalled();
  });
});
