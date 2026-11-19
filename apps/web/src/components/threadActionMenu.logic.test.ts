import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";
import { buildChatGPTSessionContextMenu } from "../chatGPTSessionContextMenu";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("uses the ChatGPT Caffy menu options and the same live scheduler state", () => {
    const setup = buildThreadActionMenuItems({ ...baseState, caffy: null });
    expect(setup.filter((item) => item.id.startsWith("schedule:")).map((item) => item.id)).toEqual([
      "schedule:prompt",
    ]);
    expect(setup.find((item) => item.id === "caffy:quick-4h")).toMatchObject({
      checked: false,
      disabled: false,
    });
    expect(setup.find((item) => item.id === "caffy")?.children?.map((item) => item.id)).toEqual([
      "caffy:auto",
      "caffy:pause",
      "caffy:startup",
      "caffy:stop",
    ]);

    const liveCaffy = {
      mode: "periodic" as const,
      paused: true,
      startup: true,
      onceOnly: false,
      intervalMinutes: 20,
      createdAt: 1000,
      expiresAt: null,
    };
    const running = buildThreadActionMenuItems({ ...baseState, caffy: liveCaffy });
    const chatgpt = buildChatGPTSessionContextMenu({
      session: { id: "same", title: "Same" },
      sessions: [],
      projects: [],
      managerIds: new Set<string>(),
      snoozePresets: [],
      now: Date.now(),
      working: false,
      hasTask: false,
      caffy: liveCaffy,
    });
    const sharedIds = ["caffy:quick-4h", "schedule:prompt", "caffy"];
    expect(running.filter((item) => sharedIds.includes(item.id))).toEqual(
      chatgpt.filter((item) => sharedIds.includes(item.id)),
    );
    expect(running.find((item) => item.id === "caffy")?.children).toEqual(
      chatgpt.find((item) => item.id === "caffy")?.children,
    );

    const denied = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      caffy: null,
    });
    expect(
      denied
        .filter((item) => sharedIds.includes(item.id))
        .every(
          (item) => item.disabled && (item.children?.every((child) => child.disabled) ?? true),
        ),
    ).toBe(true);
    expect(buildThreadActionMenuItems(baseState).some((item) => item.id === "caffy")).toBe(false);
  });

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });
});
