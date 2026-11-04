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
    intervalMinutes: number } | null;
  keepT3Busy?: boolean;
}): MenuItem[] {
  const { session, sessions, managerIds, projects, snoozePresets, now, working, hasTask } = input;
  const role = chatGPTSessionDisplayRole(session, managerIds.has(session.id));
  const activeCaffy = input.caffy;
  const durationMinutes = activeCaffy?.expiresAt !== null && activeCaffy?.expiresAt !== undefined
    ? Math.round((activeCaffy.expiresAt - activeCaffy.createdAt) / 60_000) : null;
  const wakeMode = activeCaffy?.mode === "idle" ? "Idle" :
    activeCaffy?.mode === "periodic" ? "Periodic" :
    activeCaffy?.mode === "queued" ? "Queued idle" :
    activeCaffy?.mode === "startup" ? "Startup only" : null;
  const caffyDurations = (mode: "idle" | "periodic", prefix: string, intervalMinutes = 20) => {
    const current = activeCaffy?.mode === mode &&
      (mode === "idle" || activeCaffy.intervalMinutes === intervalMinutes);
    return [
      ...CAFFY_DURATION_HOURS.map((hours) => item(`${prefix}:${hours}`, `${hours}h`, {
        checked: current && !activeCaffy?.onceOnly && durationMinutes === hours * 60,
      })),
      item(`${prefix}:infinite`, "Infinite", {
        checked: current && !activeCaffy?.onceOnly && durationMinutes === null,
      }),
      item(`${prefix}:custom`, "Custom…"),
      item(`${prefix}:once`, "Once only", {
        separatorBefore: true,
        checked: current && activeCaffy?.onceOnly,
      }),
    ];
  };
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
    item("copy", "Copy", {
      children: [
        item("copy:t3-id", "T3 Session ID"),
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
    item("reboot", "Reboot agent", { separatorBefore: true }),
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
    item("caffy", wakeMode ? `Caffy · ${wakeMode}${activeCaffy?.paused ? " (paused)" : ""}` : "Caffy", {
      children: [
        item("caffy:idle", "Wake on Idle", {
          checked: activeCaffy?.mode === "idle",
          children: caffyDurations("idle", "caffy:idle"),
        }),
        item("caffy:queued", "Wake on Idle (Queued) · Infinite", {
          checked: activeCaffy?.mode === "queued",
        }),
        item("caffy:periodic", "Periodic Wake", {
          checked: activeCaffy?.mode === "periodic",
          children: [
            ...CAFFY_INTERVAL_MINUTES.map((minutes) => item(
              `caffy:periodic:${minutes}`, `Every ${minutes}m`, {
                checked: activeCaffy?.mode === "periodic" && activeCaffy.intervalMinutes === minutes,
                children: caffyDurations("periodic", `caffy:periodic:${minutes}`, minutes),
              },
            )),
            item("caffy:periodic:custom", "Custom interval…", {
              separatorBefore: true,
              checked: activeCaffy?.mode === "periodic" &&
                !CAFFY_INTERVAL_MINUTES.some((minutes) => minutes === activeCaffy.intervalMinutes),
            }),
          ],
        }),
        item("caffy:pause", activeCaffy?.paused ? "Resume Caffy" : "Pause Caffy", { disabled: !activeCaffy, separatorBefore: true }),
        item("caffy:startup", "Resume on Startup", {
          checked: input.caffy?.startup ?? false,
          separatorBefore: true,
        }),
        item("caffy:busy", "Keep T3 Busy (queued work)", { checked: input.keepT3Busy ?? false }),
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
