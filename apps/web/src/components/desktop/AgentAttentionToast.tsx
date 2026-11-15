import { useEffect, useState } from "react";

import {
  type AgentAttention,
  AGENT_ATTENTION_CHANGE_EVENT,
  changeAttention,
  loadAgentAttention,
  markAgentAttentionNotified,
  openAgentAttention,
} from "../../chatGPTAgentAttention";

/** Single actionable in-app alert. Snoozing never counts as a dismissal. */
export function AgentAttentionToast({ openSession, onDismiss }: {
  openSession: (sessionId: string) => boolean;
  onDismiss: (request: AgentAttention) => Promise<boolean>;
}) {
  const [items, setItems] = useState(loadAgentAttention);
  const [now, setNow] = useState(Date.now);
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState(false);
  useEffect(() => {
    const refresh = () => { setItems(loadAgentAttention()); setNow(Date.now()); };
    window.addEventListener(AGENT_ATTENTION_CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      window.removeEventListener(AGENT_ATTENTION_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
      window.clearInterval(timer);
    };
  }, []);
  const toPublish = items.find((item) => item.status === "pending" && !item.notifiedAt);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publish the ready request to the existing phone transport
  useEffect(() => {
    if (!toPublish) return;
    const publish = window.desktopBridge?.appActivation?.publishAgentAttention;
    if (!publish) return;
    void publish({ requestId: toPublish.id, sessionId: toPublish.sessionId, message: toPublish.message })
      .then((success) => { if (success) markAgentAttentionNotified(toPublish.id); })
      .catch((error: unknown) => console.warn("[Agent attention] Phone notification failed", error));
  }, [toPublish?.id, toPublish?.status, toPublish?.notifiedAt, now]);
  const visible = items
    .filter((item) => (item.status === "pending" || item.status === "snoozed") && item.nextAt <= now)
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  useEffect(() => {
    if (!visible) return;
    const key = `t3.agent-attention-spoken.${visible.id}`;
    const stamp = String(visible.nextAt);
    // Keyed by scheduled appearance, so a snoozed request speaks again once it resurfaces.
    if (localStorage.getItem(key) === stamp) return;
    localStorage.setItem(key, stamp);
    void window.desktopBridge?.speakOpenRigPreview?.(
      "An agent needs your attention. Please open T three to respond.",
    ).catch((error: unknown) =>
      console.warn("[Agent attention] Speech unavailable", error),
    );
  }, [visible?.id, visible?.nextAt]);
  if (!visible) return null;
  return (
    <section role="alertdialog" aria-label="Agent needs your attention"
      className="fixed bottom-5 right-5 z-[9999] w-[350px] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-background p-4 shadow-2xl">
      <div className="mb-2 text-sm font-semibold">Agent requests your attention</div>
      <p className="mb-3 whitespace-pre-wrap break-words text-sm">{visible.message}</p>
      <div className="flex flex-wrap gap-2 text-xs">
        <button className="rounded-md bg-primary px-3 py-2 text-primary-foreground" onClick={() => {
          if (openSession(visible.sessionId)) openAgentAttention([visible.sessionId]);
        }}>Open session</button>
        <button className="rounded-md border px-2 py-2" onClick={() =>
          changeAttention(visible.id, "snoozed", Date.now() + 15 * 60_000)}>15 min</button>
        <button className="rounded-md border px-2 py-2" onClick={() =>
          changeAttention(visible.id, "snoozed", Date.now() + 60 * 60_000)}>1 hour</button>
        <button disabled={dismissing} className="rounded-md border px-2 py-2 disabled:opacity-50" onClick={async () => {
          setDismissing(true);
          setDismissError(false);
          try {
            // A dismissal cannot be acknowledged until its agent handoff is
            // durably queued; otherwise the user loses the request silently.
            if (await onDismiss(visible)) changeAttention(visible.id, "dismissed");
            else setDismissError(true);
          } catch {
            setDismissError(true);
          } finally {
            setDismissing(false);
          }
        }}>{dismissing ? "Dismissing…" : "Dismiss"}</button>
      </div>
      {dismissError && <p role="alert" className="mt-2 text-xs text-destructive">Could not notify the agent. Try again or open its session.</p>}
    </section>
  );
}
