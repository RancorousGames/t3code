import type { ChatGPTPromptAutomation } from "../chatGPTBrowserAutomation";
import { readChatGPTSessionProfileId } from "../chatGPTAccountProfiles";

type NativeBridge = NonNullable<NonNullable<Window["desktopBridge"]>["stableChatGPTViewRequest"]>;

const SEND_SELECTORS = [
  '[data-testid="send-button"]',
  '[data-testid="composer-submit-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="Send message"]',
  'button[aria-label="Send"]',
  'button[type="submit"]',
  'button[aria-label^="Send "]',
  'button[data-testid*="send"]',
].join(", ");

/**
 * Drive a newly reserved ChatGPT session through the native Electron-owned
 * Chromium view. This is an alternative to the legacy <webview> automation;
 * every interaction is scoped to the exact session/profile and checked again
 * inside the page before a send can occur.
 */
export function nativeChatGPTInitialPromptAutomation(
  bridge: NativeBridge,
  environmentId: string,
  sessionId: string,
): ChatGPTPromptAutomation {
  const profileId = readChatGPTSessionProfileId(environmentId, sessionId);
  const identity = { environmentId, sessionId, profileId };
  const evaluate = async (expression: string): Promise<unknown> => {
    const result = (await bridge({ operation: "evaluate", identity, expression })) as {
      result?: unknown;
    };
    return result.result;
  };
  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  return {
    async status() {
      const snapshot = (await bridge({ operation: "snapshot", identity })) as {
        url?: string;
        destroyed?: boolean;
        loading?: boolean;
      };
      return {
        available: !snapshot.destroyed && Boolean(snapshot.url),
        loading: snapshot.loading === true,
        url: snapshot.url ?? "",
      };
    },
    async waitFor(_runtimeId, { selector, timeoutMs }) {
      const deadline = Date.now() + timeoutMs;
      do {
        if (
          (await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) === true
        )
          return;
        await pause(125);
      } while (Date.now() < deadline);
      throw new Error("Native ChatGPT composer has not become available.");
    },
    async evaluate(_runtimeId, { expression }) {
      return evaluate(expression);
    },
    async type(_runtimeId, { selector, text }) {
      const response = (await evaluate(`(() => {
        if (location.hostname !== 'chatgpt.com' || location.pathname !== '/')
          return { ok: false, reason: 'New ChatGPT page changed before typing.' };
        const editor = document.querySelector(${JSON.stringify(selector)});
        if (!(editor instanceof HTMLElement) ||
            (!editor.isContentEditable && !(editor instanceof HTMLTextAreaElement)))
          return { ok: false, reason: 'ChatGPT composer is missing.' };
        editor.focus();
        if (editor.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(editor);
          const selection = document.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        } else {
          editor.select();
        }
        const inserted = document.execCommand('insertText', false, ${JSON.stringify(text)});
        const value = editor instanceof HTMLTextAreaElement
          ? editor.value : (editor.innerText || editor.textContent || '');
        const normalize = s => (s || '').replace(/\\s+/g, ' ').trim();
        return { ok: inserted && normalize(value) === normalize(${JSON.stringify(text)}),
          reason: 'Native composer did not accept the exact initial prompt.' };
      })()`)) as { ok?: boolean; reason?: string } | null;
      if (response?.ok !== true)
        throw new Error(response?.reason ?? "Native ChatGPT typing outcome unknown.");
    },
    async press(_runtimeId, { key, expectedComposerText }) {
      if (key !== "Enter" || !expectedComposerText)
        throw new Error("Native initial prompt requires a guarded Send click.");
      // The app can enable its Send control asynchronously after execCommand.
      // Each attempt validates both the home URL and the exact editor content;
      // only the first observed enabled control can be clicked.
      const deadline = Date.now() + 8_000;
      let lastReason = "ChatGPT Send control unavailable.";
      while (Date.now() < deadline) {
        const result = (await evaluate(`(() => {
          if (location.hostname !== 'chatgpt.com' || location.pathname !== '/')
            return { reason: 'New ChatGPT page changed before send.' };
          const editor = document.querySelector('#prompt-textarea, [data-testid="prompt-textarea"], [data-testid="composer-input"], [contenteditable="true"][role="textbox"], div[contenteditable="true"], textarea');
          const value = editor instanceof HTMLTextAreaElement
            ? editor.value : (editor?.innerText || editor?.textContent || '');
          const normalize = s => (s || '').replace(/\\s+/g, ' ').trim();
          if (normalize(value) !== normalize(${JSON.stringify(expectedComposerText)}))
            return { reason: 'Composer changed before native send.', abort: true };
          const controls = [...document.querySelectorAll(${JSON.stringify(SEND_SELECTORS)})];
          const button = controls.find(node => node instanceof HTMLButtonElement &&
            !node.disabled && node.getAttribute('aria-disabled') !== 'true' &&
            node.getAttribute('aria-label') !== 'Stop' &&
            !node.matches('[data-testid="stop-button"]'));
          if (!button) return { reason: 'Send button not yet enabled.' };
          button.click();
          return { clicked: true };
        })()`)) as { clicked?: boolean; abort?: boolean; reason?: string } | null;
        if (result?.clicked === true) return;
        if (result?.abort) throw new Error(result.reason);
        lastReason = result?.reason ?? "Native ChatGPT send outcome unknown.";
        await pause(150);
      }
      throw new Error(lastReason);
    },
  };
}
