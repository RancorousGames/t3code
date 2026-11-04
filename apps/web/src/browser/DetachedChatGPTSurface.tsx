"use client";

import { AuthPreviewOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { useEnvironmentScope } from "~/state/session";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { resolveBrowserSurfacePanelRect, useBrowserSurfaceStore } from "./browserSurfaceStore";
import { resolveHostedBrowserWebviewWrapperStyle } from "./hostedBrowserWebviewStyle";
import { nativeTooltipMirror } from "./nativeChatGPTTooltipMirror";
import {
  mutationTouchesNativeChatGPTOverlay,
  nativeChatGPTOverlayOverlaps,
} from "./nativeChatGPTOverlayVisibility";

type Identity = { sessionId: string; environmentId: string; profileId: string };
type Bounds = { x: number; y: number; width: number; height: number };
type BrowserReply = {
  url?: string;
  display?: string;
  visible?: boolean;
  result?: unknown;
  nativeHwnd?: string;
};

/**
 * Reserves the pane for a real Chromium window from the persistent host, which
 * survives T3 rebuilds/restarts. That window sits on top of this element and
 * receives input directly from Windows, so this component only reports where
 * the pane is. There is no image capture or input relay.
 */
export function DetachedChatGPTSurface({
  sessionId,
  runtimeTabId,
  initialUrl,
  threadRef,
  profileId,
  standalone = false,
  onUrlChange,
  onAttachFailure,
  onAttachSuccess,
}: {
  readonly sessionId: string;
  readonly runtimeTabId: string;
  readonly initialUrl: string | null;
  readonly threadRef: ScopedThreadRef;
  readonly profileId: string | undefined;
  readonly zoomFactor: number;
  readonly standalone?: boolean;
  readonly onUrlChange?: (url: string) => void;
  readonly onAttachFailure?: (reason: string) => void;
  readonly onAttachSuccess?: () => void;
}) {
  const authorized = useEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope);
  const bridge = authorized ? window.desktopBridge?.stableChatGPTViewRequest : undefined;
  const inputBridge = authorized ? window.desktopBridge?.persistentChatGPTRequest : undefined;
  const identity: Identity = {
    sessionId,
    environmentId: threadRef.environmentId,
    profileId: profileId ?? "default",
  };
  const node = useRef<HTMLDivElement | null>(null);
  const currentUrl = useRef(initialUrl ?? "https://chatgpt.com/");
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;
  const onFailureRef = useRef(onAttachFailure);
  onFailureRef.current = onAttachFailure;
  const onSuccessRef = useRef(onAttachSuccess);
  onSuccessRef.current = onAttachSuccess;
  const [ready, setReady] = useState(false);
  const [attachmentEpoch, setAttachmentEpoch] = useState(0);
  const [presented, setPresented] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const presentation = useBrowserSurfaceStore(
    useShallow((state) => {
      const value = state.byTabId[runtimeTabId];
      return {
        visible: value?.visible ?? false,
        rect: resolveBrowserSurfacePanelRect(state.byTabId, runtimeTabId),
        zIndex: value?.zIndex ?? 30,
        cornerRadius: value?.cornerRadius ?? 0,
      };
    }),
  );
  const visible = standalone || (presentation.visible && presentation.rect !== null);
  const displayStyle = resolveHostedBrowserWebviewWrapperStyle({
    active: visible,
    renderingActive: false,
    rect: presentation.rect,
    hiddenSize: { width: 1280, height: 800 },
    zIndex: presentation.zIndex,
    cornerRadius: presentation.cornerRadius,
  });

  useEffect(() => {
    if (!bridge) {
      setError("Native Chromium bridge is unavailable.");
      return;
    }
    let disposed = false;
    const identity: Identity = {
      sessionId,
      environmentId: threadRef.environmentId,
      profileId: profileId ?? "default",
    };
    void bridge({ operation: "attach", identity, url: currentUrl.current })
      .then((value) => {
        if (disposed) return;
        const reply = value as BrowserReply;
        if (reply.display !== "native") {
          throw new Error("The persistent host did not supply a native Chromium window.");
        }
        if (reply.url) {
          currentUrl.current = reply.url;
          onUrlChangeRef.current?.(reply.url);
        }
        setReady(true);
        setError(null);
        onSuccessRef.current?.();
      })
      .catch((failure) => {
        if (disposed) return;
        const reason = failure instanceof Error ? failure.message : String(failure);
        setError(reason);
        onFailureRef.current?.(reason);
      });
    return () => {
      disposed = true;
      // Only stop presenting; never close the host's live WebContentsView.
    };
  }, [bridge, sessionId, threadRef.environmentId, profileId]);

  // A detached Chromium host can restart while this React surface stays mounted.
  // Only a verified missing page may be reopened; a resident page (or an
  // unknown/mismatched probe) must never be navigated or replaced.
  useEffect(() => {
    if (!bridge || !visible || (!ready && !error)) return;
    let disposed = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const identity: Identity = {
      sessionId,
      environmentId: threadRef.environmentId,
      profileId: profileId ?? "default",
    };
    const inspect = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      let confirmedMissing = false;
      try {
        const state = (await bridge({ operation: "probe", identity })) as { residency?: string; url?: string };
        if (disposed) return;
        if (state.residency === "resident" && state.url && state.url !== currentUrl.current) {
          currentUrl.current = state.url;
          onUrlChangeRef.current?.(state.url);
        }
        if (state.residency !== "missing") return;
        confirmedMissing = true;
        const response = (await bridge({
          operation: "attach", identity, url: currentUrl.current,
        })) as BrowserReply;
        if (disposed) return;
        if (response.display !== "native")
          throw new Error("The recovered Chromium page has no native window.");
        if (response.url) {
          currentUrl.current = response.url;
          onUrlChangeRef.current?.(response.url);
        }
        setReady(true);
        setError(null);
        onSuccessRef.current?.();
        // The previous presentation's cached bounds are stale after host loss.
        // Re-run it to adopt the new native HWND even if the pane did not move.
        setAttachmentEpoch((epoch) => epoch + 1);
      } catch (failure) {
        if (!disposed && confirmedMissing) {
          const reason = failure instanceof Error ? failure.message : String(failure);
          setError(reason);
          onFailureRef.current?.(reason);
        }
      } finally {
        inFlight = false;
        if (!disposed) timer = setTimeout(() => void inspect(), 3_000);
      }
    };
    const onReset = () => {
      if (timer !== undefined) clearTimeout(timer);
      void inspect();
    };
    window.addEventListener("t3:chatgpt-webviews-reset", onReset);
    timer = setTimeout(() => void inspect(), 750);
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener("t3:chatgpt-webviews-reset", onReset);
    };
  }, [bridge, ready, error, visible, sessionId, threadRef.environmentId, profileId]);

  useEffect(() => {
    if (!bridge || !ready) return;
    let disposed = false;
    let raf = 0;
    let lastBounds = "";
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const identity: Identity = {
      sessionId,
      environmentId: threadRef.environmentId,
      profileId: profileId ?? "default",
    };
    const present = () => {
      raf = 0;
      // Alt-Tab can make T3's renderer document hidden even though this
      // ChatGPT session is still selected. Never unpresent/throttle that live
      // session solely because another desktop app has focus. The native
      // window coordinator handles OS z-order and minimization separately.
      const rect = visible ? node.current?.getBoundingClientRect() : null;
      const bounds: Bounds | null =
        rect && !nativeChatGPTOverlayOverlaps(document, rect) && rect.width > 1 && rect.height > 1
          ? {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            }
          : null;
      const signature = JSON.stringify(bounds);
      if (signature === lastBounds) return;
      lastBounds = signature;
      queue.current = queue.current
        .catch(() => undefined)
        .then(() => bridge({ operation: "present", identity, bounds }))
        .then((response) => {
          if (disposed) return;
          const result = response as BrowserReply;
          if (bounds && (result.display !== "native" || !result.visible))
            throw new Error("Native Chromium window did not become visible.");
          retries = 0;
          setPresented(Boolean(bounds && result.visible));
          setError(null);
        })
        .catch((failure) => {
          if (disposed) return;
          setError(failure instanceof Error ? failure.message : String(failure));
          setPresented(false);
          // A rejected geometry/snapshot during a tab transition must not
          // permanently poison this session: the signature was previously
          // cached before the operation succeeded. Retry boundedly.
          if (bounds && retries < 3) {
            retries++;
            lastBounds = "";
            retryTimer = setTimeout(schedule, 600 * retries);
          }
        });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(present);
    };
    const observer = new ResizeObserver(schedule);
    if (node.current) observer.observe(node.current);
    // Menus/dialogs live in the T3 renderer and cannot overpaint a native
    // window. Temporarily hide it only while an overlapping modal is open;
    // hovercards use the native tooltip mirror below without hiding ChatGPT.
    const overlayObserver = new MutationObserver((mutations) => {
      if (mutations.some(mutationTouchesNativeChatGPTOverlay)) schedule();
    });
    overlayObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "data-state",
        "data-open",
        "data-closed",
        "data-starting-style",
        "data-ending-style",
        "aria-hidden",
        "hidden",
        "inert",
        "role",
        "style",
      ],
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => {
      disposed = true;
      observer.disconnect();
      overlayObserver.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", schedule);
      if (raf) cancelAnimationFrame(raf);
      if (retryTimer !== null) clearTimeout(retryTimer);
      queue.current = queue.current
        .catch(() => undefined)
        .then(() => bridge({ operation: "present", identity, bounds: null }))
        .catch(() => undefined);
    };
  }, [bridge, ready, visible, sessionId, threadRef.environmentId, profileId, attachmentEpoch]);

  useEffect(() => {
    if (!bridge || !ready || !visible || !node.current) return;
    const identity: Identity = {
      sessionId,
      environmentId: threadRef.environmentId,
      profileId: profileId ?? "default",
    };
    let disposed = false;
    let frame = 0;
    let lastTooltip = "";
    let chain: Promise<unknown> = Promise.resolve();
    const measure = () => {
      frame = 0;
      if (disposed) return;
      const panel = node.current;
      const rect = panel?.getBoundingClientRect();
      const tooltip =
        rect && document.visibilityState !== "hidden" ? nativeTooltipMirror(document, rect) : null;
      const signature = tooltip ? JSON.stringify(tooltip) : "";
      if (signature === lastTooltip) return;
      lastTooltip = signature;
      chain = chain
        .catch(() => undefined)
        .then(() =>
          bridge({
            operation: "tooltip",
            identity,
            bounds: tooltip?.bounds ?? null,
            html: tooltip?.html ?? null,
          }),
        )
        .catch(() => undefined);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    // T3 hovercards overlapping the page are mirrored into a native window.
    const observer = new MutationObserver((mutations) => {
      if (mutations.some(mutationTouchesNativeChatGPTOverlay)) schedule();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "data-state",
        "data-open",
        "data-closed",
        "data-starting-style",
        "data-ending-style",
        "aria-hidden",
        "hidden",
        "inert",
        "style",
        "role",
      ],
    });
    const resize = new ResizeObserver(schedule);
    resize.observe(node.current);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => {
      disposed = true;
      observer.disconnect();
      resize.disconnect();
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", schedule);
      // A closing session must dismiss its own hovercard, never another
      // session's newer popup. The main-process overlay enforces ownership.
      void chain
        .catch(() => undefined)
        .then(() => bridge({ operation: "tooltip", identity, bounds: null, html: null }))
        .catch(() => undefined);
    };
  }, [bridge, ready, visible, sessionId, threadRef.environmentId, profileId]);

  useEffect(() => {
    const element = node.current;
    if (!element || !bridge) return;
    // Compatibility with existing native session-activity/DOM observers.
    Object.assign(element, {
      getURL: () => currentUrl.current,
      isLoading: () => !ready,
      executeJavaScript: async (expression: string) => {
        const reply = (await bridge({
          operation: "evaluate",
          identity,
          expression,
        })) as BrowserReply;
        if (reply.url) {
          currentUrl.current = reply.url;
          onUrlChangeRef.current?.(reply.url);
        }
        return reply.result;
      },
      sendInputEvent: async (event: { type: string; keyCode: string }) => {
        if (!inputBridge) throw new Error("Native Chromium input bridge unavailable.");
        await inputBridge({
          operation: "input",
          sessionId,
          input: {
            type: "key",
            key: event.keyCode,
            action: event.type === "keyDown" ? "down" : "up",
          },
        });
      },
    });
  }, [bridge, inputBridge, ready, sessionId, threadRef.environmentId, profileId]);

  useEffect(() => {
    if (!ready) return;
    const publish = () => {
      window.dispatchEvent(new CustomEvent("t3:chatgpt-page-push", { detail: { runtimeTabId } }));
      window.dispatchEvent(
        new CustomEvent("t3:chromium-sidebar-probe", {
          detail: { environmentId: threadRef.environmentId, sessionId },
        }),
      );
    };
    publish();
    const timer = setInterval(publish, 3_000);
    return () => clearInterval(timer);
  }, [ready, runtimeTabId, threadRef.environmentId, sessionId]);

  return (
    <div
      ref={node}
      data-t3-chromium-guest="true"
      data-t3-chromium-ready={ready ? "true" : "false"}
      data-t3-native-composited={presented ? "true" : "pending"}
      data-preview-tab={runtimeTabId}
      className={
        standalone
          ? "absolute inset-0 overflow-hidden bg-background [-webkit-app-region:no-drag]"
          : "fixed overflow-hidden bg-background [-webkit-app-region:no-drag]"
      }
      style={standalone ? undefined : displayStyle}
      aria-label="Persistent native Chromium browser"
    >
      {error && (
        <div
          role="alert"
          className="absolute inset-x-0 top-0 z-10 bg-destructive px-3 py-2 text-xs text-white"
        >
          {error}
        </div>
      )}
    </div>
  );
}
