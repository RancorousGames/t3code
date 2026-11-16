import { useEffect, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronUpIcon } from "lucide-react";
import attentionSoundUrl from "../../assets/agent-attention.ogg?url";
import { watchPersistentChatGPTSessionSnoozes } from "../../chatGPTPersistentSnoozeAttention";
import { useClientSettings } from "../../hooks/useSettings";
import { pickSnoozePreset, resolveSnoozePresets, type SnoozePreset } from "../Sidebar.snooze";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuTrigger } from "../ui/menu";

import {
  type AgentAttention,
  AGENT_ATTENTION_CHANGE_EVENT,
  activeAgentAttentionStack,
  changeAttention,
  loadAgentAttention,
  markAgentAttentionNotified,
} from "../../chatGPTAgentAttention";

/** The top of a one-entry-at-a-time stack shared with the Ctrl+S shortcut.
 * Snoozing hides one entry until its scheduled return. */
export function AgentAttentionToast({ openSession, onDismiss, sessionTitle, environmentId }: {
  openSession: (request: AgentAttention) => boolean;
  onDismiss: (request: AgentAttention) => Promise<boolean>;
  sessionTitle: (sessionId: string) => string | undefined;
  environmentId: EnvironmentId | undefined;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [snoozePresets, setSnoozePresets] = useState<ReadonlyArray<SnoozePreset>>([]);
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
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
  // Subscribe to the toast's attention events before processing overdue session
  // snoozes, so an alert restored on mount appears immediately.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns one real snooze-expiry timer and store subscription for the desktop alert system
  useEffect(() => environmentId
    ? watchPersistentChatGPTSessionSnoozes(environmentId)
    : undefined, [environmentId]);
  const toPublish = items.find((item) => item.status === "pending" && !item.notifiedAt);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publish the ready request to the existing phone transport
  useEffect(() => {
    if (!toPublish) return;
    const publish = window.desktopBridge?.appActivation?.publishAgentAttention;
    if (!publish) return;
    // Ctrl+D text may have been captured before the session was renamed.
    // Resolve its current sidebar title for phone alerts too, not just the toast.
    const message = toPublish.source === "manual"
      ? (sessionTitle(toPublish.sessionId) ?? toPublish.message) : toPublish.message;
    void publish({ requestId: toPublish.id, sessionId: toPublish.sessionId, message })
      .then((success) => { if (success) markAgentAttentionNotified(toPublish.id); })
      .catch((error: unknown) => console.warn("[Agent attention] Phone notification failed", error));
  }, [toPublish?.id, toPublish?.status, toPublish?.notifiedAt, now]);
  const availableIds = new Set(items
    .filter((item) => sessionTitle(item.sessionId) !== undefined)
    .map((item) => item.sessionId));
  const stack = activeAgentAttentionStack(items, availableIds, now);
  const visible = stack[0];
  useEffect(() => {
    if (!visible) return;
    const key = `t3.agent-attention-announced.${visible.id}`;
    const stamp = String(visible.nextAt);
    // Keyed by scheduled appearance, so snoozed requests announce again when they resurface.
    if (localStorage.getItem(key) === stamp) return;
    localStorage.setItem(key, stamp);
    if (visible.spokenMessage?.trim()) {
      void window.desktopBridge?.speakOpenRigPreview?.(visible.spokenMessage).catch((error: unknown) =>
        console.warn("[Agent attention] Speech unavailable", error),
      );
    } else {
      const audio = new Audio(attentionSoundUrl);
      audio.volume = 0.55;
      void audio.play().catch((error: unknown) =>
        console.warn("[Agent attention] Sound unavailable", error),
      );
    }
  }, [visible?.id, visible?.nextAt]);
  // Hide the high-z notification while the shared custom-snooze dialog is open.
  if (!visible || customSnoozeOpen) return null;
  return (
    <section role="alertdialog" aria-label="Agent needs your attention"
      data-agent-attention-toast
      className="fixed bottom-5 right-5 z-[9999] w-[350px] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-background p-4 shadow-2xl">
      <div className="mb-2 text-sm font-semibold">
        Agent requests your attention{stack.length > 1 ? ` (${stack.length})` : ""}
      </div>
      <p className="mb-3 whitespace-pre-wrap break-words text-sm">
        {visible.source === "manual" ? (sessionTitle(visible.sessionId) ?? visible.message) : visible.message}
      </p>
      <div className="flex flex-wrap gap-2 text-xs">
        <button className="rounded-md bg-primary px-3 py-2 text-primary-foreground" onClick={() => {
          openSession(visible);
        }}>Open session</button>
        <button className="rounded-md border px-2 py-2" onClick={() =>
          changeAttention(visible.id, "snoozed", Date.now() + 10 * 60_000)}>10 min</button>
        <Menu onOpenChange={(open) => {
          if (open && environmentId)
            setSnoozePresets(resolveSnoozePresets(new Date(), timestampFormat, environmentId));
        }}>
          <MenuTrigger
            render={<button type="button" disabled={!environmentId}
              className="flex items-center gap-1 rounded-md border px-2 py-2 disabled:opacity-50" />}
          >
            Snooze <ChevronUpIcon className="size-3" aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup side="top" align="end" positionerClassName="z-[10001]">
            {snoozePresets.map((preset) => (
              <MenuItem key={preset.id} onClick={() => {
                if (!environmentId) return;
                const chosen = pickSnoozePreset(snoozePresets, preset.id, timestampFormat, environmentId);
                if (chosen) changeAttention(visible.id, "snoozed", Date.parse(chosen.snoozedUntil));
              }}>
                <MenuItemLabel>{preset.label}</MenuItemLabel>
                <span className="ml-auto text-xs text-muted-foreground">{preset.whenLabel}</span>
              </MenuItem>
            ))}
            <MenuItem onClick={() => {
              const requestId = visible.id;
              setCustomSnoozeOpen(true);
              void requestCustomSnooze()
                .then((choice) => {
                  if (choice) changeAttention(requestId, "snoozed", Date.parse(choice.snoozedUntil));
                })
                .finally(() => setCustomSnoozeOpen(false));
            }}>Custom…</MenuItem>
          </MenuPopup>
        </Menu>
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
