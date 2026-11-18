import type { ContextMenuItem } from "@t3tools/contracts";

/** Shared Caffy menu for ChatGPT browser sessions and native T3 threads.
 * State always comes from the same T3 desktop Caffy scheduler (action=status). */
export interface CaffyMenuStatus {
  mode: "idle" | "periodic" | "startup";
  startup: boolean;
  paused: boolean;
  onceOnly: boolean;
  beginAt?: number | null;
  repeatPrompt?: string | null;
  delayedPrompt?: string | null;
}

export type CaffyMenuAction =
  | "schedule:resume"
  | "schedule:prompt"
  | "caffy"
  | "caffy:auto"
  | "caffy:pause"
  | "caffy:startup"
  | "caffy:stop"
  | `caffy:stop-legacy:${string}`;

export function buildCaffyContextMenuItems(input: {
  caffy: CaffyMenuStatus | null;
  now: number;
  exhausted?: boolean;
  legacyCaffyIds?: readonly string[];
}): ReadonlyArray<ContextMenuItem<CaffyMenuAction>> {
  const { caffy, now } = input;
  const exhausted = input.exhausted === true;
  const legacyIds = input.legacyCaffyIds ?? [];
  const quickResumeScheduled = Boolean(
    caffy &&
    caffy.mode === "idle" &&
    caffy.onceOnly &&
    !caffy.paused &&
    !caffy.beginAt &&
    !caffy.repeatPrompt &&
    !caffy.delayedPrompt,
  );
  const wakeMode =
    !caffy && legacyIds.length > 0
      ? "Legacy OmniHub active"
      : caffy?.mode === "idle"
        ? caffy.onceOnly
          ? "Continue once"
          : "Keep running"
        : caffy?.mode === "periodic"
          ? "Interval wake"
          : caffy?.mode === "startup"
            ? "Startup only"
            : null;
  const item = (
    id: CaffyMenuAction,
    label: string,
    extra: Partial<ContextMenuItem<CaffyMenuAction>> = {},
  ): ContextMenuItem<CaffyMenuAction> => ({ id, label, ...extra });
  return [
    item("schedule:resume", "Continue once when idle", {
      separatorBefore: true,
      checked: quickResumeScheduled,
      disabled: exhausted || Boolean(caffy && !quickResumeScheduled),
    }),
    item("schedule:prompt", "Schedule prompt…", { disabled: exhausted }),
    item(
      "caffy",
      exhausted
        ? "Caffy · conversation full (reboot)"
        : wakeMode
          ? `Caffy · ${wakeMode}${caffy?.beginAt && caffy.beginAt > now ? " (scheduled)" : ""}${caffy?.paused ? " (paused)" : ""}`
          : "Caffy",
      {
        children: [
          item("caffy:auto", "Auto-continue…", {
            disabled: exhausted,
            checked: Boolean(caffy && caffy.mode !== "startup" && !caffy.onceOnly),
          }),
          item("caffy:pause", caffy?.paused ? "Resume Caffy" : "Pause Caffy", {
            disabled: exhausted || !caffy,
            separatorBefore: true,
          }),
          item("caffy:startup", "Resume when T3 starts", {
            disabled: exhausted,
            checked: caffy?.startup ?? false,
            separatorBefore: true,
          }),
          item("caffy:stop", !caffy && legacyIds.length > 0 ? "Stop legacy Caffy" : "Stop Caffy", {
            disabled: !caffy && legacyIds.length === 0,
            separatorBefore: true,
            ...(legacyIds.length > 1 && !caffy
              ? {
                  children: legacyIds.map((id, index) =>
                    item(`caffy:stop-legacy:${id}`, `Legacy monitor ${index + 1}`),
                  ),
                }
              : {}),
          }),
        ],
      },
    ),
  ];
}
