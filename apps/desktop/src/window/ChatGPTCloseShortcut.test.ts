import { describe, expect, it } from "vite-plus/test";
import {
  activeChatGPTBrowserSessionId,
  isChatGPTCloseShortcut,
  isChatGPTSessionPreviewTab,
} from "./ChatGPTCloseShortcut.ts";

describe("ChatGPT close-session keyboard shortcut", () => {
  const key = {
    type: "keyDown" as const,
    key: "w",
    control: true,
    meta: false,
    shift: false,
    alt: false,
  };

  it("matches Windows/Linux Ctrl+W, macOS Cmd+W, but not unrelated keys", () => {
    expect(isChatGPTCloseShortcut(key, "win32")).toBe(true);
    expect(isChatGPTCloseShortcut({ ...key, key: "W" }, "linux")).toBe(true);
    expect(isChatGPTCloseShortcut({ ...key, control: false, meta: true }, "darwin")).toBe(true);

    expect(isChatGPTCloseShortcut(key, "darwin")).toBe(false);
    expect(isChatGPTCloseShortcut({ ...key, control: false, meta: true }, "win32")).toBe(false);
    expect(isChatGPTCloseShortcut({ ...key, key: "e" }, "win32")).toBe(false);
    expect(isChatGPTCloseShortcut({ ...key, shift: true }, "win32")).toBe(false);
    expect(isChatGPTCloseShortcut({ ...key, alt: true }, "win32")).toBe(false);
    expect(isChatGPTCloseShortcut({ ...key, type: "keyUp" }, "win32")).toBe(false);
  });

  it("accepts only active ChatGPT browser hash routes", () => {
    expect(activeChatGPTBrowserSessionId("t3code://app/#/browser/a")).toBe("a");
    expect(activeChatGPTBrowserSessionId("t3code://app/#/browser/a?view=1")).toBe("a");
    expect(activeChatGPTBrowserSessionId("t3code://app/#/browser/My%20Session")).toBe("My Session");
    expect(activeChatGPTBrowserSessionId("t3code://app/#/settings")).toBeNull();
    expect(activeChatGPTBrowserSessionId("t3code://app/#/threads/any")).toBeNull();
    expect(activeChatGPTBrowserSessionId("not-a-url")).toBeNull();
  });

  it("never closes a preview tab owned by another thread or session", () => {
    const selectedId = "selected";
    expect(
      isChatGPTSessionPreviewTab(
        JSON.stringify(["env", "t3-browser-session:selected", "epoch", "tab"]),
        selectedId,
      ),
    ).toBe(true);
    expect(
      isChatGPTSessionPreviewTab(
        JSON.stringify(["env", "t3-browser-session:other", "epoch", "tab"]),
        selectedId,
      ),
    ).toBe(false);
    expect(isChatGPTSessionPreviewTab("random-tab", selectedId)).toBe(false);
  });
});
