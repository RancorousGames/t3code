import type { DesktopOpenRigAgent, DesktopOpenRigManagedSession } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { canMessagePrimary, sendDefinitelyNotSent, sessionDisplayTitle } from "./openRigAgentPresentation";

const STORAGE_KEY = "t3code:openrig-human-send-drafts:v1";
type HeldSend = { text: string; state: "sending" | "uncertain"; detail?: string };
export type SendTabState = {
  selectedId: string;
  drafts: Record<string, string>;
  holds: Record<string, HeldSend>;
  feedback: Record<string, string>;
};
const EMPTY: SendTabState = { selectedId: "", drafts: {}, holds: {}, feedback: {} };

/** An interrupted desktop/renderer cannot prove that a POST was not delivered. */
export function readHumanSendState(storage: Pick<Storage, "getItem">): SendTabState {
  try {
    const raw = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null") as Partial<SendTabState> | null;
    if (!raw || typeof raw !== "object") return { ...EMPTY };
    const drafts = Object.fromEntries(Object.entries(raw.drafts ?? {}).filter(
      ([id, value]) => id.length <= 512 && typeof value === "string" && value.length <= 8_000,
    ));
    const holds = Object.fromEntries(Object.entries(raw.holds ?? {}).flatMap(([id, value]) =>
      id.length <= 512 && value && typeof value.text === "string"
        ? [[id, { text: value.text, state: "uncertain" as const, ...(typeof value.detail === "string" ? { detail: value.detail } : {}) }]]
        : [],
    ));
    return {
      selectedId: typeof raw.selectedId === "string" ? raw.selectedId : "",
      drafts, holds,
      feedback: Object.fromEntries(Object.entries(raw.feedback ?? {}).filter(
        ([id, value]) => id.length <= 512 && typeof value === "string",
      )),
    };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * A separate Human Inbox compose surface. OpenRig's agent list and managed-seat
 * ledger are the only recipient/route sources. The desktop send method repeats
 * the active-primary verification immediately before the POST.
 */
export function OpenRigHumanSendTab({ active }: { active: boolean }) {
  const [state, setState] = useState<SendTabState>(() => readHumanSendState(window.localStorage));
  const stateRef = useRef(state);
  const [agents, setAgents] = useState<readonly DesktopOpenRigAgent[]>([]);
  const [agentsError, setAgentsError] = useState("");
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [primary, setPrimary] = useState<DesktopOpenRigManagedSession | null>(null);
  const [routeError, setRouteError] = useState("");
  const [loadingRoute, setLoadingRoute] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const requestVersion = useRef(0);
  const selectedId = state.selectedId;
  const selectedAgent = agents.find((agent) => agent.id === selectedId);
  const draft = state.drafts[selectedId] ?? "";
  const held = state.holds[selectedId];
  const feedback = state.feedback[selectedId];

  const update = useCallback((change: (current: SendTabState) => SendTabState) => {
    const next = change(stateRef.current);
    // Persist synchronously before any potentially ambiguous external POST.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    stateRef.current = next;
    setState(next);
  }, []);

  const refreshAgents = useCallback(async () => {
    setLoadingAgents(true);
    try {
      const list = window.desktopBridge?.listOpenRigAgents;
      if (!list) throw new Error("OpenRig agent directory is unavailable in this desktop build.");
      const results = await list();
      setAgents(results);
      setAgentsError("");
    } catch (error) {
      setAgents([]);
      setAgentsError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingAgents(false);
    }
  }, []);

  useEffect(() => {
    if (active) void refreshAgents();
  }, [active, refreshAgents]);

  const readRoute = useCallback(async (id: string) => {
    const version = ++requestVersion.current;
    setPrimary(null);
    setRouteError("");
    if (!id) return null;
    setLoadingRoute(true);
    try {
      const list = window.desktopBridge?.listOpenRigManagedSessions;
      if (!list) throw new Error("Managed-seat routing is unavailable in this desktop build.");
      const ledger = await list(id);
      const current = ledger.sessions.find((session) => session.id === ledger.primarySessionId) ?? null;
      if (version === requestVersion.current) {
        setPrimary(current);
        setRouteError(canMessagePrimary(current) ? "" : "No routable active OpenRig-managed primary.");
      }
      return canMessagePrimary(current) ? current : null;
    } catch (error) {
      if (version === requestVersion.current)
        setRouteError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      if (version === requestVersion.current) setLoadingRoute(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    if (!selectedAgent) {
      ++requestVersion.current;
      setPrimary(null);
      setRouteError(selectedId ? "Selected agent is no longer in OpenRig's directory." : "Select an agent.");
      return;
    }
    void readRoute(selectedId);
  }, [active, selectedAgent, selectedId, readRoute]);

  async function send() {
    const id = stateRef.current.selectedId;
    const agent = agents.find((entry) => entry.id === id);
    const text = stateRef.current.drafts[id] ?? "";
    if (!agent || !canMessagePrimary(primary) || !text.trim() ||
        text.length > 8_000 || stateRef.current.holds[id] || sendingRef.current) return;
    // Never let a tab change, close or interrupted async send clear the fence.
    sendingRef.current = true;
    setSending(true);
    update((current) => ({
      ...current, holds: { ...current.holds, [id]: { text, state: "sending" } },
      feedback: { ...current.feedback, [id]: "" },
    }));
    try {
      // A refreshed authoritative route is required even if the displayed one was previously active.
      const current = await readRoute(id);
      if (!current) {
        update((previous) => {
          const holds = { ...previous.holds }; delete holds[id];
          return { ...previous, holds, feedback: { ...previous.feedback,
            [id]: "Not sent: OpenRig no longer reports an active managed primary." } };
        });
        return;
      }
      const method = window.desktopBridge?.sendOpenRigAgentMessage;
      if (!method) throw new Error("OpenRig messaging is unavailable.");
      await method({ id, message: text });
      update((previous) => {
        const holds = { ...previous.holds }; delete holds[id];
        const drafts = { ...previous.drafts };
        if (drafts[id] === text) drafts[id] = "";
        return { ...previous, holds, drafts, feedback: { ...previous.feedback,
          [id]: "T3 acknowledged delivery to the managed primary; agent read/reply not confirmed." } };
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const definite = sendDefinitelyNotSent(reason);
      update((previous) => {
        const holds = { ...previous.holds };
        if (definite) delete holds[id];
        else holds[id] = { text, state: "uncertain", detail: reason };
        return { ...previous, holds, feedback: { ...previous.feedback,
          [id]: definite ? `Not sent: ${reason}` :
            `Delivery unknown: ${reason}. Inspect the exact primary's history before another send.` } };
      });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  return (
    <section aria-label="Human Inbox send message" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-52 flex-1 text-xs text-muted-foreground">
          Recipient (OpenRig agent)
          <select aria-label="Send message to agent" className="mt-1 w-full rounded-md border border-border bg-background px-2 py-2 text-sm text-foreground"
            value={selectedAgent ? selectedId : ""}
            onChange={(event) => {
              update((current) => ({ ...current, selectedId: event.currentTarget.value }));
              setPrimary(null);
            }}>
            <option value="">Choose an agent…</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.id}</option>)}
          </select>
        </label>
        <Button size="sm" variant="outline" disabled={loadingAgents || sending}
          onClick={() => void refreshAgents()}>Refresh agents</Button>
      </div>
      {agentsError && <p role="alert" className="text-xs text-warning">Agent directory unavailable: {agentsError}</p>}
      {selectedAgent && (
        <p role="status" className="text-xs text-muted-foreground">
          {loadingRoute ? "Checking active managed primary…" : canMessagePrimary(primary)
            ? `Route: ${sessionDisplayTitle(primary!)} · ${primary!.target?.kind} · ${primary!.status}`
            : `Cannot send: ${routeError || "No verified active managed primary."}`}
        </p>
      )}
      <label className="flex min-h-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
        Message
        <Textarea size="sm" rows={6} aria-label="Outgoing message" className="min-h-32 flex-1"
          disabled={!selectedAgent || Boolean(held)}
          value={draft} maxLength={8_000}
          placeholder="Message for the selected managed agent…"
          onChange={(event) => update((current) => ({
            ...current, drafts: { ...current.drafts, [selectedId]: event.currentTarget.value },
          }))} />
      </label>
      {held && <div role="alert" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
        {held.state === "sending" ? "Send pending; changing tabs does not cancel or retry it." :
          "Delivery outcome unknown. Check the exact target conversation history before unlocking another send."}
        {held.detail && <p className="mt-1 break-words">{held.detail}</p>}
        {held.state === "uncertain" && <div className="mt-2"><Button size="xs" variant="outline"
          onClick={() => update((current) => {
            const holds = { ...current.holds }; delete holds[selectedId];
            return { ...current, holds, feedback: { ...current.feedback,
              [selectedId]: "Hold cleared after operator reconciliation; no message automatically resent." } };
          })}>I checked the target history; clear hold</Button></div>}
      </div>}
      {feedback && <p role="status" className="text-xs text-muted-foreground">{feedback}</p>}
      <div className="flex justify-end">
        <Button size="sm" disabled={!selectedAgent || !canMessagePrimary(primary) || loadingRoute ||
          !draft.trim() || Boolean(held) || sending || draft.length > 8_000}
          onClick={() => void send()}>Send to agent</Button>
      </div>
    </section>
  );
}
