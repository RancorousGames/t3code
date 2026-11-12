import type { ContextMenuItem } from "@t3tools/contracts";
/** Structural session data shared by T3 and independent embedded apps. */
export interface ChatGPTContextMenuSession {
  id: string;
  title: string;
  parentSessionId?: string | null | undefined;
  snoozedUntil?: number | undefined;
  verificationPending?: boolean | undefined;
  borderColor?: string | undefined;
  hidden?: boolean | undefined;
  project?: string | undefined;
  markedAsWorkerAt?: number | undefined;
  humanControlled?: boolean | undefined;
  binding?: {
    role: "manager" | "worker" | "personal";
    taskRef?: { board: string; id: string } | null | undefined;
  } | undefined;
  spawnRequestId?: string | undefined;
  creationOrigin?: "manual" | "backend" | undefined;
}
import { chatGPTSessionDisplayRole } from "./components/sidebar/chatGPTSidebarVisuals";

export type ChatGPTContextAction = string;
type MenuItem = ContextMenuItem<ChatGPTContextAction>;
type SnoozePreset = { id: string; label: string; whenLabel: string };
export const CAFFY_DURATION_HOURS = [1, 2, 4, 8] as const;
export const CAFFY_INTERVAL_MINUTES = [5, 10, 20, 30, 60] as const;
export const CAFFY_REBOOT_MINUTES = [30, 60, 120] as const;
export function resolveCaffyBeginAt(preset: string, now = new Date()): number | null {
  if (preset === "clear") return null;
  const durations: Record<string, number> = { "30": 30, "60": 60, "120": 120, "240": 240 };
  if (durations[preset]) return now.getTime() + durations[preset] * 60_000;
  const hours: Record<string, number> = {
    "tomorrow-morning": 9, "tomorrow-afternoon": 13, "tomorrow-evening": 18,
  };
  if (hours[preset] !== undefined) {
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(hours[preset], 0, 0, 0);
    return tomorrow.getTime();
  }
  throw new Error("Unknown Caffy start preset.");
}
const item = (id: string, label: string, extra: Partial<MenuItem> = {}): MenuItem => ({
  id,
  label,
  ...extra,
});

/** Data-only native T3 menu model; all click/position/submenu handling belongs to LocalApi. */
export function buildChatGPTSessionContextMenu(input: {
  session: ChatGPTContextMenuSession;
  sessions: readonly ChatGPTContextMenuSession[];
  managerIds: ReadonlySet<string>;
  projects: readonly string[];
  snoozePresets: readonly SnoozePreset[];
  now: number;
  working: boolean;
  hasTask: boolean;
  hasConversationUrl?: boolean;
  caffy?: { mode: "idle" | "periodic" | "queued" | "startup"; startup: boolean;
    onceOnly: boolean; paused: boolean; createdAt: number; expiresAt: number | null;
    intervalMinutes: number; beginAt?: number | null; autoRebootMinutes?: number | null;
    delayedPrompt?: string | null; repeatPrompt?: string | null } | null;
}): MenuItem[] {
  const { session, sessions, managerIds, projects, snoozePresets, now, working, hasTask } = input;
  const role = chatGPTSessionDisplayRole(session, managerIds.has(session.id));
  const activeCaffy = input.caffy;
  // One-click resume owns a one-shot Caffy monitor. Do not silently replace
  // another ongoing, periodic, or custom-prompt schedule.
  const quickResumeScheduled = Boolean(activeCaffy &&
    activeCaffy.mode === "queued" && activeCaffy.onceOnly && !activeCaffy.paused &&
    !activeCaffy.beginAt && !activeCaffy.repeatPrompt && !activeCaffy.delayedPrompt);
  const wakeMode = activeCaffy?.mode === "idle" || activeCaffy?.mode === "queued" ? "Auto-continue" :
    activeCaffy?.mode === "periodic" ? "Periodic auto-continue" :
    activeCaffy?.mode === "startup" ? "Startup only" : null;

  const snoozed = (session.snoozedUntil ?? 0) > now;
  const ancestors = new Set([session.id]);
  const walk = (id: string) => {
    for (const entry of sessions.filter((candidate) => candidate.parentSessionId === id)) {
      if (ancestors.has(entry.id)) continue;
      ancestors.add(entry.id);
      walk(entry.id);
    }
  };
  walk(session.id);
  const availableParents = sessions.filter((entry) => !ancestors.has(entry.id));
  return [
    item("copy:t3-id", "Copy T3 session ID"),
    item("copy", "Copy", {
      children: [
        item("copy:conversation-id", "ChatGPT Conversation ID"),
        item("copy:url", "ChatGPT URL", { disabled: input.hasConversationUrl === false }),
        item("copy:title", "Session title"),
        item("copy:parent-id", "Parent Session ID", {
          disabled: !Boolean(session.parentSessionId),
        }),
      ],
    }),
    item("role", "Role & Omniwork", {
      separatorBefore: true,
      children: [
        item("role:toggle", role === "worker" ? "Mark as personal" : "Mark as worker", {
          disabled: role === "manager",
        }),
        item("role:edit", "Edit Omniwork binding…", { separatorBefore: true }),
        item("role:clear", "Clear Omniwork binding", { disabled: !session.binding }),
      ],
    }),
    item("project", "Move to project", {
      children: [
        ...projects.map((project, index) =>
          item(`project:${index}`, project, { checked: session.project === project }),
        ),
        item("project:none", "None", {
          separatorBefore: true,
          checked: !session.project,
        }),
        item("project:add", "Add project…", { separatorBefore: true }),
      ],
    }),
    item("parent", "Parent", {
      children: [
        item("parent:set", "Set parent", {
          disabled: availableParents.length === 0,
          children: availableParents.map((candidate) =>
            item(`parent:${candidate.id}`, candidate.title, {
              checked: candidate.id === session.parentSessionId,
            }),
          ),
        }),
        item("parent:detach", "Detach from parent", {
          disabled: !Boolean(session.parentSessionId),
        }),
      ],
    }),
    item("task:open", "Open TaskBoard task", { disabled: !hasTask }),
    item("url:restore", "Restore URL", { separatorBefore: true }),
    item("reboot", "Reboot agent"),
    item("stop", "Stop generation", { disabled: !working }),
    item(
      "verification:toggle",
      session.verificationPending ? "Clear verification" : "Mark for verification",
      { separatorBefore: true },
    ),
    ...(snoozed
      ? [item("snooze:clear", "Unsnooze", { separatorBefore: true })]
      : [
          item("snooze", "Snooze", {
            separatorBefore: true,
            children: [
              ...snoozePresets.map((preset) =>
                item(`snooze:${preset.id}`, `${preset.label} (${preset.whenLabel})`),
              ),
              item("snooze:custom", "Custom…", { separatorBefore: true }),
            ],
          }),
        ]),
    item("schedule:resume", "Schedule resume", {
      separatorBefore: true,
      checked: quickResumeScheduled,
      disabled: Boolean(activeCaffy && !quickResumeScheduled),
    }),
    item("schedule:prompt", "Schedule prompt…"),
    item("caffy", wakeMode
      ? `Caffy · ${wakeMode}${activeCaffy?.beginAt && activeCaffy.beginAt > now ? " (scheduled)" : ""}${activeCaffy?.paused ? " (paused)" : ""}`
      : "Caffy", {
      children: [
        item("caffy:auto", "Auto-continue…", {
          checked: activeCaffy?.mode === "queued" || activeCaffy?.mode === "periodic",
        }),


        item("caffy:pause", activeCaffy?.paused ? "Resume Caffy" : "Pause Caffy", { disabled: !activeCaffy, separatorBefore: true }),
        item("caffy:startup", "Resume when T3 starts", {
          checked: input.caffy?.startup ?? false,
          separatorBefore: true,
        }),
        item("caffy:stop", "Stop Caffy", {
          disabled: !input.caffy,
          separatorBefore: true,
        }),
      ],
    }),
    item("highlight", "Highlight", {
      children: [
        ...["Red", "Orange", "Yellow", "Green", "Blue", "Purple", "Pink"].map((color) =>
          item(`highlight:${color.toLowerCase()}`, color, {
            checked: session.borderColor === color.toLowerCase(),
          }),
        ),
        item("highlight:none", "None", {
          checked: !session.borderColor,
          separatorBefore: true,
        }),
      ],
    }),
    item("hide", session.hidden ? "Unhide session" : "Hide session", {
      separatorBefore: true,
    }),
    item("unload", "Unload session", { disabled: working || Boolean(session.hidden) }),
  ];
}

export function buildChatGPTProjectContextMenu(input: {
  permanent: boolean;
  snoozed: boolean;
  snoozePresets: readonly SnoozePreset[];
}): MenuItem[] {
  return [
    item("group:rename", "Rename project group"),
    item("group:permanent", input.permanent ? "Remove permanent" : "Make permanent"),
    ...(input.snoozed
      ? [item("snooze:clear", "Unsnooze all sessions", { separatorBefore: true })]
      : [
          item("snooze", "Snooze all sessions", {
            separatorBefore: true,
            children: [
              ...input.snoozePresets.map((preset) =>
                item(`snooze:${preset.id}`, `${preset.label} (${preset.whenLabel})`),
              ),
              item("snooze:custom", "Custom…", { separatorBefore: true }),
            ],
          }),
        ]),
  ];
}
