/**
 * Prototype for T3-0226 Backup C: main-process-owned native ChatGPT views.
 *
 * Not yet wired to production routes. The browser owner must remain alive
 * when its replaceable UI/backend restart. This registry never treats React
 * unmount, UI reload or view hiding as a session-close operation.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - Partition identity must be synchronously derived before native view construction.
import { createHash } from "node:crypto";
import { WebContentsView, type BrowserWindow, type Rectangle } from "electron";
import { MENU_ACTION_CHANNEL, STABLE_CHATGPT_VIEW_STATE_CHANNEL } from "../ipc/channels.ts";
import { nativeChatGPTGuestShortcut } from "./NativeChatGPTGuestShortcut.ts";

const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const MAX_ID_LENGTH = 128;
const MAX_VISIBLE_DIMENSION = 16384;

/** Isolated general-purpose browser vertical slice, never a ChatGPT account. */
export const NATIVE_BROWSER_SLICE_IDENTITY = {
  sessionId: "36bafe20-7ce4-4c4d-a155-0943a99f99b3",
  environmentId: "t3-native-browser-slice",
  profileId: "isolated-web",
} as const;
export function isNativeBrowserSlice(identity: StableChatGPTIdentity): boolean {
  return (
    identity.sessionId === NATIVE_BROWSER_SLICE_IDENTITY.sessionId &&
    identity.environmentId === NATIVE_BROWSER_SLICE_IDENTITY.environmentId &&
    identity.profileId === NATIVE_BROWSER_SLICE_IDENTITY.profileId
  );
}

export interface StableChatGPTIdentity {
  readonly sessionId: string;
  readonly environmentId: string;
  readonly profileId: string;
}

export interface StableChatGPTViewSnapshot {
  readonly sessionId: string;
  readonly url: string;
  readonly title: string;
  readonly visible: boolean;
  readonly processId: number;
  readonly destroyed: boolean;
  readonly loading: boolean;
  readonly loadError: string | null;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

interface ViewEntry {
  readonly identity: StableChatGPTIdentity;
  readonly view: WebContentsView;
  visible: boolean;
  loadError: string | null;
}

function validateIdentity(identity: StableChatGPTIdentity): void {
  if (!UUID.test(identity.sessionId)) {
    throw new Error("ChatGPT view requires an exact session UUID.");
  }
  for (const value of [identity.environmentId, identity.profileId]) {
    if (!value || value.length > MAX_ID_LENGTH || /[\x00-\x1F\x7F]/.test(value)) {
      throw new Error("Invalid ChatGPT environment or profile identity.");
    }
  }
}

function validateUrl(rawUrl: string, identity: StableChatGPTIdentity): URL {
  const url = new URL(rawUrl);
  if (
    url.protocol !== "https:" ||
    (!isNativeBrowserSlice(identity) && url.hostname !== "chatgpt.com") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(
      "The native browser accepts HTTPS URLs only; ChatGPT sessions are restricted to chatgpt.com.",
    );
  }
  return url;
}

function partitionFor(identity: StableChatGPTIdentity): string {
  // The partition is shared by sessions of the same environment/profile,
  // never between accounts/environments. Hash avoids ambiguity or collisions
  // between concatenated variable-length identifiers.
  const digest = createHash("sha256")
    .update(JSON.stringify([identity.environmentId, identity.profileId]))
    .digest("hex");
  return `persist:t3-stable-chatgpt-${digest.slice(0, 32)}`;
}

function validateBounds(bounds: Rectangle): Rectangle {
  for (const value of [bounds.x, bounds.y, bounds.width, bounds.height]) {
    if (!Number.isSafeInteger(value)) throw new Error("Invalid embedded browser bounds.");
  }
  if (
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    bounds.width > MAX_VISIBLE_DIMENSION ||
    bounds.height > MAX_VISIBLE_DIMENSION
  ) {
    throw new Error("Embedded browser panel has invalid dimensions.");
  }
  return bounds;
}

function sameIdentity(a: StableChatGPTIdentity, b: StableChatGPTIdentity): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.environmentId === b.environmentId &&
    a.profileId === b.profileId
  );
}

/**
 * Owner-side registry. Call only from the stable Electron main process.
 * The caller must verify all IPC senders belong to the trusted T3 UI.
 */
export function createStableChatGPTViewRegistry(owner: BrowserWindow) {
  const entries = new Map<string, ViewEntry>();

  const attach = async (identity: StableChatGPTIdentity, rawUrl: string) => {
    validateIdentity(identity);
    const url = validateUrl(rawUrl, identity);
    if (owner.isDestroyed()) throw new Error("Stable browser owner window is gone.");
    const prior = entries.get(identity.sessionId);
    if (prior) {
      if (!sameIdentity(prior.identity, identity)) {
        throw new Error("Refusing to rebind an existing ChatGPT page to a different profile.");
      }
      if (prior.view.webContents.isDestroyed()) {
        throw new Error("Existing persistent page has been destroyed; never reload silently.");
      }
      // Reattach is deliberately side-effect free. No loadURL(), no draft loss.
      return snapshot(identity.sessionId);
    }

    const view = new WebContentsView({
      webPreferences: {
        partition: partitionFor(identity),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Keep background pages throttled. Disabling this on every persistent
        // ChatGPT view keeps hidden sessions rendering/ticking at foreground rates.
        backgroundThrottling: true,
      },
    });
    // A native WebContentsView has its own keyboard focus, bypassing the T3
    // React shortcut listeners. Relay T3 modifier chords to the UI without
    // moving focus or disturbing ordinary ChatGPT editing shortcuts.
    view.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || owner.isDestroyed() || owner.webContents.isDestroyed())
        return;
      // The guest owns keyboard focus, so the owner's before-input-event
      // handler never sees Ctrl/Cmd+W. Route real accelerators through the
      // same desktop menu-action channel used by legacy webviews. A synthetic
      // KeyboardEvent is insufficient: the renderer only listens for the
      // menu action to close the session.
      const nativeAction = nativeChatGPTGuestShortcut(
        input,
        process.platform,
        owner.webContents.getURL(),
        identity.sessionId,
      );
      if (nativeAction) {
        event.preventDefault();
        if (!input.isAutoRepeat) owner.webContents.send(MENU_ACTION_CHANNEL, nativeAction);
        return;
      }
      const key = input.key.toLowerCase();
      const appChord = (input.control || input.meta) && (input.shift || input.alt);
      const appWindowChord =
        (input.control || input.meta) && !input.shift && !input.alt && (key === "w" || key === "f");
      if (!appChord && !appWindowChord) return;
      event.preventDefault();
      const options = JSON.stringify({
        key: input.key,
        code: input.code,
        ctrlKey: input.control,
        metaKey: input.meta,
        shiftKey: input.shift,
        altKey: input.alt,
        repeat: input.isAutoRepeat,
      });
      // Dispatch to the existing shortcut handling, not a competing native map.
      // T3 receives the key while Chromium retains input focus and draft state.
      void owner.webContents
        .executeJavaScript(
          `window.dispatchEvent(new KeyboardEvent("keydown", { ...${options}, bubbles: true, cancelable: true }))`,
          false,
        )
        .catch(() => undefined);
    });
    // The owner has a draggable custom titlebar. Electron can otherwise treat
    // the top strip of a child WebContentsView as part of that hit-test region.
    // Override app-region inside the CHILD renderer itself; CSS on T3's React
    // placeholder cannot affect a separate WebContentsView renderer.
    const preventChildWindowDragging = () => {
      if (view.webContents.isDestroyed()) return;
      void view.webContents
        .insertCSS("html, body { -webkit-app-region: no-drag !important; }", {
          cssOrigin: "user",
        })
        .catch(() => undefined);
    };
    view.webContents.on("dom-ready", preventChildWindowDragging);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.setVisible(false);
    owner.contentView.addChildView(view);
    const entry: ViewEntry = { identity, view, visible: false, loadError: null };
    entries.set(identity.sessionId, entry);
    // Report actual Chromium navigation transitions, including user-initiated
    // refreshes. React observers then inspect live DOM health; neither a
    // navigation nor a finished network load alone proves ChatGPT is healthy.
    const emitState = (phase: "loading" | "loaded" | "failed" | "navigated") => {
      if (!owner.isDestroyed() && !owner.webContents.isDestroyed())
        owner.webContents.send(STABLE_CHATGPT_VIEW_STATE_CHANNEL, {
          environmentId: identity.environmentId,
          sessionId: identity.sessionId,
          phase,
        });
    };
    view.webContents.on("did-start-loading", () => {
      entry.loadError = null;
      emitState("loading");
    });
    view.webContents.on("did-stop-loading", () => emitState("loaded"));
    view.webContents.on("did-navigate-in-page", () => emitState("navigated"));
    view.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      // -3 is ERR_ABORTED, normal during a reload or redirect.
      if (!isMainFrame || code === -3) return;
      entry.loadError = description;
      emitState("failed");
    });
    try {
      await view.webContents.loadURL(url.href);
    } catch (error) {
      // Network errors may leave a valid, live document/error state. Report
      // the failure; never destroy or recreate the owned page as an automatic
      // recovery response.
      throw error;
    }
    return snapshot(identity.sessionId);
  };

  const snapshot = (sessionId: string): StableChatGPTViewSnapshot => {
    const entry = entries.get(sessionId);
    if (!entry) throw new Error("Unknown embedded ChatGPT session.");
    const webContents = entry.view.webContents;
    const destroyed = webContents.isDestroyed();
    return {
      sessionId,
      url: destroyed ? "" : webContents.getURL(),
      title: destroyed ? "" : webContents.getTitle(),
      visible: entry.visible,
      processId: destroyed ? 0 : webContents.getOSProcessId(),
      destroyed,
      loading: !destroyed && webContents.isLoading(),
      loadError: entry.loadError,
      canGoBack: !destroyed && webContents.navigationHistory.canGoBack(),
      canGoForward: !destroyed && webContents.navigationHistory.canGoForward(),
    };
  };

  /** A read-only residency check. Missing pages are routine during warming;
   * never emit an IPC exception for them or conflate another profile with missing. */
  const probe = (identity: StableChatGPTIdentity) => {
    validateIdentity(identity);
    const entry = entries.get(identity.sessionId);
    if (!entry) return { residency: "missing" as const };
    if (!sameIdentity(entry.identity, identity)) return { residency: "mismatch" as const };
    // A destroyed-but-still-owned entry cannot be safely reattached as new.
    if (entry.view.webContents.isDestroyed()) return { residency: "unavailable" as const };
    return { residency: "resident" as const, ...snapshot(identity.sessionId) };
  };

  const assertIdentity = (identity: StableChatGPTIdentity): void => {
    if (probe(identity).residency !== "resident") {
      throw new Error("ChatGPT view identity or environment/profile binding mismatch.");
    }
  };

  const present = (sessionId: string, bounds: Rectangle | null): void => {
    const entry = entries.get(sessionId);
    if (!entry || entry.view.webContents.isDestroyed()) {
      throw new Error("Cannot present a missing or destroyed ChatGPT page.");
    }
    if (owner.isDestroyed()) throw new Error("Stable browser owner is gone.");
    if (bounds === null) {
      entry.view.setVisible(false);
      entry.visible = false;
      return;
    }
    const validated = validateBounds(bounds);
    const ownerSize = owner.getContentBounds();
    if (
      validated.x + validated.width > ownerSize.width ||
      validated.y + validated.height > ownerSize.height
    ) {
      throw new Error("Embedded ChatGPT panel exceeds the T3 window client area.");
    }
    entry.view.setBounds(validated);
    entry.view.setVisible(true);
    entry.visible = true;
  };

  const navigate = async (sessionId: string, url: string): Promise<void> => {
    const entry = entries.get(sessionId);
    if (!entry || entry.view.webContents.isDestroyed()) {
      throw new Error("Cannot navigate a missing native ChatGPT page.");
    }
    await entry.view.webContents.loadURL(validateUrl(url, entry.identity).href);
  };

  const history = (sessionId: string, direction: "back" | "forward"): void => {
    const entry = entries.get(sessionId);
    if (!entry || entry.view.webContents.isDestroyed()) {
      throw new Error("Cannot navigate history of a missing browser page.");
    }
    const nav = entry.view.webContents.navigationHistory;
    if (direction === "back" && nav.canGoBack()) nav.goBack();
    if (direction === "forward" && nav.canGoForward()) nav.goForward();
  };

  const reload = (sessionId: string): void => {
    const entry = entries.get(sessionId);
    if (!entry || entry.view.webContents.isDestroyed()) {
      throw new Error("Cannot reload a missing native ChatGPT page.");
    }
    entry.view.webContents.reload();
  };

  // Read-only activity observation; never navigate or mount a hidden page.
  const evaluate = async (sessionId: string, expression: string): Promise<unknown> => {
    const entry = entries.get(sessionId);
    if (!entry || entry.view.webContents.isDestroyed())
      throw new Error("Unknown embedded ChatGPT session.");
    if (entry.view.webContents.isLoading()) return "unknown: ChatGPT is loading";
    if (!/^https:\/\/chatgpt\.com(?:[/:?#]|$)/i.test(entry.view.webContents.getURL()))
      return "invalid: this page is not on ChatGPT";
    if (typeof expression !== "string" || expression.length > 200_000)
      throw new Error("Invalid browser activity expression.");
    return entry.view.webContents.executeJavaScript(expression, false);
  };

  /** Owner-side native find uses Chromium's own selection, never DOM text scans. */
  const find = async (
    sessionId: string,
    text: string,
    findNext = false,
    forward = true,
  ): Promise<{ matches: number; activeMatchOrdinal: number }> => {
    const entry = entries.get(sessionId);
    if (!entry || entry.view.webContents.isDestroyed())
      throw new Error("Cannot find text in a missing ChatGPT page.");
    if (!text.trim() || text.length > 500) throw new Error("Find text must be 1..500 characters.");
    const webContents = entry.view.webContents;
    return new Promise((resolve, reject) => {
      let findId = -1;
      const cleanup = () => {
        clearTimeout(timer);
        webContents.off("found-in-page", onFound);
      };
      const onFound = (_event: Electron.Event, result: Electron.FoundInPageResult) => {
        if (findId !== -1 && result.requestId !== findId) return;
        if (!result.finalUpdate) return;
        cleanup();
        resolve({ matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal });
      };
      // @effect-diagnostics-next-line globalTimers:off -- Native IPC find completion is Electron event driven with a bounded timeout.
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Native browser find did not confirm its result."));
      }, 2_000);
      webContents.on("found-in-page", onFound);
      try {
        findId = webContents.findInPage(text, { findNext, forward });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  };
  const stopFind = (sessionId: string): void => {
    const entry = entries.get(sessionId);
    if (entry && !entry.view.webContents.isDestroyed())
      entry.view.webContents.stopFindInPage("clearSelection");
  };

  const close = (sessionId: string): void => {
    const entry = entries.get(sessionId);
    if (!entry) return;
    entries.delete(sessionId);
    entry.view.setVisible(false);
    if (!owner.isDestroyed()) owner.contentView.removeChildView(entry.view);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
  };

  return {
    attach,
    assertIdentity,
    probe,
    present,
    snapshot,
    evaluate,
    navigate,
    history,
    reload,
    find,
    stopFind,
    close,
    list: () => [...entries.keys()].map(snapshot),
  } as const;
}
