// @vitest-environment node
// @ts-expect-error jsdom is present for tests without its types in this workspace.
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { chatGPTWebviewAutomation } from "./chatGPTWebviewAutomation";

const A = {
  session: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  conversation: "11111111-1111-4111-8111-111111111111",
};
const B = {
  session: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
  conversation: "22222222-2222-4222-8222-222222222222",
};
const owned = Symbol.for("t3.chatgpt.composerOwner");
const guests: JSDOM[] = [];
let shell: JSDOM;

function attachGuest(identity: typeof A, initialDraft = "", focusFollowsEditor = false) {
  const dom = new JSDOM(
    '<textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button>',
    {
      url: `https://chatgpt.com/c/${identity.conversation}`,
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  guests.push(dom);
  const doc = dom.window.document;
  const editor = doc.querySelector("textarea") as HTMLTextAreaElement;
  const button = doc.querySelector("button") as HTMLButtonElement;
  editor.value = initialDraft;
  let genuinelyFocused = false;
  let clicks = 0;
  const turns: string[] = [];
  Object.defineProperty(doc, "hasFocus", { configurable: true, value: () => genuinelyFocused ||
    (focusFollowsEditor && doc.activeElement === editor) });
  Object.defineProperty(doc, "execCommand", {
    configurable: true,
    value: vi.fn((_name: string, _ui: boolean, text: string) => {
      editor.value = text;
      return true;
    }),
  });
  button.addEventListener("click", () => {
    clicks++;
    turns.push(editor.value);
    editor.value = "";
  });
  const view = document.createElement("webview");
  view.dataset.previewTab = identity.session;
  Object.defineProperty(view, "executeJavaScript", {
    configurable: true,
    value: vi.fn(async (expression: string) => dom.window.eval(expression)),
  });
  document.body.appendChild(view);
  return {
    view,
    editor,
    doc,
    dom,
    turns,
    get clicks() {
      return clicks;
    },
    humanFocus(value: boolean) {
      genuinelyFocused = value;
    },
    owner() {
      return (
        dom.window as unknown as Record<symbol, { interrupted: boolean; finish: () => void }>
      )[owned];
    },
  };
}

async function stageB(message: string) {
  await chatGPTWebviewAutomation.type(B.session, {
    selector: "#prompt-textarea",
    text: message,
    clear: true,
    requireEmptyComposer: true,
    expectedConversationId: B.conversation,
  });
}
async function submitB(message: string) {
  await chatGPTWebviewAutomation.press(B.session, {
    key: "Enter",
    expectedComposerText: message,
    expectedConversationId: B.conversation,
  });
}

beforeEach(() => {
  shell = new JSDOM("", { url: "http://localhost", pretendToBeVisual: true });
  vi.stubGlobal("window", shell.window);
  vi.stubGlobal("document", shell.window.document);
  vi.stubGlobal("HTMLElement", shell.window.HTMLElement);
  Object.defineProperty(shell.window.document, "hasFocus", {
    configurable: true,
    value: () => true,
  });
});
afterEach(() => {
  for (const dom of guests.splice(0)) {
    (dom.window as unknown as Record<symbol, { finish?: () => void }>)[owned]?.finish?.();
    dom.window.close();
  }
  shell.window.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("T3-0085 exact recipient-only composer focus", () => {
  it("delivers consecutive messages when automation itself focuses the recipient", async () => {
    const b = attachGuest(B, "", true);
    await stageB("first");
    await submitB("first");
    await stageB("second");
    await submitB("second");
    expect(b.turns).toEqual(["first", "second"]);
  });

  it("sends to a focused empty composer after a send", async () => {
    const b = attachGuest(B, "", true);
    await stageB("first");
    await submitB("first");
    b.humanFocus(true);
    b.editor.focus();
    await stageB("second");
    await submitB("second");
    expect(b.turns).toEqual(["first", "second"]);
  });

  it("preserves another focus target selected while Send is handled", async () => {
    const b = attachGuest(B, "", true);
    const other = b.doc.createElement("input");
    b.doc.body.appendChild(other);
    b.doc.querySelector("button")?.addEventListener("click", () => other.focus());
    await stageB("first");
    await submitB("first");
    expect(b.doc.activeElement).toBe(other);
  });
  it("delivers B exactly once despite selected A's focused, nonempty human draft", async () => {
    const a = attachGuest(A, "do not modify my A draft");
    const b = attachGuest(B);
    a.view.tabIndex = 0;
    a.view.focus(); // host T3's selected browser session is A
    a.humanFocus(true);
    a.editor.focus(); // its own guest composer is being used by the human
    expect(document.activeElement).toBe(a.view);
    await stageB("automated B message");
    await submitB("automated B message");
    expect(b.turns).toEqual(["automated B message"]);
    expect(b.clicks).toBe(1);
    await expect(submitB("automated B message")).rejects.toThrow(
      "Composer changed before submitting",
    );
    expect(b.clicks).toBe(1);
    expect(a.editor.value).toBe("do not modify my A draft");
    expect(a.clicks).toBe(0);
  });

  it("sends to B when its empty composer is focused", async () => {
    const a = attachGuest(A, "A human draft");
    const b = attachGuest(B);
    b.humanFocus(true);
    b.editor.focus();
    await stageB("automated B message");
    await submitB("automated B message");
    expect(b.clicks).toBe(1);
    expect(b.editor.value).toBe("");
    expect(a.editor.value).toBe("A human draft");
  });

  it("does not type over B's draft even when it is not currently focused", async () => {
    const b = attachGuest(B, "B human draft");
    await expect(stageB("robot")).rejects.toThrow("existing draft");
    expect(b.editor.value).toBe("B human draft");
    expect(b.clicks).toBe(0);
  });

  it("switching focus in A during B's staged send does not veto B", async () => {
    const a = attachGuest(A, "A typing");
    const b = attachGuest(B);
    await stageB("B once");
    a.humanFocus(true);
    a.editor.focus();
    a.editor.blur();
    a.editor.focus();
    await submitB("B once");
    expect(b.turns).toEqual(["B once"]);
    expect(a.editor.value).toBe("A typing");
  });

  it("recipient B's new focus mid-send does not prevent submission", async () => {
    const a = attachGuest(A, "A typing");
    const b = attachGuest(B);
    await stageB("staged B robot");
    b.editor.blur();
    b.humanFocus(true);
    b.editor.focus(); // focusin may occur without keyboard or pointer inside B
    await submitB("staged B robot");
    expect(b.clicks).toBe(1);
    expect(b.editor.value).toBe("");
    expect(a.editor.value).toBe("A typing");
  });

  it("targets a newly mounted B, never the selected A or an old conversation", async () => {
    const a = attachGuest(A, "A stays untouched");
    a.view.tabIndex = 0;
    a.view.focus();
    await expect(stageB("B only")).rejects.toThrow("has not attached");
    const b = attachGuest(B); // deferred mount of exact recipient
    await stageB("B only");
    await submitB("B only");
    expect(b.turns).toEqual(["B only"]);
    expect(a.editor.value).toBe("A stays untouched");
    await expect(
      chatGPTWebviewAutomation.type(B.session, {
        selector: "#prompt-textarea",
        text: "wrong conversation",
        clear: true,
        requireEmptyComposer: true,
        expectedConversationId: A.conversation,
      }),
    ).rejects.toThrow("conversation guard mismatch");
    expect(b.clicks).toBe(1);
    expect(a.clicks).toBe(0);
  });
  it("refuses a changed B editor and an unattached B without falling back to A", async () => {
    const a = attachGuest(A, "A untouched");
    const b = attachGuest(B);
    await stageB("B robot");
    b.editor.value = "human modified B";
    await expect(submitB("B robot")).rejects.toThrow("Composer changed before submitting");
    expect(b.clicks).toBe(0);
    expect(b.editor.value).toBe("human modified B");
    b.owner()?.finish();
    b.view.remove(); // unloaded/background recipient is not a fallback to selected A
    await expect(stageB("never send elsewhere")).rejects.toThrow("has not attached");
    expect(a.editor.value).toBe("A untouched");
    expect(a.clicks).toBe(0);
  });
});
