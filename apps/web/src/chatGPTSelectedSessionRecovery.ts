import type { EnvironmentId } from "@t3tools/contracts";

import {
  isChatGPTGuestHibernated,
  wakeChatGPTGuest,
} from "./browser/chatGPTGuestHibernation";
import { previewRuntimeTabId } from "./browser/previewRuntimeTabId";
import { isChatGPTHomeUrl } from "./chatGPTBrowserPrewarm";
import {
  chatGPTBrowserLastUrlKey,
  chatGPTBrowserThreadRef,
  readChatGPTBrowserSessions,
} from "./chatGPTBrowserSessions";
import { chatGPTConversationIdFromUrl } from "./chatGPTConversationIdentity";
import { inspectBrowserSession, runChatGPTSessionControl } from "./chatGPTSessionControl";
import { readThreadPreviewState } from "./previewStateStore";

const ATTACH_POLL_MS = 300;
const HOME_CONFIRM_MS = 650;
const MAX_WAIT_MS = 45_000;

export type SelectedBlankRecoveryOutcome =
  | "recovered" | "already-open" | "no-saved-conversation" | "cancelled"
  | "guest-not-ready" | "unsafe-or-unavailable";

/**
 * Triggered by selecting a sidebar/route session, not by scanning all guests.
 * Never reload an ordinary healthy conversation or force an orange session.
 *
 * Hibernated guests are woken, but not navigated until the actual guest has
 * rendered and the existing reload controller has verified two empty-page
 * inspections (including its draft and generation guards).
 */
export async function recoverSelectedBlankChatGPTSession(input: {
  environmentId: EnvironmentId;
  sessionId: string;
  isCurrent: () => boolean;
  maxWaitMs?: number;
}): Promise<SelectedBlankRecoveryOutcome> {
  const { environmentId, sessionId, isCurrent } = input;
  const current = () =>
    isCurrent() &&
    readChatGPTBrowserSessions(environmentId).some(
      (session) => session.id === sessionId && !session.hidden,
    );

  if (!current()) return "cancelled";
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(chatGPTBrowserLastUrlKey(environmentId, sessionId)) ?? "null");
  } catch {
    return "no-saved-conversation";
  }
  if (typeof saved !== "string" || !chatGPTConversationIdFromUrl(saved))
    return "no-saved-conversation";

  const startedAt = Date.now();
  let blankSince: number | null = null;
  let seenGuest = false;
  let lastRuntimeId: string | null = null;
  const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, ATTACH_POLL_MS));
  while (Date.now() - startedAt < (input.maxWaitMs ?? MAX_WAIT_MS)) {
    if (!current()) return "cancelled";
    const ref = chatGPTBrowserThreadRef(environmentId, sessionId);
    const preview = readThreadPreviewState(ref);
    const tabId = preview.activeTabId;
    if (!tabId || !preview.serverEpoch) {
      blankSince = null;
      await sleep();
      continue;
    }
    const runtimeId = previewRuntimeTabId(ref, preview.serverEpoch, tabId);
    if (lastRuntimeId !== runtimeId) blankSince = null;
    lastRuntimeId = runtimeId;
    if (isChatGPTGuestHibernated(runtimeId)) {
      // A selected tab should wake automatically. Wake explicitly as well for
      // a repeated click on an already-selected but unloaded tab.
      wakeChatGPTGuest(runtimeId);
      blankSince = null;
      await sleep();
      continue;
    }

    const guest = Array.from(document.querySelectorAll("webview")).find(
      (element) => element.dataset.previewTab === runtimeId,
    );
    if (!guest) {
      blankSince = null;
      await sleep();
      continue;
    }
    seenGuest = true;
    const entry = readChatGPTBrowserSessions(environmentId).find((s) => s.id === sessionId);
    if (!entry || entry.hidden) return "cancelled";
    const inspection = await inspectBrowserSession(environmentId, entry);
    if (!current()) return "cancelled";
    if (inspection.observedGuestUrl) {
      if (!isChatGPTHomeUrl(inspection.observedGuestUrl)) return "already-open";
      // A homepage during guest hydration is not yet a lost route. Do not
      // navigate until it remains an idle blank homepage across observations.
      if (inspection.activity !== "idle" || inspection.status === "working" ||
          inspection.totalTurns !== 0 || inspection.lastRole !== null ||
          inspection.uiColor === "interrupted" ||
          inspection.uiColor === "delivery-timeout")
        return "unsafe-or-unavailable";
      if (blankSince === null) blankSince = Date.now();
      if (Date.now() - blankSince >= HOME_CONFIRM_MS) {
        if (!current()) return "cancelled";
        try {
          const outcome = await runChatGPTSessionControl({
            environmentId,
            sessions: readChatGPTBrowserSessions(environmentId),
            sessionId,
            action: "reload",
            shouldContinue: current,
            // Never force on selection. Orange states still need deliberate user action.
          }) as { recoveredUrl?: string; requestedNavigation?: boolean };
          return outcome.requestedNavigation === true && outcome.recoveredUrl === saved
            ? "recovered"
            : "unsafe-or-unavailable";
        } catch (error) {
          // Another recovery may have won the race or the page/draft changed.
          // Neither condition permits a second navigation from the click path.
          console.debug("[ChatGPT selected blank recovery] Skipped unsafe navigation:", {
            sessionId, message: error instanceof Error ? error.message : String(error),
          });
          return "unsafe-or-unavailable";
        }
      }
    } else {
      blankSince = null;
    }
    await sleep();
  }
  return seenGuest ? "unsafe-or-unavailable" : "guest-not-ready";
}
