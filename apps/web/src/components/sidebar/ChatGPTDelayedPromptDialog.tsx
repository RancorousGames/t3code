import { useState, type FormEvent } from "react";
import { AlarmClockIcon, CalendarClockIcon, CheckIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";

export type DelayedPromptTarget =
  | { kind: "existing"; sessionId: string; sessionTitle: string; beginAt: number }
  | { kind: "new" };

export interface ScheduledChatGPTJob {
  id: string;
  title: string;
  beginAt: number | null;
  onIdle?: boolean;
  status: "scheduled" | "dispatching" | "created" | "uncertain";
  sessionId?: string;
  error?: string;
}

const maxDelayMs = 90 * 24 * 60 * 60_000;
const dateTimeLocal = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

export function ChatGPTDelayedPromptDialog({
  target, jobs, close, submit, cancelJob,
}: {
  target: DelayedPromptTarget;
  jobs: readonly ScheduledChatGPTJob[];
  close: () => void;
  submit: (input: { title: string; prompt: string; beginAt: number | null; onIdle: boolean }) => Promise<void>;
  cancelJob: (id: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [onIdle, setOnIdle] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [when, setWhen] = useState(() => dateTimeLocal(new Date(
    target.kind === "existing" ? target.beginAt : Date.now() + 60 * 60_000,
  )));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timestamp = new Date(when).getTime();
  const validTime = Number.isSafeInteger(timestamp) &&
    timestamp > Date.now() && timestamp <= Date.now() + maxDelayMs;
  const valid = (onIdle || validTime) && prompt.trim().length > 0 && prompt.length <= 29_800 &&
    (target.kind === "existing" || (title.trim().length > 0 && title.length <= 120));

  const setPreset = (minutes: number) => {
    setWhen(dateTimeLocal(new Date(Date.now() + minutes * 60_000)));
    setError(null);
  };
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await submit({ title: title.trim(), prompt: prompt.trim(), beginAt: onIdle ? null : timestamp, onIdle });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) close(); }}>
      <DialogPopup>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary">
              {target.kind === "new" ? <PlusIcon className="size-5" /> : <AlarmClockIcon className="size-5" />}
            </div>
            <div className="min-w-0">
              <DialogTitle>{target.kind === "new" ? "Schedule a new ChatGPT task" : "Begin working later"}</DialogTitle>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {target.kind === "new"
                  ? "A new session will be created when the deadline arrives."
                  : `Send a custom prompt to ${target.sessionTitle} at the selected time.`}
              </p>
            </div>
          </div>
        </DialogHeader>
        <form onSubmit={(event) => void onSubmit(event)}>
          <div className="space-y-5 px-6 pb-5">
            {target.kind === "new" && (
              <label className="block space-y-1.5 text-sm font-medium">
                Session title
                <Input autoFocus placeholder="What will this session work on?" maxLength={120}
                  value={title} onChange={(event) => setTitle(event.target.value)} required />
              </label>
            )}
            <label className="block space-y-1.5 text-sm font-medium">
              Prompt to send
              <textarea
                autoFocus={target.kind === "existing"}
                aria-label="Prompt to send when scheduled"
                placeholder="Describe exactly what ChatGPT should do when the time comes…"
                rows={7} maxLength={29_800} required
                className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2.5 text-sm leading-relaxed outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25"
                value={prompt} onChange={(event) => setPrompt(event.target.value)}
              />
              <span className="block text-right text-2xs font-normal tabular-nums text-muted-foreground">
                {prompt.length.toLocaleString()} / 29,800
              </span>
            </label>
            <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-3.5">
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" variant={!onIdle ? "default" : "outline"} size="sm"
                  onClick={() => setOnIdle(false)} aria-pressed={!onIdle}>At a time</Button>
                <Button type="button" variant={onIdle ? "default" : "outline"} size="sm"
                  onClick={() => setOnIdle(true)} aria-pressed={onIdle}>Begin on idle</Button>
              </div>
              {onIdle ? <p className="rounded-lg border border-primary/20 bg-primary/5 p-2.5 text-xs leading-relaxed text-muted-foreground">
                Wait for a free Keep T3 Busy slot, then send this prompt. Scheduled tasks take priority over new TaskBoard work. Keep T3 Busy must be enabled.
              </p> : null}
              {!onIdle && <>
              <div className="flex items-center gap-2 text-sm font-semibold">
                <CalendarClockIcon className="size-4 text-primary" /> When to begin
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { label: "30 min", minutes: 30 },
                  { label: "1 hour", minutes: 60 },
                  { label: "2 hours", minutes: 120 },
                  { label: "4 hours", minutes: 240 },
                  { label: "Tomorrow", minutes: 1440 },
                ].map(({ label, minutes }) => (
                  <Button key={minutes} type="button" size="xs" variant="outline"
                    onClick={() => setPreset(minutes)}>{label}</Button>
                ))}
              </div>
              <Input aria-label="Scheduled local date and time" type="datetime-local"
                value={when} onChange={(event) => { setWhen(event.target.value); setError(null); }} required />
              <p className="text-xs text-muted-foreground">
                {validTime
                  ? `Scheduled for ${new Date(timestamp).toLocaleString()} (local time). T3 must be running to trigger it.`
                  : "Choose a future time within 90 days."}
              </p>
              </>}
            </div>
            {target.kind === "new" && jobs.length > 0 && (
              <div className="space-y-2 border-t border-border pt-4">
                <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Scheduled tasks</p>
                <div className="max-h-44 space-y-1.5 overflow-y-auto">
                  {jobs.map((job) => (
                    <div key={job.id} className="flex items-center gap-2 rounded-lg border border-border bg-background p-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{job.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {job.onIdle ? "Begin on idle" : job.beginAt === null ? "Unscheduled" : new Date(job.beginAt).toLocaleString()} · {job.status}
                        </p>
                        {job.error && <p className="text-xs text-destructive">{job.error}</p>}
                      </div>
                      {job.status === "scheduled" ? (
                        <Button type="button" size="icon-xs" variant="ghost-muted" disabled={busy}
                          aria-label={`Cancel scheduled task ${job.title}`}
                          onClick={() => {
                            setBusy(true);
                            void cancelJob(job.id).catch((cause: unknown) =>
                              setError(cause instanceof Error ? cause.message : String(cause)),
                            ).finally(() => setBusy(false));
                          }}>
                          <Trash2Icon aria-hidden className="size-4" />
                        </Button>
                      ) : job.status === "created" ? <CheckIcon className="size-4 text-emerald-500" /> : null}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>Cancel</Button>
            <Button type="submit" disabled={!valid || busy}>
              {busy ? "Saving…" : target.kind === "new" ? "Schedule new session" : "Schedule prompt"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
