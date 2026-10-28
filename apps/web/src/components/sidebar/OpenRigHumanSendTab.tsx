import type { DesktopOpenRigAgent, DesktopOpenRigManagedSession } from "@t3tools/contracts";
import { humanSendEnvelope, humanSendMayRetry, sameHumanSendTarget, validHumanSendId, type HumanSendHold } from "./humanInboxDelivery";
import { useCallback, useEffect, useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { canMessagePrimary, sendDefinitelyNotSent, sessionDisplayTitle } from "./openRigAgentPresentation";

const STORAGE_KEY = "t3code:openrig-human-send-drafts:v1";
type HeldSend = HumanSendHold & { detail?: string };
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
    const holds = Object.fromEntries(Object.entries(raw.holds ?? {}).flatMap(([id, value]) => {
      if (id.length > 512 || !value || typeof value.text !== "string") return [];
      const receipt = validHumanSendId(value.attemptId) &&
        typeof value.managedSessionId === "string" && value.managedSessionId.length > 0 &&
        value.target && (value.target.kind === "chatgpt-conversation" ||
          value.target.kind === "t3-thread") ?
        { attemptId: value.attemptId, managedSessionId: value.managedSessionId,
          target: value.target } : {};
      // A crash while POST might have happened is UNKNOWN. A recorded preflight
      // or definite pre-POST rejection is safe to resume automatically.
      const retryable = validHumanSendId(value.attemptId) &&
        (value.state === "retryable" || value.state === "preflight");
      return [[id, { text: value.text, state: retryable ? "retryable" as const :
        value.state === "route_changed" ? "route_changed" as const : "uncertain" as const,
        ...receipt }]];
    }));
    return {
      selectedId: typeof raw.selectedId === "string" ? raw.selectedId : "",
      drafts, holds,
      feedback: Object.fromEntries(Object.entries(raw.feedback ?? {}).filter(
        ([id, value]) => id.length <= 512 && typeof value === "string",
      ).map(([id, value]) => [id, /UnknownError|Error invoking remote method|Effect\.tryPromise/u.test(value)
        ? "Checking delivery in the background." : value])),
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

  async function send(id = stateRef.current.selectedId, backgroundRetry = false) {
    const previous = stateRef.current.holds[id];
    if (sendingRef.current || !agents.some((agent) => agent.id === id) ||
        (previous && !(backgroundRetry && humanSendMayRetry(previous)))) return;
    const text = previous?.text ?? stateRef.current.drafts[id] ?? "";
    if (!text.trim() || text.length > 7_900 ||
        (!backgroundRetry && !canMessagePrimary(primary))) return;
    const attemptId = previous?.attemptId ?? randomUUID();
    // Freeze the selected managed primary BEFORE the preflight; an offline
    // retry must never silently pick a newly rotated primary for this message.
    const addressed = previous?.target && previous.managedSessionId ? previous :
      canMessagePrimary(primary) ? {
        target: primary!.target!, managedSessionId: primary!.id,
      } : null;
    const message = humanSendEnvelope(text, attemptId);
    if (message.length > 8_000) return;
    sendingRef.current = true;
    setSending(true);
    let postAttempted = false;
    update((current) => ({
      ...current, holds: { ...current.holds, [id]: {
        text, attemptId, state: "preflight", ...(addressed ? {
          target: addressed.target, managedSessionId: addressed.managedSessionId,
        } : {}),
      } },
      feedback: { ...current.feedback, [id]: "" },
    }));
    try {
      // Preflight is side-effect-free. It can be retried after offline periods.
      const list = window.desktopBridge?.listOpenRigManagedSessions;
      if (!list) {
        update((current) => ({ ...current,
          holds: { ...current.holds, [id]: { ...current.holds[id]!, state: "retryable" } },
        }));
        return;
      }
      const ledger = await list(id);
      const current = ledger.sessions.find((session) => session.id === ledger.primarySessionId);
      if (stateRef.current.selectedId === id) {
        setPrimary(current ?? null);
        setRouteError(canMessagePrimary(current ?? null) ? "" : "No routable active OpenRig-managed primary.");
      }
      if (!canMessagePrimary(current ?? null)) {
        update((state) => ({ ...state,
          holds: { ...state.holds, [id]: { ...state.holds[id]!, state: "retryable" } },
        }));
        return;
      }
      if (addressed?.target && (!sameHumanSendTarget(addressed.target, current!.target) ||
          addressed.managedSessionId !== current!.id)) {
        // Never silently redirect a previously addressed message to a new primary.
        update((state) => ({ ...state,
          holds: { ...state.holds, [id]: { ...state.holds[id]!, state: "route_changed" } },
        }));
        return;
      }
      // Persist the exact managed target before crossing the side-effect boundary.
      // On crash, 'sending' rehydrates as UNKNOWN, never as retryable.
      update((state) => ({ ...state,
        holds: { ...state.holds, [id]: {
          text, attemptId, state: "sending", managedSessionId: current!.id, target: current!.target!,
        } },
      }));
      const method = window.desktopBridge?.sendOpenRigAgentMessage;
      if (!method) {
        update((state) => ({ ...state,
          holds: { ...state.holds, [id]: { ...state.holds[id]!, state: "retryable" } },
        }));
        return;
      }
      postAttempted = true;
      await method({ id, message });
      // MAIN checked a positive, exact-target durable enqueue or observed turn.
      update((state) => {
        const holds = { ...state.holds }; delete holds[id];
        const drafts = { ...state.drafts };
        if (drafts[id] === text) drafts[id] = "";
        return { ...state, holds, drafts, feedback: { ...state.feedback,
          [id]: "Queued for delivery. T3 handles it from here." } };
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Everything before invoke was read-only: an offline ledger is safe to
      // retry. An invoked IPC may have POSTed before throwing.
      const definite = !postAttempted || sendDefinitelyNotSent(reason);
      update((state) => ({
        ...state, holds: { ...state.holds, [id]: {
          ...state.holds[id]!, text, attemptId,
          state: definite ? "retryable" : "uncertain",
        } },
        feedback: { ...state.feedback, [id]: "Checking delivery in the background." },
      }));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  const reconcilingRef = useRef(false);
  useEffect(() => {
    async function pulse() {
      if (reconcilingRef.current || sendingRef.current) return;
      reconcilingRef.current = true;
      try {
        const pending = Object.entries(stateRef.current.holds);
        if (!agents.length && pending.some(([, hold]) => humanSendMayRetry(hold))) {
          // If the operator window stays open across an offline period, refresh
          // the directory too; no user click should be needed to resume.
          await refreshAgents();
        }
        for (const [id, held] of pending) {
          if (humanSendMayRetry(held)) {
            // A positive no-POST preflight outcome is safe to retry. Other
            // UNKNOWN outcomes may ONLY be reconciled by reading exact history.
            if (agents.some((agent) => agent.id === id)) {
              await send(id, true);
            }
            continue;
          }
          if (!validHumanSendId(held.attemptId) || !held.managedSessionId ||
              !held.target || (held.state !== "uncertain" && held.state !== "route_changed")) continue;
          const reconcile = window.desktopBridge?.reconcileOpenRigHumanSend;
          if (!reconcile) continue;
          try {
            const receipt = await reconcile({
              id, attemptId: held.attemptId,
              managedSessionId: held.managedSessionId, target: held.target,
            });
            // A stale reply for an earlier attempt must never unlock the newer one.
            if (stateRef.current.holds[id]?.attemptId !== held.attemptId) continue;
            if (receipt.state === "observed") {
              update((state) => {
                const holds = { ...state.holds }; delete holds[id];
                const drafts = { ...state.drafts };
                if (drafts[id] === held.text) drafts[id] = "";
                return { ...state, holds, drafts, feedback: { ...state.feedback,
                  [id]: "Delivered to the verified conversation." } };
              });
            } else if (receipt.state === "route_changed") {
              update((state) => ({ ...state,
                holds: { ...state.holds, [id]: { ...held, state: "route_changed" } },
              }));
            }
          } catch {
            // Offline/read unavailability is NOT evidence of non-dispatch.
          }
        }
      } finally {
        reconcilingRef.current = false;
      }
    }
    void pulse();
    const timer = globalThis.setInterval(() => { void pulse(); }, 12_000);
    return () => globalThis.clearInterval(timer);
  }, [agents, refreshAgents, update]);

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
      {agentsError && <p role="status" className="text-xs text-muted-foreground">Agent list temporarily unavailable. Try Refresh agents in a moment.</p>}
      {selectedAgent && (
        <p role="status" className="text-xs text-muted-foreground">
          {loadingRoute ? "Checking recipient…" : canMessagePrimary(primary)
            ? `Route: ${sessionDisplayTitle(primary!)} · ${primary!.target?.kind} · ${primary!.status}`
            : routeError === "Selected agent is no longer in OpenRig's directory."
              ? "This agent is no longer available."
              : "Recipient has no active conversation right now."}
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
      {/* Pending sends reconcile in the background; raw hold details are never shown. */}
      {held && <div role="status" aria-live="polite" className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        {held.state === "route_changed" ? "Message paused: recipient conversation changed. No duplicate sent." :
          held.state === "retryable" ? "Recipient temporarily unavailable; retrying automatically…" :
          held.state === "uncertain" ? "Checking delivery automatically…" :
          "Sending to selected agent…"}
        {!held.attemptId && <details className="mt-2">
          <summary className="cursor-pointer text-2xs">Legacy delivery hold</summary>
          <p className="mt-1 text-2xs leading-relaxed">
            This message was sent by an older T3 version without a delivery tag, so automatic
            checking cannot identify it in the conversation history. Check the recipient's
            conversation yourself before clearing; nothing is resent automatically.
          </p>
          <div className="mt-2"><Button size="xs" variant="outline"
            onClick={() => update((current) => {
              const holds = { ...current.holds }; delete holds[selectedId];
              return { ...current, holds, feedback: { ...current.feedback,
                [selectedId]: "Hold cleared after operator reconciliation; no message automatically resent." } };
            })}>I checked the target history; clear hold</Button></div>
        </details>}
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
