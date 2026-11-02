"use client";

import { AuthPreviewOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { useEnvironmentScope } from "~/state/session";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { resolveBrowserSurfacePanelRect, useBrowserSurfaceStore } from "./browserSurfaceStore";
import { resolveHostedBrowserWebviewWrapperStyle } from "./hostedBrowserWebviewStyle";
import { INSTALL_PERSISTENT_CHATGPT_CARET } from "./persistentChatGPTVirtualCaret";
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
 * T3 presents a real GPU-composited Chromium HWND from an independent Electron
 * owner. There is no image capture, frame polling, or alternative image path.
 * The owner's WebContentsView survives T3 rebuilds/restarts.
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
  const [ready, setReady] = useState(false);
  const [presented, setPresented] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const inputQueue = useRef<Promise<unknown>>(Promise.resolve());
  const latestMove = useRef<Record<string, unknown> | null>(null);
  const moveQueued = useRef(false);
  const moveFrame = useRef<number | null>(null);
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
      })
      .catch((failure) => {
        if (disposed) return;
        const reason = failure instanceof Error ? failure.message : String(failure);
        setError(reason);
        onFailureRef.current?.(reason);
      });
    return () => {
      disposed = true;
      // Unmount only the HWND; never close the host's live WebContentsView.
    };
  }, [bridge, sessionId, threadRef.environmentId, profileId]);

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
        rect && !nativeChatGPTOverlayOverlaps(document, rect) &&
        rect.width > 1 && rect.height > 1
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
    // surface. Temporarily hide DWM only while an overlapping modal is open;
    // hovercards use the native tooltip mirror below without hiding ChatGPT.
    const overlayObserver = new MutationObserver((mutations) => {
      if (mutations.some(mutationTouchesNativeChatGPTOverlay)) schedule();
    });
    overlayObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "data-state", "data-open", "data-closed",
        "data-starting-style", "data-ending-style",
        "aria-hidden", "hidden", "inert", "role", "style",
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
  }, [bridge, ready, visible, sessionId, threadRef.environmentId, profileId]);

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
      const tooltip = rect && document.visibilityState !== "hidden"
        ? nativeTooltipMirror(document, rect)
        : null;
      const signature = tooltip ? JSON.stringify(tooltip) : "";
      if (signature === lastTooltip) return;
      lastTooltip = signature;
      chain = chain.catch(() => undefined).then(() =>
        bridge({
          operation: "tooltip",
          identity,
          bounds: tooltip?.bounds ?? null,
          html: tooltip?.html ?? null,
        }),
      ).catch(() => undefined);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    // Restore the native hovercard mirroring introduced in 81015cbf24 and
    // corrected for fade-in in 5543bd4a63. The DWM migration disconnected it.
    const observer = new MutationObserver((mutations) => {
      if (mutations.some(mutationTouchesNativeChatGPTOverlay)) schedule();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "data-state", "data-open", "data-closed",
        "data-starting-style", "data-ending-style",
        "aria-hidden", "hidden", "inert", "style", "role",
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
      void chain.catch(() => undefined).then(() =>
        bridge({ operation: "tooltip", identity, bounds: null, html: null }),
      ).catch(() => undefined);
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

  const sendInput = (input: Record<string, unknown>) => {
    if (!inputBridge || !ready || !visible) return;
    if (input.type === "move") {
      // Never flood the authenticated host with stale cursor positions. Under
      // IPC backpressure, deliver the newest pending move before the next click.
      latestMove.current = input;
      if (moveQueued.current) return;
      moveQueued.current = true;
      inputQueue.current = inputQueue.current.catch(() => undefined).then(async () => {
        const latest = latestMove.current;
        latestMove.current = null;
        moveQueued.current = false;
        if (latest) await inputBridge({ operation: "input", sessionId, input: latest });
      }).catch((failure) => {
        setError(failure instanceof Error ? failure.message : String(failure));
      });
      return;
    }
    inputQueue.current = inputQueue.current.catch(() => undefined).then(() =>
      inputBridge({ operation: "input", sessionId, input }),
    ).catch((failure) => {
      setError(failure instanceof Error ? failure.message : String(failure));
    });
  };
  const pointer = (event: React.PointerEvent<HTMLDivElement>, type: "move" | "down" | "up") => {
    if (!ready || !visible) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const input = {
      type,
      x: Math.max(0, Math.round(event.clientX - rect.left)),
      y: Math.max(0, Math.round(event.clientY - rect.top)),
      button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
    };
    if (type === "move") {
      // Coalesce cursor movements to one native event per renderer frame.
      if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current);
      moveFrame.current = requestAnimationFrame(() => {
        moveFrame.current = null;
        sendInput(input);
      });
      return;
    }
    if (moveFrame.current !== null) {
      cancelAnimationFrame(moveFrame.current);
      moveFrame.current = null;
    }
    if (type === "down") {
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
    } else if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    sendInput(input);
  };
  const key = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!ready || !visible || event.nativeEvent.isComposing || event.key === "Process") return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") return;
    event.preventDefault();
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      sendInput({ type: "text", text: event.key });
      return;
    }
    const modifiers = [
      event.ctrlKey ? "Control" : "",
      event.altKey ? "Alt" : "",
      event.metaKey ? "Meta" : "",
      event.shiftKey ? "Shift" : "",
    ].filter(Boolean).join("+");
    sendInput({
      type: "key",
      key: (modifiers ? modifiers + "+" : "") + event.key,
      action: "press",
    });
  };
  useEffect(() => {
    const element = node.current;
    if (!element || !ready) return;
    const wheel = (event: WheelEvent) => {
      if (!visible) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      sendInput({
        type: "wheel",
        x: Math.round(event.clientX - rect.left),
        y: Math.round(event.clientY - rect.top),
        // DOM WheelEvent deltas are positive toward the bottom/right.
        // Electron's sendInputEvent mouseWheel uses the opposite convention.
        deltaX: -event.deltaX,
        deltaY: -event.deltaY,
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [ready, visible, inputBridge, sessionId]);

  useEffect(() => {
    if (!bridge || !ready || !visible) return;
    let disposed = false;
    const install = () => {
      if (disposed) return;
      void bridge({
        operation: "evaluate",
        identity: {
          sessionId,
          environmentId: threadRef.environmentId,
          profileId: profileId ?? "default",
        },
        expression: INSTALL_PERSISTENT_CHATGPT_CARET,
      }).catch(() => {
        // Caret decoration must never interfere with the actual page or input.
      });
    };
    install();
    // SPA navigation may replace the document without remounting this panel.
    // A very infrequent idempotent check restores only the missing decoration.
    const interval = setInterval(install, 20_000);
    window.addEventListener("focus", install);
    return () => {
      disposed = true;
      clearInterval(interval);
      window.removeEventListener("focus", install);
    };
  }, [bridge, ready, visible, sessionId, threadRef.environmentId, profileId]);

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
      tabIndex={0}
      onPointerMove={(event) => pointer(event, "move")}
      onPointerDown={(event) => pointer(event, "down")}
      onPointerUp={(event) => pointer(event, "up")}
      onKeyDown={key}
      onCompositionEnd={(event) => {
        if (event.data) sendInput({ type: "text", text: event.data });
      }}
      onPaste={(event) => {
        event.preventDefault();
        sendInput({ type: "text", text: event.clipboardData.getData("text/plain") });
      }}
      onContextMenu={(event) => event.preventDefault()}
      aria-label="Persistent native Chromium browser"
    >
      {error && (
        <div role="alert" className="absolute inset-x-0 top-0 z-10 bg-destructive px-3 py-2 text-xs text-white">
          {error}
        </div>
      )}
    </div>
  );
}
