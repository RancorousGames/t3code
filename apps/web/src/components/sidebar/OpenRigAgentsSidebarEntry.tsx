import type { DesktopOpenRigAgent, DesktopOpenRigSession } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronUpIcon, RefreshCwIcon, SendIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { isElectron } from "../../env";
import { Button } from "../ui/button";
import { SidebarMenu, SidebarMenuItem } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";

const REFRESH_INTERVAL_MS = 20_000;

function OpenRigAgentRow({
  agent,
  onChanged,
}: {
  agent: DesktopOpenRigAgent;
  onChanged: () => Promise<void>;
}) {
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [sessions, setSessions] = useState<readonly DesktopOpenRigSession[]>([]);
  const [chosenSession, setChosenSession] = useState("");
  const [linking, setLinking] = useState(false);

  useEffect(() => {
    if (!composing || agent.bound) return;
    let current = true;
    const load = async () => {
      try {
        const available = await window.desktopBridge?.listOpenRigSessions?.();
        if (current) setSessions(available ?? []);
      } catch {
        if (current) setFeedback("Unable to list OpenRig conversations.");
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [composing, agent.bound]);

  async function linkSession() {
    const bind = window.desktopBridge?.bindOpenRigAgent;
    const chosen = sessions.find((session) => session.id === chosenSession);
    if (!bind || !chosen || linking) return;
    setLinking(true);
    setFeedback("");
    try {
      await bind({ id: agent.id, target: chosen.target });
      await onChanged();
      setFeedback("Session linked.");
    } catch {
      setFeedback("Could not link this session; check that it is not already assigned.");
    } finally {
      setLinking(false);
    }
  }

  async function detachSession() {
    const unbind = window.desktopBridge?.unbindOpenRigAgent;
    if (!unbind || linking) return;
    setLinking(true);
    try {
      await unbind(agent.id);
      await onChanged();
      setFeedback("Session detached.");
    } catch {
      setFeedback("Could not detach this session.");
    } finally {
      setLinking(false);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending || !draft.trim() || !agent.bound) return;
    setSending(true);
    setFeedback("");
    try {
      const bridge = window.desktopBridge?.sendOpenRigAgentMessage;
      if (!bridge) throw new Error("OpenRig messaging is unavailable.");
      await bridge({ id: agent.id, message: draft });
      setDraft("");
      setFeedback("Message sent.");
    } catch {
      setFeedback("Delivery unconfirmed. Check the T3 conversation before sending again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <SidebarMenuItem>
      <button
        type="button"
        className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-sidebar-row-hover focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={`Message OpenRig agent ${agent.name}`}
        aria-expanded={composing}
        onClick={() => setComposing((current) => !current)}
      >
        <span className="mt-1 size-1.5 shrink-0 rounded-full bg-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline justify-between gap-2">
            <span className="truncate font-medium text-sidebar-foreground">{agent.name}</span>
            <span className="shrink-0 text-sidebar-muted-foreground">{agent.status}</span>
          </span>
          {agent.role && (
            <span className="block truncate text-sidebar-muted-foreground">
              {agent.role.replaceAll("-", " ")}
            </span>
          )}
          {agent.task && (
            <span
              className="block truncate text-sidebar-muted-foreground"
              aria-label={`Task: ${agent.task}`}
            >
              {agent.task}
            </span>
          )}
        </span>
      </button>
      {composing && (
        <div className="space-y-1.5 px-2 pb-2">
          {agent.bound ? (
            <div className="flex items-center justify-between gap-2 text-2xs text-sidebar-muted-foreground">
              <span className="min-w-0 truncate" title={agent.sessionTitle ?? undefined}>
                {agent.sessionTitle ?? "Linked conversation"}
              </span>
              <Button
                size="sm"
                variant="ghost-muted"
                disabled={linking}
                onClick={() => void detachSession()}
              >
                Detach
              </Button>
            </div>
          ) : (
            <div className="flex gap-1">
              <select
                aria-label={`T3 session for ${agent.name}`}
                className="min-w-0 flex-1 rounded-md border border-sidebar-border bg-transparent text-xs"
                value={chosenSession}
                disabled={linking}
                onChange={(event) => setChosenSession(event.currentTarget.value)}
              >
                <option value="">Choose T3 or ChatGPT conversation</option>
                {sessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.kind === "t3-thread"
                      ? "T3"
                      : session.kind === "chatgpt-conversation"
                        ? "ChatGPT"
                        : "Browser"}
                    {" · "}
                    {session.title}
                    {session.project ? ` · ${session.project}` : ""}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="ghost-muted"
                disabled={!chosenSession || linking}
                onClick={() => void linkSession()}
              >
                Link
              </Button>
            </div>
          )}
          {agent.bound && (
            <form className="space-y-1.5" onSubmit={(event) => void sendMessage(event)}>
              <Textarea
                size="sm"
                rows={2}
                aria-label={`Message to ${agent.name}`}
                placeholder={`Message ${agent.name}…`}
                value={draft}
                maxLength={8_000}
                disabled={sending}
                onChange={(event) => {
                  setDraft(event.currentTarget.value);
                  setFeedback("");
                }}
              />
              <div className="flex items-center justify-between gap-2">
                <span role="status" className="min-w-0 text-2xs text-sidebar-muted-foreground">
                  {feedback}
                </span>
                <Button
                  type="submit"
                  size="sm"
                  variant="ghost-muted"
                  disabled={sending || !draft.trim()}
                >
                  <SendIcon aria-hidden />
                  {sending ? "Sending…" : "Send"}
                </Button>
              </div>
            </form>
          )}
          {!agent.bound && (
            <span role="status" className="text-2xs text-sidebar-muted-foreground">
              {feedback}
            </span>
          )}
        </div>
      )}
    </SidebarMenuItem>
  );
}

/** Optional desktop-only integration. Native T3 providers and ChatGPT webviews stay owned by T3. */
export function OpenRigAgentsSidebarEntry() {
  const [agents, setAgents] = useState<readonly DesktopOpenRigAgent[]>([]);
  const [connection, setConnection] = useState<"checking" | "online" | "offline">("checking");
  const [collapsed, setCollapsed] = useState(false);
  const requestVersion = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const bridge = window.desktopBridge?.listOpenRigAgents;
      if (!bridge) throw new Error("OpenRig desktop bridge unavailable.");
      const snapshot = await bridge();
      if (version !== requestVersion.current) return;
      setAgents(snapshot);
      setConnection("online");
    } catch {
      if (version !== requestVersion.current) return;
      setAgents([]);
      setConnection("offline");
    }
  }, []);

  useEffect(() => {
    if (!isElectron) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => {
      ++requestVersion.current;
      window.clearInterval(timer);
    };
  }, [refresh]);

  if (!isElectron) return null;
  return (
    <div className="mt-1 border-t border-sidebar-border/60 pt-1">
      <SidebarMenu aria-label="OpenRig agents">
        <SidebarMenuItem>
          <div className="flex min-w-0 items-center gap-1 px-2">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-xs font-semibold text-sidebar-muted-foreground hover:text-sidebar-foreground"
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Expand OpenRig agents" : "Collapse OpenRig agents"}
              onClick={() => setCollapsed((current) => !current)}
            >
              {collapsed ? (
                <ChevronDownIcon className="size-3" />
              ) : (
                <ChevronUpIcon className="size-3" />
              )}
              <span>OpenRig</span>
              {connection === "online" && <span className="font-normal">({agents.length})</span>}
            </button>
            <span className="text-2xs text-sidebar-muted-foreground" role="status">
              {connection === "checking" ? "Checking…" : connection === "offline" ? "Offline" : ""}
            </span>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Refresh OpenRig agents"
              onClick={() => void refresh()}
            >
              <RefreshCwIcon aria-hidden />
            </Button>
          </div>
        </SidebarMenuItem>
        {!collapsed && connection === "online" && agents.length === 0 && (
          <SidebarMenuItem>
            <span className="block px-2 py-1 text-xs text-sidebar-muted-foreground">
              No OpenRig agents
            </span>
          </SidebarMenuItem>
        )}
        {!collapsed &&
          agents.map((agent) => (
            <OpenRigAgentRow key={agent.id} agent={agent} onChanged={refresh} />
          ))}
      </SidebarMenu>
    </div>
  );
}
