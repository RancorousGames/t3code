import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

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

  it("shows native Caffy setup and lifecycle controls only when supported and permitted", () => {
    const setup = buildThreadActionMenuItems({ ...baseState, caffy: null })
      .find(item => item.id === "caffy:keep-running");
    expect(setup?.children?.map(child => child.id)).toContain("caffy:begin:15");
    expect(setup?.children?.map(child => child.id)).toContain("caffy:interval:20");
    const running = buildThreadActionMenuItems({
      ...baseState, caffy: { mode: "idle", paused: true, intervalMinutes: 20 },
    }).find(item => item.id === "caffy:keep-running");
    expect(running?.children?.map(child => child.id)).toContain("caffy:resume");
    expect(running?.children?.map(child => child.id)).toContain("caffy:stop");
    const denied = buildThreadActionMenuItems({
      ...baseState, canOperate: false, caffy: null,
    }).find(item => item.id === "caffy:keep-running");
    expect(denied?.disabled).toBe(true);
    expect(denied?.children?.every(child => child.disabled)).toBe(true);
    expect(buildThreadActionMenuItems(baseState).some(item =>
      item.id === "caffy:keep-running")).toBe(false);
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
