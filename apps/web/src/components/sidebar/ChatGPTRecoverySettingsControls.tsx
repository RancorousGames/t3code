import { useEffect, useState } from "react";
import { currentRecoveryExperimentArm, readRecoveryExperiment, recoveryExperimentStatistics, recoveryExperimentSummaryReport, setRecoveryExperimentEnabled, subscribeRecoveryExperiment } from "../../chatGPTRecoveryExperiment";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  readChatGPTRecoverySettings,
  updateChatGPTRecoverySettings,
  useChatGPTRecoverySettings,
  DEFAULT_CHATGPT_RECOVERY_SETTINGS,
  CHATGPT_RECOVERY_INTERVAL_BOUNDS,
  validRecoverySettingNumber,
} from "../../chatGPTRecoverySettings";

type NumericKey =
  | "watchdogSeconds"
  | "globalSeconds"
  | "orangeGlobalSeconds"
  | "perSessionSeconds"
  | "orangeGraceMinutes"
  | "missingComposerSeconds"
  | "targetCount";

const numericOptions: Array<{
  key: NumericKey;
  label: string;
  help: string;
  values: number[];
  unit: string;
}> = [
  {
    key: "watchdogSeconds",
    label: "Fallback watchdog interval",
    help: "Catch silent hangs or missed events; normal recovery follows events and exact deadlines.",
    values: [60, 120, 180, 300, 600],
    unit: "sec",
  },
  {
    key: "globalSeconds",
    label: "Red retry spacing",
    help: "Minimum time between red recovery attempts, independent of orange retries (default 30 sec).",
    values: [10, 20, 30, 60],
    unit: "sec",
  },
  {
    key: "orangeGlobalSeconds",
    label: "Orange retry spacing",
    help: "Minimum time between orange recoveries, independently of red retry cadence (default 60 sec).",
    values: [30, 60, 120, 300],
    unit: "sec",
  },
  {
    key: "perSessionSeconds",
    label: "Orange per-session retry spacing",
    help: "Minimum wait before retrying the same orange session (default 120 sec). Red retries are not affected.",
    values: [30, 60, 120, 300],
    unit: "sec",
  },
  {
    key: "orangeGraceMinutes",
    label: "Interrupted grace",
    help: "Observe a transient interruption before reloading.",
    values: [2, 5, 10, 20],
    unit: "min",
  },
  {
    key: "missingComposerSeconds",
    label: "Missing composer grace",
    help: "Wait for a missing ChatGPT composer to recover naturally.",
    values: [30, 60, 120],
    unit: "sec",
  },
  {
    key: "targetCount",
    label: "Persistent recovery targets",
    help: "How many errored sessions have persistent retry slots (attempts remain serialized).",
    values: [1, 2, 3],
    unit: "",
  },
];

/** Keep edits local until blur/Enter, so partial numbers do not change the live scheduler. */
function CustomIntervalSetting({
  settingKey, label, help, value, unit,
}: {
  settingKey: keyof typeof CHATGPT_RECOVERY_INTERVAL_BOUNDS;
  label: string;
  help: string;
  value: number;
  unit: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const [min, max] = CHATGPT_RECOVERY_INTERVAL_BOUNDS[settingKey];
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() !== "" && validRecoverySettingNumber(settingKey, parsed)) {
      updateChatGPTRecoverySettings({ [settingKey]: parsed });
      setDraft(String(parsed));
    } else {
      setDraft(String(value));
    }
  };
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/30 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{help}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Input nativeInput type="number" inputMode="numeric" step={1} min={min} max={max}
          size="sm" font="mono" className="w-23" aria-label={label}
          title={`Enter a whole number from ${min} to ${max} ${unit}`}
          value={draft} onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={commit} onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            else if (event.key === "Escape") { setDraft(String(value)); event.currentTarget.blur(); }
          }} />
        <span className="w-7 text-xs text-muted-foreground">{unit}</span>
      </div>
    </div>
  );
}

function SettingSelect({
  label,
  help,
  value,
  onChange,
  options,
}: {
  label: string;
  help: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/30 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{help}</div>
      </div>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next) onChange(next);
        }}
      >
        <SelectTrigger size="sm" aria-label={label}>
          <SelectValue>{options.find((option) => option.value === value)?.label}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

export function ChatGPTRecoveryPauseButton() {
  const settings = useChatGPTRecoverySettings();
  return (
    <Button
      size="sm"
      variant={settings.paused ? "outline" : "secondary"}
      aria-label={
        settings.paused
          ? "Resume automatic session maintenance"
          : "Pause automatic session maintenance"
      }
      onClick={() =>
        updateChatGPTRecoverySettings({ paused: !readChatGPTRecoverySettings().paused })
      }
    >
      {settings.paused ? "Resume auto maintenance" : "Pause auto maintenance"}
    </Button>
  );
}

export function ChatGPTRecoverySettingsControls() {
  const settings = useChatGPTRecoverySettings();
  const [experiment, setExperiment] = useState(readRecoveryExperiment);
  useEffect(() => subscribeRecoveryExperiment(() => setExperiment(readRecoveryExperiment())), []);
  const stats = recoveryExperimentStatistics(experiment);
  const [copyStatus, setCopyStatus] = useState("");
  const copyStats = () => {
    try {
      const request = navigator.clipboard?.writeText(recoveryExperimentSummaryReport(experiment));
      if (!request) { setCopyStatus("Clipboard unavailable"); return; }
      void request.then(() => setCopyStatus("Copied"))
        .catch(() => setCopyStatus("Clipboard unavailable"));
    } catch {
      setCopyStatus("Clipboard unavailable");
    }
  };
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-2">
        <div>
          <div className="text-sm font-medium">Automatic session maintenance</div>
          <div className="text-xs text-muted-foreground">
            Pause queued recovery and warm-set loading; preserve all pending work. Manual session
            opening still works.
          </div>
        </div>
        <ChatGPTRecoveryPauseButton />
      </div>
      <div className="rounded-md border p-3 space-y-2" aria-label="Recovery experimentation">
        <div className="flex items-center justify-between gap-2">
          <div><div className="text-sm font-medium">Recovery cadence experiment</div>
            <p className="text-xs text-muted-foreground">Compare retry cadences and gentler orange action sequences using verified recovery outcomes. Manual preferences are preserved; observe-only is never overridden.</p></div>
          <Button size="sm" variant={experiment.enabled ? "secondary" : "outline"}
            onClick={() => setRecoveryExperimentEnabled(!experiment.enabled)}>
            {experiment.enabled ? "Stop experiment" : "Start experiment"}
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button size="xs" variant="outline" onClick={copyStats}>Copy aggregate statistics</Button>
          {copyStatus && <span role="status" className="text-xs text-muted-foreground">{copyStatus}</span>}
        </div>
        <p className="text-xs">Current arm: {currentRecoveryExperimentArm(experiment).id} · round {experiment.round + 1} · {experiment.enabled ? "managing cooldowns" : "inactive"}</p>
        <p className="text-xs text-muted-foreground">Current policy: red {currentRecoveryExperimentArm(experiment).redSeconds}s, orange {currentRecoveryExperimentArm(experiment).orangeSeconds}s, orange per-session {currentRecoveryExperimentArm(experiment).perSessionSeconds}s; orange scheme {settings.orangeStrategy}. Global pause and observe-only take precedence.</p>
        <p className="text-xs">Recent trials: {(experiment.switchHistory ?? []).slice(-3).reverse()
          .map(trial => `${trial.from} → ${trial.to} (${trial.reason}; ${trial.recoveredEpisodes}/${trial.closedEpisodes} observed recoveries)`)
          .join(" · ") || "No completed trials yet"}</p>
        <div className="grid gap-1 text-xs text-muted-foreground">
          {stats.map(item => (
            <div key={item.arm} className="rounded border border-border/40 px-2 py-1.5">
              <div className="font-medium">{item.arm}: {item.episodes} verified closed episodes</div>
              <div>{item.recovered} recovered; {item.recoveredPerHour === null
                ? "rate pending (requires 5 observed minutes)"
                : `${item.recoveredPerHour.toFixed(1)} recoveries / observed hour`};
                {" "}{item.observedRecoveryRate === null ? "insufficient data"
                  : `${Math.round(item.observedRecoveryRate * 100)}% observed`};
                {" "}recent median recovered {item.medianMs === null ? "n/a"
                  : `${Math.round(item.medianMs / 1000)}s`}.
              </div>
              <div>Recent red {item.byCategory[0]?.recovered}/{item.byCategory[0]?.attempts};
                {" "}orange {item.byCategory[1]?.recovered}/{item.byCategory[1]?.attempts}.
              </div>
              <div className="mt-0.5">
                Workload proxy (matched opportunity exposure): {item.buckets.map(group =>
                  `${group.busyBucket}: ${group.count < 3 ? `${group.count} samples` : `${Math.round(group.recovered / group.count * 100)}% (${group.count})`}`
                ).join(" · ")}
              </div>
              <div>Matched lane/load throughput: {item.laneBuckets.filter(group => group.recoveredPerHour !== null)
                .map(group => `${group.category} ${group.busyBucket}: ${group.recoveredPerHour!.toFixed(1)}/h`)
                .join(" · ") || "pending comparable observations"}</div>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Observed runtime {Math.round(Object.values(experiment.exposureMs ?? {}).reduce((a,b) => a+b, 0) / 60000)} min; no recovery opportunity {Math.round((experiment.noOpportunityMs ?? 0) / 60000)} min; unobserved gaps {Math.round((experiment.missingExposureMs ?? 0) / 60000)} min. Active/unknown and partial episodes are excluded. Recently observed working guests are only a load proxy; missing activity observations remain unknown. Results are observational, not proof of causal improvement.</p>
      </div>
      <fieldset disabled={experiment.enabled} className={experiment.enabled ? "opacity-50" : ""}>
      {numericOptions.map(({ key, label, help, values, unit }) => key === "targetCount" ? (
        <SettingSelect key={key} label={label} help={help}
          value={String(settings[key])}
          options={values.map((value) => ({ value: String(value), label: String(value) }))}
          onChange={(value) => updateChatGPTRecoverySettings({ targetCount: Number(value) })}
        />
      ) : (
        <CustomIntervalSetting key={key} settingKey={key} label={label} help={help}
          value={settings[key]} unit={unit} />
      ))}
      <div className="flex justify-end pt-1">
        <Button
          variant="ghost"
          size="xs"
          onClick={() => updateChatGPTRecoverySettings(DEFAULT_CHATGPT_RECOVERY_SETTINGS)}
        >
          Reset defaults
        </Button>
      </div>
      </fieldset>
      <p className="text-xs text-muted-foreground">
        Red recovery stays on one highest-priority failing session and retries it until healthy,
        without round-robin. Only an explicit manual retry can replace the pinned red target.
        Orange sessions keep their own rotating recovery queue.
      </p>
      <p className="text-xs text-muted-foreground">
        Enter custom whole-number intervals and press Enter or leave the field to save.
        Red and orange have separate retry cadences. After 20 consecutive verified failures,
        only that lane pauses for 10 minutes, then retries the same target. Safety rules remain fixed:
        draft/ambiguous-send protection, one browser mutation at a time, and no
        automatic recovery of snoozed sessions. Pause to stop retries.
      </p>
    </div>
  );
}
