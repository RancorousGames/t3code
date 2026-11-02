"use client";

import { type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { UserRoundIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  CHATGPT_DEFAULT_URL,
  chatGPTBrowserLastUrlKey,
  chatGPTBrowserThreadRef,
  isChatGPTConversationUrl,
  readChatGPTBrowserSessions,
  useChatGPTBrowserSessions,
} from "../chatGPTBrowserSessions";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { resolveWarmChatGPTConversationUrl } from "../omniwork/chatGPTWarmConversationUrl";
import { DetachedChatGPTSurface } from "./DetachedChatGPTSurface";
import { chatGPTSessionProfileId } from "../chatGPTAccountProfiles";
import { wakeChatGPTGuest } from "./chatGPTGuestHibernation";
import { runChatGPTSessionControl } from "../chatGPTSessionControl";

/**
 * ChatGPT's standalone Chromium panel. The browser is owned by the detached
 * process; this panel does not depend on T3's preview tab, preview Idle state,
 * preview surface store or Electron webview lifecycle.
 */
export function DedicatedChatGPTBrowser({
  environmentId,
  sessionId,
  toolbarActions,
}: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
  /** Session/Browser switcher shares this row with Chromium navigation controls. */
  readonly toolbarActions?: ReactNode;
}) {
  const { sessions } = useChatGPTBrowserSessions(environmentId);
  const threadRef = useMemo(
    () => chatGPTBrowserThreadRef(environmentId, sessionId),
    [environmentId, sessionId],
  );
  const [savedUrl, setSavedUrl] = useLocalStorage(
    chatGPTBrowserLastUrlKey(environmentId, sessionId),
    CHATGPT_DEFAULT_URL,
    Schema.String,
  );
  const session = sessions.find((item) => item.id === sessionId);
  const profileId = chatGPTSessionProfileId(session);
  const recovered = session ? resolveWarmChatGPTConversationUrl(session, savedUrl) : null;
  const attachUrl =
    recovered ?? (isChatGPTConversationUrl(savedUrl) ? savedUrl : CHATGPT_DEFAULT_URL);
  // Latch the initial URL for this mount. Attaching to a live Chromium page
  // never navigates it, even if the saved conversation URL has become stale.
  const [firstUrl] = useState(attachUrl);
  const [displayUrl, setDisplayUrl] = useState(firstUrl);
  const [address, setAddress] = useState(firstUrl);
  const [notice, setNotice] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [findResult, setFindResult] = useState<{
    matches: number;
    activeMatchOrdinal: number;
  } | null>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  // The native bridge routes detached live pages, with an in-process native
  // fallback if sign-in transfer fails. Original Webviews remain a separate mode.
  const stableBridge = window.desktopBridge?.stableChatGPTViewRequest;
  const stableIdentity = useMemo(
    () => ({ sessionId, environmentId, profileId }),
    [sessionId, environmentId, profileId],
  );

  useEffect(() => {
    // User explicitly opened this native session; clear a prior manual unload.
    // This does not alter any legacy preview or navigate the existing page.
    wakeChatGPTGuest(sessionId);
  }, [sessionId]);

  useEffect(() => {
    if (recovered && !isChatGPTConversationUrl(savedUrl)) setSavedUrl(recovered);
  }, [recovered, savedUrl, setSavedUrl]);

  useEffect(() => {
    const unsubscribe = window.desktopBridge?.onMenuAction((action) => {
      if (action === "chatgpt.find") {
        setFindOpen(true);
        requestAnimationFrame(() => findInputRef.current?.focus());
      }
    });
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        setFindOpen(true);
        requestAnimationFrame(() => findInputRef.current?.focus());
      }
      if (event.key === "Escape" && findOpen) setFindOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      unsubscribe?.();
      window.removeEventListener("keydown", onKey);
    };
  }, [findOpen]);

  useEffect(() => {
    if (!findOpen || !stableBridge || !findText) {
      setFindResult(null);
      return;
    }
    let disposed = false;
    const timer = setTimeout(() => {
      void stableBridge({
        operation: "find",
        identity: stableIdentity,
        text: findText,
        findNext: false,
        forward: true,
      })
        .then((value) => {
          if (!disposed) setFindResult(value as { matches: number; activeMatchOrdinal: number });
        })
        .catch(() => {
          if (!disposed) setFindResult(null);
        });
    }, 140);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [findOpen, findText, stableBridge, stableIdentity]);

  const findNext = (forward: boolean) => {
    if (!stableBridge || !findText) return;
    void stableBridge({
      operation: "find",
      identity: stableIdentity,
      text: findText,
      findNext: true,
      forward,
    })
      .then((value) => setFindResult(value as { matches: number; activeMatchOrdinal: number }))
      .catch(() => setFindResult(null));
  };
  const closeFind = () => {
    setFindOpen(false);
    setFindResult(null);
    if (stableBridge)
      void stableBridge({ operation: "stop_find", identity: stableIdentity }).catch(() => {});
  };

  const browserUrlChanged = (url: string) => {
    setDisplayUrl(url);
    setAddress(url);
    if (isChatGPTConversationUrl(url) && url !== savedUrl) setSavedUrl(url);
  };
  const navigate = async (raw: string) => {
    const value = raw.trim();
    let target: URL;
    try {
      target = new URL(value.startsWith("http") ? value : "https://" + value);
    } catch {
      setNotice("Enter a valid ChatGPT URL.");
      return;
    }
    if (
      target.protocol !== "https:" ||
      !["chatgpt.com", "chat.openai.com"].includes(target.hostname)
    ) {
      setNotice("This panel only opens ChatGPT URLs.");
      return;
    }
    if (!stableBridge) {
      setNotice("The Chromium connection is unavailable.");
      return;
    }
    setNotice(null);
    try {
      await stableBridge({ operation: "navigate", identity: stableIdentity, url: target.href });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Navigation failed.");
    }
  };
  const refresh = async () => {
    if (!stableBridge) return;
    try {
      // Unlike an unconditional native WebContents.reload(), the shared
      // controller checks exact identity, drafts, uploads and UNKNOWN sends.
      await runChatGPTSessionControl({
        environmentId,
        sessions: readChatGPTBrowserSessions(environmentId),
        action: "reload",
        sessionId,
        force: false,
      });
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Reload was not safe.");
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-background px-2">
        <button
          type="button"
          className="rounded px-2 text-sm hover:bg-muted"
          title="Reload ChatGPT (checks for unsent drafts)"
          onClick={() => void refresh()}
        >
          ↻
        </button>
        <input
          aria-label="ChatGPT address"
          className="h-7 min-w-0 flex-1 rounded border border-border bg-muted/40 px-2 text-xs"
          value={address}
          onChange={(event) => setAddress(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void navigate(address);
          }}
        />
        <button
          type="button"
          className="rounded px-2 text-xs hover:bg-muted"
          onClick={() => void navigate(address)}
        >
          Go
        </button>
        {findOpen && (
          <div className="flex shrink-0 items-center gap-1 border-l border-border pl-2">
            <input
              ref={findInputRef}
              value={findText}
              onChange={(event) => setFindText(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  findNext(!event.shiftKey);
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeFind();
                }
              }}
              aria-label="Find on ChatGPT page"
              placeholder="Find in page"
              className="h-7 w-36 rounded border border-border bg-muted px-2 text-xs"
            />
            <span className="text-xs tabular-nums text-muted-foreground">
              {findResult ? `${findResult.activeMatchOrdinal}/${findResult.matches}` : "—"}
            </span>
            <button type="button" title="Previous result" onClick={() => findNext(false)}>
              ↑
            </button>
            <button type="button" title="Next result" onClick={() => findNext(true)}>
              ↓
            </button>
            <button type="button" title="Close find" onClick={closeFind}>
              ×
            </button>
          </div>
        )}
        {profileId === "chatgpt-second" && (
          <span
            title="Second ChatGPT account (fixed for this session)"
            aria-label="Second ChatGPT account"
            className="flex size-5 shrink-0 items-center justify-center rounded-full bg-amber-400/20 text-amber-300"
          >
            <UserRoundIcon aria-hidden className="size-3" />
          </span>
        )}
        {toolbarActions && (
          <div className="ml-1 flex shrink-0 items-center gap-1 border-l border-border pl-2">
            {toolbarActions}
          </div>
        )}
      </div>
      {notice && (
        <div role="alert" className="border-b border-border px-3 py-1 text-xs">
          {notice}
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-background [-webkit-app-region:no-drag]">
        <DetachedChatGPTSurface
          sessionId={sessionId}
          runtimeTabId={sessionId}
          initialUrl={firstUrl}
          threadRef={threadRef}
          profileId={profileId}
          zoomFactor={1}
          standalone
          onUrlChange={browserUrlChanged}
          onAttachFailure={setNotice}
        />
      </div>
      <span className="sr-only">Current ChatGPT page: {displayUrl}</span>
    </div>
  );
}
