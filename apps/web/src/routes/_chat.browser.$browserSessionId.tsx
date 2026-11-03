import { type EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { openChatGPTGuestByUser } from "../browser/chatGPTGuestHibernation";
import { previewRuntimeTabId } from "../browser/previewRuntimeTabId";

import { PreviewView } from "../components/preview/PreviewView";
import { DedicatedChatGPTBrowser } from "../browser/DedicatedChatGPTBrowser";
import { isPersistentChatGPTSessionOptedIn } from "../browser/persistentChatGPTSessionMode";
import { ChatGPTSessionCockpit } from "../components/ChatGPTSessionCockpit";
import { Button } from "../components/ui/button";
import {
  resolveChatGPTView,
  useChatGPTDefaultView,
  useChatGPTSessionViewOverride,
} from "../chatGPTSessionViewPreferences";
import { readThreadPreviewState, useThreadPreviewState } from "../previewStateStore";
import { ChatGPTBrowserFindBar } from "../components/browser/ChatGPTBrowserFindBar";
import { ChatGPTDuplicateConversationBanner } from "../components/browser/ChatGPTDuplicateConversationBanner";
import {
  CHATGPT_DEFAULT_URL,
  chatGPTBrowserThreadRef,
  useChatGPTBrowserSessions,
} from "../chatGPTBrowserSessions";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { usePrimaryEnvironmentId } from "../state/environments";

function ChatGPTBrowserRoute() {
  const environmentId = usePrimaryEnvironmentId();
  const { browserSessionId } = Route.useParams();
  const { sessions } = useChatGPTBrowserSessions(environmentId);
  const session = sessions.find((entry) => entry.id === browserSessionId);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron} className="border-b border-border">
        <span className="text-sm font-medium text-muted-foreground">T3 Code</span>
      </WorkspacePageHeader>
      {!isElectron ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          The integrated browser is available in the desktop app.
        </div>
      ) : environmentId && session && !session.hidden ? (
        <ChatGPTBrowserView
          key={`${environmentId}:${session.id}`}
          environmentId={environmentId}
          sessionId={session.id}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {environmentId
            ? session?.hidden
              ? "This browser session is hidden. Restore it from Hidden sessions."
              : "This browser session has been closed."
            : "Connect an environment to open the browser."}
        </div>
      )}
    </SidebarInset>
  );
}

function ChatGPTBrowserView({
  environmentId,
  sessionId,
}: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
}) {
  const threadRef = useMemo(
    () => chatGPTBrowserThreadRef(environmentId, sessionId),
    [environmentId, sessionId],
  );
  const [defaultView] = useChatGPTDefaultView();
  const [override, setOverride] = useChatGPTSessionViewOverride(environmentId, sessionId);
  const preview = useThreadPreviewState(threadRef);
  // Apply the configured default once, then lock each session's own selection.
  // Agent replies, page navigation and login observations never change the view.
  useEffect(() => {
    if (override === "default") setOverride(defaultView);
  }, [defaultView, override, setOverride]);
  const view = resolveChatGPTView(defaultView, override);
  const persistentChromium = isPersistentChatGPTSessionOptedIn(sessionId);

  // Session view can render the SQLite transcript without a browser guest.
  // Only an explicit Browser selection/composer request wakes a cold page.
  // The existing background warm scheduler independently restores guests.
  useEffect(() => {
    const key = JSON.stringify([environmentId, threadRef.threadId]);
    const wakeOnClick = (event: Event) => {
      if ((event as CustomEvent<string>).detail === sessionId) openChatGPTGuestByUser(key);
    };
    if (view === "browser") openChatGPTGuestByUser(key);
    window.addEventListener("t3:focus-chatgpt-composer", wakeOnClick);
    return () => window.removeEventListener("t3:focus-chatgpt-composer", wakeOnClick);
  }, [environmentId, threadRef, sessionId, view]);
  useEffect(() => {
    if (view !== "session" || !preview.activeTabId) return;
    // An explicit Session selection deserves a fresh read immediately rather
    // than displaying a stale send gate until the next background heartbeat.
    window.dispatchEvent(
      new CustomEvent("t3:chatgpt-page-push", {
        detail: {
          runtimeTabId: previewRuntimeTabId(threadRef, preview.serverEpoch, preview.activeTabId),
        },
      }),
    );
  }, [view, threadRef, preview.activeTabId, preview.serverEpoch]);
  useEffect(() => {
    if (view !== "browser" || persistentChromium) return;
    let cancelled = false;
    let focused = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    // Focus only the selected ChatGPT guest, not a background or previously selected session.
    const focus = () => {
      for (const delay of [0, 120, 350, 800, 1500]) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (cancelled || focused || !window.location.pathname.includes(sessionId)) return;
          const state = readThreadPreviewState(threadRef);
          const tabId = state.snapshot?.tabId;
          if (!tabId) return;
          const runtimeTabId = previewRuntimeTabId(threadRef, state.serverEpoch, tabId);
          const guest = Array.from(document.querySelectorAll("webview")).find(
            (node) => node.dataset.previewTab === runtimeTabId,
          );
          if (!guest || typeof guest.executeJavaScript !== "function") return;
          guest.focus();
          void guest
            .executeJavaScript(`(() => {
            const editor = document.querySelector('#prompt-textarea,[data-testid="prompt-textarea"],[data-testid="composer-input"],form textarea,[contenteditable="true"][role="textbox"]');
            if (!editor || !(editor instanceof HTMLElement) || editor.getAttribute('contenteditable') === 'false') return false;
            editor.focus({preventScroll:true});
            return document.activeElement === editor;
          })()`)
            .then((ok: unknown) => {
              if (!cancelled && ok === true) focused = true;
            })
            .catch(() => {});
        }, delay);
        timers.add(timer);
      }
    };
    const onRequest = (event: Event) => {
      if ((event as CustomEvent<string>).detail === sessionId) {
        focused = false;
        focus();
      }
    };
    window.addEventListener("t3:focus-chatgpt-composer", onRequest);
    focus();
    return () => {
      cancelled = true;
      window.removeEventListener("t3:focus-chatgpt-composer", onRequest);
      for (const timer of timers) clearTimeout(timer);
    };
  }, [threadRef, sessionId, view, persistentChromium]);
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        !event.shiftKey ||
        event.altKey ||
        event.key.toLowerCase() !== "b"
      )
        return;
      event.preventDefault();
      setOverride(view === "browser" ? "session" : "browser");
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, [view, setOverride]);

  const viewSwitcher = (
    <>
      <Button
        size="xs"
        variant={view === "session" ? "secondary" : "ghost"}
        onClick={() => setOverride("session")}
        title="Session view (Ctrl+Shift+B)"
      >
        Session
      </Button>
      <Button
        size="xs"
        variant={view === "browser" ? "secondary" : "ghost"}
        onClick={() => setOverride("browser")}
        title="Browser view (Ctrl+Shift+B)"
      >
        Browser
      </Button>
    </>
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <ChatGPTDuplicateConversationBanner environmentId={environmentId} sessionId={sessionId} />
      {/* Native WebContentsView draws above React: the switcher belongs in the
          Chromium toolbar, not over the browser pixels or in a second row. */}
      {!(persistentChromium && view === "browser") && (
        <div className="flex shrink-0 justify-end gap-1 border-b border-border bg-background px-3 py-1">
          {viewSwitcher}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {persistentChromium ? (
          view === "browser" ? (
            <DedicatedChatGPTBrowser
              environmentId={environmentId}
              sessionId={sessionId}
              toolbarActions={viewSwitcher}
            />
          ) : null
        ) : (
          <PreviewView
            threadRef={threadRef}
            visible={view === "browser"}
            configuredUrls={[CHATGPT_DEFAULT_URL]}
          />
        )}
        {view === "session" && (
          <ChatGPTSessionCockpit
            environmentId={environmentId}
            sessionId={sessionId}
            onShowBrowser={() => setOverride("browser")}
          />
        )}
      </div>
      {view === "browser" && !persistentChromium && <ChatGPTBrowserFindBar threadRef={threadRef} />}
    </div>
  );
}

export const Route = createFileRoute("/_chat/browser/$browserSessionId")({
  component: ChatGPTBrowserRoute,
});
