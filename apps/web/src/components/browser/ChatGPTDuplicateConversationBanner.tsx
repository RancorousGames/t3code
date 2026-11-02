import { type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useState } from "react";
import { chatGPTConversationIdFromUrl } from "../../chatGPTConversationIdentity";
import { chatGPTSessionProfileId } from "../../chatGPTAccountProfiles";
import {
  CHATGPT_COMPOSER_PROBE_EXPRESSION,
  sameComposerProbe,
  type ComposerProbe,
} from "../../chatGPTDraftInspection";
import { chatGPTWebviewAutomation } from "../../chatGPTWebviewAutomation";
import { inspectBrowserSession, hasUncertainChatGPTSend } from "../../chatGPTSessionControl";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { closePreviewSession } from "../preview/closePreviewSession";
import { readThreadPreviewState } from "../../previewStateStore";
import { removeLocalStorageItem } from "../../hooks/useLocalStorage";

import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import { hasHostedBrowserGuest } from "../../browser/hostedBrowserGuestPresence";
import { isPersistentChatGPTSessionOptedIn } from "../../browser/persistentChatGPTSessionMode";
import { nativeChatGPTResidency } from "../../browser/nativeChatGPTWarmSession";
import { inspectPersistentChatGPTPage } from "../../browser/inspectPersistentChatGPTPage";
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
  const close = useAtomCommand(previewEnvironment.close);
  const threadRef = useMemo(
    () => chatGPTBrowserThreadRef(environmentId, sessionId),
    [environmentId, sessionId],
  );
  const state = useThreadPreviewState(threadRef);
  const { sessions, setSessionHidden, setSessionSnooze, removeSession } =
    useChatGPTBrowserSessions(environmentId);
  const nav = state.snapshot?.navStatus;
  const [nativeUrl, setNativeUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!isPersistentChatGPTSessionOptedIn(sessionId)) return;
    const bridge = window.desktopBridge?.stableChatGPTViewRequest;
    if (!bridge) return;
    let disposed = false;
    const read = async () => {
      try {
        const result = (await bridge({ operation: "snapshot", identity: {
          environmentId, sessionId, profileId: chatGPTSessionProfileId(readChatGPTBrowserSessions(environmentId).find((entry) => entry.id === sessionId)),
        } })) as { url?: string; destroyed?: boolean };
        if (!disposed) setNativeUrl(!result.destroyed ? result.url ?? null : null);
      } catch {
        if (!disposed) setNativeUrl(null);
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 2_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [environmentId, sessionId]);
  const observedUrl = isPersistentChatGPTSessionOptedIn(sessionId)
    ? nativeUrl
    : nav?._tag === "Success" ? nav.url : null;
  const owner = findDuplicateChatGPTConversationOwner(sessions, sessionId, observedUrl, (id) =>
    lastKnownConversationUrl(environmentId, id),
  );
  const [reason, setReason] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  // Do not erase an actionable merge error when health/navigation updates arrive.
  useEffect(() => setReason(null), [sessionId]);

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
    if (isPersistentChatGPTSessionOptedIn(sessionId)) {
      const bridge = window.desktopBridge?.stableChatGPTViewRequest;
      if (!bridge) { setReason("Native Chromium browser unavailable."); return; }
      const identity = { environmentId, sessionId, profileId: chatGPTSessionProfileId(sessions.find((entry) => entry.id === sessionId)) };
      void bridge({ operation: "snapshot", identity }).then(async (result) => {
        const snapshot = result as { canGoBack?: boolean };
        if (!snapshot.canGoBack) {
          setReason("This native page has no previous history.");
          return;
        }
        await bridge({ operation: "back", identity });
      }).catch(() => setReason("Could not navigate back in the exact native browser."));
      return;
    }
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

  const closeRedundantSession = async (
    discardId: string,
    status: string,
    conversationId: string,
  ) => {
    const discardRef = chatGPTBrowserThreadRef(environmentId, discardId);
    if (isPersistentChatGPTSessionOptedIn(discardId)) {
      const bridge = window.desktopBridge?.stableChatGPTViewRequest;
      if (!bridge) throw new Error("Merge paused: native Chromium bridge unavailable.");
      const residency = await nativeChatGPTResidency(bridge, environmentId, discardId);
      if (residency === "unknown")
        throw new Error("Merge paused: native owner state is uncertain.");
      if (residency === "resident") {
        if (["working", "pending_or_stalled", "stuck_connecting"].includes(status))
          throw new Error("Merge paused: redundant native page may be generating.");
        const identity = { environmentId, sessionId: discardId, profileId: chatGPTSessionProfileId(sessions.find((entry) => entry.id === discardId)) };
        const snapshot = (await bridge({ operation: "snapshot", identity })) as { url?: string };
        if (chatGPTConversationIdFromUrl(snapshot.url ?? null) !== conversationId)
          throw new Error("Merge paused: native duplicate navigated to another conversation.");
        const first = await inspectPersistentChatGPTPage<ComposerProbe>(
          environmentId, discardId, CHATGPT_COMPOSER_PROBE_EXPRESSION,
        );
        const second = await inspectPersistentChatGPTPage<ComposerProbe>(
          environmentId, discardId, CHATGPT_COMPOSER_PROBE_EXPRESSION,
        );
        if (!first || !second || !sameComposerProbe(first, second) ||
            first.status !== "empty" || first.url !== snapshot.url)
          throw new Error("Merge paused: native duplicate draft is not verified empty.");
        const attachments = await inspectPersistentChatGPTPage<boolean>(
          environmentId, discardId, `(() => {
            const editor = document.querySelector('#prompt-textarea,[data-testid="prompt-textarea"],[data-testid="composer-input"]');
            const form = editor?.closest('form');
            if (!form) return null;
            return Boolean(form.querySelector('[data-testid*="attachment"],[data-testid*="upload"],[aria-label^="Remove file"],[aria-label^="Remove attachment"]') ||
              Array.from(form.querySelectorAll('input[type="file"]')).some(input => input.files?.length));
          })()`,
        );
        if (attachments !== false) throw new Error("Merge paused: native duplicate has unverified attachments.");
        const after = (await bridge({ operation: "snapshot", identity })) as { url?: string };
        if (after.url !== snapshot.url || hasUncertainChatGPTSend(environmentId, discardId))
          throw new Error("Merge paused: native duplicate changed during verification.");
        // Close only the confirmed redundant owner, preserving its original.
        await bridge({ operation: "close", identity });
      }
      return;
    }
    const preview = readThreadPreviewState(discardRef);
    const tabId = preview.activeTabId;
    const loaded = hasHostedBrowserGuest(discardRef);
    // A failed renderer cannot expose a composer. Unresolved deliveries and
    // managed ownership were checked separately before retiring such a guest.
    if (loaded && !["unavailable", "stuck"].includes(status)) {
      if (!tabId || !preview.serverEpoch) {
        throw new Error("Cannot inspect the redundant session's draft. No session was closed.");
      }
      const runtimeId = previewRuntimeTabId(discardRef, preview.serverEpoch, tabId);
      const first = (await chatGPTWebviewAutomation.evaluate(runtimeId, {
        expression: CHATGPT_COMPOSER_PROBE_EXPRESSION,
      })) as ComposerProbe;
      const second = (await chatGPTWebviewAutomation.evaluate(runtimeId, {
        expression: CHATGPT_COMPOSER_PROBE_EXPRESSION,
      })) as ComposerProbe;
      if (
        !sameComposerProbe(first, second) ||
        first.status !== "empty" ||
        chatGPTConversationIdFromUrl(first.url) !== conversationId
      ) {
        throw new Error(
          "Merge paused: the redundant session has a draft or its composer cannot be verified empty.",
        );
      }
      const attachments = await chatGPTWebviewAutomation.evaluate(runtimeId, {
        expression: `(() => {
          const editor = document.querySelector('#prompt-textarea,[data-testid="prompt-textarea"],[data-testid="composer-input"]');
          const form = editor?.closest('form');
          if (!form) return null;
          return Boolean(form.querySelector('[data-testid*="attachment"],[data-testid*="upload"],[aria-label^="Remove file"],[aria-label^="Remove attachment"]') ||
            Array.from(form.querySelectorAll('input[type="file"]')).some(input => input.files?.length));
        })()`,
      });
      if (attachments !== false) {
        throw new Error(
          "Merge paused: attachments or an unverified draft are present in the redundant session.",
        );
      }
    } else if (!loaded && !["hibernated", "unloaded", "loading", "hidden", "unavailable", "stuck"].includes(status)) {
      throw new Error("Merge paused: the redundant session is not safely unloaded.");
    }
    const results = await Promise.all(
      Object.values(preview.sessions).map((snapshot) =>
        closePreviewSession({
          closePreview: close,
          snapshot,
          tabId: snapshot.tabId,
          threadRef: discardRef,
        }),
      ),
    );
    if (results.some((result) => result._tag === "Failure")) {
      throw new Error("Could not close the redundant browser. Both session records were kept.");
    }
  };

  const merge = async () => {
    if (merging) return;
    setMerging(true);
    setReason(null);
    try {
      if (!stillOwned()) throw new Error("The duplicate ownership changed. Nothing was closed.");
      const latest = readChatGPTBrowserSessions(environmentId);
      const current = latest.find((item) => item.id === sessionId);
      const original = latest.find((item) => item.id === owner.id);
      if (!current || !original) throw new Error("A session disappeared. Nothing was closed.");
      const [currentHealth, originalHealth] = await Promise.all([
        inspectBrowserSession(environmentId, current),
        inspectBrowserSession(environmentId, original),
      ]);
      // An unmounted guest reports 'loading' or 'unavailable' even when its
      // persisted conversation is valid. Treat it as unloaded, without waking
      // it merely to decide a merge. This makes first-click Merge symmetric.
      const nativeLoaded = async (id: string) => {
        if (!isPersistentChatGPTSessionOptedIn(id))
          return hasHostedBrowserGuest(chatGPTBrowserThreadRef(environmentId, id));
        const bridge = window.desktopBridge?.stableChatGPTViewRequest;
        if (!bridge) throw new Error("Cannot inspect native owner before merge.");
        const state = await nativeChatGPTResidency(bridge, environmentId, id);
        if (state === "unknown") throw new Error("Native owner state uncertain; refusing merge.");
        return state === "resident";
      };
      const [currentLoaded, originalLoaded] = await Promise.all([
        nativeLoaded(current.id), nativeLoaded(original.id),
      ]);
      const rank = (id: string, status: string) =>
        duplicateMergeHealthRank(
          !(id === current.id ? currentLoaded : originalLoaded) ? "unloaded" : status,
        );
      const keepCurrent = rank(current.id, currentHealth.status) >
        rank(original.id, originalHealth.status);
      const keep = keepCurrent ? current : original;
      const discard = keepCurrent ? original : current;
      const discardedHealth = keepCurrent ? originalHealth : currentHealth;
      if (!stillOwned()) throw new Error("The conversation owner changed. Nothing was closed.");
      const conversationId = chatGPTConversationIdFromUrl(observedUrl);
      const observedIdentity = (id: string, url: string | null) =>
        chatGPTConversationIdFromUrl(url) ??
        chatGPTConversationIdFromUrl(lastKnownConversationUrl(environmentId, id));
      if (
        !conversationId ||
        observedIdentity(current.id, currentHealth.observedGuestUrl ?? currentHealth.url) !==
          conversationId ||
        observedIdentity(original.id, originalHealth.observedGuestUrl ?? originalHealth.url) !==
          conversationId
      ) {
        throw new Error("Could not verify both sessions belong to the same conversation.");
      }
      if (hasUncertainChatGPTSend(environmentId, discard.id)) {
        throw new Error(
          "Merge paused: the redundant session has an unresolved message delivery. Its evidence must be preserved.",
        );
      }
      if (
        discard.binding ||
        discard.spawnRequestId ||
        discard.bootstrapIdentity?.state === "registered" ||
        latest.some((item) => item.parentSessionId === discard.id)
      ) {
        throw new Error(
          "Merge paused: the redundant session owns a managed seat, spawn or child sessions.",
        );
      }
      if (["working", "pending_or_stalled", "stuck_connecting"].includes(discardedHealth.status)) {
        throw new Error("Merge paused: the redundant session may still be processing a message.");
      }
      await closeRedundantSession(discard.id, discardedHealth.status, conversationId);
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
          <strong>This conversation is already open as “{owner.title}”.</strong> Two T3 sessions on
          one conversation can conflict over drafts and recovery.
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
