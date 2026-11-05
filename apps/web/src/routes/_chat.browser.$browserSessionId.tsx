import { type EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { clearChatGPTGuestUserOpened, openChatGPTGuestByUser } from "../browser/chatGPTGuestHibernation";
import { closeLeaf, readSplitLayout, reconcileSplitLayout, replaceLeaf, saveSplitLayout, splitLeaf, splitSessionIds, useSplitLayout, type SplitNode } from "../chatGPTSplitLayout";
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
  const { sessions, createSession } = useChatGPTBrowserSessions(environmentId);
  const navigate = useNavigate();
  const layout = useSplitLayout(environmentId);
  const session = sessions.find((entry) => entry.id === browserSessionId);
  const available = useMemo(() => new Set(sessions.filter((s) => !s.hidden).map((s) => s.id)), [sessions]);
  useEffect(() => {
    if (environmentId && available.has(browserSessionId))
      reconcileSplitLayout(environmentId, available, browserSessionId);
  }, [environmentId, browserSessionId, available]);
  useEffect(() => {
    if (!environmentId || available.has(browserSessionId)) return;
    let remaining = readSplitLayout(environmentId);
    if (!remaining) return;
    for (const id of splitSessionIds(remaining))
      if (!available.has(id)) remaining = remaining && closeLeaf(remaining, id);
    if (!remaining) return;
    saveSplitLayout(environmentId, remaining);
    void navigate({ to: "/browser/$browserSessionId",
      params: { browserSessionId: splitSessionIds(remaining)[0]! } });
  }, [environmentId, browserSessionId, available, navigate]);
  const tree = environmentId && session && !session.hidden
    ? layout && splitSessionIds(layout).includes(browserSessionId)
      ? layout : { id: "initial", sessionId: browserSessionId } as SplitNode
    : null;
  const choose = (id: string) => void navigate({
    to: "/browser/$browserSessionId", params: { browserSessionId: id },
  });
  const visibleIds = splitSessionIds(tree);
  useEffect(() => {
    const onNativeInteraction = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (id && id !== browserSessionId && visibleIds.includes(id)) choose(id);
    };
    window.addEventListener("t3:chatgpt-page-interaction", onNativeInteraction);
    return () => window.removeEventListener("t3:chatgpt-page-interaction", onNativeInteraction);
  }, [browserSessionId, visibleIds.join("|")]);
  const update = (next: SplitNode | null, primary: string) => {
    if (!environmentId) return;
    saveSplitLayout(environmentId, next);
    if (primary !== browserSessionId) choose(primary);
  };
  const release = (id: string) => {
    if (!environmentId) return;
    clearChatGPTGuestUserOpened(id);
    clearChatGPTGuestUserOpened(JSON.stringify([
      environmentId, chatGPTBrowserThreadRef(environmentId, id).threadId,
    ]));
  };
  const split = (id: string, direction: "row" | "column") => {
    if (!tree) return;
    const next = sessions.find((s) => !s.hidden && !visibleIds.includes(s.id))?.id
      ?? createSession(undefined, { explicitlyUserCreated: true });
    update(splitLeaf(tree, id, next, direction), browserSessionId);
  };
  const replace = (id: string, next: string) => {
    if (!tree || visibleIds.includes(next)) return;
    update(replaceLeaf(tree, id, next), id === browserSessionId ? next : browserSessionId);
    release(id);
  };
  const close = (id: string) => {
    if (!tree) return;
    const next = closeLeaf(tree, id);
    if (!next) return;
    update(next, id === browserSessionId ? splitSessionIds(next)[0]! : browserSessionId);
    release(id);
  };

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
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {tree && <SplitPane node={tree} environmentId={environmentId}
            primaryId={browserSessionId} sessions={sessions.filter((s) => !s.hidden)}
            onSelect={choose} onSplit={split} onReplace={replace} onClose={close} />}
        </div>
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

function SplitPane({
  node, environmentId, primaryId, sessions, onSelect, onSplit, onReplace, onClose,
}: {
  node: SplitNode;
  environmentId: EnvironmentId;
  primaryId: string;
  sessions: readonly { id: string; title: string }[];
  onSelect: (id: string) => void;
  onSplit: (id: string, direction: "row" | "column") => void;
  onReplace: (id: string, next: string) => void;
  onClose: (id: string) => void;
}) {
  if ("children" in node) return <div className={`flex min-h-0 min-w-0 flex-1 ${node.direction === "row" ? "flex-row" : "flex-col"}`}>
    {node.children.map((child) => <SplitPane key={child.id} node={child} environmentId={environmentId}
      primaryId={primaryId} sessions={sessions} onSelect={onSelect}
      onSplit={onSplit} onReplace={onReplace} onClose={onClose} />)}
  </div>;
  const primary = primaryId === node.sessionId;
  const splitMode = splitSessionIds(readSplitLayout(environmentId)).length > 1;
  const available = sessions.some((s) => s.id === node.sessionId);
  return <section className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border ${primary ? "border-primary" : "border-border"}`}
    onPointerDownCapture={() => { if (!primary) onSelect(node.sessionId); }}>
    <div className="flex h-8 shrink-0 items-center gap-1 bg-muted/40 px-1 text-xs">
      <button type="button" aria-label="Make primary ChatGPT pane"
        className={`rounded px-1 ${primary ? "font-bold text-primary" : "text-muted-foreground"}`}
        onClick={() => onSelect(node.sessionId)}>{primary ? "●" : "○"}</button>
      <select aria-label="Session in pane" className="min-w-0 flex-1 truncate bg-transparent"
        value={node.sessionId} onChange={(e) => onReplace(node.sessionId, e.target.value)}>
        {sessions.map((s) => <option key={s.id} value={s.id}
          disabled={s.id !== node.sessionId && splitSessionIds(readSplitLayout(environmentId)).includes(s.id)}>{s.title}</option>)}
      </select>
      <button type="button" title="Split left / right" aria-label="Split pane vertically"
        className="rounded px-1 hover:bg-muted" onClick={() => onSplit(node.sessionId, "row")}>◫</button>
      <button type="button" title="Split top / bottom" aria-label="Split pane horizontally"
        className="rounded px-1 hover:bg-muted" onClick={() => onSplit(node.sessionId, "column")}>⬓</button>
      {splitMode && <button type="button" title="Close split" aria-label="Close pane"
        className="rounded px-1 hover:bg-muted" onClick={() => onClose(node.sessionId)}>×</button>}
    </div>
    {available ? <ChatGPTBrowserView key={node.sessionId} environmentId={environmentId}
      sessionId={node.sessionId} primary={primary} splitMode={splitMode} /> :
      <div className="p-3 text-sm">Session unavailable.</div>}
  </section>;
}

function ChatGPTBrowserView({
  environmentId,
  sessionId,
  primary,
  splitMode,
}: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
  readonly primary: boolean;
  readonly splitMode: boolean;
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
    if (override === "default" && !splitMode) setOverride(defaultView);
  }, [defaultView, override, setOverride, splitMode]);
  const view = splitMode ? "browser" : resolveChatGPTView(defaultView, override);
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
          if (cancelled || focused || !primary) return;
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
  }, [threadRef, sessionId, view, persistentChromium, primary]);
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (
        !primary || !(event.ctrlKey || event.metaKey) ||
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
  }, [view, setOverride, primary, splitMode]);

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
      {!splitMode && !(persistentChromium && view === "browser") && (
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
              toolbarActions={splitMode ? undefined : viewSwitcher}
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
