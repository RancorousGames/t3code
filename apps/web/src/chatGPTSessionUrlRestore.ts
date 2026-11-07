import * as Schema from "effect/Schema";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  chatGPTBrowserLastUrlKey,
  chatGPTBrowserThreadRef,
  isChatGPTConversationUrl,
  type BrowserSession,
} from "./chatGPTBrowserSessions";
import { chatGPTConversationIdFromUrl } from "./chatGPTConversationIdentity";
import { chatGPTSessionProfileId } from "./chatGPTAccountProfiles";
import { getChatGPTSessionPersistedStore } from "./chatGPTSessionPersistedStore";
import { getLocalStorageItem, setLocalStorageItemAndNotify } from "./hooks/useLocalStorage";
import { resolveWarmChatGPTConversationUrl } from "./omniwork/chatGPTWarmConversationUrl";
import { readThreadPreviewState } from "./previewStateStore";
import { previewRuntimeTabId } from "./browser/previewRuntimeTabId";
import { isPersistentChatGPTSessionOptedIn } from "./browser/persistentChatGPTSessionMode";
import { guardedNativeChatGPTReload } from "./browser/guardedNativeChatGPTReload";
import { hasUncertainChatGPTSend } from "./chatGPTSessionControl";
import { chatGPTWebviewAutomation } from "./chatGPTWebviewAutomation";
import { inspectChatGPTComposer, inspectUnusedNewChatMarkers } from "./chatGPTDraftInspection";

type HistoryHit = { conversationId: string; title: string; url: string };
const taskIdIn = (title: string) => /\b[A-Za-z][A-Za-z0-9]*-\d{4,}\b/.exec(title)?.[0] ?? null;

/** Search only the signed-in account assigned to this T3 slot. A title is
 * not a conversation identity: ambiguous provider results require manual review. */
export function uniqueHistoryRecoveryUrl(
  hits: readonly HistoryHit[],
  title: string,
): string | null {
  const valid = [...new Map(
    hits.filter((hit) => chatGPTConversationIdFromUrl(hit.url) === hit.conversationId.toLowerCase())
      .map((hit) => [hit.conversationId.toLowerCase(), hit] as const),
  ).values()];
  const exact = valid.filter((hit) => hit.title.trim().toLowerCase() === title.trim().toLowerCase());
  const candidate = exact.length === 1 ? exact[0] : exact.length > 1 ? null :
    valid.length === 1 ? valid[0] : null;
  return candidate?.url ?? null;
}

async function historyRecoveryUrl(
  environmentId: EnvironmentId,
  session: BrowserSession,
): Promise<string> {
  const search = window.desktopBridge?.searchChatGPTHistory;
  if (!search) throw new Error("No saved URL; this T3 build cannot search ChatGPT history.");
  const query = taskIdIn(session.binding?.taskRef?.id ?? session.title) ??
    session.title.trim().slice(0, 150);
  if (query.length < 2) throw new Error("No identifying title to search ChatGPT history.");
  const hits = await search({
    environmentId,
    profileId: chatGPTSessionProfileId(session),
    query,
  });
  const found = uniqueHistoryRecoveryUrl(hits, session.title);
  if (!found) {
    throw new Error(hits.length
      ? "Several possible ChatGPT conversations were found. Choose the correct one in ChatGPT history search."
      : "No saved URL or matching ChatGPT history was found. This session may never have opened a conversation.");
  }
  return found;
}

/** Recover an already observed URL first; only then search the same account's
 * public ChatGPT history. Never treat a T3 session ID as a ChatGPT conversation ID. */
export async function restoreChatGPTSessionUrl(
  environmentId: EnvironmentId,
  session: BrowserSession,
  working: boolean,
): Promise<{ url: string; source: "saved" | "history" }> {
  if (working || hasUncertainChatGPTSend(environmentId, session.id))
    throw new Error("Finish the active generation or reconcile its unresolved send before restoring.");
  const ref = chatGPTBrowserThreadRef(environmentId, session.id);
  const preview = readThreadPreviewState(ref);
  const previewUrl = preview.snapshot?.navStatus._tag === "Success"
    ? preview.snapshot.navStatus.url : null;
  const cached = getLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, session.id), Schema.String);
  const pageSnapshot = getChatGPTSessionPersistedStore(environmentId).getState()
    .snapshots[session.id] as { url?: string } | undefined;
  const recovered = resolveWarmChatGPTConversationUrl(
    session, cached, previewUrl,
  ) ?? (isChatGPTConversationUrl(pageSnapshot?.url ?? null) ? pageSnapshot!.url! : null);
  const url = recovered ?? await historyRecoveryUrl(environmentId, session);
  const target = chatGPTConversationIdFromUrl(url);
  if (!target) throw new Error("Recovered address is not a ChatGPT conversation URL.");

  if (isPersistentChatGPTSessionOptedIn(session.id)) {
    const bridge = window.desktopBridge?.stableChatGPTViewRequest;
    if (!bridge) throw new Error("Native Chromium bridge unavailable.");
    const identity = { environmentId, sessionId: session.id,
      profileId: chatGPTSessionProfileId(session) };
    const state = await bridge({ operation: "probe", identity }) as {
      residency?: string; destroyed?: boolean; url?: string;
    };
    if (state.residency === "missing") {
      const attached = await bridge({ operation: "attach", identity, url }) as { url?: string };
      if (chatGPTConversationIdFromUrl(attached.url ?? null) !== target)
        throw new Error("Native session attached somewhere else; no URL was overwritten.");
    } else if (state.residency === "resident" && !state.destroyed && state.url) {
      const current = chatGPTConversationIdFromUrl(state.url);
      if (current && current !== target)
        throw new Error("This slot already contains a different conversation; refusing to overwrite it.");
      if (!current) {
        await guardedNativeChatGPTReload({
          environmentId, sessionId: session.id, currentUrl: state.url,
          savedUrl: url, working: false, force: false, bridge,
        });
      }
    } else {
      throw new Error("Native session state is unknown; refusing to replace its page.");
    }
  } else {
    const tabId = preview.activeTabId;
    const runtimeId = tabId && preview.serverEpoch
      ? previewRuntimeTabId(ref, preview.serverEpoch, tabId) : null;
    const currentUrl = previewUrl;
    if (!runtimeId || !currentUrl)
      throw new Error("Open this session's browser first, then retry Restore URL.");
    const current = chatGPTConversationIdFromUrl(currentUrl);
    if (current && current !== target)
      throw new Error("This slot already contains a different conversation; refusing to overwrite it.");
    if (!current) {
      const expression = `(() => {
        if (location.href !== ${JSON.stringify(currentUrl)}) return false;
        const draft = (${inspectChatGPTComposer.toString()})(document, location.href);
        if (draft.status !== 'empty' ||
            !(${inspectUnusedNewChatMarkers.toString()})(document, location.href)) return false;
        if (document.querySelector('[data-testid="stop-button"],[data-testid="composer-stop-button"]'))
          return false;
        location.assign(${JSON.stringify(url)});
        return true;
      })()`;
      const ok = await chatGPTWebviewAutomation.evaluate(runtimeId, { expression });
      if (ok !== true) throw new Error("The browser could not prove its homepage and draft were empty.");
    }
  }
  setLocalStorageItemAndNotify(chatGPTBrowserLastUrlKey(environmentId, session.id), url, Schema.String);
  return { url, source: recovered ? "saved" : "history" };
}
