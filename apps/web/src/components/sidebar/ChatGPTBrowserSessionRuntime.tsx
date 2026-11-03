import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { FILL_PREVIEW_VIEWPORT, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useRef, useState } from "react";

import { isChatGPTHomeUrl } from "../../chatGPTBrowserPrewarm";
import { chatGPTSessionProfileId } from "../../chatGPTAccountProfiles";
import {
  useChatGPTSessionQueueDriver,
  hasAdmittedCapacityMessage,
} from "../../chatGPTSessionMessageQueue";
import { isPersistentChatGPTSessionOptedIn } from "../../browser/persistentChatGPTSessionMode";
import { isChatGPTStartupSessionDeferred } from "../../omniwork/chatGPTStartupLoadPolicy";
import { useWarmChatGPTSessionIds } from "../../omniwork/chatGPTWarmSessionPolicy";
import { resolveWarmChatGPTConversationUrl } from "../../omniwork/chatGPTWarmConversationUrl";
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
  selected = false,
  quiet = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
  readonly suspended: boolean;
  /** The selected conversation always bypasses startup deferral. */
  readonly selected?: boolean;
  readonly quiet?: boolean;
}) {
  const threadRef = useMemo(
    () => chatGPTBrowserThreadRef(environmentId, sessionId),
    [environmentId, sessionId],
  );
  const previewState = useThreadPreviewState(threadRef);
  const warmedIds = useWarmChatGPTSessionIds(environmentId);
  const [capacityAdmitted, setCapacityAdmitted] = useState(() =>
    hasAdmittedCapacityMessage(environmentId, sessionId),
  );
  useEffect(() => {
    const changed = (event: Event) => {
      const data = (event as CustomEvent<{ environmentId: string; sessionId: string }>).detail;
      if (data?.environmentId === environmentId && data.sessionId === sessionId)
        setCapacityAdmitted(hasAdmittedCapacityMessage(environmentId, sessionId));
    };
    const changedQueue = (event: Event) => {
      const key = (event as CustomEvent<string>).detail;
      if (key === `t3code:chatgpt-browser:session-queue:v1:${environmentId}:${sessionId}`)
        setCapacityAdmitted(hasAdmittedCapacityMessage(environmentId, sessionId));
    };
    window.addEventListener("t3:chatgpt-capacity-admitted", changed);
    window.addEventListener("t3:chatgpt-session-queue-change", changedQueue);
    return () => {
      window.removeEventListener("t3:chatgpt-capacity-admitted", changed);
      window.removeEventListener("t3:chatgpt-session-queue-change", changedQueue);
    };
  }, [environmentId, sessionId]);
  // The startup plan uses a plain Set, which cannot trigger a React update.
  // Selection must bypass deferral directly, even when the warm scheduler is full.
  const startupDeferred =
    !capacityAdmitted &&
    !selected &&
    !warmedIds.includes(sessionId) &&
    isChatGPTStartupSessionDeferred(environmentId, sessionId);
  const { sessions, renameSessionFromPageTitle, disqualifyManualEmptyCandidate } =
    useChatGPTBrowserSessions(environmentId);
  useChatGPTSessionQueueDriver(environmentId, sessionId, sessions);
  const observedHomeRef = useRef(false);
  const open = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const close = useAtomCommand(previewEnvironment.close, { reportFailure: false });
  const list = useAtomQueryRunner(previewEnvironment.list, { refresh: true, reportFailure: false });
  const openingRef = useRef(false);
  const startupRetryUsedRef = useRef(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [lastUrl, setLastUrl] = useLocalStorage(
    chatGPTBrowserLastUrlKey(environmentId, sessionId),
    CHATGPT_DEFAULT_URL,
    Schema.String,
  );
  const previewUrl =
    previewState.snapshot?.navStatus._tag === "Success"
      ? previewState.snapshot.navStatus.url
      : null;
  const recoveredUrl = resolveWarmChatGPTConversationUrl(
    sessions.find((session) => session.id === sessionId) ?? { id: sessionId, title: "" },
    lastUrl,
    previewUrl,
  );
  const openUrl =
    recoveredUrl ?? (/^https?:\/\//i.test(lastUrl.trim()) ? lastUrl.trim() : CHATGPT_DEFAULT_URL);

  useEffect(() => {
    if (recoveredUrl && !isChatGPTConversationUrl(lastUrl)) setLastUrl(recoveredUrl);
  }, [lastUrl, recoveredUrl, setLastUrl]);

  const persistentChromium = isPersistentChatGPTSessionOptedIn(sessionId);
  usePreviewSession(threadRef);
  // Restored webviews load their saved URL on attach. Do not eagerly reload
  // every existing session: large sets of ChatGPT tabs can hit rate limits.
  // The recovery coordinator refreshes only confirmed failures, one at a time.

  useEffect(() => {
    // Native Chrome owns its pages outside the preview-tab lifecycle. Never
    // open/close a preview tab for one: its transient Idle/missing snapshot is
    // NOT evidence that the already-live Chrome page needs to load again.
    if (
      persistentChromium ||
      (suspended && !capacityAdmitted) ||
      startupDeferred ||
      openError !== null ||
      openingRef.current
    )
      return;
    const currentSnapshot = previewState.snapshot;
    if (currentSnapshot && (persistentChromium || currentSnapshot.navStatus._tag !== "Idle"))
      return;

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
      if (existingSnapshot && (persistentChromium || existingSnapshot.navStatus._tag !== "Idle"))
        return;

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
        ...(persistentChromium ? {} : { url: openUrl }),
        viewport: FILL_PREVIEW_VIEWPORT,
        profileId: chatGPTSessionProfileId(sessions.find((session) => session.id === sessionId)),
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
    persistentChromium,
    previewState.sessions,
    previewState.snapshot,
    suspended,
    capacityAdmitted,
    startupDeferred,
    threadRef,
  ]);

  // React may report a transient update-depth error while dozens of stored
  // sessions hydrate after desktop startup. Retry that specific failure once
  // after hydration, through the ordinary list-before-open path (never blindly
  // reload an existing guest or discard a draft). Persistent errors keep Retry.
  useEffect(() => {
    if (
      quiet ||
      !openError ||
      startupRetryUsedRef.current ||
      !/Minified React error #185|Maximum update depth exceeded/i.test(openError)
    )
      return;
    const delay =
      3_000 + ([...sessionId].reduce((value, char) => value + char.charCodeAt(0), 0) % 2_000);
    const retry = setTimeout(() => {
      startupRetryUsedRef.current = true;
      setOpenError((current) => (current === openError ? null : current));
    }, delay);
    return () => clearTimeout(retry);
  }, [quiet, openError, sessionId]);

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
    if (currentUrl !== null && isChatGPTHomeUrl(currentUrl)) {
      observedHomeRef.current = true;
    } else if (
      (currentUrl !== null && !isChatGPTHomeUrl(currentUrl)) ||
      (observedHomeRef.current &&
        (navStatus?._tag === "Loading" || navStatus?._tag === "LoadFailed"))
    ) {
      // Once this guest navigates away from its pristine home, future returns
      // to home cannot prove that no send or navigation attempt ever occurred.
      disqualifyManualEmptyCandidate(sessionId);
    }
  }, [currentUrl, navStatus?._tag, disqualifyManualEmptyCandidate, sessionId]);
  useEffect(() => {
    if (isChatGPTConversationUrl(currentUrl)) renameSessionFromPageTitle(sessionId, currentTitle);
  }, [currentTitle, currentUrl, renameSessionFromPageTitle, sessionId]);
  useEffect(() => {
    // A failed/offline conversation load can redirect the guest to ChatGPT's
    // homepage. Never replace the durable conversation reference with that
    // transient URL: otherwise every following T3 restart loses the session.
    if (currentUrl !== null && isChatGPTConversationUrl(currentUrl) && currentUrl !== lastUrl)
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
