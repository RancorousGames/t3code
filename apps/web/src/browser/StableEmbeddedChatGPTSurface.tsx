"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  mutationTouchesNativeChatGPTOverlay,
  nativeChatGPTOverlayOverlaps,
} from "./nativeChatGPTOverlayVisibility";
import { nativeTooltipMirror } from "./nativeChatGPTTooltipMirror";
import { nativeChatGPTPageStatus } from "./nativeChatGPTWarmSession";
import { logChatGPTRecoveryAttempt, logChatGPTRecoveryTimeline } from "../chatGPTRecoveryTimeline";

type NativeBridge = NonNullable<NonNullable<Window["desktopBridge"]>["stableChatGPTViewRequest"]>;
type Identity = {
  readonly sessionId: string;
  readonly environmentId: string;
  readonly profileId: string;
};
type NativeSnapshot = { readonly url?: unknown; readonly destroyed?: unknown };

/**
 * Backup C: only a positioning/visibility placeholder. Actual page pixels,
 * mouse, wheel, keyboard, IME, and selection are owned by a native Chromium
 * WebContentsView within this T3 BrowserWindow, never by a JPEG/canvas stream.
 *
 * Experimental: the matching main-process registry must be enabled. On
 * unmount, hide only; do not close, reload or discard the ChatGPT page.
 */
export function StableEmbeddedChatGPTSurface({
  environmentId,
  sessionId,
  profileId,
  initialUrl,
  onUrlChange,
  forceNative = false,
}: {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly profileId: string;
  readonly initialUrl: string;
  readonly onUrlChange?: (url: string) => void;
  readonly forceNative?: boolean;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attached, setAttached] = useState(false);
  const identity = useMemo<Identity>(
    () => ({ environmentId, sessionId, profileId }),
    [environmentId, sessionId, profileId],
  );
  const initialUrlRef = useRef(initialUrl);
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;

  useEffect(() => {
    const bridge: NativeBridge | undefined = window.desktopBridge?.stableChatGPTViewRequest;
    const node = panel.current;
    if (!bridge || !node) {
      setError("Stable native Chromium is unavailable in this T3 build.");
      return;
    }
    let disposed = false;
    let ready = false;
    let frame = 0;
    let previousRect = "";
    let previousTooltip = "";
    let updateChain: Promise<unknown> = Promise.resolve();
    let observedUrl: string | null = null;
    let nativeTooltipReady = false;
    const notifyActivity = () => {
      if (!disposed)
        window.dispatchEvent(
          new CustomEvent("t3:chromium-sidebar-probe", {
            detail: { environmentId, sessionId },
          }),
        );
    };

    // Render tooltip popups in a native child window above the Chrome view.
    // NEVER hide the ChatGPT page for a hover tooltip; it must remain visible
    // and interactive. Existing HTML dialogs/menus keep their old fallback.
    const measure = () => {
      if (!ready || disposed) return;
      const bounds = node.getBoundingClientRect();
      const rect =
        document.visibilityState !== "hidden" &&
        !nativeChatGPTOverlayOverlaps(document, bounds, !nativeTooltipReady) &&
        bounds.width > 1 &&
        bounds.height > 1
          ? {
              x: Math.max(0, Math.round(bounds.left)),
              y: Math.max(0, Math.round(bounds.top)),
              width: Math.round(bounds.width),
              height: Math.round(bounds.height),
            }
          : null;
      const key = JSON.stringify(rect);
      const tooltip = nativeTooltipReady && rect ? nativeTooltipMirror(document, bounds) : null;
      const tooltipKey = tooltip ? JSON.stringify(tooltip) : "";
      if (key === previousRect && tooltipKey === previousTooltip) return;
      const boundsChanged = key !== previousRect;
      const tooltipChanged = tooltipKey !== previousTooltip;
      previousRect = key;
      previousTooltip = tooltipKey;
      updateChain = updateChain
        .catch(() => undefined)
        .then(async () => {
          if (disposed) return;
          if (boundsChanged) await bridge({ operation: "present", identity, bounds: rect });
          if (tooltipChanged)
            await bridge({
              operation: "tooltip",
              identity,
              bounds: tooltip?.bounds ?? null,
              html: tooltip?.html ?? null,
            });
        })
        .catch((cause: unknown) => {
          if (!disposed) console.warn("[T3 native tooltip]", cause);
        });
    };
    const scheduleMeasure = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    // Tooltip portals (including rich ThreadHoverCard previews) are identified
    // by data-slot, since Base UI does not consistently expose role=tooltip.
    // React may keep a closing tooltip mounted for its exit animation.
    const overlayObserver = new MutationObserver((mutations) => {
      if (mutations.some(mutationTouchesNativeChatGPTOverlay)) scheduleMeasure();
    });
    overlayObserver.observe(document.body, {
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
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(node);
    window.addEventListener("resize", scheduleMeasure);
    const onWindowFocus = () => {
      previousTooltip = "";
      scheduleMeasure();
    };
    window.addEventListener("focus", onWindowFocus);
    document.addEventListener("visibilitychange", scheduleMeasure);
    window.addEventListener("scroll", scheduleMeasure, true);

    let attachAttempt: number | undefined;
    void (async () => {
      // Observe before the idempotent attach to distinguish a real missing-page
      // load from merely selecting an already-resident Chromium session.
      const before = await nativeChatGPTPageStatus(bridge, environmentId, sessionId);
      if (disposed) return;
      if (before.residency === "missing") {
        attachAttempt = logChatGPTRecoveryAttempt(
          environmentId,
          "native",
          sessionId,
          "Foreground selection requested loading a missing native page.",
        );
      }
      await bridge({ operation: "attach", identity, url: initialUrlRef.current, forceNative });
      logChatGPTRecoveryTimeline(
        environmentId,
        "native",
        "outcome",
        before.residency === "resident"
          ? "Selected an existing Chromium page (no reload)."
          : "Foreground attach returned; page/ChatGPT health still needs verification.",
        { sessionId, ...(attachAttempt ? { attempt: attachAttempt } : {}) },
      );
    })()
      .then(() => {
        if (disposed) return;
        ready = true;
        setAttached(true);
        scheduleMeasure();
        notifyActivity();
        // A renderer-only rebart can run against an older Electron owner.
        // Negotiate native overlays before removing the previous fallback.
        // This is a non-mutating hide request; it never changes ChatGPT.
        void bridge({ operation: "tooltip", identity, bounds: null, html: null })
          .then(() => {
            nativeTooltipReady = true;
            scheduleMeasure();
          })
          .catch(() => {
            // Native main process not yet restarted; retain legacy fallback.
            nativeTooltipReady = false;
            scheduleMeasure();
          });
      })
      .catch((cause: unknown) => {
        logChatGPTRecoveryTimeline(
          environmentId,
          "native",
          "outcome",
          `Foreground attach failed: ${String(cause).slice(0, 200)}.`,
          { sessionId, ...(attachAttempt ? { attempt: attachAttempt } : {}) },
        );
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      });

    // Read URL only, for T3 address/history metadata. No frame captures,
    // script injection, or synthetic input occurs on this path.
    const statusTimer = setInterval(() => {
      if (disposed || !ready) return;
      void bridge({ operation: "snapshot", identity })
        .then((result) => {
          const snapshot = result as NativeSnapshot;
          if (!disposed && snapshot?.destroyed !== true && typeof snapshot?.url === "string") {
            onUrlChangeRef.current?.(snapshot.url);
            if (observedUrl !== snapshot.url) {
              observedUrl = snapshot.url;
              notifyActivity();
            }
          }
        })
        .catch(() => undefined);
    }, 1_500);

    return () => {
      disposed = true;
      clearInterval(statusTimer);
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      overlayObserver.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      window.removeEventListener("focus", onWindowFocus);
      document.removeEventListener("visibilitychange", scheduleMeasure);
      window.removeEventListener("scroll", scheduleMeasure, true);
      // Order the hide after any in-flight position updates to avoid the old
      // surface remaining visible above a different selected T3 session.
      void updateChain
        .catch(() => undefined)
        .then(async () => {
          await bridge({ operation: "tooltip", identity, bounds: null, html: null }).catch(
            () => undefined,
          );
          await bridge({ operation: "present", identity, bounds: null });
        })
        .catch(() => undefined);
    };
  }, [identity, forceNative]);

  return (
    <div
      ref={panel}
      className="relative h-full w-full overflow-hidden bg-background [-webkit-app-region:no-drag]"
      data-t3-stable-embedded-chatgpt
      data-t3-stable-attached={attached ? "true" : "false"}
    >
      {error ? (
        <div role="alert" className="p-4 text-sm text-muted-foreground">
          {error}
        </div>
      ) : null}
    </div>
  );
}
