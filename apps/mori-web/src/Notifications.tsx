import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "./Icons.tsx";

/**
 * Mori's compact, top-right notification host follows T3 Code's toast pattern:
 * a buffered app-level manager, stacked glass cards, severity icons, manual
 * dismiss, and auto-dismiss based on visible time. The full T3 component is
 * thread/router-bound, so this is a small standalone adapter for Mori.
 */
export type NotificationKind = "info" | "success" | "warning" | "error";
export interface NotificationItem {
  id: string;
  message: string;
  kind: NotificationKind;
  durationMs: number;
}

let messages: readonly NotificationItem[] = [];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const snapshot = () => messages;
const publish = (next: readonly NotificationItem[]) => {
  messages = next;
  for (const listener of listeners) listener();
};
export function notify(message: string, kind: NotificationKind = "info"): string {
  const item: NotificationItem = {
    id: crypto.randomUUID(), message, kind,
    durationMs: kind === "error" ? 7500 : kind === "warning" ? 6200 : 4400,
  };
  publish([...messages, item].slice(-4));
  return item.id;
}
export function dismissNotification(id: string) {
  publish(messages.filter(item => item.id !== id));
}

function Card({ item }: { item: NotificationItem }) {
  const [hovered, setHovered] = useState(false);
  const remaining = useRef(item.durationMs);
  const icon = item.kind === "success" ? "check-circle" :
    item.kind === "info" ? "info" : "alert";

  useEffect(() => {
    let timer: number | undefined;
    let since = 0;
    const pause = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        remaining.current = Math.max(0, remaining.current - (Date.now() - since));
        timer = undefined;
      }
    };
    const resume = () => {
      pause();
      if (hovered || document.hidden || !document.hasFocus()) return;
      since = Date.now();
      timer = window.setTimeout(() => dismissNotification(item.id), remaining.current);
    };
    const onVisibility = () => { if (document.hidden || !document.hasFocus()) pause(); else resume(); };
    resume();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
    window.addEventListener("blur", onVisibility);
    return () => {
      pause();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
      window.removeEventListener("blur", onVisibility);
    };
  }, [item.id, hovered]);

  return (
    <article className="mori-notification" data-kind={item.kind}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)} onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHovered(false);
      }}>
      <Icon name={icon} size="sm" />
      <span>{item.message}</span>
      <button type="button" className="mori-notification-close"
        aria-label="Dismiss notification" title="Dismiss"
        onClick={() => dismissNotification(item.id)}><Icon name="x" size="xs" /></button>
    </article>
  );
}

export function NotificationViewport() {
  const items = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (
    <div className="mori-notification-stack" aria-label="Notifications" aria-live="polite">
      {items.map(item => <Card key={item.id} item={item} />)}
    </div>
  );
}
