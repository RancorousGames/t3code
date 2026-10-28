import { type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useState } from "react";

import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import {
  chatGPTBrowserLastUrlKey,
  chatGPTBrowserThreadRef,
  readChatGPTBrowserSessions,
  useChatGPTBrowserSessions,
} from "../../chatGPTBrowserSessions";
import {
  findDuplicateChatGPTConversationOwner,
  refuseChatGPTConversationMove,
} from "../../chatGPTDuplicateConversationGuard";
import { hasDurableUnknownChatGPTSend } from "../../chatGPTUncertainSendFence";
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

/**
 * Navigating *inside* a ChatGPT guest bypasses the T3 open-conversation reuse
 * path. Show the conflict here, never silently close or swap a session owner.
 */
export function ChatGPTDuplicateConversationBanner({
  environmentId,
  sessionId,
}: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
}) {
  const navigate = useNavigate();
  const threadRef = useMemo(
    () => chatGPTBrowserThreadRef(environmentId, sessionId),
    [environmentId, sessionId],
  );
  const state = useThreadPreviewState(threadRef);
  const { sessions, setSessionHidden, setSessionSnooze } = useChatGPTBrowserSessions(environmentId);
  const nav = state.snapshot?.navStatus;
  const observedUrl = nav?._tag === "Success" ? nav.url : null;
  const owner = findDuplicateChatGPTConversationOwner(sessions, sessionId, observedUrl, (id) =>
    lastKnownConversationUrl(environmentId, id),
  );
  const [reason, setReason] = useState<string | null>(null);
  useEffect(() => setReason(null), [observedUrl, owner?.id]);

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

  const refuseMove = () => {
    if (!stillOwned()) {
      setReason("The original session changed. No session was closed.");
      return;
    }
    setReason(refuseChatGPTConversationMove(hasDurableUnknownChatGPTSend(environmentId, owner.id)));
  };

  return (
    <div
      role="alert"
      className="mx-3 mt-2 rounded-md border border-border bg-muted/60 px-3 py-2 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">
          <strong>This conversation is already open as “{owner.title}”.</strong> Two T3 sessions on
          one conversation can conflict over drafts and recovery.
        </span>
        <Button type="button" size="sm" onClick={switchToOwner}>
          Switch to it
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={refuseMove}>
          Move it here, close the other
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
