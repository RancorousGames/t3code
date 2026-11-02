import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  type DesktopPreviewBridge,
  type EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { useEffect, useMemo } from "react";

import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { chatGPTBrowserLastUrlKey, readChatGPTBrowserSessions } from "~/chatGPTBrowserSessions";
import { getChatGPTSessionPersistedStore } from "~/chatGPTSessionPersistedStore";
import { getLocalStorageItem } from "~/hooks/useLocalStorage";
import { resolveChatGPTGuestAttachUrl } from "./chatGPTGuestAttachUrl";

import { isElectron } from "~/env";
import { useDesktopHostedPreviewSessions } from "~/components/preview/usePreviewSession";
import {
  type ThreadPreviewState,
  useActivePreviewSessions,
} from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";

import { readPreviewAnnotationTheme } from "./annotationTheme";
import { useBrowserPointerStore } from "./browserPointerStore";
import { useAtomCommand } from "~/state/use-atom-command";
import { AuthorizedBrowserWebview } from "./ChatGPTGuestWebviewGate";
import { isPersistentChatGPTSessionOptedIn } from "./persistentChatGPTSessionMode";
import { shouldOpenChatGPTLinkInDefaultBrowser } from "./chatGPTExternalLinkRouting";
import { useChatGPTSmartLinks } from "./chatGPTSmartLinks";
import { openUrlInPreview } from "./openFileInPreview";
import { rendersServerTabNatively } from "./previewRuntime";
import { previewRuntimeTabId } from "./previewRuntimeTabId";

/** Every session this window renders as a hosted webview, in a fixed (non-display) order. */
function hostedBrowserSessions(
  previewByThreadKey: Record<string, ThreadPreviewState>,
  primaryEnvironmentId: EnvironmentId | null,
) {
  const activeSessions = Object.entries(previewByThreadKey).flatMap(([threadKey, previewState]) => {
    const threadRef = parseScopedThreadKey(threadKey);
    return threadRef
      ? Object.values(previewState.sessions)
          .filter(
            (snapshot) =>
              snapshot.runtime !== "server" ||
              rendersServerTabNatively(threadRef.environmentId, primaryEnvironmentId, snapshot),
          )
          .map((snapshot) => ({
            threadRef,
            snapshot,
            runtimeTabId: previewRuntimeTabId(threadRef, previewState.serverEpoch, snapshot.tabId),
            pictureInPicture:
              previewState.desktopByTabId[snapshot.tabId]?.pictureInPicture ?? false,
            zoomFactor: previewState.desktopByTabId[snapshot.tabId]?.zoomFactor ?? 1,
          }))
      : [];
  });
  // Electron destroys a moved webview's guest, so the render order must not follow the server's
  // updatedAt order. Any fixed order works; this one is not a display order.
  return activeSessions.toSorted((left, right) =>
    left.runtimeTabId < right.runtimeTabId ? -1 : left.runtimeTabId > right.runtimeTabId ? 1 : 0,
  );
}

function startAnnotationThemeSync(preview: DesktopPreviewBridge): () => void {
  let lastSerializedTheme = "";
  const syncTheme = () => {
    const theme = readPreviewAnnotationTheme();
    const serializedTheme = JSON.stringify(theme);
    if (serializedTheme === lastSerializedTheme) return;
    lastSerializedTheme = serializedTheme;
    void preview.setAnnotationTheme(theme).catch(() => {
      lastSerializedTheme = "";
    });
  };
  // App services start before the first paint, when the theme styles may not be applied yet.
  const frameId = window.requestAnimationFrame(syncTheme);
  const observer = new MutationObserver(syncTheme);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  const headObserver = new MutationObserver(syncTheme);
  headObserver.observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  return () => {
    window.cancelAnimationFrame(frameId);
    observer.disconnect();
    headObserver.disconnect();
  };
}

/** App-lifetime listeners for the desktop preview bridge: annotation theme, agent pointer, links. */
export function startElectronBrowserHost(): () => void {
  const preview = window.desktopBridge?.preview;
  if (!preview) return () => {};
  const disposers = [
    startAnnotationThemeSync(preview),
    preview.onPointerEvent((event) => {
      useBrowserPointerStore.getState().apply(event);
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
// Preserve the previous public re-export.
export { shouldOpenChatGPTLinkInDefaultBrowser } from "./chatGPTExternalLinkRouting";

export function ElectronBrowserHost() {
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const openSmartLink = useChatGPTSmartLinks(primaryEnvironmentId);
  const previewByThreadKey = useActivePreviewSessions();
  useDesktopHostedPreviewSessions(primaryEnvironmentId);
  const sessions = useMemo(
    () => hostedBrowserSessions(previewByThreadKey, primaryEnvironmentId),
    [previewByThreadKey, primaryEnvironmentId],
  );
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: true });
  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    return preview.onOpenLink(({ tabId, url, sourceUrl, background }) => {
      const source = sessions.find((session) => session.runtimeTabId === tabId);
      if (!source) return;
      void (async () => {
        if (
          source.threadRef.threadId.startsWith("t3-browser-session:") &&
          (await openSmartLink(url))
        ) return;
        if (
          shouldOpenChatGPTLinkInDefaultBrowser(
            source.threadRef.threadId,
            sourceUrl ??
              (source.snapshot.navStatus._tag === "Idle" ? null : source.snapshot.navStatus.url),
            url,
          )
        ) {
          await window.desktopBridge?.openExternal(url);
          return;
        }
        await openUrlInPreview({
          threadRef: source.threadRef,
          url,
          openPreview,
          profileId: source.snapshot.profileId,
          background,
        });
      })().catch((error: unknown) => {
        console.error("Could not open ChatGPT smart link:", error);
      });
    });
  }, [sessions, openPreview, openSmartLink]);

  if (!isElectron) return null;
  return (
    <div className="contents" data-electron-browser-host>
      {sessions
        .filter(({ threadRef }) => {
          // ChatGPT has its own Chromium surface in the ChatGPT route. Generic
          // preview slots must not create duplicate guests or hide an Idle page.
          const prefix = "t3-browser-session:";
          return (
            !threadRef.threadId.startsWith(prefix) ||
            !isPersistentChatGPTSessionOptedIn(threadRef.threadId.slice(prefix.length))
          );
        })
        .map(({ threadRef, snapshot, runtimeTabId, pictureInPicture, zoomFactor }) => {
          const previewUrl = snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
          // Reconstruct an existing ChatGPT conversation only for a *newly attached*
          // guest whose server-side preview still points at a transient homepage.
          // Never navigate an already-mounted guest, which may hold an unsent draft.
          const prefix = "t3-browser-session:";
          const sessionId = threadRef.threadId.startsWith(prefix)
            ? threadRef.threadId.slice(prefix.length)
            : null;
          const owner = sessionId
            ? readChatGPTBrowserSessions(threadRef.environmentId).find(
                (entry) => entry.id === sessionId,
              )
            : undefined;
          const savedUrl = sessionId
            ? getLocalStorageItem(
                chatGPTBrowserLastUrlKey(threadRef.environmentId, sessionId),
                Schema.String,
              )
            : null;
          const observed = sessionId
            ? getChatGPTSessionPersistedStore(threadRef.environmentId).getState().snapshots[
                sessionId
              ]
            : null;
          const observedId =
            observed &&
            typeof observed === "object" &&
            "conversationId" in observed &&
            typeof observed.conversationId === "string"
              ? observed.conversationId
              : null;
          const url = sessionId
            ? resolveChatGPTGuestAttachUrl(owner, savedUrl, previewUrl, observedId)
            : previewUrl;
          return (
            <AuthorizedBrowserWebview
              key={runtimeTabId}
              threadRef={threadRef}
              tabId={snapshot.tabId}
              runtimeTabId={runtimeTabId}
              initialUrl={url}
              viewport={snapshot.viewport ?? FILL_PREVIEW_VIEWPORT}
              pictureInPicture={pictureInPicture}
              profileId={snapshot.profileId}
              zoomFactor={zoomFactor}
              serverDriven={snapshot.runtime === "server"}
              {...(snapshot.runtime === "server"
                ? {
                    serverRendering: {
                      colorScheme: snapshot.colorScheme ?? "system",
                      zoomFactor: snapshot.zoomFactor ?? 1,
                    },
                  }
                : {})}
            />
          );
        })}
    </div>
  );
}
