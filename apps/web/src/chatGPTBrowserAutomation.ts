import type { EnvironmentId } from "@t3tools/contracts";

import { chatGPTBrowserThreadRef } from "./chatGPTBrowserSessions";
import { previewRuntimeTabId } from "./browser/previewRuntimeTabId";
import { acquireBrowserSurfaceActivity } from "./browser/browserSurfaceStore";
import { previewBridge } from "./components/preview/previewBridge";
import { chatGPTWebviewAutomation } from "./chatGPTWebviewAutomation";
import { readThreadPreviewState } from "./previewStateStore";

// ChatGPT changes composer IDs across deployments, but keeps an editable
// textbox. Look for the known IDs first, followed by the generic editors.
export const COMPOSER_SELECTOR = [
  "#prompt-textarea",
  '[data-testid="prompt-textarea"]',
  '[data-testid="composer-input"]',
  '[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"][data-placeholder]',
  'div[contenteditable="true"]',
  "textarea[placeholder]",
  "textarea",
].join(", ");
const COMPOSER_WAIT_MS = 3_000;
const SEND_TIMEOUT_MS = 75_000;

export interface ChatGPTPromptAutomation {
  readonly status: typeof chatGPTWebviewAutomation.status;
  readonly waitFor: typeof chatGPTWebviewAutomation.waitFor;
  readonly type: typeof chatGPTWebviewAutomation.type;
  readonly press: typeof chatGPTWebviewAutomation.press;
  readonly evaluate: typeof chatGPTWebviewAutomation.evaluate;
}

/**
 * Use Electron's embedded webview UI automation instead of trying to call
 * ChatGPT's private HTTP APIs or write directly into its authenticated cookies.
 * This is an explicitly requested, local UI automation prototype.
 */
export async function sendInitialChatGPTPrompt(input: {
  environmentId: EnvironmentId;
  sessionId: string;
  prompt: string;
  automation?: ChatGPTPromptAutomation;
  readState?: typeof readThreadPreviewState;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  acquireActivity?: (runtimeId: string) => () => void;
}): Promise<void> {
  const automation = input.automation ?? (previewBridge ? chatGPTWebviewAutomation : undefined);
  if (!automation) throw new Error("ChatGPT automation requires T3 Code desktop.");
  const readState = input.readState ?? readThreadPreviewState;
  const now = input.now ?? Date.now;
  const pause =
    input.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (input.timeoutMs ?? SEND_TIMEOUT_MS);
  const threadRef = chatGPTBrowserThreadRef(input.environmentId, input.sessionId);
  let lastError: unknown;
  let startedTyping = false;
  const acquireActivity = input.acquireActivity ?? acquireBrowserSurfaceActivity;
  let activeRuntimeId: string | null = null;
  let releaseActivity: (() => void) | null = null;

  // The sidebar mounts new ChatGPT previews even when another T3 route is
  // selected. Temporarily keep this guest composited behind the app so browser
  // automation works without navigating to it or taking the user's focus.
  try {
    while (now() < deadline) {
      const state = readState(threadRef);
      const tabId = state.activeTabId ?? state.snapshot?.tabId;
      // The upstream server-hosted browser can mount its Electron guest before
      // the desktop overlay reports hasWebContents. Resolve readiness from the
      // actual guest rather than waiting on that eventually consistent overlay.
      if (tabId) {
        const runtimeId = previewRuntimeTabId(threadRef, state.serverEpoch, tabId);
        if (runtimeId !== activeRuntimeId) {
          releaseActivity?.();
          releaseActivity = acquireActivity(runtimeId);
          activeRuntimeId = runtimeId;
        }
        try {
          const status = await automation.status(runtimeId);
          const url = status.url ?? "";
          if (
            status.available &&
            !status.loading &&
            /^https:\/\/(chatgpt\.com|chat\.openai\.com)(\/|$)/i.test(url)
          ) {
            // Do not accidentally inject a message into a previous conversation.
            // Every new session starts at the home page.
            await automation.waitFor(runtimeId, {
              selector: COMPOSER_SELECTOR,
              timeoutMs: Math.min(COMPOSER_WAIT_MS, Math.max(1, deadline - now())),
            });
            startedTyping = true;
            try {
              await automation.type(runtimeId, {
                selector: COMPOSER_SELECTOR,
                text: input.prompt,
                clear: true,
                timeoutMs: Math.min(COMPOSER_WAIT_MS, Math.max(1, deadline - now())),
              });
            } catch (error) {
              // The preview's Playwright strict selector sometimes reports
              // not-found directly after waitFor has found the composer.
              // Fall back to the native DOM, keeping the same guest WebContents.
              if (
                !(error instanceof Error) ||
                !/PreviewAutomationTargetNotFoundError/.test(error.message)
              )
                throw error;
              const fallback = await automation.evaluate(runtimeId, {
                expression: `(() => {
                const prompt = ${JSON.stringify(input.prompt)};
                const el =
                  document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)});
                if (!(el instanceof HTMLElement)) return { ok: false, reason: 'Composer element missing' };
                el.focus();
                const editable = el.isContentEditable;
                if (!editable && !(el instanceof HTMLTextAreaElement)) {
                  return { ok: false, reason: 'Composer not editable: ' + el.outerHTML.slice(0, 180) };
                }
                if (editable) {
                  const range = document.createRange();
                  range.selectNodeContents(el);
                  const selection = document.getSelection();
                  selection?.removeAllRanges();
                  selection?.addRange(range);
                  document.execCommand('insertText', false, prompt);
                } else {
                  el.select();
                  document.execCommand('insertText', false, prompt);
                }
                const actual = editable ? (el.innerText || el.textContent) : el.value;
                const normalize = (text) => (text || '').replace(/\\s+/g, ' ').trim();
                return {
                  ok: normalize(actual) === normalize(prompt),
                  reason: 'Composer text mismatch: ' + (actual || '').slice(0, 100),
                };
              })()`,
              });
              if (
                typeof fallback !== "object" ||
                fallback === null ||
                !("ok" in fallback) ||
                fallback.ok !== true
              ) {
                throw new Error(`ChatGPT composer fallback failed: ${JSON.stringify(fallback)}`, {
                  cause: error,
                });
              }
            }
            // Dispatch through ChatGPT's enabled Send control in the guest DOM.
            await automation.press(runtimeId, { key: "Enter" });

            // Do not mistake an emptied composer for delivery. The new
            // conversation URL or the rendered user message is positive evidence
            // that ChatGPT accepted this message. Navigation may briefly destroy
            // the guest document, so tolerate transient inspection failures.
            const deliveredExpression = `(() => {
            const expected = ${JSON.stringify(input.prompt)}.trim();
            return [...document.querySelectorAll('[data-message-author-role="user"]')]
              .some((el) => el.textContent?.trim() === expected) ||
              /(?:^|\\/)c\\/[^/]+/.test(window.location.pathname);
          })()`;
            while (now() < deadline) {
              try {
                if (
                  (await automation.evaluate(runtimeId, {
                    expression: deliveredExpression,
                  })) === true
                )
                  return;
              } catch {
                // The guest might be navigating to its new conversation.
              }
              try {
                const after = await automation.status(runtimeId);
                const parsed = new URL(after.url);
                if (
                  (parsed.hostname === "chatgpt.com" || parsed.hostname === "chat.openai.com") &&
                  parsed.pathname.includes("/c/")
                )
                  return;
              } catch {
                // Navigation can briefly detach the webview.
              }
              await pause(150);
            }
            throw new Error("ChatGPT did not confirm the sent message or open a new conversation.");
          }
        } catch (error) {
          lastError = error;
          // Do not retry after typing or pressing: doing so could duplicate
          // messages. Only retry readiness/selector acquisition.
          if (startedTyping) throw error;
          // A stale runtime webContents may have been replaced while mounting.
        }
      }
      await pause(250);
    }
    throw new Error(
      "ChatGPT session opened, but its message box was not ready or its prompt could not be sent." +
        (lastError instanceof Error ? ` Last error: ${lastError.message}` : ""),
    );
  } finally {
    releaseActivity?.();
  }
}
