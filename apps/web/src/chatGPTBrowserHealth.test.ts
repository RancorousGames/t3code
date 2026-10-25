// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  chatGPTBrowserFailure,
  inspectChatGPTBrowserHealth,
  isBlankChatGPTDocument,
} from "./chatGPTBrowserHealth";

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("blank browser classification", () => {
  it("excludes a normal empty composer, login/challenge controls, and visible content", () => {
    expect(isBlankChatGPTDocument()).toBe(true);
    for (const html of [
      '<div contenteditable="true"></div>', '<input>', '<iframe></iframe>',
      '<svg></svg>', '<main>Sign in</main>', '<button>Continue</button>',
    ]) {
      document.body.innerHTML = html;
      expect(isBlankChatGPTDocument()).toBe(false);
    }
  });

  it("waits a minute on the same guest and URL, then clears when the page responds", async () => {
    const guest = {
      getURL: () => "https://chatgpt.com/",
      executeJavaScript: vi.fn().mockResolvedValue({ blank: true, activity: "invalid: composer missing" }),
    };
    await inspectChatGPTBrowserHealth(guest);
    expect(chatGPTBrowserFailure(guest)).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await inspectChatGPTBrowserHealth(guest)).toBe("invalid: browser-unresponsive");
    expect(chatGPTBrowserFailure(guest)).toBe("blank-page");
    guest.executeJavaScript.mockResolvedValue({ blank: false, activity: "working" });
    expect(await inspectChatGPTBrowserHealth(guest)).toBe("working");
    expect(chatGPTBrowserFailure(guest)).toBeNull();
  });

  it("bounds nonsettling inspections and distinguishes sustained timeouts from blank DOM", async () => {
    const guest = {
      getURL: () => "https://chatgpt.com/",
      executeJavaScript: () => new Promise<unknown>(() => {}),
    };
    const first = inspectChatGPTBrowserHealth(guest);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await first).toContain("unknown:");
    expect(chatGPTBrowserFailure(guest)).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    const second = inspectChatGPTBrowserHealth(guest);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await second).toBe("invalid: browser-unresponsive");
    expect(chatGPTBrowserFailure(guest)).toBe("probe-timeout");
  });

  it("does not carry failure evidence across navigation or guest replacement", async () => {
    let url = "https://chatgpt.com/";
    const guest = {
      getURL: () => url,
      executeJavaScript: vi.fn().mockResolvedValue({ blank: true }),
    };
    await inspectChatGPTBrowserHealth(guest);
    await vi.advanceTimersByTimeAsync(60_000);
    await inspectChatGPTBrowserHealth(guest);
    url = "https://chatgpt.com/c/new-conversation";
    expect(chatGPTBrowserFailure(guest)).toBeNull();
    await inspectChatGPTBrowserHealth(guest);
    expect(chatGPTBrowserFailure(guest)).toBeNull();
    expect(chatGPTBrowserFailure({ ...guest })).toBeNull();
    guest.executeJavaScript.mockRejectedValue(new Error("detached"));
    expect(await inspectChatGPTBrowserHealth(guest)).toBeNull();
  });
});
