import { describe, expect, it } from "vite-plus/test";
import { nativeChatGPTGuestShortcut } from "./NativeChatGPTGuestShortcut.ts";

const selected = "f230f49d-1e54-405e-88d5-94c4b679e786";
const other = "1966c2aa-e097-47b5-8fe6-df5a0cabff47";
const ownerUrl = `t3code-dev://app/#/browser/${selected}`;
const ctrlW = {
  type: "keyDown" as const,
  key: "w",
  control: true,
  meta: false,
  alt: false,
  shift: false,
};

describe("native ChatGPT guest accelerator routing", () => {
  it("closes only the selected guest, not an inactive/prewarmed guest", () => {
    expect(nativeChatGPTGuestShortcut(ctrlW, "win32", ownerUrl, selected)).toBe(
      "close-chatgpt-session",
    );
    expect(nativeChatGPTGuestShortcut(ctrlW, "win32", ownerUrl, other)).toBeNull();
    expect(
      nativeChatGPTGuestShortcut(ctrlW, "win32", "t3code://app/#/settings", selected),
    ).toBeNull();
    expect(
      nativeChatGPTGuestShortcut({ ...ctrlW, alt: true }, "win32", ownerUrl, selected),
    ).toBeNull();
    expect(
      nativeChatGPTGuestShortcut({ ...ctrlW, type: "keyUp" }, "win32", ownerUrl, selected),
    ).toBeNull();
  });
  it("supports Cmd+W on macOS and native find on the selected guest", () => {
    const cmdW = { ...ctrlW, control: false, meta: true };
    expect(nativeChatGPTGuestShortcut(cmdW, "darwin", ownerUrl, selected)).toBe(
      "close-chatgpt-session",
    );
    expect(nativeChatGPTGuestShortcut(cmdW, "win32", ownerUrl, selected)).toBeNull();
    expect(nativeChatGPTGuestShortcut({ ...ctrlW, key: "f" }, "win32", ownerUrl, selected)).toBe(
      "chatgpt.find",
    );
    expect(nativeChatGPTGuestShortcut({ ...ctrlW, key: "f" }, "win32", ownerUrl, other)).toBeNull();
  });
});
