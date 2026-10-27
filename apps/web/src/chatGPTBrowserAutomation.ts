import type { EnvironmentId } from "@t3tools/contracts";

import { chatGPTBrowserThreadRef, readChatGPTBrowserSessions } from "./chatGPTBrowserSessions";
import { isChatGPTHomeUrl } from "./chatGPTBrowserPrewarm";
import { buildChatGPTSessionHandoffPrompt } from "./chatGPTSessionHandoff";
import { previewRuntimeTabId } from "./browser/previewRuntimeTabId";
import { acquireBrowserSurfaceActivity } from "./browser/browserSurfaceStore";
import { wakeChatGPTGuest } from "./browser/chatGPTGuestHibernation";
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

export interface ChatGPTInitialPromptReceipt {
  readonly delivery: "user_turn_observed" | "unknown" | "not_sent";
  readonly sendAttempted: boolean;
  readonly reason?: string;
}

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
  requestId: string;
  prompt: string;
  /** Reboots are not new managed workers; do not inject worker onboarding. */
  newManagedWorker?: boolean;
  readSessions?: typeof readChatGPTBrowserSessions;
  automation?: ChatGPTPromptAutomation;
  readState?: typeof readThreadPreviewState;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  acquireActivity?: (runtimeId: string) => () => void;
}): Promise<ChatGPTInitialPromptReceipt> {
  const automation = input.automation ?? (previewBridge ? chatGPTWebviewAutomation : undefined);
  if (!automation) throw new Error("ChatGPT automation requires T3 Code desktop.");
  const session = (input.readSessions ?? readChatGPTBrowserSessions)(input.environmentId).find(
    (entry) =>
      entry.id === input.sessionId && !entry.hidden && entry.spawnRequestId === input.requestId,
  );
  if (!session)
    return {
      delivery: "not_sent",
      sendAttempted: false,
      reason: "ChatGPT guest does not belong to this exact backend spawn reservation.",
    };
  const prompt = buildChatGPTSessionHandoffPrompt(
    input.prompt,
    session.id,
    session.parentSessionId,
    {
      newManagedWorker: input.newManagedWorker !== false,
      ...(session.project === undefined ? {} : { project: session.project }),
    },
  );
  const readState = input.readState ?? readThreadPreviewState;
  const now = input.now ?? Date.now;
  const pause =
    input.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (input.timeoutMs ?? SEND_TIMEOUT_MS);
  const threadRef = chatGPTBrowserThreadRef(input.environmentId, input.sessionId);
  let lastError: unknown;
  let startedTyping = false;
  let rejectedGuest = false;
  let sendAttempted = false;
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
        // A fresh background session has no work history yet; keep it loaded.
        wakeChatGPTGuest(runtimeId);
        if (runtimeId !== activeRuntimeId) {
          releaseActivity?.();
          releaseActivity = acquireActivity(runtimeId);
          activeRuntimeId = runtimeId;
        }
        try {
          const status = await automation.status(runtimeId);
          const url = status.url ?? "";
          if (status.available && !status.loading && isChatGPTHomeUrl(url)) {
            // Do not accidentally inject a message into a previous conversation.
            // Every new session starts at the home page.
            await automation.waitFor(runtimeId, {
              selector: COMPOSER_SELECTOR,
              timeoutMs: Math.min(COMPOSER_WAIT_MS, Math.max(1, deadline - now())),
            });
            // ChatGPT can restore a stale draft from another empty chat here.
            // Automatic spawn/reboot replaces it with the intended bootstrap;
            // exact guest, reservation and home-URL checks remain in place.
            // Prevent a removed/replaced reservation from writing to an orphaned guest.
            if (
              !(input.readSessions ?? readChatGPTBrowserSessions)(input.environmentId).some(
                (entry) =>
                  entry.id === input.sessionId &&
                  !entry.hidden &&
                  entry.spawnRequestId === input.requestId,
              )
            ) {
              rejectedGuest = true;
              throw new Error("ChatGPT spawn reservation changed before dispatch.");
            }
            // The ChatGPT home composer may contain a draft restored from an
            // unrelated empty chat. Clear that exact guest editor first, rather
            // than relying on an insert to replace the old text. This is only
            // used for an owned automatic spawn/reboot, never for manual chats.
            // Treat a partial clear as an attempted mutation; do not retry it
            // against a potentially different guest.
            startedTyping = true;
            const cleared = await automation.evaluate(runtimeId, {
              expression: `(() => {
                if (!['chatgpt.com', 'chat.openai.com'].includes(location.hostname) ||
                    location.pathname !== '/')
                  return { ok: false, reason: 'Guest left the new-chat home before clearing draft.' };
                const draftEditor = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)});
                if (!(draftEditor instanceof HTMLElement) ||
                    (!draftEditor.isContentEditable &&
                     !(draftEditor instanceof HTMLTextAreaElement)))
                  return { ok: false, reason: 'New-chat composer is not editable.' };
                const read = () => draftEditor instanceof HTMLTextAreaElement
                  ? draftEditor.value : (draftEditor.innerText || draftEditor.textContent || '');
                if (!read().trim()) return { ok: true };
                draftEditor.focus();
                if (draftEditor.isContentEditable) {
                  const selection = document.getSelection();
                  const range = document.createRange();
                  range.selectNodeContents(draftEditor);
                  selection?.removeAllRanges();
                  selection?.addRange(range);
                } else {
                  draftEditor.select();
                }
                document.execCommand('delete', false);
                // The command's boolean return is unreliable across browser
                // versions; the editor's actual content is the safety check.
                return { ok: !read().trim(),
                  reason: 'Could not clear restored ChatGPT draft.' };
              })()`,
            });
            if (
              typeof cleared !== "object" ||
              cleared === null ||
              !("ok" in cleared) ||
              cleared.ok !== true
            ) {
              throw new Error(
                `ChatGPT automatic startup draft clear failed: ${JSON.stringify(cleared)}`,
              );
            }
            try {
              await automation.type(runtimeId, {
                selector: COMPOSER_SELECTOR,
                text: prompt,
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
                const prompt = ${JSON.stringify(prompt)};
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
            // A draft can be restored again after clearing, or a type helper
            // can append instead of replace. Never press Send unless this
            // exact new-chat editor contains only the intended handoff.
            const verified = await automation.evaluate(runtimeId, {
              expression: `(() => {
                if (!['chatgpt.com', 'chat.openai.com'].includes(location.hostname) ||
                    location.pathname !== '/')
                  return { ok: false, reason: 'Guest left the new-chat home before dispatch.' };
                const editor = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)});
                if (!(editor instanceof HTMLElement) ||
                    (!editor.isContentEditable && !(editor instanceof HTMLTextAreaElement)))
                  return { ok: false, reason: 'New-chat composer is not editable before dispatch.' };
                const expectedDraft = ${JSON.stringify(prompt)};
                const actualDraft = editor instanceof HTMLTextAreaElement
                  ? editor.value : (editor.innerText || editor.textContent || '');
                const normalize = (text) => (text || '').replace(/\\s+/g, ' ').trim();
                return { ok: normalize(actualDraft) === normalize(expectedDraft),
                  reason: 'Automatic startup composer differs from intended prompt.' };
              })()`,
            });
            if (
              typeof verified !== "object" ||
              verified === null ||
              !("ok" in verified) ||
              verified.ok !== true
            ) {
              throw new Error(
                `ChatGPT automatic startup prompt verification failed: ${JSON.stringify(verified)}`,
              );
            }
            // Dispatch through ChatGPT's enabled Send control in the guest DOM.
            sendAttempted = true;
            await automation.press(runtimeId, { key: "Enter", expectedComposerText: prompt });

            // Neither a new conversation URL nor an empty composer confirms
            // delivery. Require the exact rendered user turn before acknowledging.
            const deliveredExpression = `(() => {
            // ChatGPT renders multiline messages through nested Markdown blocks;
            // textContent can omit visual paragraph separators. Match the actual
            // visible user turn, never merely the disabled/cleared composer.
            const normalize = (text) => (text || '').replace(/\\u200b/g, '')
              .replace(/\\s+/g, ' ').trim();
            const expected = normalize(${JSON.stringify(prompt)});
            return [...document.querySelectorAll('[data-message-author-role="user"]')]
              .some((el) => normalize(el.innerText || el.textContent) === expected);
          })()`;
            while (now() < deadline) {
              try {
                if (
                  (await automation.evaluate(runtimeId, {
                    expression: deliveredExpression,
                  })) === true
                )
                  return { delivery: "user_turn_observed", sendAttempted: true };
              } catch {
                // The guest might be navigating to its new conversation.
              }
              await pause(150);
            }
            throw new Error("ChatGPT did not confirm the sent message or open a new conversation.");
          }
        } catch (error) {
          lastError = error;
          // Do not retry after typing or pressing: doing so could duplicate
          // messages. Only retry readiness/selector acquisition.
          if (startedTyping || rejectedGuest) throw error;
          // A stale runtime webContents may have been replaced while mounting.
        }
      }
      await pause(250);
    }
    throw new Error(
      "ChatGPT session opened, but its message box was not ready or its prompt could not be sent." +
        (lastError instanceof Error ? ` Last error: ${lastError.message}` : ""),
    );
  } catch (error) {
    // The session is already persisted. A rejected press may still have been
    // accepted by ChatGPT, so never retry without inspecting its exact guest.
    return {
      delivery: sendAttempted ? "unknown" : "not_sent",
      sendAttempted,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    releaseActivity?.();
  }
}
