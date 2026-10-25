import type { EnvironmentId } from "@t3tools/contracts";

import { isChatGPTGuestHibernated } from "./browser/chatGPTGuestHibernation";
import { resetHostedBrowserGuest } from "./browser/hostedBrowserGuestReset";
import { previewRuntimeTabId } from "./browser/previewRuntimeTabId";
import { chatGPTBrowserFailure } from "./chatGPTBrowserHealth";
import {
  chatGPTBrowserLastUrlKey,
  chatGPTBrowserThreadRef,
  type BrowserSession,
} from "./chatGPTBrowserSessions";
import { chatGPTConversationIdFromUrl } from "./chatGPTConversationIdentity";
import { hasUncertainChatGPTSend } from "./chatGPTSessionControl";
import { hasChatGPTLoadFailure } from "./components/sidebar/chatGPTConversationRecovery";
import { readThreadPreviewState } from "./previewStateStore";

export interface OfflineRebootPredecessor {
  readonly runtimeId: string;
  readonly webview: HTMLElementTagNameMap["webview"];
}

/** Require three independently maintained URL pins before considering host reset. */
function pinnedPredecessor(
  environmentId: EnvironmentId,
  session: BrowserSession,
  priorConversationId: string,
): OfflineRebootPredecessor | null {
  if (session.hidden || hasUncertainChatGPTSend(environmentId, session.id)) return null;
  const thread = chatGPTBrowserThreadRef(environmentId, session.id);
  const state = readThreadPreviewState(thread);
  const tabId = state.activeTabId;
  if (!tabId || !state.serverEpoch || state.desktopByTabId[tabId]?.loading) return null;
  const runtimeId = previewRuntimeTabId(thread, state.serverEpoch, tabId);
  if (isChatGPTGuestHibernated(runtimeId)) return null;
  const webview = Array.from(document.querySelectorAll("webview")).find(
    (element) => element.dataset.previewTab === runtimeId,
  );
  if (!webview) return null;
  const nav = state.sessions[tabId]?.navStatus;
  if (nav?._tag !== "Success") return null;

  let observedUrl: string;
  let savedUrl: string;
  try {
    const saved: unknown = JSON.parse(
      window.localStorage.getItem(chatGPTBrowserLastUrlKey(environmentId, session.id)) ?? "null",
    );
    if (typeof saved !== "string") return null;
    savedUrl = saved;
    observedUrl = webview.getURL();
  } catch {
    return null;
  }
  if (
    chatGPTConversationIdFromUrl(savedUrl) !== priorConversationId ||
    chatGPTConversationIdFromUrl(nav.url) !== priorConversationId ||
    chatGPTConversationIdFromUrl(observedUrl) !== priorConversationId
  )
    return null;
  return { runtimeId, webview };
}

/** Only a confirmed blank renderer is safe to replace without querying its DOM. */
export function inspectOfflineRebootPredecessor(
  environmentId: EnvironmentId,
  session: BrowserSession,
  priorConversationId: string,
): OfflineRebootPredecessor | null {
  const candidate = pinnedPredecessor(environmentId, session, priorConversationId);
  return candidate && chatGPTBrowserFailure(candidate.webview) === "blank-page" ? candidate : null;
}

/** The explicit ChatGPT load-error page is another terminal, editor-free state. */
export async function inspectErroredRebootPredecessor(
  environmentId: EnvironmentId,
  session: BrowserSession,
  priorConversationId: string,
): Promise<OfflineRebootPredecessor | null> {
  const blank = inspectOfflineRebootPredecessor(environmentId, session, priorConversationId);
  if (blank) {
    // Health detects visible blanks; additionally exclude even hidden editors.
    try {
      const empty = await Promise.race([
        blank.webview.executeJavaScript(
          "(() => !!document.body && !document.querySelector('textarea,[contenteditable=\"true\"],input') && !(document.body.innerText ?? document.body.textContent)?.trim())()",
        ),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 4_000)),
      ]);
      if (
        empty === true &&
        pinnedPredecessor(environmentId, session, priorConversationId)?.webview === blank.webview
      )
        return blank;
    } catch {
      /* An unreadable renderer may still contain a draft. */
    }
    return null;
  }
  const candidate = pinnedPredecessor(environmentId, session, priorConversationId);
  if (!candidate || chatGPTBrowserFailure(candidate.webview) === "probe-timeout") return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      candidate.webview.executeJavaScript(`(() => {
        const errored = (${hasChatGPTLoadFailure.toString()})();
        const editor = document.querySelector('textarea,[contenteditable="true"],input');
        const stop = document.querySelector('button[data-testid="stop-button"],button[data-testid="composer-stop-button"]');
        return errored && !editor && !stop && location.href === ${JSON.stringify(`https://chatgpt.com/c/${priorConversationId}`)};
      })()`),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 4_000);
      }),
    ]);
    if (result !== true) return null;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const current = pinnedPredecessor(environmentId, session, priorConversationId);
  return current?.runtimeId === candidate.runtimeId && current.webview === candidate.webview
    ? current
    : null;
}

/**
 * Recheck the exact failed guest immediately before replacing it. Host reset
 * preserves the logical T3 browser slot and works when the old page cannot
 * navigate itself. The caller persists a private draft backup and the reboot
 * intent BEFORE invoking this operation.
 */
export async function navigateOfflineChatGPTReboot(
  environmentId: EnvironmentId,
  session: BrowserSession,
  conversationId: string,
  predecessor: OfflineRebootPredecessor,
  url: string,
): Promise<void> {
  if (url !== "https://chatgpt.com/")
    throw new Error("Offline reboot may only open a fresh ChatGPT home.");
  const current = await inspectErroredRebootPredecessor(environmentId, session, conversationId);
  if (
    !current ||
    current.runtimeId !== predecessor.runtimeId ||
    current.webview !== predecessor.webview
  )
    throw new Error("Offline reboot predecessor changed; preserving its browser.");
  await resetHostedBrowserGuest(predecessor.runtimeId, url);
}
