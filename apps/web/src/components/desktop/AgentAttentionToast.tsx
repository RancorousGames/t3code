import { useEffect, useState } from "react";

const STORAGE_KEY = "t3.agent-attention.v1";
const EVENT = "t3-agent-attention-change";
const DAY = 86_400_000;

export type AgentAttention = {
  id: string;
  sessionId: string;
  message: string;
  createdAt: number;
  status: "pending" | "snoozed" | "opened" | "dismissed";
  nextAt: number;
  resolvedAt?: number;
};

function load(): AgentAttention[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is AgentAttention =>
      typeof item?.id === "string" && typeof item?.sessionId === "string" &&
      typeof item?.message === "string" && typeof item?.createdAt === "number" &&
      ["pending", "snoozed", "opened", "dismissed"].includes(item.status));
  } catch {
    return [];
  }
}

function save(items: AgentAttention[]) {
  // Keep receipts for a month, including dismissals, so a resumed agent can reconcile.
  localStorage.setItem(STORAGE_KEY, JSON.stringify(
    items.filter((item) => Date.now() - item.createdAt < 30 * DAY),
  ));
  window.dispatchEvent(new Event(EVENT));
}

export function requestAgentAttention(id: string, sessionId: string, message: string) {
  const items = load();
  const previous = items.find((item) => item.id === id);
  if (previous) {
    if (previous.sessionId !== sessionId || previous.message !== message)
      throw new Error("Attention ID already belongs to a different request.");
    return previous;
  }
  const entry: AgentAttention = {
    id, sessionId, message, createdAt: Date.now(), status: "pending", nextAt: Date.now(),
  };
  save([...items, entry]);
  return entry;
}

export function readAgentAttention(id: string) {
  return load().find((item) => item.id === id) ?? null;
}

function change(id: string, status: AgentAttention["status"], nextAt = 0) {
  save(load().map((entry) => entry.id === id
    ? { ...entry, status, nextAt, ...(status === "opened" || status === "dismissed"
      ? { resolvedAt: Date.now() } : {}) }
    : entry));
}

/** Single actionable in-app alert. Snoozing never counts as a dismissal. */
export function AgentAttentionToast({ openSession, onDismiss }: {
  openSession: (sessionId: string) => boolean;
  onDismiss: (request: AgentAttention) => void;
}) {
  const [items, setItems] = useState(load);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const refresh = () => { setItems(load()); setNow(Date.now()); };
    window.addEventListener(EVENT, refresh);
    window.addEventListener("storage", refresh);
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      window.removeEventListener(EVENT, refresh);
      window.removeEventListener("storage", refresh);
      window.clearInterval(timer);
    };
  }, []);
  const visible = items
    .filter((item) => (item.status === "pending" || item.status === "snoozed") && item.nextAt <= now)
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!visible) return null;
  return (
    <section role="alertdialog" aria-label="Agent needs your attention"
      className="fixed bottom-5 right-5 z-[9999] w-[350px] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-background p-4 shadow-2xl">
      <div className="mb-2 text-sm font-semibold">Agent requests your attention</div>
      <p className="mb-3 whitespace-pre-wrap break-words text-sm">{visible.message}</p>
      <div className="flex flex-wrap gap-2 text-xs">
        <button className="rounded-md bg-primary px-3 py-2 text-primary-foreground" onClick={() => {
          if (openSession(visible.sessionId)) change(visible.id, "opened");
        }}>Open session</button>
        <button className="rounded-md border px-2 py-2" onClick={() =>
          change(visible.id, "snoozed", Date.now() + 15 * 60_000)}>15 min</button>
        <button className="rounded-md border px-2 py-2" onClick={() =>
          change(visible.id, "snoozed", Date.now() + 60 * 60_000)}>1 hour</button>
        <button className="rounded-md border px-2 py-2" onClick={() => {
          change(visible.id, "dismissed");
          onDismiss(visible);
        }}>Dismiss</button>
      </div>
    </section>
  );
}
