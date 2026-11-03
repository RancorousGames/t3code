import type { ContextMenuItem } from "@t3tools/contracts";
import type { BrowserSession } from "./chatGPTBrowserSessions";
import { chatGPTSessionDisplayRole } from "./components/sidebar/chatGPTSidebarVisuals";

export type ChatGPTContextAction = string;
type MenuItem = ContextMenuItem<ChatGPTContextAction>;
type SnoozePreset = { id: string; label: string; whenLabel: string };
const item = (id: string, label: string, extra: Partial<MenuItem> = {}): MenuItem => ({
  id,
  label,
  ...extra,
});

/** Data-only native T3 menu model; all click/position/submenu handling belongs to LocalApi. */
export function buildChatGPTSessionContextMenu(input: {
  session: BrowserSession;
  sessions: readonly BrowserSession[];
  managerIds: ReadonlySet<string>;
  projects: readonly string[];
  snoozePresets: readonly SnoozePreset[];
  now: number;
  working: boolean;
  hasTask: boolean;
}): MenuItem[] {
  const { session, sessions, managerIds, projects, snoozePresets, now, working, hasTask } = input;
  const role = chatGPTSessionDisplayRole(session, managerIds.has(session.id));
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
        item("copy:url", "ChatGPT URL"),
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
    item("awake", "Keep Awake", {
      children: ([1, 2, 4, 6] as const).map((hours) =>
        item(`awake:${hours}`, `${hours} hour${hours === 1 ? "" : "s"}`),
      ),
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
