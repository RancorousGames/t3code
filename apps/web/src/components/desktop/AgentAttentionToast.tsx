import { useEffect, useRef, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronUpIcon } from "lucide-react";
import attentionSoundUrl from "../../assets/agent-attention.ogg?url";
import { watchPersistentChatGPTSessionSnoozes } from "../../chatGPTPersistentSnoozeAttention";
import { readChatGPTBrowserSessions } from "../../chatGPTBrowserSessions";
import { readChatGPTProviderActivity, flushDeferredCaffyAttention } from "../../chatGPTProviderActivity";
import { isCaffyIdleContinuationActive } from "../../chatGPTCaffyAttentionPolicy";
import { readVerifiedT3CaffyOverview } from "../../hooks/useT3CaffyOverview";
import { rearmPersistentSessionAttention } from "../../chatGPTPersistentAttention";
import { useClientSettings } from "../../hooks/useSettings";
import { pickSnoozePreset, resolveSnoozePresets, type SnoozePreset } from "../Sidebar.snooze";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuTrigger } from "../ui/menu";

import {
  type AgentAttention,
  AGENT_ATTENTION_CHANGE_EVENT,
  activeAgentAttentionStack,
  loadAgentAttention,
  markAgentAttentionNotified,
  resolveAttentionQueueEntries,
  snoozeActionableAttentionQueue,
} from "../../chatGPTAgentAttention";

/** Open consumes one stack item; snooze and dismiss apply to the entire
 * currently actionable queue, without touching future untriggered requests. */
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
  const publishingIds = useRef(new Set<string>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribes to the shared external attention store and its timed snooze refresh.
  useEffect(() => {
    const refresh = () => {
      if (environmentId) flushDeferredCaffyAttention(environmentId);
      setItems(loadAgentAttention());
      setNow(Date.now());
    };
    window.addEventListener(AGENT_ATTENTION_CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      window.removeEventListener(AGENT_ATTENTION_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
      window.clearInterval(timer);
    };
  }, [environmentId]);
  // Subscribe to the toast's attention events before processing overdue session
  // snoozes, so an alert restored on mount appears immediately.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns one real snooze-expiry timer and store subscription for the desktop alert system
  useEffect(() => environmentId
    ? watchPersistentChatGPTSessionSnoozes(environmentId)
    : undefined, [environmentId]);
  // A sleeping session is not actionable: do not surface it in the toast,
  // publish a phone alert for it, or let queue buttons wake it indirectly.
  const availableIds = new Set(items.filter((item) => {
    if (!environmentId || sessionTitle(item.sessionId) === undefined) return false;
    const session = readChatGPTBrowserSessions(environmentId).find((entry) =>
      entry.id === item.sessionId || entry.bootstrapIdentity?.publicId === item.sessionId);
    return session !== undefined && (session.snoozedUntil ?? 0) <= now &&
      !(item.source === "manual" && isCaffyIdleContinuationActive(
        readVerifiedT3CaffyOverview(), session, now));
  }).map((item) => item.sessionId));
  const toPublish = items.find((item) => item.status === "pending" &&
    !item.notifiedAt && availableIds.has(item.sessionId));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronizes actionable attention with the external phone-notification transport.
  useEffect(() => {
    if (!toPublish || publishingIds.current.has(toPublish.id)) return;
    const publish = window.desktopBridge?.appActivation?.publishAgentAttention;
    if (!publish) return;
    const id = toPublish.id;
    publishingIds.current.add(id);
    // Resolve current T3 title; the reminder may predate a session rename.
    const message = toPublish.source === "manual"
      ? (sessionTitle(toPublish.sessionId) ?? toPublish.message) : toPublish.message;
    void publish({ requestId: id, sessionId: toPublish.sessionId, message })
      .then((success) => { if (success) markAgentAttentionNotified(id); })
      .catch((error: unknown) => console.warn("[Agent attention] Phone notification failed", error))
      .finally(() => { publishingIds.current.delete(id); });
  }, [toPublish, sessionTitle]);
  const stack = activeAgentAttentionStack(items, availableIds, now);
  const visible = stack[0];
  const snoozeQueue = (until: number) => {
    snoozeActionableAttentionQueue(until, availableIds);
  };
  const dismissQueue = async () => {
    // Snapshot the entire actionable stack, not merely the front toast card.
    // A new request arriving during the async handoff belongs to a later batch.
    const targets = activeAgentAttentionStack(loadAgentAttention(), availableIds);
    if (!targets.length) return;
    setDismissing(true);
    setDismissError(false);
    try {
      const results = await Promise.all(targets.map(async (item) => {
        try { return await onDismiss(item); }
        catch { return false; }
      }));
      const successful = targets.filter((_, index) => results[index]);
      const changed = resolveAttentionQueueEntries(successful.map((item) => item.id));
      // Persistent Ctrl+D flags stay enabled, but a dismissed yellow alert
      // becomes armed for the next completed turn. Never send a dismissal
      // message to those sessions.
      if (environmentId) {
        const sessions = readChatGPTBrowserSessions(environmentId);
        const rearmed = new Set<string>();
        for (const item of changed) {
          if (item.source !== "manual") continue;
          const session = sessions.find((entry) =>
            entry.id === item.sessionId ||
            entry.bootstrapIdentity?.publicId === item.sessionId);
          if (!session || rearmed.has(session.id)) continue;
          rearmed.add(session.id);
          rearmPersistentSessionAttention(environmentId, session,
            readChatGPTProviderActivity(environmentId, session.id));
        }
      }
      if (results.some((success) => !success)) setDismissError(true);
    } finally {
      setDismissing(false);
    }
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Plays a single external notification sound or speech cue when the current alert becomes visible.
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
  }, [visible]);
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
        <button className="rounded-md border px-2 py-2"
          onClick={() => snoozeQueue(Date.now() + 10 * 60_000)}>10 min (all)</button>
        <Menu onOpenChange={(open) => {
          if (open && environmentId)
            setSnoozePresets(resolveSnoozePresets(new Date(), timestampFormat, environmentId));
        }}>
          <MenuTrigger
            render={<button type="button" disabled={!environmentId}
              className="flex items-center gap-1 rounded-md border px-2 py-2 disabled:opacity-50" />}
          >
            Snooze all <ChevronUpIcon className="size-3" aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup side="top" align="end" positionerClassName="z-[10001]">
            {snoozePresets.map((preset) => (
              <MenuItem key={preset.id} onClick={() => {
                if (!environmentId) return;
                const chosen = pickSnoozePreset(snoozePresets, preset.id, timestampFormat, environmentId);
                if (chosen) snoozeQueue(Date.parse(chosen.snoozedUntil));
              }}>
                <MenuItemLabel>{preset.label}</MenuItemLabel>
                <span className="ml-auto text-xs text-muted-foreground">{preset.whenLabel}</span>
              </MenuItem>
            ))}
            <MenuItem onClick={() => {
              setCustomSnoozeOpen(true);
              void requestCustomSnooze()
                .then((choice) => {
                  if (choice) snoozeQueue(Date.parse(choice.snoozedUntil));
                })
                .finally(() => setCustomSnoozeOpen(false));
            }}>Custom…</MenuItem>
          </MenuPopup>
        </Menu>
        <button disabled={dismissing} className="rounded-md border px-2 py-2 disabled:opacity-50"
          onClick={() => { void dismissQueue(); }}>
          {dismissing ? "Dismissing…" : "Dismiss all"}
        </button>
      </div>
      {dismissError && <p role="alert" className="mt-2 text-xs text-destructive">Some agent requests could not be dismissed. Those alerts remain queued.</p>}
    </section>
  );
}
