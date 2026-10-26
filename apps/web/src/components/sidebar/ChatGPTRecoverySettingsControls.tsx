import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  readChatGPTRecoverySettings,
  updateChatGPTRecoverySettings,
  useChatGPTRecoverySettings,
  DEFAULT_CHATGPT_RECOVERY_SETTINGS,
  type ChatGPTRecoverySettings,
} from "../../chatGPTRecoverySettings";

type NumericKey =
  | "scanSeconds"
  | "globalSeconds"
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
    key: "scanSeconds",
    label: "Scan interval",
    help: "How often the recovery coordinator checks sessions.",
    values: [10, 20, 30, 60],
    unit: "sec",
  },
  {
    key: "globalSeconds",
    label: "Global retry spacing",
    help: "Minimum time between any two automatic recovery attempts (default 30 sec).",
    values: [10, 20, 30, 60],
    unit: "sec",
  },
  {
    key: "perSessionSeconds",
    label: "Per-session retry spacing",
    help: "Minimum time before the same session is retried again (default 120 sec).",
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
      {numericOptions.map(({ key, label, help, values, unit }) => (
        <SettingSelect
          key={key}
          label={label}
          help={help}
          value={String(settings[key])}
          options={values.map((value) => ({
            value: String(value),
            label: unit ? value + " " + unit : String(value),
          }))}
          onChange={(value) =>
            updateChatGPTRecoverySettings({
              [key]: Number(value),
            } as Partial<ChatGPTRecoverySettings>)
          }
        />
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
      <p className="text-xs text-muted-foreground">
        Recovery order is fixed: manually selected sessions, then managers, then observed
        interruptions, then recently active, then all others. Within each tier the session attempted
        longest ago goes first.
      </p>
      <p className="text-xs text-muted-foreground">
        Automatic retries continue until a session recovers, at the spacing above with no backoff.
        Safety rules remain fixed: draft/ambiguous-send protection, one attempt at a time, and no
        automatic recovery of snoozed sessions. Pause to stop retries.
      </p>
    </div>
  );
}
