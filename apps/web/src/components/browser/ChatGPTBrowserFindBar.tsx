import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import { useThreadPreviewState } from "../../previewStateStore";

type FindableWebview = HTMLElementTagNameMap["webview"] & {
  findInPage: (text: string, options?: { forward?: boolean; findNext?: boolean }) => number;
  stopFindInPage: (action: "clearSelection" | "keepSelection" | "activateSelection") => void;
};

type FindResult = Event & {
  result?: { matches?: number; activeMatchOrdinal?: number };
};

function findWebview(runtimeTabId: string | null): FindableWebview | null {
  if (!runtimeTabId) return null;
  return (Array.from(document.querySelectorAll("webview")).find(
    (element) => element.dataset.previewTab === runtimeTabId,
  ) ?? null) as FindableWebview | null;
}

/** Electron's guest owns focus, so the host handles Ctrl/Cmd+F via a menu action. */
export function ChatGPTBrowserFindBar({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const preview = useThreadPreviewState(threadRef);
  const runtimeTabId = preview.activeTabId
    ? previewRuntimeTabId(threadRef, preview.serverEpoch, preview.activeTabId)
    : null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [match, setMatch] = useState<{ active: number; total: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The host receives a forwarded menu action when keyboard focus is inside
  // ChatGPT's guest WebContents. Native Ctrl/Cmd+F still works in the address bar.
  useEffect(() => {
    const show = () => {
      setOpen(true);
      // Repeated Ctrl/Cmd+F should focus the existing bar, not leave focus in the guest.
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    const unsubscribe = window.desktopBridge?.onMenuAction((action) => {
      if (action === "chatgpt.find") show();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const modifier = /Mac/i.test(navigator.platform) ? event.metaKey : event.ctrlKey;
      if (
        modifier &&
        !event.altKey &&
        !(/Mac/i.test(navigator.platform) ? event.ctrlKey : event.metaKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        event.stopPropagation();
        show();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    return () => {
      try {
        findWebview(runtimeTabId)?.stopFindInPage("clearSelection");
      } catch {
        // A previous guest can have detached while navigating to another session.
      }
    };
  }, [runtimeTabId]);

  useEffect(() => {
    if (!open) return;
    const guest = findWebview(runtimeTabId);
    if (!guest) return;
    const onFound = (event: Event) => {
      const result = (event as FindResult).result;
      if (result) {
        setMatch({
          active: result.activeMatchOrdinal ?? 0,
          total: result.matches ?? 0,
        });
      }
    };
    guest.addEventListener("found-in-page", onFound);
    return () => guest.removeEventListener("found-in-page", onFound);
  }, [open, runtimeTabId]);

  useEffect(() => {
    if (!open) return;
    const guest = findWebview(runtimeTabId);
    if (!guest) return;
    setMatch(null);
    try {
      if (query) guest.findInPage(query, { findNext: true });
      else guest.stopFindInPage("clearSelection");
    } catch {
      // A browser tab can detach or navigate while the user is typing.
      setMatch({ active: 0, total: 0 });
    }
  }, [open, query, runtimeTabId]);

  const step = (forward: boolean) => {
    if (!query) return;
    try {
      findWebview(runtimeTabId)?.findInPage(query, { findNext: false, forward });
    } catch {
      // Ignore a guest being replaced during find navigation.
    }
  };
  const close = () => {
    try {
      findWebview(runtimeTabId)?.stopFindInPage("clearSelection");
    } catch {
      // The guest may have closed while the find bar was open.
    }
    setOpen(false);
    setMatch(null);
  };

  if (!open) return null;
  // The Electron browser surface is a fixed-position sibling with its own
  // stacking context. A normal child of this route renders *behind* the guest.
  // Portal into the document so the search input is visible and can take focus.
  const bounds = findWebview(runtimeTabId)?.getBoundingClientRect();
  const top = bounds ? Math.max(8, bounds.top + 10) : 72;
  const right = bounds ? Math.max(8, window.innerWidth - bounds.right + 16) : 16;
  return createPortal(
    <div
      role="search"
      aria-label="Find in ChatGPT page"
      style={{ top, right }}
      className="fixed z-[1000] flex items-center gap-1 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
    >
      <input
        ref={inputRef}
        aria-label="Find in page"
        className="w-56 bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground"
        placeholder="Find in page"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          } else if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            step(!event.shiftKey);
          }
        }}
      />
      {query && (
        <span aria-live="polite" className="min-w-12 text-center text-xs text-muted-foreground">
          {match ? `${match.active}/${match.total}` : "…"}
        </span>
      )}
      <button
        type="button"
        aria-label="Previous match"
        title="Previous match"
        className="rounded px-2 py-1 hover:bg-accent"
        onClick={() => step(false)}
      >
        ↑
      </button>
      <button
        type="button"
        aria-label="Next match"
        title="Next match"
        className="rounded px-2 py-1 hover:bg-accent"
        onClick={() => step(true)}
      >
        ↓
      </button>
      <button
        type="button"
        aria-label="Close find"
        title="Close find (Esc)"
        className="rounded px-2 py-1 hover:bg-accent"
        onClick={close}
      >
        ×
      </button>
    </div>,
    document.body,
  );
}
