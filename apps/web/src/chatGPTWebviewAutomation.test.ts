// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { COMPOSER_SELECTOR } from "./chatGPTBrowserAutomation";
import { chatGPTWebviewAutomation } from "./chatGPTWebviewAutomation";

const runtimeTabId = "browser:test";
let guest: HTMLElement;

beforeEach(() => {
  guest = document.createElement("webview");
  guest.dataset.previewTab = runtimeTabId;
  Object.defineProperty(guest, "getURL", { value: vi.fn(() => "https://chatgpt.com/") });
  Object.defineProperty(guest, "isLoading", { value: vi.fn(() => false) });
  Object.defineProperty(guest, "executeJavaScript", {
    value: vi.fn(async (script: string) => {
      if (script.includes("Boolean(document.querySelector(")) return true;
      if (script.includes("Contenteditable rejected text")) return { ok: true };
      if (script.includes("const selectors = [")) return { clicked: true };
      if (script === "1 + 1") return 2;
      return true;
    }),
  });
  Object.defineProperty(guest, "sendInputEvent", { value: vi.fn(async () => {}) });
  document.body.appendChild(guest);
});
afterEach(() => {
  guest.remove();
});

describe("local ChatGPT Electron webview automation", () => {
  it("uses the attached guest to check readiness, type a message, and press Enter", async () => {
    expect(await chatGPTWebviewAutomation.status(runtimeTabId)).toEqual({
      available: true,
      loading: false,
      url: "https://chatgpt.com/",
    });
    await chatGPTWebviewAutomation.waitFor(runtimeTabId, {
      selector: "#prompt-textarea",
      timeoutMs: 1000,
    });
    await chatGPTWebviewAutomation.type(runtimeTabId, {
      selector: "#prompt-textarea",
      text: "Hello from T3",
      clear: true,
    });
    await chatGPTWebviewAutomation.press(runtimeTabId, { key: "Enter" });
    const send = (guest as never as { sendInputEvent: ReturnType<typeof vi.fn> }).sendInputEvent;
    expect(send).not.toHaveBeenCalled();
    const execute = (guest as never as { executeJavaScript: ReturnType<typeof vi.fn> })
      .executeJavaScript;
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("button.click()"));
    expect(await chatGPTWebviewAutomation.evaluate(runtimeTabId, { expression: "1 + 1" })).toBe(2);
  });
  it("detects an editable textbox without the retired #prompt-textarea ID", async () => {
    const editor = document.createElement("div");
    editor.setAttribute("role", "textbox");
    editor.setAttribute("contenteditable", "true");
    document.body.appendChild(editor);
    const execute = (guest as never as { executeJavaScript: ReturnType<typeof vi.fn> })
      .executeJavaScript;
    execute.mockImplementation(async (script: string) => window.eval(script));
    try {
      expect(document.querySelector("#prompt-textarea")).toBeNull();
      await chatGPTWebviewAutomation.waitFor(runtimeTabId, {
        selector: COMPOSER_SELECTOR,
        timeoutMs: 1000,
      });
    } finally {
      editor.remove();
    }
  });

  it("clicks a real enabled ChatGPT send button without requiring native guest focus", async () => {
    const sendButton = document.createElement("button");
    sendButton.dataset.testid = "send-button";
    sendButton.textContent = "Send";
    document.body.appendChild(sendButton);
    const clicked = vi.fn();
    sendButton.addEventListener("click", clicked);
    const execute = (guest as never as { executeJavaScript: ReturnType<typeof vi.fn> })
      .executeJavaScript;
    execute.mockImplementation(async (script: string) => window.eval(script));
    try {
      await chatGPTWebviewAutomation.press(runtimeTabId, { key: "Enter" });
      expect(clicked).toHaveBeenCalledOnce();
      const send = (guest as never as { sendInputEvent: ReturnType<typeof vi.fn> }).sendInputEvent;
      expect(send).not.toHaveBeenCalled();
    } finally {
      sendButton.remove();
    }
  });

  it("accepts multiline prompts when ProseMirror renders separate paragraphs", async () => {
    const editor = document.createElement("div");
    editor.id = "prompt-textarea";
    editor.setAttribute("contenteditable", "true");
    Object.defineProperty(editor, "isContentEditable", { value: true });
    document.body.appendChild(editor);
    const execute = (guest as never as { executeJavaScript: ReturnType<typeof vi.fn> })
      .executeJavaScript;
    execute.mockImplementation(async (script: string) => window.eval(script));
    const originalExecCommand = document.execCommand;
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn((_command: string, _showUI: boolean, text: string) => {
        const lines = text.split("\n");
        editor.replaceChildren(
          ...lines.map((line) => {
            const paragraph = document.createElement("p");
            paragraph.textContent = line;
            return paragraph;
          }),
        );
        Object.defineProperty(editor, "innerText", {
          configurable: true,
          value: lines.join("\n"),
        });
        return true;
      }),
    });
    try {
      await chatGPTWebviewAutomation.type(runtimeTabId, {
        selector: "#prompt-textarea",
        text: "First task\nSecond task",
        clear: true,
      });
      expect(editor.textContent).toBe("First taskSecond task");
    } finally {
      if (originalExecCommand === undefined) {
        Reflect.deleteProperty(document, "execCommand");
      } else {
        Object.defineProperty(document, "execCommand", {
          configurable: true,
          value: originalExecCommand,
        });
      }
      editor.remove();
    }
  });

  it("restores the T3 editor's focus when background ChatGPT input takes it", async () => {
    const userEditor = document.createElement("input");
    document.body.appendChild(userEditor);
    userEditor.focus();
    expect(document.activeElement).toBe(userEditor);
    const execute = (guest as never as { executeJavaScript: ReturnType<typeof vi.fn> })
      .executeJavaScript;
    execute.mockImplementation(async () => {
      guest.focus();
      return { ok: true };
    });
    try {
      await chatGPTWebviewAutomation.type(runtimeTabId, {
        selector: "#prompt-textarea",
        text: "Background task",
        clear: true,
      });
      expect(document.activeElement).toBe(userEditor);
    } finally {
      userEditor.remove();
    }
  });

  it("does not override user focus changes made during background input", async () => {
    const originallyFocused = document.createElement("input");
    const userSelected = document.createElement("input");
    document.body.append(originallyFocused, userSelected);
    originallyFocused.focus();
    const execute = (guest as never as { executeJavaScript: ReturnType<typeof vi.fn> })
      .executeJavaScript;
    execute.mockImplementation(async () => {
      userSelected.focus();
      return { ok: true };
    });
    try {
      await chatGPTWebviewAutomation.type(runtimeTabId, {
        selector: "#prompt-textarea",
        text: "Background task",
        clear: true,
      });
      expect(document.activeElement).toBe(userSelected);
    } finally {
      originallyFocused.remove();
      userSelected.remove();
    }
  });

  it("reports actual composer controls rather than silently sending Enter to an unfocused guest", async () => {
    const execute = (guest as never as { executeJavaScript: ReturnType<typeof vi.fn> })
      .executeJavaScript;
    execute.mockResolvedValue({
      clicked: false,
      editorPresent: true,
      editorLength: 40,
      controls: [],
    });
    let clock = 1000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => (clock += 9000));
    try {
      await expect(chatGPTWebviewAutomation.press(runtimeTabId, { key: "Enter" })).rejects.toThrow(
        "ChatGPT Send control did not become available",
      );
    } finally {
      now.mockRestore();
    }
    const send = (guest as never as { sendInputEvent: ReturnType<typeof vi.fn> }).sendInputEvent;
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses to send when the expected guest isn't present", async () => {
    await expect(chatGPTWebviewAutomation.press("absent", { key: "Enter" })).rejects.toThrow(
      "has not attached",
    );
  });
});
