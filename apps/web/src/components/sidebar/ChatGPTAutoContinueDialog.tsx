import { useState, type FormEvent } from "react";
import { AlarmClockIcon, CheckIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import type { ScheduledChatGPTJob } from "./ChatGPTDelayedPromptDialog";

type TimeUnit = "minutes" | "hours" | "days" | "weeks";
const unitMinutes: Record<TimeUnit, number> = { minutes: 1, hours: 60, days: 1440, weeks: 10080 };
const timeScale = (minutes: number): [number, TimeUnit] =>
  minutes % 10080 === 0
    ? [minutes / 10080, "weeks"]
    : minutes % 1440 === 0
      ? [minutes / 1440, "days"]
      : minutes % 60 === 0
        ? [minutes / 60, "hours"]
        : [minutes, "minutes"];
const dateTimeLocal = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
const maxDelayMs = 90 * 24 * 60 * 60_000;

export interface AutoContinueConfig {
  mode: "idle" | "periodic" | "startup";
  respectSlots?: boolean;
  onceOnly: boolean;
  intervalMinutes: number;
  createdAt: number;
  expiresAt: number | null;
  beginAt?: number | null;
  delayedPrompt?: string | null;
  repeatPrompt?: string | null;
  autoRebootMinutes?: number | null;
  autoRebootEveryRuns?: number | null;
}

export type CaffyScheduleTarget =
  | {
      kind: "session";
      sessionId: string;
      title: string;
      intent: "once" | "recurring";
      config: AutoContinueConfig | null;
      beginAt?: number;
      legacyMonitors: Array<{ id: string; targetId: string; status: string }>;
    }
  | { kind: "new" }
  | { kind: "scheduled"; job: ScheduledChatGPTJob; prompt: string };

export interface CaffyScheduleRequest {
  frequency: "once" | "idle" | "periodic";
  start: "now" | "later";
  beginAt: number | null;
  respectSlots: boolean;
  intervalMinutes: number;
  durationMinutes?: number;
  prompt: string;
  recurringPrompt: string;
  autoRebootMinutes: number | null;
  autoRebootEveryRuns: number | null;
}

export function ChatGPTCaffyScheduleDialog({
  target,
  jobs,
  close,
  submit,
  cancelJob,
  cancelLegacy,
}: {
  target: CaffyScheduleTarget;
  jobs: readonly ScheduledChatGPTJob[];
  close: () => void;
  submit: (input: CaffyScheduleRequest) => Promise<void>;
  cancelJob: (id: string) => Promise<void>;
  cancelLegacy?: (id: string, targetId: string) => Promise<void>;
}) {
  const isSession = target.kind === "session";
  const config = isSession ? target.config : null;
  const priorSpawn = target.kind === "scheduled" ? target.job.caffy : null;
  const initialFrequency: CaffyScheduleRequest["frequency"] = config?.onceOnly
    ? "once"
    : config && target.kind === "session" && target.intent === "recurring"
      ? config.mode === "periodic"
        ? "periodic"
        : "idle"
      : priorSpawn
        ? priorSpawn.mode === "periodic"
          ? "periodic"
          : "idle"
        : target.kind === "session" && target.intent === "recurring"
          ? "idle"
          : "once";
  const [frequency, setFrequency] = useState(initialFrequency);
  const [openedAt] = useState(Date.now);
  const scheduledAt =
    target.kind === "scheduled"
      ? target.job.beginAt
      : target.kind === "session"
        ? (target.beginAt ?? (target.intent === "recurring" ? config?.beginAt : null))
        : null;
  const [start, setStart] = useState<"now" | "later">(
    target.kind === "new"
      ? "later"
      : target.kind === "scheduled"
        ? target.job.onIdle
          ? "now"
          : "later"
        : scheduledAt && scheduledAt > openedAt
          ? "later"
          : "now",
  );
  const [when, setWhen] = useState(() =>
    dateTimeLocal(
      new Date(scheduledAt && scheduledAt > openedAt ? scheduledAt : openedAt + 60 * 60_000),
    ),
  );
  const [respectSlots, setRespectSlots] = useState(
    config?.respectSlots ?? priorSpawn?.respectSlots ?? target.kind !== "session",
  );
  const [prompt, setPrompt] = useState(
    target.kind === "scheduled"
      ? target.prompt
      : target.kind === "session" && target.intent === "recurring"
        ? (config?.repeatPrompt ?? "")
        : target.kind === "session"
          ? (config?.delayedPrompt ?? (config?.onceOnly ? (config?.repeatPrompt ?? "") : ""))
          : "",
  );
  const [recurringPrompt, setRecurringPrompt] = useState(priorSpawn?.repeatPrompt ?? "");
  const [intervalAmount, intervalUnit] = timeScale(
    config?.mode === "periodic" ? config.intervalMinutes : (priorSpawn?.intervalMinutes ?? 60),
  );
  const [every, setEvery] = useState(String(intervalAmount));
  const [everyUnit, setEveryUnit] = useState<TimeUnit>(intervalUnit);
  const priorDuration =
    priorSpawn?.durationMinutes ??
    (config?.expiresAt == null
      ? null
      : Math.max(
          1,
          Math.round((config.expiresAt - (config.beginAt ?? config.createdAt)) / 60_000),
        ));
  const [duration, setDuration] = useState(
    priorDuration === null
      ? "forever"
      : [60, 120, 240, 480].includes(priorDuration)
        ? String(priorDuration)
        : "custom",
  );
  const [customHours, setCustomHours] = useState(String((priorDuration ?? 180) / 60));
  const initialRebootRuns = config?.autoRebootEveryRuns ?? priorSpawn?.autoRebootEveryRuns;
  const initialRebootMinutes = config?.autoRebootMinutes ?? priorSpawn?.autoRebootMinutes;
  const [rebootRule, setRebootRule] = useState(
    initialRebootRuns ? "runs" : initialRebootMinutes ? "time" : "off",
  );
  const [rebootValue, rebootUnit] = timeScale(initialRebootMinutes ?? 1440);
  const [rebootEvery, setRebootEvery] = useState(String(initialRebootRuns ?? rebootValue));
  const [rebootEveryUnit, setRebootEveryUnit] = useState<TimeUnit>(rebootUnit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelledLegacy, setCancelledLegacy] = useState<ReadonlySet<string>>(new Set());
  const legacy =
    target.kind === "session"
      ? target.legacyMonitors.filter((item) => !cancelledLegacy.has(item.id))
      : [];
  const recurring = frequency !== "once";
  const timestamp = new Date(when).getTime();
  const validTime =
    (Number.isSafeInteger(timestamp) &&
      timestamp > openedAt &&
      timestamp <= openedAt + maxDelayMs) ||
    (target.kind === "scheduled" && timestamp === target.job.beginAt);
  const intervalMinutes = Number(every) * unitMinutes[everyUnit];
  const durationMinutes =
    duration === "forever"
      ? undefined
      : duration === "custom"
        ? Math.round(Number(customHours) * 60)
        : Number(duration);
  const rebootMinutes =
    rebootRule === "time" && recurring ? Number(rebootEvery) * unitMinutes[rebootEveryUnit] : null;
  const rebootRuns = rebootRule === "runs" && recurring ? Number(rebootEvery) : null;
  const valid =
    (isSession || prompt.trim().length > 0) &&
    prompt.length <= 29_800 &&
    recurringPrompt.length <= 29_800 &&
    (start !== "later" || validTime) &&
    (frequency !== "periodic" ||
      (Number.isInteger(intervalMinutes) && intervalMinutes >= 1 && intervalMinutes <= 525_600)) &&
    (!recurring ||
      durationMinutes === undefined ||
      (Number.isInteger(durationMinutes) && durationMinutes >= 1 && durationMinutes <= 525_600)) &&
    (rebootMinutes === null ||
      (Number.isInteger(rebootMinutes) && rebootMinutes >= 1 && rebootMinutes <= 525_600)) &&
    (rebootRuns === null ||
      (Number.isInteger(rebootRuns) && rebootRuns >= 1 && rebootRuns <= 10_000));
  const inputClass = "mt-1 w-full rounded-md border border-input bg-background px-2 py-2";

  const preset = (minutes: number) => {
    setWhen(dateTimeLocal(new Date(openedAt + minutes * 60_000)));
    setError(null);
  };
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await submit({
        frequency,
        start,
        beginAt: start === "later" ? timestamp : null,
        respectSlots,
        intervalMinutes: frequency === "periodic" ? intervalMinutes : 20,
        ...(recurring && durationMinutes !== undefined ? { durationMinutes } : {}),
        prompt: prompt.trim(),
        recurringPrompt: recurringPrompt.trim(),
        autoRebootMinutes: rebootMinutes,
        autoRebootEveryRuns: rebootRuns,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const cancelOldMonitor = async (id: string, targetId: string) => {
    if (!cancelLegacy || busy) return;
    setBusy(true);
    setError(null);
    try {
      await cancelLegacy(id, targetId);
      setCancelledLegacy((current) => new Set([...current, id]));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const title = "Caffy schedule";
  const subtitle =
    target.kind === "session"
      ? `Existing: ${target.title}`
      : target.kind === "scheduled"
        ? "Edit scheduled new session"
        : "Create a new ChatGPT session";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup className="flex h-[min(760px,calc(100dvh-32px))] w-full flex-col overflow-hidden sm:max-w-xl">
        <DialogHeader className="shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
              {target.kind === "new" ? (
                <PlusIcon className="size-4" />
              ) : (
                <AlarmClockIcon className="size-4" />
              )}
            </div>
            <div className="min-w-0">
              <DialogTitle>{title}</DialogTitle>
              <p className="mt-1 truncate text-xs text-muted-foreground">{subtitle}</p>
            </div>
          </div>
        </DialogHeader>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void onSubmit(event)}>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-4">
            <div className="space-y-1.5">
              <span className="text-sm font-medium">Run</span>
              <div className="grid grid-cols-3 gap-1 rounded-md border border-input p-1">
                {(
                  [
                    ["once", "Once"],
                    ["idle", "Keep running"],
                    ["periodic", "At intervals"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={frequency === value}
                    className={`rounded px-2 py-2 text-sm ${
                      frequency === value
                        ? "bg-accent font-medium text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent/50"
                    }`}
                    onClick={() => setFrequency(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="min-h-8 text-xs text-muted-foreground">
                {frequency === "once"
                  ? "Send one message, then stop."
                  : frequency === "idle"
                    ? "Continue after each completed reply until stopped."
                    : "Continue on a repeating timer; wait for idle if still working."}
              </p>
            </div>
            <div className="space-y-2">
              <span className="text-sm font-medium">Start</span>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={start === "now" ? "default" : "outline"}
                  aria-pressed={start === "now"}
                  onClick={() => setStart("now")}
                >
                  Now / when ready
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={start === "later" ? "default" : "outline"}
                  aria-pressed={start === "later"}
                  onClick={() => setStart("later")}
                >
                  At a later time
                </Button>
              </div>
            </div>
            <label className="flex min-h-8 items-center gap-2 text-sm">
              <Switch
                checked={respectSlots}
                disabled={!isSession && !recurring}
                onCheckedChange={setRespectSlots}
              />
              Respect T3 working slots
              {!isSession && (
                <span className="text-xs text-muted-foreground">
                  (new sessions always wait for capacity)
                </span>
              )}
            </label>
            <label className="block text-sm font-medium">
              {isSession ? "Message (optional)" : "Initial prompt for new session (required)"}
              <textarea
                className={`${inputClass} h-28 resize-none text-sm font-normal`}
                rows={4}
                maxLength={29_800}
                value={prompt}
                aria-label="Message to send"
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={
                  isSession
                    ? "Leave empty to continue the current assignment."
                    : "Describe what the new ChatGPT session should do."
                }
              />
              <span className="block text-right text-xs font-normal text-muted-foreground">
                {prompt.length.toLocaleString()} / 29,800
              </span>
            </label>
            {legacy.length > 0 && (
              <div
                role="alert"
                className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
              >
                <p>
                  An older OmniHub monitor owns this session. Stop it before saving to avoid
                  duplicate wakes.
                </p>
                {legacy.map((item) => (
                  <Button
                    key={item.id}
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy || !cancelLegacy}
                    onClick={() => void cancelOldMonitor(item.id, item.targetId)}
                  >
                    Stop legacy monitor ({item.status})
                  </Button>
                ))}
              </div>
            )}
            {start === "later" && (
              <div className="space-y-2 rounded-lg border border-border p-3">
                <div className="flex flex-wrap gap-1.5">
                  {[
                    [30, "30 min"],
                    [60, "1 hour"],
                    [120, "2 hours"],
                    [240, "4 hours"],
                    [1440, "Tomorrow"],
                  ].map(([minutes, label]) => (
                    <Button
                      key={minutes}
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => preset(minutes as number)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
                <Input
                  aria-label="Scheduled local date and time"
                  type="datetime-local"
                  value={when}
                  onChange={(event) => setWhen(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {validTime
                    ? `Starts ${new Date(timestamp).toLocaleString()} (local time).`
                    : "Choose a future time within 90 days."}{" "}
                  T3 must be running.
                </p>
              </div>
            )}
            {frequency === "periodic" && recurring && (
              <div className="grid grid-cols-2 gap-2">
                <label className="text-sm">
                  Repeat every
                  <Input
                    className="mt-1"
                    type="number"
                    min="1"
                    step="1"
                    aria-label="Repeat every"
                    value={every}
                    onChange={(event) => setEvery(event.target.value)}
                  />
                </label>
                <label className="text-sm">
                  Unit
                  <select
                    className={inputClass}
                    value={everyUnit}
                    onChange={(event) => setEveryUnit(event.target.value as TimeUnit)}
                  >
                    {(["minutes", "hours", "days", "weeks"] as const).map((unit) => (
                      <option key={unit} value={unit}>
                        {unit}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {recurring && !isSession && (
              <label className="block text-sm font-medium">
                Recurring message (optional)
                <textarea
                  className={`${inputClass} h-20 resize-none text-sm font-normal`}
                  rows={2}
                  maxLength={29_800}
                  value={recurringPrompt}
                  onChange={(event) => setRecurringPrompt(event.target.value)}
                  placeholder="Leave empty to continue the new session's assignment."
                />
              </label>
            )}
            {recurring && (
              <>
                <label className="block text-sm">
                  Stop repeating
                  <select
                    className={inputClass}
                    value={duration}
                    onChange={(event) => setDuration(event.target.value)}
                  >
                    <option value="forever">Never (until stopped)</option>
                    <option value="60">After 1 hour</option>
                    <option value="120">After 2 hours</option>
                    <option value="240">After 4 hours</option>
                    <option value="480">After 8 hours</option>
                    <option value="custom">Custom duration</option>
                  </select>
                </label>
                {duration === "custom" && (
                  <label className="block text-sm">
                    Duration (hours)
                    <Input
                      className="mt-1"
                      type="number"
                      min="0.02"
                      max="8760"
                      step="any"
                      value={customHours}
                      onChange={(event) => setCustomHours(event.target.value)}
                    />
                  </label>
                )}
                <label className="block text-sm">
                  Automatic reboot
                  <select
                    className={inputClass}
                    value={rebootRule}
                    onChange={(event) => setRebootRule(event.target.value)}
                  >
                    <option value="off">Off</option>
                    <option value="time">After a time interval</option>
                    <option value="runs">After N completed runs</option>
                  </select>
                </label>
                {rebootRule !== "off" && (
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-sm">
                      {rebootRule === "runs" ? "Runs" : "Every"}
                      <Input
                        className="mt-1"
                        type="number"
                        min="1"
                        step="1"
                        value={rebootEvery}
                        onChange={(event) => setRebootEvery(event.target.value)}
                      />
                    </label>
                    {rebootRule === "time" && (
                      <label className="text-sm">
                        Unit
                        <select
                          className={inputClass}
                          value={rebootEveryUnit}
                          onChange={(event) => setRebootEveryUnit(event.target.value as TimeUnit)}
                        >
                          {(["minutes", "hours", "days", "weeks"] as const).map((unit) => (
                            <option key={unit} value={unit}>
                              {unit}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                )}
              </>
            )}
            {target.kind === "new" && jobs.length > 0 && (
              <div className="space-y-2 border-t border-border pt-3">
                <p className="text-xs font-medium text-muted-foreground">
                  Pending scheduled sessions
                </p>
                <div className="max-h-36 space-y-1.5 overflow-y-auto">
                  {jobs.map((job) => (
                    <div
                      key={job.id}
                      className="flex items-center gap-2 rounded-md border border-border p-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{job.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {job.onIdle
                            ? "When capacity is free"
                            : job.beginAt === null
                              ? "Unscheduled"
                              : new Date(job.beginAt).toLocaleString()}{" "}
                          · {job.status}
                        </p>
                      </div>
                      {job.status === "scheduled" ? (
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost-muted"
                          disabled={busy}
                          aria-label={`Cancel scheduled task ${job.title}`}
                          onClick={() => {
                            setBusy(true);
                            void cancelJob(job.id)
                              .catch((cause: unknown) =>
                                setError(cause instanceof Error ? cause.message : String(cause)),
                              )
                              .finally(() => setBusy(false));
                          }}
                        >
                          <Trash2Icon className="size-4" />
                        </Button>
                      ) : job.status === "created" ? (
                        <CheckIcon className="size-4" />
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter className="shrink-0">
            {target.kind === "scheduled" && (
              <Button
                type="button"
                variant="destructive-outline"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  void cancelJob(target.job.id)
                    .then(close)
                    .catch((cause: unknown) =>
                      setError(cause instanceof Error ? cause.message : String(cause)),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                Cancel scheduled session
              </Button>
            )}
            <Button type="button" variant="outline" disabled={busy} onClick={close}>
              {target.kind === "scheduled" ? "Close" : "Cancel"}
            </Button>
            <Button type="submit" disabled={!valid || busy || legacy.length > 0}>
              {busy
                ? "Saving…"
                : target.kind === "scheduled"
                  ? "Save changes"
                  : target.kind === "new"
                    ? "Schedule new session"
                    : frequency === "once"
                      ? "Schedule once"
                      : "Save Caffy schedule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
