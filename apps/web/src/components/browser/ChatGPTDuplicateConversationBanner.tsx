import { type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { inspectBrowserSession } from "../../chatGPTSessionControl";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { closePreviewSession } from "../preview/closePreviewSession";
import { readThreadPreviewState } from "../../previewStateStore";
import { removeLocalStorageItem } from "../../hooks/useLocalStorage";

import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import { hasHostedBrowserGuest } from "../../browser/hostedBrowserGuestPresence";
import {
  chatGPTBrowserLastWorkingKey,
  chatGPTBrowserLastUrlKey,
  chatGPTBrowserThreadRef,
  readChatGPTBrowserSessions,
  useChatGPTBrowserSessions,
} from "../../chatGPTBrowserSessions";
import {
  findDuplicateChatGPTConversationOwner,
  duplicateMergeHealthRank,
} from "../../chatGPTDuplicateConversationGuard";
import { getLocalStorageItem } from "../../hooks/useLocalStorage";
import { useThreadPreviewState } from "../../previewStateStore";
import { Button } from "../ui/button";
import { previewBridge } from "../preview/previewBridge";

function lastKnownConversationUrl(environmentId: EnvironmentId, sessionId: string): string | null {
  try {
    return getLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, sessionId), Schema.String);
  } catch {
    return null;
  }
}

/** Never make guest health/close acknowledgements a prerequisite for a user merge. */
async function settleMergeBestEffort<T>(promise: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), 1_500);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Navigating inside a ChatGPT guest bypasses T3's open-conversation reuse.
 * A manual merge collapses duplicate local views of the same URL.
 */
export function ChatGPTDuplicateConversationBanner({
  environmentId,
  sessionId,
}: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
}) {
  const navigate = useNavigate();
  const close = useAtomCommand(previewEnvironment.close);
  const threadRef = chatGPTBrowserThreadRef(environmentId, sessionId);
  const state = useThreadPreviewState(threadRef);
  const { sessions, setSessionHidden, setSessionSnooze, removeSession } =
    useChatGPTBrowserSessions(environmentId);
  const nav = state.snapshot?.navStatus;
  const observedUrl = nav?._tag === "Success" ? nav.url : null;
  const owner = findDuplicateChatGPTConversationOwner(sessions, sessionId, observedUrl, (id) =>
    lastKnownConversationUrl(environmentId, id),
  );
  const [reason, setReason] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);

  if (!owner) return null;

  const stillOwned = () =>
    findDuplicateChatGPTConversationOwner(
      readChatGPTBrowserSessions(environmentId),
      sessionId,
      observedUrl,
      (id) => lastKnownConversationUrl(environmentId, id),
    )?.id === owner.id;

  const switchToOwner = () => {
    if (!stillOwned()) {
      setReason("The original session changed. Reopen the conversation from its current owner.");
      return;
    }
    if (owner.hidden) setSessionHidden(owner.id, false);
    if (owner.snoozedUntil !== undefined) setSessionSnooze([owner.id], null);
    void navigate({
      to: "/browser/$browserSessionId",
      params: { browserSessionId: owner.id },
    });
  };

  const goBack = () => {
    const tabId = state.activeTabId;
    if (!tabId || !state.serverEpoch || !state.desktopByTabId[tabId]?.canGoBack || !previewBridge) {
      setReason("This guest has no available previous page. Use Switch to it instead.");
      return;
    }
    const runtimeId = previewRuntimeTabId(threadRef, state.serverEpoch, tabId);
    void previewBridge.goBack(runtimeId).catch(() => {
      setReason("Could not return to the previous page. No session was changed.");
    });
  };

  const closeRedundantSession = async (discardId: string) => {
    const discardRef = chatGPTBrowserThreadRef(environmentId, discardId);
    const preview = readThreadPreviewState(discardRef);
    await Promise.all(
      Object.values(preview.sessions).map((snapshot) =>
        settleMergeBestEffort(
          closePreviewSession({
            closePreview: close,
            snapshot,
            tabId: snapshot.tabId,
            threadRef: discardRef,
          }),
          undefined,
        ),
      ),
    );
  };

  const merge = async () => {
    if (merging) return;
    setMerging(true);
    setReason(null);
    try {
      const latest = readChatGPTBrowserSessions(environmentId);
      const current = latest.find((item) => item.id === sessionId);
      const original = latest.find((item) => item.id === owner.id);
      // A concurrent close already reduced the pair to one session.
      if (!current || !original) {
        const remaining = current ?? original;
        if (remaining) {
          await navigate({
            to: "/browser/$browserSessionId",
            params: { browserSessionId: remaining.id },
          });
        }
        return;
      }

      // Status probes are a preference, never a veto. A broken/unresponsive
      // renderer must not stop an explicitly requested duplicate-URL merge.
      const webviewLoaded = (id: string): Promise<boolean> =>
        Promise.resolve(hasHostedBrowserGuest(chatGPTBrowserThreadRef(environmentId, id)));
      const [currentStatus, originalStatus, currentLoaded, originalLoaded] = await Promise.all([
        settleMergeBestEffort(
          inspectBrowserSession(environmentId, current).then((health) => health.status),
          "unavailable",
        ),
        settleMergeBestEffort(
          inspectBrowserSession(environmentId, original).then((health) => health.status),
          "unavailable",
        ),
        webviewLoaded(current.id),
        webviewLoaded(original.id),
      ]);
      const keepCurrent =
        duplicateMergeHealthRank(currentStatus, currentLoaded) >=
        duplicateMergeHealthRank(originalStatus, originalLoaded);
      const keep = keepCurrent ? current : original;
      const discard = keepCurrent ? original : current;

      // The two entries already identify the same ChatGPT conversation. Even
      // draft inspection failures, uncertain sends, managed bindings and
      // broken guests must not leave two local browser instances behind.
      await closeRedundantSession(discard.id);
      removeSession(discard.id, "sidebar-user-action");
      removeLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, discard.id));
      removeLocalStorageItem(chatGPTBrowserLastWorkingKey(environmentId, discard.id));
      if (keep.hidden) setSessionHidden(keep.id, false);
      if (keep.snoozedUntil !== undefined) setSessionSnooze([keep.id], null);
      await navigate({ to: "/browser/$browserSessionId", params: { browserSessionId: keep.id } });
    } catch (error) {
      setReason(error instanceof Error ? error.message : String(error));
    } finally {
      setMerging(false);
    }
  };
  return (
    <div
      role="alert"
      className="mx-3 mt-2 rounded-md border border-border bg-muted/60 px-3 py-2 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">
          <strong>This conversation is already open as “{owner.title}”.</strong> Merge closes one
          local view, including its unsent draft.
        </span>
        <Button type="button" size="sm" onClick={switchToOwner}>
          Switch to it
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void merge()}
          disabled={merging}
        >
          {merging ? "Merging…" : "Merge"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={goBack}>
          Go back
        </Button>
      </div>
      {reason && (
        <p className="mt-2 text-muted-foreground" aria-live="polite">
          {reason}
        </p>
      )}
    </div>
  );
}
