import {
  caffyBadge,
  caffyNextWake,
  caffyRecentEvents,
  caffyStoppedBadge,
  type CaffyReadout,
  type CaffyColor,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { CaffyCoffeePotIcon } from "./CaffyCoffeePotIcon";

const palettes: Record<CaffyColor, { badge: string; color: string; rail: string }> = {
  green: {
    badge: "border-emerald-400/60 bg-emerald-400/15 hover:bg-emerald-400/25",
    color: "text-emerald-300",
    rail: "border-emerald-400/55",
  },
  purple: {
    badge: "border-violet-400/60 bg-violet-400/15 hover:bg-violet-400/25",
    color: "text-violet-300",
    rail: "border-violet-400/55",
  },
  cyan: {
    badge: "border-cyan-300/60 bg-cyan-300/15 hover:bg-cyan-300/25",
    color: "text-cyan-200",
    rail: "border-cyan-300/55",
  },
  blue: {
    badge: "border-blue-400/60 bg-blue-400/15 hover:bg-blue-400/25",
    color: "text-blue-300",
    rail: "border-blue-400/55",
  },
  orange: {
    badge: "border-orange-400/60 bg-orange-400/15 hover:bg-orange-400/25",
    color: "text-orange-300",
    rail: "border-orange-400/55",
  },
  red: {
    badge: "border-rose-400/60 bg-rose-400/15 hover:bg-rose-400/25",
    color: "text-rose-300",
    rail: "border-rose-400/55",
  },
};

function time(value: number | null | undefined): string {
  return value != null && Number.isFinite(value) ? new Date(value).toLocaleString() : "Never";
}

export function CaffyStatusBadge({
  monitor,
  stoppedAt,
  now,
  shortcuts,
  onQuickMenu,
}: {
  monitor: CaffyReadout | null;
  stoppedAt?: number | undefined;
  now: number;
  shortcuts: {
    controls: string;
    toggle: string;
    once: string;
  };
  onQuickMenu: (position: { x: number; y: number }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [popupPosition, setPopupPosition] = useState({ x: 8, y: 8 });
  const anchor = useRef<HTMLSpanElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const badge = monitor ? caffyBadge(monitor, now) : stoppedAt ? caffyStoppedBadge() : null;
  const palette = badge ? palettes[badge.color] : null;

  const clearClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const openAtAnchor = () => {
    clearClose();
    const rect = anchor.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(356, window.innerWidth - 16);
      setPopupPosition({
        x: Math.max(8, Math.min(rect.right + 8, window.innerWidth - width - 8)),
        y: Math.max(8, Math.min(rect.top, window.innerHeight - 420)),
      });
    }
    setOpen(true);
  };
  const scheduleClose = () => {
    if (pinned) return;
    clearClose();
    closeTimer.current = setTimeout(() => setOpen(false), 220);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps document listeners attached only while the tooltip is open
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        anchor.current?.contains(event.target as Node) ||
        popup.current?.contains(event.target as Node)
      )
        return;
      setOpen(false);
      setPinned(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setPinned(false);
      }
    };
    const scroll = (event: Event) => {
      if (!popup.current?.contains(event.target as Node)) {
        setOpen(false);
        setPinned(false);
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cleans up delayed hover timer on unmount
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  if (!badge || !palette) return null;
  const next = monitor ? caffyNextWake(monitor, now) : "No further wakes";
  const events = monitor
    ? caffyRecentEvents(monitor)
    : stoppedAt
      ? [{ time: stoppedAt, label: "Agent stopped Caffy" }]
      : [];

  return (
    <>
      <span
        ref={anchor}
        role="button"
        tabIndex={0}
        aria-label={badge.label + ". " + badge.sentence}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`inline-flex h-6 max-w-18 shrink-0 cursor-default items-center gap-0.5 rounded-md border px-1 text-3xs font-bold tabular-nums outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${palette.badge} ${palette.color}`}
        onPointerEnter={openAtAnchor}
        onPointerLeave={scheduleClose}
        onFocus={openAtAnchor}
        onClick={(event) => {
          event.stopPropagation();
          clearClose();
          if (pinned) {
            setPinned(false);
            setOpen(false);
          } else {
            setPinned(true);
            openAtAnchor();
          }
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            clearClose();
            if (pinned) {
              setPinned(false);
              setOpen(false);
            } else {
              setPinned(true);
              openAtAnchor();
            }
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          clearClose();
          setOpen(false);
          setPinned(false);
          onQuickMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <CaffyCoffeePotIcon stopped={!monitor} aria-hidden className="size-4 shrink-0" />
        <span className="max-w-12 truncate">{badge.code}</span>
      </span>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popup}
            role="dialog"
            aria-label="Caffy details"
            onPointerEnter={clearClose}
            onPointerLeave={scheduleClose}
            onClick={(event) => event.stopPropagation()}
            className={`fixed z-[180] w-[min(356px,calc(100vw-16px))] rounded-xl border border-border bg-popover p-3.5 text-popover-foreground shadow-xl shadow-black/50 ${palette.rail}`}
            style={{
              left: popupPosition.x,
              top: popupPosition.y,
              maxHeight: "calc(100vh - 24px)",
              overflowY: "auto",
            }}
          >
            <div className={`flex items-center gap-1.5 text-xs font-semibold ${palette.color}`}>
              <CaffyCoffeePotIcon aria-hidden className="size-4" />
              {badge.label}
              <button
                type="button"
                aria-label="Close Caffy details"
                className="ml-auto rounded px-1 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setPinned(false);
                  setOpen(false);
                }}
              >
                ×
              </button>
            </div>
            <p className="mt-2.5 text-sm leading-relaxed text-foreground">{badge.sentence}</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div
                className={`rounded-lg border border-current/15 bg-current/5 p-2 ${palette.color}`}
              >
                <div className="text-3xs text-muted-foreground">Next wake</div>
                <div className="mt-1 text-xs font-semibold leading-snug">{next}</div>
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-2">
                <div className="text-3xs text-muted-foreground">Previous wake</div>
                <div className="mt-1 text-xs font-semibold leading-snug">
                  {time(monitor?.lastWakeAt)}
                </div>
              </div>
            </div>
            <div className="mt-3">
              <div className="text-3xs font-semibold tracking-wider text-muted-foreground uppercase">
                Recent events
              </div>
              <table className="mt-1.5 w-full text-left text-3xs">
                <thead className="border-b border-border text-muted-foreground">
                  <tr>
                    <th className="w-24 py-1 font-medium">Time</th>
                    <th className="py-1 font-medium">Event</th>
                  </tr>
                </thead>
                <tbody>
                  {events.length ? (
                    events.map((event) => (
                      <tr key={event.time + event.label} className="border-b border-border/50">
                        <td className="py-1.5 pr-1 text-muted-foreground">
                          {new Date(event.time).toLocaleTimeString()}
                        </td>
                        <td className="py-1.5">{event.label}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="py-2 text-muted-foreground" colSpan={2}>
                        No scheduler events recorded yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {monitor && (
              <details className="mt-2.5 border-t border-border pt-2 text-2xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Scheduler details
                </summary>
                <div className="mt-2 grid gap-1 text-foreground/80">
                  <div>Working slots: {monitor.respectSlots ? "Respected" : "Not restricted"}</div>
                  <div>
                    Auto-reboot:{" "}
                    {monitor.autoRebootEveryRuns
                      ? `Every ${monitor.autoRebootEveryRuns} completed runs`
                      : monitor.autoRebootMinutes
                        ? `Every ${monitor.autoRebootMinutes} min`
                        : "Off"}
                  </div>
                  <div>
                    Run limit:{" "}
                    {monitor.expiresAt == null ? "Until stopped" : time(monitor.expiresAt)}
                  </div>
                  <div>Last scheduler check: {time(monitor.lastCheckedAt)}</div>
                  <div>Next scheduler check: {time(monitor.nextCheckAt)}</div>
                  {monitor.lastCheckResult && <div>Last check: {monitor.lastCheckResult}</div>}
                  {monitor.lastError && (
                    <div className="text-destructive">Last error: {monitor.lastError}</div>
                  )}
                  {monitor.pendingMessageId && (
                    <div>Delivery: {monitor.deliveryStatus ?? "Pending"}</div>
                  )}
                </div>
              </details>
            )}
            <details className="mt-2.5 border-t border-border pt-2 text-2xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                Caffy hotkeys
              </summary>
              <div className="mt-2 grid gap-1.5">
                {(
                  [
                    ["Controls", shortcuts.controls],
                    ["Pause / resume", shortcuts.toggle],
                    ["Continue once", shortcuts.once],
                  ] as const
                ).map(([label, shortcut]) => (
                  <div key={label} className="flex items-center justify-between gap-2">
                    <span>{label}</span>
                    <kbd className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-3xs">
                      {shortcut || "Unbound"}
                    </kbd>
                  </div>
                ))}
              </div>
            </details>
            <button
              type="button"
              className={`mt-3 w-full rounded-md border px-2 py-1.5 text-xs font-semibold ${palette.badge} ${palette.color}`}
              onClick={() => {
                setOpen(false);
                const rect = anchor.current?.getBoundingClientRect();
                onQuickMenu({ x: rect?.left ?? 12, y: rect?.bottom ?? 12 });
              }}
            >
              Caffy actions…
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
