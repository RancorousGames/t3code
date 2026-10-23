import { useEffect, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Icon } from "./Icons.tsx";
import { keyLabel } from "./shortcuts.ts";

export type PopAlign = "start" | "end" | "right";

/**
 * Anchored, opaque popover. Positions itself next to its anchor, closes on an outside press,
 * and moves through [data-opt] items with the arrow keys (Enter picks the highlighted one).
 */
export function PopoverFrame({ anchor, align = "start", width, onClose, children }: {
  anchor: HTMLElement;
  align?: PopAlign | undefined;
  width?: number | undefined;
  onClose: () => void;
  children: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const highlighted = useRef(0);

  // Placement is written straight to the element so a re-render of the content never jumps it.
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const rect = anchor.getBoundingClientRect();
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    let left = align === "right" ? rect.right + 8 : align === "end" ? rect.right - width : rect.left;
    let top = align === "right" ? rect.top - 6 : rect.bottom + 6;
    left = Math.max(8, Math.min(left, innerWidth - width - 8));
    if (top + height > innerHeight - 8) top = align === "right" ? innerHeight - height - 8 : Math.max(8, rect.top - height - 6);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  });

  useEffect(() => {
    frame.current?.querySelector<HTMLInputElement>("input[data-pop-search]")?.focus();
  }, []);

  useEffect(() => {
    const onPress = (event: PointerEvent) => {
      const target = event.target as Node;
      if (frame.current?.contains(target) || anchor.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPress, true);
    return () => document.removeEventListener("pointerdown", onPress, true);
  }, [anchor, onClose]);

  const items = () => [...(frame.current?.querySelectorAll<HTMLElement>("[data-opt]") ?? [])];
  const highlight = (index: number) => {
    const list = items();
    list.forEach(item => item.classList.remove("hi"));
    if (!list.length) return;
    highlighted.current = Math.max(0, Math.min(index, list.length - 1));
    const current = list[highlighted.current];
    current?.classList.add("hi");
    current?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      highlight(highlighted.current + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      highlight(highlighted.current - 1);
    } else if (event.key === "Enter") {
      const target = items()[highlighted.current] ?? items()[0];
      if (target) {
        event.preventDefault();
        event.stopPropagation();
        target.click();
      }
    }
  };

  return (
    <div
      ref={frame}
      className="pop"
      style={width ? { width } : undefined}
      onKeyDown={onKeyDown}
      // Typing in a filter restarts the highlight at the first match once React has re-rendered the list.
      onInput={() => { highlighted.current = 0; requestAnimationFrame(() => highlight(0)); }}
      onMouseMove={event => {
        const item = (event.target as HTMLElement).closest<HTMLElement>("[data-opt]");
        if (item) highlight(items().indexOf(item));
      }}
    >
      {children}
    </div>
  );
}

export function PopSearch({ placeholder, value, onChange }: { placeholder: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="pop-search">
      <Icon name="search" size="sm" />
      <input
        data-pop-search
        placeholder={placeholder}
        aria-label={placeholder}
        value={value}
        onChange={event => onChange(event.target.value)}
      />
    </div>
  );
}

/** Keyboard shortcut shown as key caps, e.g. "Ctrl+Shift+A" becomes three caps. */
export function KeyCaps({ binding }: { binding: string }) {
  if (!binding) return <span className="muted" style={{ fontSize: 12 }}>Not set</span>;
  return (
    <span className="keys">
      {keyLabel(binding).split("+").map((part, index) => <span key={index} className="kbd">{part}</span>)}
    </span>
  );
}

export function PopLabel({ children }: { children: ReactNode }) {
  return <div className="pop-label">{children}</div>;
}

export function Opt({ onPick, className, children, disabled }: {
  onPick?: () => void;
  className?: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={["opt", className].filter(Boolean).join(" ")}
      data-opt
      disabled={disabled}
      onClick={(event: MouseEvent) => { event.stopPropagation(); onPick?.(); }}
    >
      {children}
    </button>
  );
}

export function Modal({ onClose, className, children }: {
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="overlay" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={["modal", className].filter(Boolean).join(" ")} role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}

export function Toast({ message }: { message: string | null }) {
  return (
    <div className={`toast${message ? " show" : ""}`} role="status" aria-live="polite">
      <Icon name="check-circle" size="sm" />
      <span>{message ?? ""}</span>
    </div>
  );
}
