import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

/**
 * In-app, nonmodal floating windows shared by the OpenRig Human Inbox and the
 * Agent Workspace. The app underneath stays interactive. Geometry is the
 * operator's preferred rectangle; what renders is that rectangle clamped to
 * the current viewport, so a temporary small window never shrinks the saved
 * layout permanently.
 */
export interface FloatingGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface FloatingSize {
  width: number;
  height: number;
}

const MARGIN = 8;
const BASE_Z_INDEX = 60;
// The three nonmodal windows share a click boundary, including React-portaled descendants.
// Mark during React capture; the document bubble listener observes it afterwards.
const floatingWindowPointerEvents = new WeakSet<Event>();

export function clampFloatingGeometry(
  preferred: FloatingGeometry,
  viewport: FloatingSize,
  min: FloatingSize,
): FloatingGeometry {
  const maxWidth = Math.max(160, viewport.width - MARGIN * 2);
  const maxHeight = Math.max(160, viewport.height - MARGIN * 2);
  const width = Math.round(Math.min(maxWidth, Math.max(Math.min(min.width, maxWidth), preferred.width)));
  const height = Math.round(
    Math.min(maxHeight, Math.max(Math.min(min.height, maxHeight), preferred.height)),
  );
  return {
    width,
    height,
    left: Math.round(Math.min(Math.max(MARGIN, preferred.left), Math.max(MARGIN, viewport.width - width - MARGIN))),
    top: Math.round(Math.min(Math.max(MARGIN, preferred.top), Math.max(MARGIN, viewport.height - height - MARGIN))),
  };
}

function readViewport(): FloatingSize {
  const width = typeof window.innerWidth === "number" ? window.innerWidth : 1440;
  const height = typeof window.innerHeight === "number" ? window.innerHeight : 900;
  return { width, height };
}

export function readFloatingGeometry(key: string): FloatingGeometry | null {
  try {
    const parsed: unknown = JSON.parse(window.localStorage?.getItem(key) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return null;
    const { left, top, width, height } = parsed as Record<string, unknown>;
    return [left, top, width, height].every((value) => typeof value === "number" && Number.isFinite(value))
      ? { left, top, width, height } as FloatingGeometry
      : null;
  } catch {
    return null;
  }
}
function writeFloatingGeometry(key: string, value: FloatingGeometry | null) {
  try {
    if (value) window.localStorage?.setItem(key, JSON.stringify(value));
    else window.localStorage?.removeItem?.(key);
  } catch {
    /* Session-only layout. */
  }
}

// Stacking order of the open windows; the last one is in front. Kept tiny so
// inbox menus and confirmations (z-70+) always render above every window.
let layerOrder: readonly string[] = [];
const layerListeners = new Set<() => void>();
function setLayerOrder(next: readonly string[]) {
  layerOrder = next;
  for (const listener of layerListeners) listener();
}
function raiseLayer(id: string) {
  if (layerOrder[layerOrder.length - 1] === id) return;
  setLayerOrder([...layerOrder.filter((entry) => entry !== id), id]);
}
function subscribeLayers(listener: () => void) {
  layerListeners.add(listener);
  return () => layerListeners.delete(listener);
}
function useFloatingLayer(id: string) {
  useEffect(() => {
    raiseLayer(id);
    return () => setLayerOrder(layerOrder.filter((entry) => entry !== id));
  }, [id]);
  const index = useSyncExternalStore(subscribeLayers, () => layerOrder.indexOf(id));
  return BASE_Z_INDEX + Math.max(0, index);
}

function isInteractive(target: EventTarget | null) {
  const element = target as { closest?: (selector: string) => unknown } | null;
  return Boolean(
    element?.closest?.("button,a,input,select,textarea,label,[role='tab'],[data-floating-no-drag]"),
  );
}

type Interaction = {
  kind: "move" | "resize";
  pointerX: number;
  pointerY: number;
  start: FloatingGeometry;
};

export interface FloatingWindowState {
  /** Rendered width is below the consumer's compact breakpoint. */
  compact: boolean;
  geometry: FloatingGeometry;
  resetGeometry: () => void;
}

export function OpenRigFloatingWindow({
  id,
  label,
  storageKey,
  defaultGeometry,
  minSize,
  compactBelow,
  header,
  children,
  onEscape,
  onOutsidePointerDown,
  onKeyDown,
  panelRef,
  initialFocusRef,
}: {
  /** Stable layer identity; one floating window per id. */
  id: string;
  label: string;
  storageKey: string;
  defaultGeometry: (viewport: FloatingSize) => FloatingGeometry;
  minSize: FloatingSize;
  compactBelow: number;
  header: (state: FloatingWindowState) => ReactNode;
  children: (state: FloatingWindowState) => ReactNode;
  /** Escape pressed inside the window and not already handled by a descendant. */
  onEscape?: () => void;
  /** Dismiss on an actual click in the host app, not OS blur or focus changes. */
  onOutsidePointerDown?: () => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void;
  panelRef?: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [viewport, setViewport] = useState(readViewport);
  const [preferred, setPreferred] = useState<FloatingGeometry>(
    () => readFloatingGeometry(storageKey) ?? defaultGeometry(readViewport()),
  );
  const interaction = useRef<Interaction | null>(null);
  const ownRef = useRef<HTMLElement | null>(null);
  const outsideDismissRef = useRef(onOutsidePointerDown);
  outsideDismissRef.current = onOutsidePointerDown;
  const dismissible = onOutsidePointerDown !== undefined;
  const zIndex = useFloatingLayer(id);
  const geometry = clampFloatingGeometry(preferred, viewport, minSize);

  useEffect(() => {
    const resize = () => setViewport(readViewport());
    window.addEventListener?.("resize", resize);
    return () => window.removeEventListener?.("resize", resize);
  }, []);

  useEffect(() => {
    if (!dismissible) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.button !== 0 || floatingWindowPointerEvents.has(event)) return;
      if (ownRef.current?.contains(event.target as Node)) return;
      // Do not prevent the underlying click or move focus back to the opener.
      outsideDismissRef.current?.();
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [dismissible]);

  useEffect(() => {
    // Nonmodal: take focus once on open so Escape and keyboard navigation work,
    // without trapping it. The opener restores focus on close.
    (initialFocusRef?.current ?? ownRef.current)?.focus?.({ preventScroll: true });
  }, [initialFocusRef]);

  const resetGeometry = useCallback(() => {
    writeFloatingGeometry(storageKey, null);
    setPreferred(defaultGeometry(readViewport()));
  }, [defaultGeometry, storageKey]);

  const begin = (kind: Interaction["kind"]) => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (kind === "move" && isInteractive(event.target))) return;
    event.preventDefault();
    interaction.current = { kind, pointerX: event.clientX, pointerY: event.clientY, start: geometry };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* Pointer capture unavailable; movement still follows bubbling events. */
    }
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const active = interaction.current;
    if (!active) return;
    const dx = event.clientX - active.pointerX;
    const dy = event.clientY - active.pointerY;
    setPreferred(
      clampFloatingGeometry(
        active.kind === "move"
          ? { ...active.start, left: active.start.left + dx, top: active.start.top + dy }
          : { ...active.start, width: active.start.width + dx, height: active.start.height + dy },
        viewport,
        minSize,
      ),
    );
  };
  const end = () => {
    if (!interaction.current) return;
    interaction.current = null;
    setPreferred((current) => {
      writeFloatingGeometry(storageKey, current);
      return current;
    });
  };

  const state: FloatingWindowState = {
    compact: geometry.width < compactBelow,
    geometry,
    resetGeometry,
  };

  return (
    <section
      ref={(node) => {
        ownRef.current = node;
        if (panelRef) panelRef.current = node;
      }}
      role="dialog"
      aria-modal="false"
      aria-label={label}
      tabIndex={-1}
      data-compact={state.compact ? "true" : undefined}
      className="fixed flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl outline-none"
      style={{ ...geometry, zIndex }}
      onPointerDownCapture={(event) => {
        floatingWindowPointerEvents.add(event.nativeEvent);
        raiseLayer(id);
      }}
      onFocusCapture={() => raiseLayer(id)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.key === "Escape" && !event.defaultPrevented && onEscape) {
          event.preventDefault();
          event.stopPropagation();
          onEscape();
        }
      }}
    >
      <div
        className="shrink-0 cursor-grab touch-none select-none active:cursor-grabbing"
        data-floating-drag-handle
        onPointerDown={begin("move")}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={(event) => {
          if (!isInteractive(event.target)) resetGeometry();
        }}
      >
        {header(state)}
      </div>
      {children(state)}
      <div
        aria-hidden
        data-floating-resize-handle
        className="absolute right-0 bottom-0 size-4 cursor-nwse-resize touch-none"
        onPointerDown={begin("resize")}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <svg viewBox="0 0 16 16" className="size-4 text-muted-foreground/50">
          <path d="M14 6 6 14M14 10l-4 4" stroke="currentColor" strokeWidth="1.25" fill="none" />
        </svg>
      </div>
    </section>
  );
}
