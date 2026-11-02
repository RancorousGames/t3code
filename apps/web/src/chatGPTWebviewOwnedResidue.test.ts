// @vitest-environment node
// @ts-expect-error jsdom types are not installed in this workspace.
import { JSDOM } from "jsdom";
import { expect, it, vi } from "vite-plus/test";
import { chatGPTWebviewAutomation } from "./chatGPTWebviewAutomation";

it("atomically replaces only exact confirmed residue without interrupted ownership", async () => {
  const conversation = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  const dom = new JSDOM("", { url: "https://chatgpt.com/c/" + conversation, runScripts: "outside-only" });
  const { window } = dom;
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  const editor = window.document.createElement("textarea");
  editor.id = "prompt-textarea";
  const guest = window.document.createElement("webview");
  guest.dataset.previewTab = "test";
  Object.defineProperty(guest, "executeJavaScript", { value: async (script: string) => window.eval(script) });
  Object.defineProperty(window.document, "execCommand", { configurable: true,
    value: (_command: string, _ui: boolean, value: string) => { editor.value = value; return true; } });
  window.document.body.append(editor, guest);
  const input = { selector: "#prompt-textarea", text: "next", clear: true,
    requireEmptyComposer: true, expectedConversationId: conversation,
    replaceOwnedComposerText: "previous\nbody" };
  try {
    editor.value = "previous body";
    await expect(chatGPTWebviewAutomation.type("test", input)).rejects.toThrow("existing draft");
    editor.value = "previous\nbody";
    await chatGPTWebviewAutomation.type("test", input);
    expect(editor.value).toBe("next");
    const owner = (window as unknown as Record<symbol, { interrupted: boolean; finish: () => void }>)[Symbol.for("t3.chatgpt.composerOwner")]!;
    owner.interrupted = true;
    editor.value = "previous\nbody";
    await expect(chatGPTWebviewAutomation.type("test", input)).rejects.toThrow("existing draft");
    expect(editor.value).toBe("previous\nbody");
    owner.finish();
  } finally { dom.window.close(); vi.unstubAllGlobals(); }
});
