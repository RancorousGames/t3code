import type { EnvironmentId } from "@t3tools/contracts";
import { previewRuntimeTabId } from "./browser/previewRuntimeTabId";
import {
  chatGPTBrowserLastUrlKey,
  chatGPTBrowserThreadRef,
  type BrowserSession,
} from "./chatGPTBrowserSessions";
import { chatGPTConversationIdFromUrl } from "./chatGPTConversationIdentity";
import { readThreadPreviewState } from "./previewStateStore";

/**
 * T3—not OpenRig—owns the ChatGPT conversation underneath a stable T3 session.
 * An existing request is always resolved from its immutable reboot receipt;
 * for a new request prefer the live browser URL, then T3's persisted URL.
 * No predecessor activity/idle test is performed here.
 */
export function resolveT3RebootPredecessor(input: {
  environmentId: EnvironmentId;
  session: BrowserSession;
  requestId: string;
}): string {
  const { environmentId, session, requestId } = input;
  const raw = window.localStorage.getItem(`t3code:chatgpt-browser:refresh:v1:${environmentId}`);
  if (raw) {
    const receipts: unknown = JSON.parse(raw);
    if (!Array.isArray(receipts)) throw new Error("T3 reboot receipt ledger is unreadable.");
    const matching = receipts.filter((item) =>
      item && typeof item === "object" && item.operationId === requestId,
    );
    if (matching.length > 1) throw new Error("Duplicate T3 reboot operation receipts.");
    if (matching.length === 1) {
      const item = matching[0] as { sessionId?: string; priorConversationId?: string };
      if (item.sessionId !== session.id ||
          !chatGPTConversationIdFromUrl(`https://chatgpt.com/c/${item.priorConversationId ?? ""}`))
        throw new Error("T3 reboot request is bound to a different session or invalid conversation.");
      return item.priorConversationId!;
    }
  }
  const thread = chatGPTBrowserThreadRef(environmentId, session.id);
  const state = readThreadPreviewState(thread);
  const tabId = state.activeTabId;
  if (tabId && state.serverEpoch) {
    const runtimeId = previewRuntimeTabId(thread, state.serverEpoch, tabId);
    const guest = Array.from(document.querySelectorAll("webview")).find(
      (el) => el.dataset.previewTab === runtimeId,
    );
    if (guest) {
      try {
        const observed = chatGPTConversationIdFromUrl(guest.getURL());
        if (observed) return observed;
      } catch { /* Dead/errored guests still have persisted T3 URL history. */ }
    }
    const nav = state.sessions[tabId]?.navStatus;
    if (nav?._tag === "Success") {
      const fromNav = chatGPTConversationIdFromUrl(nav.url);
      if (fromNav) return fromNav;
    }
  }
  const persisted: unknown = JSON.parse(
    window.localStorage.getItem(chatGPTBrowserLastUrlKey(environmentId, session.id)) ?? "null",
  );
  const id = chatGPTConversationIdFromUrl(typeof persisted === "string" ? persisted : null);
  if (id) return id;
  if (session.archive?.conversationUrl) {
    const archiveId = chatGPTConversationIdFromUrl(session.archive.conversationUrl);
    if (archiveId) return archiveId;
  }
  throw new Error("T3 session has no recorded ChatGPT conversation to replace.");
}
