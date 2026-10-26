// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
// Keep this Electron guest test isolated from the unrelated browser/provider stack.
const COMPOSER_SELECTOR = '#prompt-textarea, [contenteditable="true"][role="textbox"]';
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
      if (script.includes("Contenteditable rejected or changed text")) return { ok: true };
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


  it("refuses an empty but human-focused composer without editing or clicking", async () => {
    const editor = document.createElement("textarea");
    editor.id = "prompt-textarea";
    document.body.appendChild(editor);
    editor.focus();
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const exec = vi.fn();
    const oldExec = document.execCommand;
    Object.defineProperty(document, "execCommand", { configurable: true, value: exec });
    const execute = (guest as never as { executeJavaScript: ReturnType<typeof vi.fn> }).executeJavaScript;
    execute.mockImplementation(async (script: string) => window.eval(script));
    try {
      await expect(chatGPTWebviewAutomation.type(runtimeTabId, {
        selector: "#prompt-textarea", text: "robot", clear: true,
        requireEmptyComposer: true,
      })).rejects.toThrow("User-focused composer before typing");
      expect(editor.value).toBe("");
      expect(exec).not.toHaveBeenCalled();
    } finally {
      focused.mockRestore();
      if (oldExec === undefined) Reflect.deleteProperty(document, "execCommand");
      else Object.defineProperty(document, "execCommand", { configurable: true, value: oldExec });
      editor.remove();
    }
  });

  it("vetoes Send if human input interrupts an already staged automated draft", async () => {
    const conversation = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
    const url = "https://chatgpt.com/c/" + conversation;
    const editor = document.createElement("textarea");
    editor.id = "prompt-textarea";
    const button = document.createElement("button");
    button.dataset.testid = "send-button";
    document.body.append(editor, button);
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const oldExec = document.execCommand;
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn((_command: string, _showUI: boolean, value: string) => {
        editor.value = value;
        return true;
      }),
    });
    const execute = (guest as never as { executeJavaScript: ReturnType<typeof vi.fn> }).executeJavaScript;
    execute.mockImplementation(async (script: string) =>
      window.eval(script.replaceAll("location.href", JSON.stringify(url))));
    try {
      await chatGPTWebviewAutomation.type(runtimeTabId, {
        selector: "#prompt-textarea", text: "robot", clear: true,
        requireEmptyComposer: true, expectedConversationId: conversation,
      });
      const owner = (window as unknown as Record<symbol, {
        active: boolean; interrupted: boolean; finish: () => void;
      }>)[Symbol.for("t3.chatgpt.composerOwner")];
      expect(owner?.active).toBe(true);
      // Simulate the human's trusted key event during React's async Send-button wait.
      owner.interrupted = true;
      editor.value = "robot + human draft";
      await expect(chatGPTWebviewAutomation.press(runtimeTabId, {
        key: "Enter", expectedConversationId: conversation,
        expectedComposerText: "robot",
      })).rejects.toThrow("Composer changed before submitting");
      expect(clicked).not.toHaveBeenCalled();
      expect(editor.value).toBe("robot + human draft");
      // Even if the user deletes their edit back to the exact automation text,
      // the previously observed human interaction must still veto Send.
      editor.value = "robot";
      await expect(chatGPTWebviewAutomation.press(runtimeTabId, {
        key: "Enter", expectedConversationId: conversation,
        expectedComposerText: "robot",
      })).rejects.toThrow("Composer changed before submitting");
      expect(clicked).not.toHaveBeenCalled();
      owner.finish();
    } finally {
      focused.mockRestore();
      if (oldExec === undefined) Reflect.deleteProperty(document, "execCommand");
      else Object.defineProperty(document, "execCommand", { configurable: true, value: oldExec });
      editor.remove();
      button.remove();
    }
  });

  it("submits exactly once when the composer owner and conversation stay unchanged", async () => {
    const conversation = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
    const url = "https://chatgpt.com/c/" + conversation;
    const editor = document.createElement("textarea");
    editor.id = "prompt-textarea";
    const button = document.createElement("button");
    button.dataset.testid = "send-button";
    document.body.append(editor, button);
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    const originalExec = document.execCommand;
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn((_command: string, _showUI: boolean, value: string) => {
        editor.value = value;
        return true;
      }),
    });
    const execute = (guest as never as { executeJavaScript: ReturnType<typeof vi.fn> }).executeJavaScript;
    execute.mockImplementation(async (script: string) =>
      window.eval(script.replaceAll("location.href", JSON.stringify(url))));
    try {
      await chatGPTWebviewAutomation.type(runtimeTabId, {
        selector: "#prompt-textarea", text: "robot", clear: true,
        requireEmptyComposer: true, expectedConversationId: conversation,
      });
      await chatGPTWebviewAutomation.press(runtimeTabId, {
        key: "Enter", expectedConversationId: conversation,
        expectedComposerText: "robot",
      });
      expect(clicked).toHaveBeenCalledOnce();
      expect((window as unknown as Record<symbol, unknown>)[Symbol.for("t3.chatgpt.composerOwner")])
        .toBeUndefined();
    } finally {
      (window as unknown as Record<symbol, { finish?: () => void }>)[
        Symbol.for("t3.chatgpt.composerOwner")]?.finish?.();
      if (originalExec === undefined) Reflect.deleteProperty(document, "execCommand");
      else Object.defineProperty(document, "execCommand", { configurable: true, value: originalExec });
      editor.remove();
      button.remove();
    }
  });


  it("does not submit a previously staged UNKNOWN draft while a human has focused it", async () => {
    const conversation = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
    const editor = document.createElement("textarea");
    editor.id = "prompt-textarea";
    editor.value = "staged automation";
    const button = document.createElement("button");
    button.dataset.testid = "send-button";
    document.body.append(editor, button);
    editor.focus();
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    const execute = (guest as never as { executeJavaScript: ReturnType<typeof vi.fn> }).executeJavaScript;
    execute.mockImplementation(async (script: string) =>
      window.eval(script.replaceAll("location.href", JSON.stringify("https://chatgpt.com/c/" + conversation))));
    try {
      await expect(chatGPTWebviewAutomation.press(runtimeTabId, {
        key: "Enter", expectedConversationId: conversation,
        expectedComposerText: "staged automation",
      })).rejects.toThrow("Composer changed before submitting");
      expect(clicked).not.toHaveBeenCalled();
      expect(editor.value).toBe("staged automation");
    } finally {
      focused.mockRestore();
      editor.remove();
      button.remove();
    }
  });

  it("refuses to send when the expected guest isn't present", async () => {
    await expect(chatGPTWebviewAutomation.press("absent", { key: "Enter" })).rejects.toThrow(
      "has not attached",
    );
  });
});
