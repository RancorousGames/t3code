import { AuthOrchestrationOperateScope, type ChatGPTRegistryAction, type ChatGPTRegistrySession, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { useEnvironmentScope } from "../state/session";
import { randomUUID } from "../lib/utils";
import { useAtomCommand } from "../state/use-atom-command";
import { actChatGPTRegistry, patchChatGPTRegistry, readChatGPTRegistry, readChatGPTRegistryReceipt } from "../state/chatGPTSessionRegistry";
import { registryBrowserSession, registryPageSnapshot } from "../chatGPTRegistryProjection";
import { projectChatGPTDashboardSession, groupChatGPTDashboardSessions, CHATGPT_DASHBOARD_BUCKETS } from "../chatGPTDashboardData";
import { Button } from "./ui/button";

type RegistryRead = {
  sessions: readonly ChatGPTRegistrySession[];
  driver: { readonly online: boolean; readonly lastSeenAt: number | null };
};
type DisplayRow = ReturnType<typeof projectChatGPTDashboardSession>;

function when(at: number | null, now: number) {
  if (at === null || at <= 0) return "never";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago`
    : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago`
    : `${Math.floor(minutes / 1440)}d ago`;
}

/** Server-backed, read-only-by-default client. Does not mount a ChatGPT webview.
 * Every action gets a unique receipt; awaiting a receipt never retries the action. */
export function ChatGPTRegistryRemoteDashboard({ environmentId }: { environmentId: EnvironmentId }) {
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const read = useAtomCommand(readChatGPTRegistry, { reportFailure: false });
  const requestAction = useAtomCommand(actChatGPTRegistry, { reportFailure: false });
  const patch = useAtomCommand(patchChatGPTRegistry, { reportFailure: false });
  const readReceipt = useAtomCommand(readChatGPTRegistryReceipt, { reportFailure: false });
  const [data, setData] = useState<RegistryRead | null>(null);
  const [now, setNow] = useState(Date.now);
  const [feedback, setFeedback] = useState("Connecting to the ChatGPT session registry…");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const detailRef = useRef<HTMLElement>(null);
  const lastComposerTarget = useRef<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [projectDraft, setProjectDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let disposed = false;
    let inflight = false;
    const refresh = async () => {
      if (document.hidden || inflight) return;
      inflight = true;
      try {
        const result = await read({ environmentId, input: { environmentId } });
        if (!disposed && result._tag === "Success") {
          setData(result.value);
          setFeedback((previous) => previous.startsWith("Connecting") ? "" : previous);
        } else if (!disposed && result._tag === "Failure") {
          setData((old) => old ? { ...old, driver: { ...old.driver, online: false } } : null);
          setFeedback("Registry connection unavailable. Last-known sessions are retained; actions are disabled.");
        }
      } finally { inflight = false; if (!disposed) setNow(Date.now()); }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { disposed = true; window.clearInterval(interval); document.removeEventListener("visibilitychange", refresh); };
  }, [environmentId, read]);

  const projected = useMemo(() => (data?.sessions ?? []).flatMap((row) => {
    if (row.closedAt !== null) return [];
    const session = registryBrowserSession(row);
    if (!session) return [];
    return [projectChatGPTDashboardSession({
      session, snapshot: registryPageSnapshot(row.snapshot), now,
    })];
  }), [data, now]);
  const groups = useMemo(() => groupChatGPTDashboardSessions(projected, now), [projected, now]);
  const selected = projected.find((row) => row.session.id === selectedId) ?? projected[0] ?? null;
  const online = data?.driver.online === true;
  const composerTarget = selected ? `${selected.session.id}:${selected.snapshot?.conversationId ?? "unobserved"}` : null;
  useEffect(() => {
    if (composerTarget !== lastComposerTarget.current) {
      lastComposerTarget.current = composerTarget;
      // T3 session selection/reboot cannot inherit a draft from another
      // recipient or ChatGPT conversation, even after server-side refresh.
      setMessage("");
    }
  }, [composerTarget]);
  useEffect(() => {
    setTitleDraft(selected?.session.title ?? "");
    setProjectDraft(selected?.session.project ?? "");
  }, [selected?.session.id]);

  async function updateMetadata(row: DisplayRow, values: { title?: string; project?: string | null; snoozedUntil?: number | null }) {
    if (!canOperate || busy) return;
    const source = data?.sessions.find((candidate) => candidate.sessionId === row.session.id);
    if (!source) { setFeedback("Session not in registry. Refresh before updating."); return; }
    if (!source.publicSessionId) { setFeedback("Session awaiting Bootstrap ID; metadata was not changed."); return; }
    setBusy(true);
    try {
      const result = await patch({ environmentId, input: {
        environmentId, sessionId: source.publicSessionId, expectedUpdatedAt: source.updatedAt, patch: values,
      } });
      if (result._tag !== "Success" || !result.value.ok || !result.value.session) {
        setFeedback(result._tag === "Success" ? result.value.reason ?? "Metadata change refused." : "Registry unavailable.");
        return;
      }
      const updated = result.value.session;
      setData((existing) => existing ? { ...existing,
        sessions: existing.sessions.map((session) => session.sessionId === updated.sessionId ? updated : session),
      } : existing);
      setFeedback(online ? "Metadata saved to server; desktop will synchronize." : "Metadata saved to server; desktop will synchronize when online.");
    } finally { setBusy(false); }
  }

  async function act(row: DisplayRow, actionId: string, args: Record<string, unknown>) {
    const externalId = data?.sessions.find((candidate) => candidate.sessionId === row.session.id)?.publicSessionId;
    if (!externalId) {
      setFeedback("This session has not registered a Bootstrap [T3_ID] yet; no action was queued.");
      return;
    }
    if (!online || !canOperate || busy) {
      setFeedback("Desktop driver offline or insufficient permissions. No action was queued.");
      return;
    }
    const requestId = randomUUID();
    setBusy(true);
    setFeedback("Sending request to desktop driver…");
    try {
      const queued = await requestAction({ environmentId, input: {
        requestId, environmentId, sessionId: externalId, actionId, args,
      } });
      if (queued._tag !== "Success" || !queued.value.ok || !queued.value.action) {
        setFeedback(queued._tag === "Success"
          ? queued.value.reason ?? "Desktop unavailable; nothing queued."
          : "Registry action unavailable; nothing confirmed.");
        return;
      }
      setFeedback("Request queued. Awaiting the desktop receipt; no resend will occur.");
      // Only query a receipt, never repeat the original action.
      for (let attempt = 0; attempt < 8; attempt++) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_500));
        const status = await readReceipt({ environmentId, input: { requestId } });
        if (status._tag !== "Success" || !status.value?.resolvedAt) continue;
        const result = status.value.result;
        setFeedback(result?.ok === true
          ? `Desktop: ${String(result.status ?? "action completed")}`
          : `Desktop rejected: ${String(result?.reason ?? result?.status ?? "unknown result")}`);
        return;
      }
      setFeedback("Desktop result not yet confirmed. Request was NOT resent; check before retrying.");
    } catch {
      setFeedback("The action result is uncertain. Request was NOT resent.");
    } finally {
      setBusy(false);
      setNow(Date.now());
    }
  }

  const send = async (row: DisplayRow) => {
    const conversationId = row.snapshot?.conversationId;
    if (!conversationId || !message.trim()) {
      setFeedback("Select a session with a known conversation and enter a message.");
      return;
    }
    const value = message.trim();
    await act(row, "send", { expectedConversationId: conversationId, message: value });
    // Preserve the composer until delivery is verified by the user.
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 lg:p-6" aria-label="ChatGPT remote sessions">
      <header>
        <h1 className="text-xl font-semibold">ChatGPT sessions</h1>
        <p className="text-sm text-muted-foreground">
          {online ? "Desktop connected" : "Desktop offline"} · Last driver contact {when(data?.driver.lastSeenAt ?? null, now)}.
          {!online && " Last-known sessions are shown; live actions are refused."}
        </p>
      </header>
      {feedback && <p role="status" className="rounded-md border border-border bg-muted/40 p-3 text-sm">{feedback}</p>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {CHATGPT_DASHBOARD_BUCKETS.map(([key, label]) => (
          <div className="rounded-lg border border-border p-3" key={key}>
            <div className="text-xl font-semibold">{groups[key].length}</div>
            <div className="text-xs text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {CHATGPT_DASHBOARD_BUCKETS.map(([bucket, label]) => (
          <section key={bucket} className="rounded-lg border border-border/80 p-3">
            <h2 className="mb-3 text-sm font-semibold">{label}</h2>
            <div className="space-y-2">
              {groups[bucket].length === 0 && <p className="text-xs text-muted-foreground">No sessions</p>}
              {groups[bucket].map((row) => (
                <button key={row.session.id}
                  type="button" onClick={() => {
                    setMessage("");
                    setSelectedId(row.session.id);
                    requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
                  }}
                  className={`w-full rounded-md border p-3 text-left transition-colors ${selected?.session.id === row.session.id ? "border-primary" : "border-border"} ${online ? "" : "opacity-65"}`}>
                  <div className="truncate font-medium">{row.session.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {row.session.project ?? "Personal"} · {row.model.statusLine}
                  </div>
                  {row.snapshot?.lastAssistant?.text && <p className="mt-1 line-clamp-2 text-xs">{row.snapshot.lastAssistant.text}</p>}
                  <div className="mt-1 text-xs text-muted-foreground">Observed {when(row.updatedAt, now)}</div>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      {selected && <section ref={detailRef} className="rounded-lg border border-border p-4" aria-label="Selected ChatGPT session">
        <h2 className="font-semibold">{selected.session.title}</h2>
        <p className="text-xs text-muted-foreground">Session {data?.sessions.find((row) => row.sessionId === selected.session.id)?.publicSessionId ?? "Awaiting Bootstrap ID"} · {selected.model.statusLine}</p>
        <div className="my-4 space-y-2">
          <p className="text-xs text-muted-foreground">Last user message: {selected.snapshot?.lastUser?.text ?? "Not observed"}</p>
          <p className="text-sm">Last assistant message: {selected.snapshot?.lastAssistant?.text ?? "Not observed"}</p>
        </div>
        <label className="block text-sm">
          Message
          <textarea rows={3} maxLength={8_000} className="mt-1 w-full rounded-md border border-border bg-background p-2"
            value={message} onChange={(event) => setMessage(event.target.value)}
            disabled={!online || busy || !canOperate} placeholder="Send to this exact conversation…" />
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button disabled={!online || !canOperate || busy || !message.trim() || !selected.snapshot?.conversationId || !data?.sessions.find((row) => row.sessionId === selected.session.id)?.publicSessionId}
            onClick={() => void send(selected)}>Send</Button>
          <Button variant="outline" disabled={!online || !canOperate || busy}
            onClick={() => void act(selected, "reload", {})}>Reload</Button>
          <Button variant="outline" disabled={!online || !canOperate || busy}
            onClick={() => void act(selected, "retry_recovery", {})}>Retry recovery</Button>
          <Button variant="outline" disabled={!online || !canOperate || busy}
            onClick={() => void act(selected, "complete", {})}>Mark complete</Button>
          <Button variant="outline" disabled={!canOperate || busy}
            onClick={() => void updateMetadata(selected, { snoozedUntil: Date.now() + 60 * 60_000 })}>Snooze 1h</Button>
          <Button variant="outline" disabled={!canOperate || busy}
            onClick={() => void updateMetadata(selected, { snoozedUntil: null })}>Unsnooze</Button>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="text-xs">Title
            <input className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
              value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} />
            <Button size="xs" variant="outline" className="mt-1" disabled={!canOperate || busy || titleDraft.trim().length < 3}
              onClick={() => void updateMetadata(selected, { title: titleDraft.trim() })}>Rename</Button>
          </label>
          <label className="text-xs">Project
            <input className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
              value={projectDraft} onChange={(event) => setProjectDraft(event.target.value)} />
            <Button size="xs" variant="outline" className="mt-1" disabled={!canOperate || busy}
              onClick={() => void updateMetadata(selected, { project: projectDraft.trim() || null })}>Save project</Button>
          </label>
        </div>
      </section>}
    </main>
  );
}
