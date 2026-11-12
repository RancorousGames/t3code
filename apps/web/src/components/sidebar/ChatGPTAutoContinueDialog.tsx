import { useState, type FormEvent } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";

type TimeUnit = "minutes" | "hours" | "days" | "weeks";
const unitMinutes: Record<TimeUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 1440,
  weeks: 10080,
};
const durationPresets = [60, 120, 240, 480];
const timeScale = (minutes: number): [number, TimeUnit] =>
  minutes % 10080 === 0
    ? [minutes / 10080, "weeks"]
    : minutes % 1440 === 0
      ? [minutes / 1440, "days"]
      : minutes % 60 === 0
        ? [minutes / 60, "hours"]
        : [minutes, "minutes"];

export interface AutoContinueConfig {
  mode: "idle" | "queued" | "periodic" | "startup";
  intervalMinutes: number;
  createdAt: number;
  expiresAt: number | null;
  beginAt?: number | null;
  repeatPrompt?: string | null;
  autoRebootMinutes?: number | null;
  autoRebootEveryRuns?: number | null;
}

export interface AutoContinueRequest {
  mode: "queued" | "periodic";
  durationMinutes?: number;
  intervalMinutes: number;
  beginAt?: number;
  repeatPrompt: string;
  autoRebootMinutes: number | null;
  autoRebootEveryRuns: number | null;
}

export function ChatGPTAutoContinueDialog({
  existing,
  close,
  submit,
}: {
  existing: AutoContinueConfig | null;
  close: () => void;
  submit: (input: AutoContinueRequest) => Promise<void>;
}) {
  const [frequency, setFrequency] = useState<"slot" | "periodic">(
    existing?.mode === "periodic" ? "periodic" : "slot",
  );
  const [intervalAmount, initialUnit] = timeScale(
    existing?.mode === "periodic" ? existing.intervalMinutes : 1440,
  );
  const [every, setEvery] = useState(String(intervalAmount));
  const [everyUnit, setEveryUnit] = useState<TimeUnit>(initialUnit);
  const [firstDue, setFirstDue] = useState(() => {
    if (!existing?.beginAt || existing.beginAt <= Date.now()) return "";
    const local = new Date(existing.beginAt - new Date().getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  });
  const priorDuration =
    existing?.expiresAt == null
      ? null
      : Math.max(
          1,
          Math.round((existing.expiresAt - (existing.beginAt ?? existing.createdAt)) / 60_000),
        );
  const [duration, setDuration] = useState(
    String(
      priorDuration === null
        ? "forever"
        : durationPresets.includes(priorDuration)
          ? priorDuration
          : "custom",
    ),
  );
  const [customHours, setCustomHours] = useState(String((priorDuration ?? 180) / 60));
  const [prompt, setPrompt] = useState(existing?.repeatPrompt ?? "");
  const [rebootRule, setRebootRule] = useState(
    existing?.autoRebootEveryRuns ? "runs" : existing?.autoRebootMinutes ? "time" : "off",
  );
  const [rebootAmount, rebootUnit] = timeScale(existing?.autoRebootMinutes ?? 1440);
  const [rebootEvery, setRebootEvery] = useState(
    String(existing?.autoRebootEveryRuns ?? rebootAmount),
  );
  const [rebootEveryUnit, setRebootEveryUnit] = useState<TimeUnit>(rebootUnit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const intervalMinutes = Number(every) * unitMinutes[everyUnit];
  const durationMinutes =
    duration === "forever"
      ? undefined
      : duration === "custom"
        ? Math.round(Number(customHours) * 60)
        : Number(duration);
  const rebootMinutes =
    rebootRule === "time" ? Number(rebootEvery) * unitMinutes[rebootEveryUnit] : null;
  const rebootRuns = rebootRule === "runs" ? Number(rebootEvery) : null;
  const firstDueAt = firstDue ? new Date(firstDue).getTime() : undefined;
  const valid =
    prompt.length <= 29_800 &&
    (frequency !== "periodic" ||
      (Number.isInteger(intervalMinutes) && intervalMinutes >= 1 && intervalMinutes <= 525_600)) &&
    (durationMinutes === undefined ||
      (Number.isInteger(durationMinutes) && durationMinutes >= 1 && durationMinutes <= 525_600)) &&
    (firstDueAt === undefined ||
      (Number.isSafeInteger(firstDueAt) &&
        firstDueAt > Date.now() &&
        firstDueAt <= Date.now() + 90 * 24 * 60 * 60_000)) &&
    (rebootMinutes === null ||
      (Number.isInteger(rebootMinutes) && rebootMinutes >= 1 && rebootMinutes <= 525_600)) &&
    (rebootRuns === null ||
      (Number.isInteger(rebootRuns) && rebootRuns >= 1 && rebootRuns <= 10_000));

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await submit({
        mode: frequency === "slot" ? "queued" : "periodic",
        intervalMinutes: frequency === "slot" ? 20 : intervalMinutes,
        ...(durationMinutes === undefined ? {} : { durationMinutes }),
        ...(frequency === "periodic" && firstDueAt !== undefined ? { beginAt: firstDueAt } : {}),
        repeatPrompt: prompt.trim(),
        autoRebootMinutes: rebootMinutes,
        autoRebootEveryRuns: rebootRuns,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const inputClass = "mt-1 w-full rounded-md border border-input bg-background px-2 py-2";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Auto-continue</DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void onSubmit(event)}>
          <div className="max-h-[70vh] space-y-4 overflow-y-auto px-6 pb-4">
            <label className="block text-sm">
              Trigger
              <select
                className={inputClass}
                value={frequency}
                onChange={(event) => setFrequency(event.target.value as typeof frequency)}
              >
                <option value="slot">Whenever a Keep T3 Busy slot is available</option>
                <option value="periodic">At a recurring interval</option>
              </select>
            </label>
            {frequency === "periodic" && (
              <>
                <div className="grid grid-cols-[1fr_1fr] gap-2">
                  <label className="text-sm">
                    Every
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
                      <option value="minutes">Minutes</option>
                      <option value="hours">Hours</option>
                      <option value="days">Days</option>
                      <option value="weeks">Weeks</option>
                    </select>
                  </label>
                </div>
                <label className="block text-sm">
                  First run at (optional)
                  <Input
                    className="mt-1"
                    type="datetime-local"
                    aria-label="First scheduled run"
                    value={firstDue}
                    onChange={(event) => setFirstDue(event.target.value)}
                  />
                  <span className="text-xs text-muted-foreground">
                    Leave empty to start after the first interval. Missed intervals never
                    accumulate.
                  </span>
                </label>
              </>
            )}
            <label className="block text-sm">
              Stop auto-continue
              <select
                className={inputClass}
                value={duration}
                onChange={(event) => setDuration(event.target.value)}
              >
                <option value="forever">Never — until stopped</option>
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
              Recurring prompt (optional)
              <textarea
                className={inputClass}
                rows={3}
                maxLength={29_800}
                value={prompt}
                aria-label="Recurring prompt"
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Leave empty to continue the current assignment."
              />
            </label>
            <label className="block text-sm">
              Automatic reboot
              <select
                className={inputClass}
                value={rebootRule}
                onChange={(event) => setRebootRule(event.target.value)}
              >
                <option value="off">Off</option>
                <option value="time">After a time interval (before the next run)</option>
                <option value="runs">After N completed runs (before the next run)</option>
              </select>
            </label>
            {rebootRule !== "off" && (
              <div className="grid grid-cols-[1fr_1fr] gap-2">
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
                      <option value="minutes">Minutes</option>
                      <option value="hours">Hours</option>
                      <option value="days">Days</option>
                      <option value="weeks">Weeks</option>
                    </select>
                  </label>
                )}
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || busy}>
              {busy ? "Saving…" : "Save auto-continue"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
