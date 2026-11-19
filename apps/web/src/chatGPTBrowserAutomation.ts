import type { EnvironmentId } from "@t3tools/contracts";

import { chatGPTBrowserThreadRef, readChatGPTBrowserSessions } from "./chatGPTBrowserSessions";
import { isChatGPTHomeUrl } from "./chatGPTBrowserPrewarm";
import { ensureChatGPTHighEffort } from "./chatGPTHighEffort";
import { buildChatGPTSessionHandoffPrompt } from "./chatGPTSessionHandoff";
import { publicChatGPTParentId, publicChatGPTSessionId } from "./chatGPTBootstrapIdentity";
import { previewRuntimeTabId } from "./browser/previewRuntimeTabId";
import { acquireBrowserSurfaceActivity } from "./browser/browserSurfaceStore";
import { wakeChatGPTGuest } from "./browser/chatGPTGuestHibernation";
import { previewBridge } from "./components/preview/previewBridge";
import { chatGPTWebviewAutomation } from "./chatGPTWebviewAutomation";
import { chatGPTDirectSubmitExpression, directSubmitOutcome } from "./chatGPTDirectSubmit";
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
  readonly evaluate: typeof chatGPTWebviewAutomation.evaluate;
}

/**
 * Submit an initial ChatGPT message through the mounted Electron webview of
 * its exact reserved session. Never overwrite a draft or replay an ambiguous
 * first-message submission.
 */
export async function sendInitialChatGPTPrompt(input: {
  environmentId: EnvironmentId;
  sessionId: string;
  requestId: string;
  prompt: string;
  /** Reboots are not new managed workers; do not inject worker onboarding. */
  newManagedWorker?: boolean;
  resumeWorkAfterReboot?: boolean;
  readSessions?: typeof readChatGPTBrowserSessions;
  automation?: ChatGPTPromptAutomation;
  readState?: typeof readThreadPreviewState;
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  acquireActivity?: (runtimeId: string) => () => void;
}): Promise<ChatGPTInitialPromptReceipt> {
  const sessions = (input.readSessions ?? readChatGPTBrowserSessions)(input.environmentId);
  const session = sessions.find(
    (entry) =>
      entry.id === input.sessionId && !entry.hidden && entry.spawnRequestId === input.requestId,
  );
  if (!session)
    return {
      delivery: "not_sent",
      sendAttempted: false,
      reason: "ChatGPT guest does not belong to this exact backend spawn reservation.",
    };
  const automation = input.automation ?? (previewBridge ? chatGPTWebviewAutomation : undefined);
  if (!automation) throw new Error("ChatGPT automation requires T3 Code desktop.");
  const prompt = buildChatGPTSessionHandoffPrompt(
    input.prompt,
    publicChatGPTSessionId(session),
    publicChatGPTParentId(sessions, session),
    {
      newManagedWorker: input.newManagedWorker !== false,
      resumeWorkAfterReboot: input.resumeWorkAfterReboot === true,
      ...(session.project === undefined ? {} : { project: session.project }),
      ...(session.binding ? { role: session.binding.role } : {}),
    },
  );
  const readState = input.readState ?? readThreadPreviewState;
  const now = input.now ?? Date.now;
  const pause =
    input.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (input.timeoutMs ?? SEND_TIMEOUT_MS);
  const threadRef = chatGPTBrowserThreadRef(input.environmentId, input.sessionId);
  let lastError: unknown;
  let rejectedGuest = false;
  let lastSubmitReason: string | null = null;
  let callbackOutcome: string | null = null;
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
      if (tabId) {
        const runtimeId = previewRuntimeTabId(threadRef, state.serverEpoch, tabId);
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
            // A restored draft is never touched. The callback receives the
            // bootstrap text separately and this reservation must remain exact.
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
            // A spawned worker must start on High, not inherit the account's last
            // manually selected effort. Fail before submitting if ChatGPT is not ready.
            if (input.newManagedWorker !== false) {
              const high = await ensureChatGPTHighEffort((expression) =>
                automation.evaluate(runtimeId, { expression }),
              );
              if (!high) {
                lastError = new Error("ChatGPT High effort selection is not ready.");
                await pause(250);
                continue;
              }
            }
            // Submit through ChatGPT's mounted React handler. Unlike typing and
            // clicking Send, this neither mutates nor focuses a restored draft.
            // A definite no-callback result permits another readiness probe;
            // transport loss or callback exceptions remain UNKNOWN (no retry).
            sendAttempted = true;
            const callbackResult = await automation.evaluate(runtimeId, {
              expression: chatGPTDirectSubmitExpression({
                text: prompt,
                expectedNewChat: true,
                sendExpiresAt: deadline,
              }),
            });
            const submit = directSubmitOutcome(callbackResult);
            callbackOutcome =
              callbackResult &&
              typeof callbackResult === "object" &&
              "callbackOutcome" in callbackResult &&
              typeof callbackResult.callbackOutcome === "string"
                ? callbackResult.callbackOutcome
                : "unreported";
            if (submit === "not_submitted") {
              lastSubmitReason =
                callbackResult &&
                typeof callbackResult === "object" &&
                "reason" in callbackResult &&
                typeof callbackResult.reason === "string"
                  ? callbackResult.reason
                  : "callback_not_submitted";
              sendAttempted = false;
              lastError = new Error(`ChatGPT direct submit not ready (${lastSubmitReason}).`);
              await pause(250);
              continue;
            }

            // Navigation/empty composer is not delivery. Confirm the exact
            // rendered user turn after ChatGPT creates the new conversation.
            const deliveredExpression = `(() => {
              const normalize = (text) => (text || '').replace(/\\u200b/g, '')
                .replace(/\\s+/g, ' ').trim();
              const expected = normalize(${JSON.stringify(prompt)});
              const conversationReady = location.pathname.startsWith('/c/') &&
                /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(location.pathname.split('/')[2]);
              const expectedPrefix = expected.slice(0, 120);
              const bootstrapId = ${JSON.stringify(input.sessionId)};
              return conversationReady && [...document.querySelectorAll(
                '[data-message-author-role="user"],[data-content-search-unit-key$=":user"]'
              )].some(el => {
                const observed = normalize(el.innerText || el.textContent);
                return observed === expected ||
                  (observed.startsWith(expectedPrefix) && observed.includes(bootstrapId));
              });
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
                // ChatGPT may navigate during the first user turn.
              }
              await pause(150);
            }
            throw new Error(
              `ChatGPT direct callback ${callbackOutcome ?? "unknown"}; no user turn was confirmed before deadline.`,
            );
          }
        } catch (error) {
          lastError = error;
          // Once the callback may have run, never retry an ambiguous send.
          if (sendAttempted || rejectedGuest) throw error;
          // A stale runtime webContents may have been replaced while mounting.
        }
      }
      await pause(250);
    }
    throw new Error(
      "ChatGPT session opened, but direct submission was not ready or its prompt could not be sent." +
        (lastError instanceof Error ? ` Last error: ${lastError.message}` : ""),
    );
  } catch (error) {
    // The session is already persisted. A lost direct-submit response may
    // follow a real send; keep UNKNOWN until this exact guest is reconciled.
    return {
      delivery: sendAttempted ? "unknown" : "not_sent",
      sendAttempted,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    releaseActivity?.();
  }
}
