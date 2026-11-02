import {
  AuthOrchestrationOperateScope,
  type ChatGPTRegistrySession,
  type ChatGPTRegistryMetadataPatch,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState, Pressable, RefreshControl, ScrollView, TextInput, View, type ScrollViewInstance,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { uuidv4 } from "../../lib/uuid";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentScope } from "../../state/session";
import { useWorkspaceState } from "../../state/workspace";
import {
  actChatGPTRegistry, listChatGPTRegistry, patchChatGPTRegistry,
  readChatGPTRegistryReceipt,
} from "../../state/chatGPTRegistry";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";

function elapsed(at: number | null, now: number): string {
  if (!at || !Number.isFinite(at)) return "never";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

type RegistryRead = {
  sessions: readonly ChatGPTRegistrySession[];
  driver: { online: boolean; lastSeenAt: number | null };
};
function title(row: ChatGPTRegistrySession): string {
  return typeof row.record.title === "string" ? row.record.title : row.sessionId;
}
function conversationId(row: ChatGPTRegistrySession): string | null {
  const value = row.snapshot?.conversationId;
  return typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value) ? value : null;
}
function status(row: ChatGPTRegistrySession, now: number): string {
  if (row.record.hidden === true) return "Hidden";
  if (typeof row.record.snoozedUntil === "number" && row.record.snoozedUntil > now) return "Snoozed";
  if (row.record.completion) return "Completed";
  if (!row.snapshot || now - row.snapshot.observedAt > 120_000) return "Last-known";
  if (row.snapshot.activity === "working") return "Working";
  if (row.snapshot.lastAssistantEndsWithQuestion) return "Needs you";
  if (row.snapshot.activity === "idle") return "Idle";
  if (row.snapshot.activity === "failed" || row.snapshot.activity === "interrupted") return "Needs attention";
  return "Last-known";
}
function NativeButton(props: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={`rounded-xl border border-border px-3 py-2 ${props.disabled ? "opacity-40" : "bg-subtle"}`}
    >
      <Text className="text-sm text-foreground">{props.label}</Text>
    </Pressable>
  );
}

/** Native browserless ChatGPT dashboard: never mounts the ChatGPT website.
 * A paired desktop remains the sole driver for send/reload/complete/recovery.
 * The server retains read-only last-known evidence while the desktop is down.
 */
export function ChatGPTSessionsScreen() {
  const workspace = useWorkspaceTabs();
  const { environments } = useWorkspaceState();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const environmentId = environments.find((entry) => entry.environmentId === selectedEnvironmentId)?.environmentId
    ?? environments[0]?.environmentId ?? null;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const list = useAtomCommand(listChatGPTRegistry, { reportFailure: false });
  const patch = useAtomCommand(patchChatGPTRegistry, { reportFailure: false });
  const act = useAtomCommand(actChatGPTRegistry, { reportFailure: false });
  const receipt = useAtomCommand(readChatGPTRegistryReceipt, { reportFailure: false });
  const [data, setData] = useState<RegistryRead | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [now, setNow] = useState(Date.now);
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollViewInstance>(null);
  const activeEnvironment = useRef(environmentId);
  activeEnvironment.current = environmentId;
  const inflightEnvironments = useRef(new Set<string>());
  const lastComposerTarget = useRef<string | null>(null);
  const query = workspace?.state.tabs.chatGPT.query.trim().toLowerCase() ?? "";

  const refresh = useCallback(async () => {
    if (!environmentId || inflightEnvironments.current.has(environmentId)) return;
    const target = environmentId;
    inflightEnvironments.current.add(target);
    setRefreshing(true);
    try {
      const response = await list({ environmentId: target, input: { environmentId: target } });
      // Switching between paired environments must not allow the first (slow)
      // response to overwrite the second environment's data and session IDs.
      if (activeEnvironment.current !== target) return;
      if (response._tag === "Success") {
        setData(response.value);
        setFeedback("");
      } else {
        setData((previous) => previous ? { ...previous, driver: { ...previous.driver, online: false } } : null);
        setFeedback("Registry unreachable. Last-known sessions remain visible; live actions disabled.");
      }
    } catch {
      if (activeEnvironment.current === target) {
        setData((previous) => previous ? { ...previous, driver: { ...previous.driver, online: false } } : null);
        setFeedback("Registry connection lost. Live actions are disabled.");
      }
    } finally {
      inflightEnvironments.current.delete(target);
      if (activeEnvironment.current === target) {
        setNow(Date.now());
        setRefreshing(false);
      }
    }
  }, [environmentId, list]);

  useEffect(() => {
    setData(null);
    setSelectedSessionId(null);
    setDraft("");
    void refresh();
  }, [environmentId, refresh]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void refresh();
    }, 8_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const rows = useMemo(() => (data?.sessions ?? [])
    .filter((row) => row.closedAt === null)
    .filter((row) => !query || [title(row), row.sessionId,
      typeof row.record.project === "string" ? row.record.project : ""]
      .some((value) => value.toLowerCase().includes(query)))
    .sort((a, b) => b.updatedAt - a.updatedAt), [data, query]);
  const selected = rows.find((row) => row.sessionId === selectedSessionId) ?? null;
  const online = data?.driver.online === true;
  const composerTarget = selected ? `${selected.sessionId}:${conversationId(selected) ?? "unobserved"}` : null;
  useEffect(() => {
    if (lastComposerTarget.current !== composerTarget) {
      lastComposerTarget.current = composerTarget;
      // A browser-session reboot can change the underlying conversation while
      // preserving its T3 identity. Never carry a private reply draft across.
      setDraft("");
    }
  }, [composerTarget]);

  const update = async (row: ChatGPTRegistrySession, patchValue: ChatGPTRegistryMetadataPatch) => {
    if (!row.publicSessionId) {
      setFeedback("This session is awaiting its Bootstrap ID; metadata was not changed.");
      return;
    }
    if (!environmentId || busy || !canOperate) return;
    setBusy(true);
    try {
      const response = await patch({
        environmentId,
        input: { environmentId, sessionId: row.publicSessionId, expectedUpdatedAt: row.updatedAt, patch: patchValue },
      });
      if (response._tag !== "Success" || !response.value.ok || !response.value.session) {
        setFeedback(response._tag === "Success"
          ? response.value.reason ?? "Metadata update rejected." : "Registry request failed.");
        return;
      }
      const updated = response.value.session;
      setData((before) => before ? { ...before, sessions: before.sessions.map((entry) =>
        entry.sessionId === updated.sessionId ? updated : entry) } : before);
      setFeedback(online ? "Metadata saved." : "Saved while desktop offline; will synchronize later.");
    } finally { setBusy(false); }
  };

  const operate = async (row: ChatGPTRegistrySession, actionId: string, args: Record<string, unknown>) => {
    if (!row.publicSessionId) {
      setFeedback("This session is not registered. Wait for its first assistant [T3_ID] marker.");
      return;
    }
    if (!environmentId || !online || busy || !canOperate) {
      setFeedback("Desktop offline or no permission; no action queued.");
      return;
    }
    const requestId = uuidv4();
    setBusy(true);
    try {
      const response = await act({
        environmentId,
        input: { requestId, environmentId, sessionId: row.publicSessionId, actionId, args },
      });
      if (response._tag !== "Success" || !response.value.ok) {
        setFeedback(response._tag === "Success" ? response.value.reason ?? "Desktop action refused."
          : "Unable to confirm the request. Do not resend without checking.");
        return;
      }
      setFeedback("Sent to desktop; awaiting the receipt. Will not resend.");
      for (let attempt = 0; attempt < 8; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const next = await receipt({ environmentId, input: { requestId } });
        if (next._tag !== "Success" || !next.value?.resolvedAt) continue;
        const result = next.value.result;
        setFeedback(result?.ok === true
          ? `Desktop: ${String(result.status ?? "action completed")}`
          : `Desktop: ${String(result?.reason ?? result?.status ?? "not completed")}`);
        return;
      }
      setFeedback("Desktop result not confirmed. The command was NOT sent again.");
    } finally { setBusy(false); }
  };

  return (
    <View className="flex-1 bg-screen">
      <ScrollView
        ref={scrollRef}
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12,
          paddingBottom: Math.max(insets.bottom, 24) + 90, gap: 12 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      >
        <Text className="text-xl font-semibold text-foreground">ChatGPT sessions</Text>
        <Text className="text-xs text-foreground-muted">
          {online ? "Desktop connected" : "Desktop offline"} · Last contact {elapsed(data?.driver.lastSeenAt ?? null, now)}
          {!online ? " · Last-known sessions only; live actions unavailable." : ""}
        </Text>
        {environments.length > 1 ? <View className="flex-row flex-wrap gap-2">
          {environments.map((environment) => (
            <NativeButton key={environment.environmentId}
              label={String(environment.environmentId).slice(0, 14)}
              onPress={() => setSelectedEnvironmentId(environment.environmentId)} />
          ))}
        </View> : null}
        {feedback ? <Text accessibilityRole="alert" className="rounded-lg bg-subtle p-3 text-xs text-foreground">{feedback}</Text> : null}
        {!environmentId ? <Text className="text-sm text-foreground-muted">Connect a T3 environment to view its ChatGPT sessions.</Text> : null}
        <Text className="text-xs font-medium text-foreground-muted">
          {rows.length} sessions · Tap a session to view its last exchange
        </Text>
        {rows.map((row) => (
          <Pressable
            key={row.sessionId}
            accessibilityRole="button"
            onPress={() => {
              setSelectedSessionId(row.sessionId);
              setDraft("");
              // The detail composer lives below the cards. Bring it into view
              // even when there are dozens of sessions in the dashboard.
              requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
            }}
            className={`rounded-xl border border-border bg-subtle p-3 ${!online ? "opacity-65" : ""}`}
          >
            <View className="flex-row items-center justify-between">
              <Text className="min-w-0 flex-1 text-sm font-semibold text-foreground" numberOfLines={1}>
                {title(row)}
              </Text>
              <Text className="ml-2 text-xs text-foreground-muted">{status(row, now)}</Text>
            </View>
            <Text className="mt-1 text-xs text-foreground-muted" numberOfLines={1}>
              {typeof row.record.project === "string" ? row.record.project : "Personal"} · {elapsed(row.updatedAt, now)}
            </Text>
            {row.snapshot?.lastAssistantText ? <Text className="mt-2 text-sm text-foreground" numberOfLines={2}>
              {row.snapshot.lastAssistantText}
            </Text> : null}
          </Pressable>
        ))}
        {selected ? (
          <View className="rounded-xl border border-border p-3">
            <Text className="text-lg font-semibold text-foreground">{title(selected)}</Text>
            <Text className="text-xs text-foreground-muted">{selected.publicSessionId ?? "Awaiting Bootstrap ID"}</Text>
            <Text className="mt-2 text-xs text-foreground-muted">
              Last user: {selected.snapshot?.lastUserText ?? "Not observed"}
            </Text>
            <Text className="mt-2 text-sm text-foreground">
              {selected.snapshot?.lastAssistantText ?? "No assistant exchange observed"}
            </Text>
            <TextInput
              accessibilityLabel="Message ChatGPT session"
              multiline
              value={draft}
              maxLength={8_000}
              onChangeText={setDraft}
              editable={online && !busy && canOperate}
              placeholder="Message this exact conversation"
              className="mt-3 min-h-20 rounded-lg border border-border bg-screen p-3 text-foreground"
            />
            <View className="mt-3 flex-row flex-wrap gap-2">
              <NativeButton label={selected.snapshot?.lastAssistantEndsWithQuestion ? "Answer" : "Send"}
                disabled={busy || !online || !canOperate || !draft.trim() || !conversationId(selected) || !selected.publicSessionId}
                onPress={() => void operate(selected, selected.snapshot?.lastAssistantEndsWithQuestion ? "answer" : "send", { message: draft.trim(),
                  expectedConversationId: conversationId(selected) })} />
              <NativeButton label="Retry" disabled={!online || busy || !canOperate || !selected.publicSessionId}
                onPress={() => void operate(selected, "retry_recovery", {})} />
              <NativeButton label="Reload" disabled={!online || busy || !canOperate || !selected.publicSessionId}
                onPress={() => void operate(selected, "reload", {})} />
              <NativeButton label="Complete" disabled={!online || busy || !canOperate || !selected.publicSessionId}
                onPress={() => void operate(selected, "complete", {})} />
              <NativeButton label="Snooze 1h" disabled={busy || !canOperate || !selected.publicSessionId}
                onPress={() => void update(selected, { snoozedUntil: Date.now() + 60 * 60_000 })} />
              <NativeButton label="Unsnooze" disabled={busy || !canOperate || !selected.publicSessionId}
                onPress={() => void update(selected, { snoozedUntil: null })} />
            </View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
