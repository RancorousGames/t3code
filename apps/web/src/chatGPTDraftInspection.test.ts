// @vitest-environment node
// @ts-expect-error jsdom is available for fixture tests without ambient declaration package.
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vite-plus/test";
import {
  inspectChatGPTComposer,
  sameComposerProbe,
  CHATGPT_COMPOSER_PROBE_EXPRESSION,
  hasVerifiedEmptyChatGPTComposer,
} from "./chatGPTDraftInspection";

describe("read-only per-guest composer inspection", () => {
  const url = "https://chatgpt.com/c/6ad81f45-bd10-83ed-8128-6a3d584c876c";

  it("preserves textarea Unicode drafts byte-for-byte and never touches the DOM", () => {
    const dom = new JSDOM(
      '<textarea id="prompt-textarea"></textarea><p data-message-author-role="assistant">Transcript must not be read</p>',
      { url },
    );
    const editor = dom.window.document.querySelector("textarea")!;
    editor.value = "  Draft 🍵\nSecond line\n";
    editor.focus();
    const currentFocus = dom.window.document.activeElement;
    const probe = inspectChatGPTComposer(dom.window.document, url);
    expect(probe).toEqual({ status: "nonempty", url, text: editor.value });
    expect(editor.value).toBe("  Draft 🍵\nSecond line\n");
    expect(dom.window.document.activeElement).toBe(currentFocus);
    expect(CHATGPT_COMPOSER_PROBE_EXPRESSION).not.toContain("data-message-author-role");
    dom.window.close();
  });

  it("never mistakes a transcript element, missing composer or disabled editor for empty", () => {
    const dom = new JSDOM(
      '<div data-message-author-role="user">user transcript</div><textarea disabled></textarea>',
      { url },
    );
    expect(inspectChatGPTComposer(dom.window.document, url).status).toBe("unknown");
    dom.window.document.body.innerHTML =
      '<div data-testid="prompt-textarea" contenteditable="false">Not editable</div>';
    expect(inspectChatGPTComposer(dom.window.document, url).status).toBe("unknown");
    dom.window.document.body.innerHTML =
      '<div data-testid="prompt-textarea" contenteditable="true"></div>';
    const first = inspectChatGPTComposer(dom.window.document, url);
    expect(first).toEqual({ status: "empty", url, text: "" });
    dom.window.document.body.firstElementChild!.textContent = "Now typing";
    expect(sameComposerProbe(first, inspectChatGPTComposer(dom.window.document, url))).toBe(false);
    dom.window.close();
  });

  it("pre-hibernation gate rejects nonempty, unknown, changed, redirected and failed reads", async () => {
    const make = (values: unknown[]) =>
      ({
        executeJavaScript: async () => {
          const next = values.shift();
          if (next instanceof Error) throw next;
          return next;
        },
      }) as unknown as HTMLElementTagNameMap["webview"];
    const empty = { status: "empty" as const, url, text: "" };
    const nonempty = { status: "nonempty" as const, url, text: "unsent" };
    expect(await hasVerifiedEmptyChatGPTComposer(make([empty, empty]), url)).toBe(true);
    expect(await hasVerifiedEmptyChatGPTComposer(make([empty, nonempty]), url)).toBe(false);
    expect(await hasVerifiedEmptyChatGPTComposer(make([nonempty, nonempty]), url)).toBe(false);
    expect(
      await hasVerifiedEmptyChatGPTComposer(make([{ status: "unknown", url }, empty]), url),
    ).toBe(false);
    expect(
      await hasVerifiedEmptyChatGPTComposer(
        make([empty, { ...empty, url: url + "?changed" }]),
        url,
      ),
    ).toBe(false);
    expect(
      await hasVerifiedEmptyChatGPTComposer(make([empty, new Error("guest detached")]), url),
    ).toBe(false);
  });

  it("only accepts two identical concrete observations of the same guest URL", () => {
    const a = { status: "nonempty" as const, url, text: "draft" };
    expect(sameComposerProbe(a, { ...a })).toBe(true);
    expect(sameComposerProbe(a, { ...a, url: "https://chatgpt.com/" })).toBe(false);
    expect(sameComposerProbe(a, { status: "unknown", url })).toBe(false);
    expect(sameComposerProbe({ status: "unknown", url }, a)).toBe(false);
  });
});
