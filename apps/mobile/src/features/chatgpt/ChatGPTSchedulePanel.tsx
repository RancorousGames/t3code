import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/AppText";

export interface MobileChatGPTSchedule {
  title: string;
  prompt: string;
  beginAt: number | null;
  onIdle: boolean;
}

export interface MobileChatGPTScheduledEntry {
  sessionId: string;
  beginAt: number | null;
  onIdle?: boolean;
  mode: string;
  pendingWake?: boolean;
}
export interface MobileChatGPTScheduledJob {
  id: string;
  title: string;
  beginAt: number | null;
  onIdle?: boolean;
  status: string;
  error?: string;
}

const localDateInput = (timestamp: number) => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

const parseLocalDate = (value: string): number | null => {
  const match = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  if (date.getFullYear() !== Number(year) || date.getMonth() + 1 !== Number(month) ||
      date.getDate() !== Number(day) || date.getHours() !== Number(hour) ||
      date.getMinutes() !== Number(minute)) return null;
  return date.getTime();
};

function ActionButton({ label, active, onPress, disabled }: {
  label: string; active?: boolean; onPress: () => void; disabled?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled}
    onPress={onPress} className={`rounded-xl border px-3 py-2 ${active ? "border-accent bg-accent/15" : "border-border bg-subtle"} ${disabled ? "opacity-40" : ""}`}>
    <Text className="text-sm text-foreground">{label}</Text>
  </Pressable>;
}

export function ChatGPTSchedulePanel({
  targetTitle, onCreate, onClose, busy, scheduledJobs, scheduledEntries, onCancelJob, onCancelExisting, onRefreshJobs,
}: {
  targetTitle: string | null;
  onCreate: (input: MobileChatGPTSchedule) => Promise<boolean>;
  onClose: () => void;
  busy: boolean;
  scheduledJobs: readonly MobileChatGPTScheduledJob[];
  scheduledEntries: readonly MobileChatGPTScheduledEntry[];
  onCancelExisting: (id: string) => Promise<void>;
  onCancelJob: (id: string) => Promise<void>;
  onRefreshJobs: () => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [onIdle, setOnIdle] = useState(false);
  const [dateInput, setDateInput] = useState(() => localDateInput(Date.now() + 3_600_000));
  const [error, setError] = useState("");
  const target = targetTitle ?? "New ChatGPT session";
  const beginAt = onIdle ? null : parseLocalDate(dateInput);
  const valid = Boolean(prompt.trim() && prompt.length <= 8_000 &&
    (targetTitle !== null || (title.trim() && title.length <= 120)) &&
    (onIdle || (beginAt !== null && beginAt > Date.now() &&
      beginAt <= Date.now() + 90 * 86_400_000)));
  const send = async () => {
    if (!valid || busy) return;
    setError("");
    const success = await onCreate({ title: title.trim(), prompt: prompt.trim(), beginAt, onIdle });
    if (success) onClose();
    else setError("The desktop did not confirm the schedule. Inspect the receipt before trying again.");
  };
  return (
    <View className="gap-3 rounded-2xl border border-border bg-screen p-4">
      <View className="flex-row items-center justify-between">
        <View className="min-w-0 flex-1">
          <Text className="text-lg font-semibold text-foreground">Schedule ChatGPT work</Text>
          <Text className="text-xs text-foreground-muted">{target}</Text>
        </View>
        <ActionButton label="Close" disabled={busy} onPress={onClose} />
      </View>
      {targetTitle === null ? (
        <TextInput accessibilityLabel="Scheduled session title" placeholder="Session title"
          maxLength={120} value={title} onChangeText={setTitle}
          className="rounded-xl border border-border bg-subtle px-3 py-3 text-foreground" />
      ) : null}
      <TextInput accessibilityLabel="Scheduled ChatGPT prompt"
        placeholder="Describe the task to run…" multiline textAlignVertical="top"
        maxLength={8_000} value={prompt} onChangeText={setPrompt}
        className="min-h-36 rounded-xl border border-border bg-subtle p-3 text-foreground" />
      <Text className="text-right text-xs text-foreground-muted">{prompt.length} / 8,000</Text>
      <View className="flex-row flex-wrap gap-2">
        <ActionButton label="At a time" active={!onIdle} disabled={busy} onPress={() => setOnIdle(false)} />
        <ActionButton label="Begin on idle" active={onIdle} disabled={busy} onPress={() => setOnIdle(true)} />
      </View>
      {onIdle ? (
        <Text className="rounded-xl bg-subtle p-3 text-sm text-foreground-muted">
          Wait for a free Keep T3 Busy slot. This work takes priority over new TaskBoard assignments. Keep T3 Busy must be enabled on the desktop.
        </Text>
      ) : (
        <View className="gap-2">
          <Text className="text-sm font-medium text-foreground">Begin at (device local time)</Text>
          <View className="flex-row flex-wrap gap-2">
            {[30, 60, 120, 240, 1440].map((minutes) => (
              <ActionButton key={minutes}
                label={minutes === 1440 ? "Tomorrow" : minutes < 60 ? "30m" : `${minutes / 60}h`}
                disabled={busy} onPress={() => setDateInput(localDateInput(Date.now() + minutes * 60_000))} />
            ))}
          </View>
          <TextInput accessibilityLabel="Scheduled date and time"
            placeholder="YYYY-MM-DD HH:mm" value={dateInput} onChangeText={setDateInput}
            autoCapitalize="none" keyboardType="numbers-and-punctuation"
            className="rounded-xl border border-border bg-subtle px-3 py-3 text-foreground" />
          <Text className="text-xs text-foreground-muted">
            {beginAt && valid
              ? `Triggers ${new Date(beginAt).toLocaleString()} when desktop is running (up to 90 days).`
              : "Use YYYY-MM-DD HH:mm, future date within 90 days."}
          </Text>
        </View>
      )}
      {error ? <Text accessibilityRole="alert" className="text-sm text-danger">{error}</Text> : null}
      <ActionButton label={busy ? "Scheduling…" : "Schedule task"} disabled={!valid || busy}
        onPress={() => void send()} />
      {scheduledEntries.length > 0 ? (
        <View className="gap-2 border-t border-border pt-3">
          <Text className="text-sm font-semibold text-foreground">Scheduled existing sessions</Text>
          {scheduledEntries.map((entry) => (
            <View key={entry.sessionId} className="flex-row items-center gap-2 rounded-xl bg-subtle p-3">
              <View className="min-w-0 flex-1">
                <Text className="text-sm text-foreground" numberOfLines={1}>{entry.sessionId}</Text>
                <Text className="text-xs text-foreground-muted">
                  {entry.onIdle ? "Begin on idle" : entry.beginAt
                    ? new Date(entry.beginAt).toLocaleString() : "Pending"} · {entry.mode}
                </Text>
              </View>
              <ActionButton label="Cancel" disabled={busy}
                onPress={() => void onCancelExisting(entry.sessionId)} />
            </View>
          ))}
        </View>
      ) : null}
      {targetTitle === null ? (
        <View className="gap-2 border-t border-border pt-3">
          <View className="flex-row items-center justify-between">
            <Text className="text-sm font-semibold text-foreground">Scheduled new sessions</Text>
            <ActionButton label="Refresh" disabled={busy} onPress={() => void onRefreshJobs()} />
          </View>
          {scheduledJobs.length === 0
            ? <Text className="text-xs text-foreground-muted">No scheduled sessions loaded.</Text>
            : scheduledJobs.map((job) => (
              <View key={job.id} className="flex-row items-center gap-2 rounded-xl bg-subtle p-3">
                <View className="min-w-0 flex-1">
                  <Text numberOfLines={1} className="font-medium text-foreground">{job.title}</Text>
                  <Text className="text-xs text-foreground-muted">
                    {job.onIdle ? "Begin on idle" : job.beginAt ? new Date(job.beginAt).toLocaleString() : "No time"} · {job.status}
                  </Text>
                  {job.error ? <Text className="text-xs text-danger">{job.error}</Text> : null}
                </View>
                {job.status === "scheduled" ? (
                  <ActionButton label="Cancel" disabled={busy} onPress={() => void onCancelJob(job.id)} />
                ) : null}
              </View>
            ))}
        </View>
      ) : null}
    </View>
  );
}
