import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { chatGPTWebviewAutomation } from "./chatGPTWebviewAutomation";

const expectedConversationId = "6ad4addb-8fc0-83eb-832c-47b147adffb2";
const runtimeId = "test:guest";

class FakeHTMLElement {
  value = "";
  isContentEditable = false;
  focus() {}
  select() {}
  closest(_selector: string): null {
    return null;
  }
}
class FakeButton extends FakeHTMLElement {
  disabled = false;
  clicks = 0;
  parentElement = null;
  getAttribute(_name: string) {
    return null;
  }
  matches(_selector: string) {
    return false;
  }
  click() {
    this.clicks++;
  }
}
class FakeTextArea extends FakeHTMLElement {}

function fakeGuest(initialUrl: string) {
  const button = new FakeButton();
  const editor = new FakeTextArea();
  const location = { href: initialUrl };
  const document = {
    hasFocus: () => false,
    querySelector: (selector: string) => (selector === "#prompt-textarea" ? editor : null),
    querySelectorAll: (selector: string) =>
      selector === "webview"
        ? [webview]
        : selector === '[data-testid="send-button"]'
          ? [button]
          : [],
    execCommand: (_name: string, _flag: boolean, text: string) => {
      editor.value = text;
      return true;
    },
  };
  let onInspect: (() => void) | undefined;
  let inspections = 0;
  const webview = {
    dataset: { previewTab: runtimeId },
    executeJavaScript: async (expression: string) => {
      // Mimic one synchronous guest JavaScript task, including the URL check
      // AND actual composer mutation or click (no network / live ChatGPT).
      const run = new Function(
        "document",
        "location",
        "HTMLElement",
        "HTMLButtonElement",
        "HTMLTextAreaElement",
        "HTMLInputElement",
        "HTMLFormElement",
        "URL",
        `return ${expression}`,
      );
      const result = run(
        document,
        location,
        FakeHTMLElement,
        FakeButton,
        FakeTextArea,
        FakeTextArea,
        FakeHTMLElement,
        URL,
      );
      inspections++;
      onInspect?.();
      return result;
    },
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("HTMLElement", FakeHTMLElement);
  return {
    button,
    editor,
    location,
    get inspections() {
      return inspections;
    },
    afterInspection(fn: () => void) {
      onInspect = fn;
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("ChatGPT guarded guest composer submission", () => {
  it("clicks only when the current guest URL is the intended conversation", async () => {
    const fixture = fakeGuest(`https://chatgpt.com/c/${expectedConversationId}?mode=chat`);
    await chatGPTWebviewAutomation.press(runtimeId, { key: "Enter", expectedConversationId });
    expect(fixture.button.clicks).toBe(1);
  });

  it("rejects wrong, blank, foreign-host and home-page URLs before any click", async () => {
    const fixture = fakeGuest("");
    for (const href of [
      "",
      "https://chatgpt.com/",
      "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111",
      `https://example.com/c/${expectedConversationId}`,
      `http://chatgpt.com/c/${expectedConversationId}`,
    ]) {
      fixture.location.href = href;
      await expect(
        chatGPTWebviewAutomation.press(runtimeId, {
          key: "Enter",
          expectedConversationId,
        }),
      ).rejects.toThrow(/conversation guard mismatch/);
    }
    expect(fixture.button.clicks).toBe(0);
  });

  it("prevents a navigation race while waiting for the send control", async () => {
    const fixture = fakeGuest(`https://chatgpt.com/c/${expectedConversationId}`);
    fixture.button.disabled = true;
    fixture.afterInspection(() => {
      if (fixture.inspections === 1) {
        fixture.button.disabled = false;
        fixture.location.href = "https://example.com/";
      }
    });
    await expect(
      chatGPTWebviewAutomation.press(runtimeId, {
        key: "Enter",
        expectedConversationId,
      }),
    ).rejects.toThrow(/conversation guard mismatch/);
    expect(fixture.inspections).toBe(2);
    expect(fixture.button.clicks).toBe(0);
  });

  it("refuses editor mutations after navigation and allows matching conversation typing", async () => {
    const fixture = fakeGuest(`https://chatgpt.com/c/${expectedConversationId}`);
    fixture.editor.value = "original draft";
    fixture.location.href = "https://chatgpt.com/";
    await expect(
      chatGPTWebviewAutomation.type(runtimeId, {
        selector: "#prompt-textarea",
        text: "Not for this conversation",
        clear: true,
        expectedConversationId,
      }),
    ).rejects.toThrow(/conversation guard mismatch/);
    expect(fixture.editor.value).toBe("original draft");
    fixture.location.href = `https://chatgpt.com/c/${expectedConversationId}`;
    await chatGPTWebviewAutomation.type(runtimeId, {
      selector: "#prompt-textarea",
      text: "For this conversation",
      clear: true,
      expectedConversationId,
    });
    expect(fixture.editor.value).toBe("For this conversation");
  });
});
