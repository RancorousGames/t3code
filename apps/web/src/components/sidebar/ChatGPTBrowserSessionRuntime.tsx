import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  FILL_PREVIEW_VIEWPORT,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  CHATGPT_DEFAULT_URL,
  chatGPTBrowserLastUrlKey,
  chatGPTBrowserThreadRef,
  isChatGPTConversationUrl,
  useChatGPTBrowserSessions,
} from "../../chatGPTBrowserSessions";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  useThreadPreviewState,
} from "../../previewStateStore";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";

import { closePreviewSession } from "../preview/closePreviewSession";
import { openPreviewSession } from "../preview/openPreviewSession";
import { usePreviewSession } from "../preview/usePreviewSession";
import { Button } from "../ui/button";

// Keep non-hidden sessions loaded even while a different page is selected.
export function ChatGPTBrowserSessionRuntime({
  environmentId,
  sessionId,
  suspended,
  quiet = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
  readonly suspended: boolean;
  readonly quiet?: boolean;
}) {
  const threadRef = useMemo(
    () => chatGPTBrowserThreadRef(environmentId, sessionId),
    [environmentId, sessionId],
  );
  const previewState = useThreadPreviewState(threadRef);
  const { renameSessionFromPageTitle } = useChatGPTBrowserSessions(environmentId);
  const open = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const close = useAtomCommand(previewEnvironment.close, { reportFailure: false });
  const list = useAtomQueryRunner(previewEnvironment.list, { refresh: true, reportFailure: false });
  const openingRef = useRef(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [lastUrl, setLastUrl] = useLocalStorage(
    chatGPTBrowserLastUrlKey(environmentId, sessionId),
    CHATGPT_DEFAULT_URL,
    Schema.String,
  );
  const openUrl = /^https?:\/\//i.test(lastUrl.trim()) ? lastUrl.trim() : CHATGPT_DEFAULT_URL;

  usePreviewSession(threadRef);
  // Restored webviews load their saved URL on attach. Do not eagerly reload
  // every existing session: large sets of ChatGPT tabs can hit rate limits.
  // The recovery coordinator refreshes only confirmed failures, one at a time.

  useEffect(() => {
    if (suspended || openError !== null || openingRef.current) return;

    const currentSnapshot = previewState.snapshot;
    if (currentSnapshot && currentSnapshot.navStatus._tag !== "Idle") return;

    // Reconciliation can briefly know about tabs before choosing an active one.
    if (!currentSnapshot && Object.keys(previewState.sessions).length > 0) return;

    openingRef.current = true;
    void (async () => {
      // Explicitly fetch the list: an empty owner has no preview events to bootstrap it.
      const listed = await list({ environmentId, input: { threadId: threadRef.threadId } });
      if (listed._tag === "Failure") {
        const error = squashAtomCommandFailure(listed);
        setOpenError(error instanceof Error ? error.message : "Unable to load ChatGPT sessions.");
        return;
      }
      reconcilePreviewServerSessions(threadRef, listed.value);
      const existingSnapshot = readThreadPreviewState(threadRef).snapshot;
      if (existingSnapshot && existingSnapshot.navStatus._tag !== "Idle") return;

      // An Idle preview renders T3's generic local-server page. Replace it
      // instead of trying to navigate that already-mounted blank webview.
      if (existingSnapshot) {
        await closePreviewSession({
          closePreview: close,
          snapshot: existingSnapshot,
          tabId: existingSnapshot.tabId,
          threadRef,
        });
      }

      const result = await openPreviewSession({
        openPreview: open,
        threadRef,
        url: openUrl,
        viewport: FILL_PREVIEW_VIEWPORT,
        profileId: DEFAULT_BROWSER_PROFILE_ID,
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        setOpenError(error instanceof Error ? error.message : "Unable to open ChatGPT.");
      }
    })()
      .catch((error: unknown) => {
        setOpenError(error instanceof Error ? error.message : "Unable to open ChatGPT.");
      })
      .finally(() => {
        openingRef.current = false;
      });
  }, [
    close,
    open,
    list,
    environmentId,
    openError,
    openUrl,
    previewState.sessions,
    previewState.snapshot,
    suspended,
    threadRef,
  ]);

  // The offscreen spare has no user-facing retry button. Retry a failed open
  // conservatively without rendering error UI over the workspace.
  useEffect(() => {
    if (!quiet || !openError) return;
    const retry = setTimeout(() => setOpenError(null), 15_000);
    return () => clearTimeout(retry);
  }, [quiet, openError]);

  const navStatus = previewState.snapshot?.navStatus;
  const currentUrl = navStatus?._tag === "Success" ? navStatus.url : null;
  const currentTitle = navStatus?._tag === "Success" ? navStatus.title : null;
  useEffect(() => {
    if (isChatGPTConversationUrl(currentUrl)) renameSessionFromPageTitle(sessionId, currentTitle);
  }, [currentTitle, currentUrl, renameSessionFromPageTitle, sessionId]);
  useEffect(() => {
    if (currentUrl && /^https?:\/\//i.test(currentUrl) && currentUrl !== lastUrl)
      setLastUrl(currentUrl);
  }, [currentUrl, lastUrl, setLastUrl]);

  if (!openError || quiet) return null;
  return (
    <div role="alert" className="px-2 text-xs text-muted-foreground">
      <span>{openError}</span>
      <Button size="sm" variant="ghost" onClick={() => setOpenError(null)}>
        Retry
      </Button>
    </div>
  );
}
