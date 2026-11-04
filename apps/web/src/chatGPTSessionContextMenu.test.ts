import { describe, expect, it } from "vite-plus/test";
import {
  buildChatGPTProjectContextMenu,
  buildChatGPTSessionContextMenu,
} from "./chatGPTSessionContextMenu";

const state = {
  session: { id: "active", title: "Chat", creationOrigin: "manual" as const },
  sessions: [
    { id: "active", title: "Chat", creationOrigin: "manual" as const },
    { id: "another", title: "Another" },
  ],
  managerIds: new Set<string>(),
  projects: ["Altraea", "T3"],
  snoozePresets: [{ id: "one", label: "1 hour", whenLabel: "01:00" }],
  now: 1000,
  working: false,
  hasTask: false,
};
describe("ChatGPT native sidebar menu", () => {
  it("keeps parent actions together and nested, without rename or reload", () => {
    const menu = buildChatGPTSessionContextMenu(state);
    expect(menu.some((item) => /rename|reload/i.test(item.label))).toBe(false);
    expect(menu.find((item) => item.id === "copy")?.children?.length).toBe(5);
    expect(menu.find((item) => item.id === "copy")?.children?.find((item) => item.id === "copy:url")?.label)
      .toBe("ChatGPT URL");
    const parent = menu.find((item) => item.id === "parent");
    expect(parent?.children?.map((item) => item.id)).toEqual(["parent:set", "parent:detach"]);
    expect(parent?.children?.[0]?.children?.[0]?.id).toBe("parent:another");
    expect(menu.find((item) => item.id === "stop")?.disabled).toBe(true);
    expect(menu.find((item) => item.id === "task:open")?.disabled).toBe(true);
    expect(menu.find((item) => item.id === "reboot")).toBeDefined();
    expect(menu.find((item) => item.id === "caffy")?.children?.length).toBeGreaterThan(4);
  });
  it("disables URL copy when the conversation URL is unavailable", () => {
    const menu = buildChatGPTSessionContextMenu({ ...state, hasConversationUrl: false });
    expect(menu.find((item) => item.id === "copy")?.children?.find((item) => item.id === "copy:url")?.disabled)
      .toBe(true);
  });
  it("offers idle duration presets and nested periodic intervals including custom", () => {
    const menu = buildChatGPTSessionContextMenu({ ...state, caffy: {
      mode: "periodic", startup: false, onceOnly: false, paused: false,
      createdAt: 1000, expiresAt: 1000 + 3 * 60 * 60_000, intervalMinutes: 10,
    } });
    const caffy = menu.find((item) => item.id === "caffy");
    const idle = caffy?.children?.find((item) => item.id === "caffy:idle");
    expect(idle?.children?.map((item) => item.label)).toEqual([
      "1h", "2h", "4h", "8h", "Infinite", "Custom…", "Once only",
    ]);
    const periodic = caffy?.children?.find((item) => item.id === "caffy:periodic");
    expect(periodic?.children?.map((item) => item.label)).toEqual([
      "Every 5m", "Every 10m", "Every 20m", "Every 30m", "Every 60m", "Custom interval…",
    ]);
    const every10 = periodic?.children?.find((item) => item.id === "caffy:periodic:10");
    expect(every10?.checked).toBe(true);
    expect(every10?.children?.map((item) => item.id)).toEqual([
      "caffy:periodic:10:1", "caffy:periodic:10:2", "caffy:periodic:10:4",
      "caffy:periodic:10:8", "caffy:periodic:10:infinite",
      "caffy:periodic:10:custom", "caffy:periodic:10:once",
    ]);
  });
  it("respects the authoritative manager role and snooze state", () => {
    const menu = buildChatGPTSessionContextMenu({
      ...state,
      session: { ...state.session, snoozedUntil: 2000 },
      managerIds: new Set(["active"]),
      working: true,
    });
    expect(menu.find((item) => item.id === "role")?.children?.[0]?.disabled).toBe(true);
    expect(menu.some((item) => item.id === "snooze:clear")).toBe(true);
    expect(menu.find((item) => item.id === "stop")?.disabled).toBe(false);
    expect(menu.find((item) => item.id === "unload")?.disabled).toBe(true);
  });
  it("keeps project snooze in one submenu", () => {
    const menu = buildChatGPTProjectContextMenu({
      permanent: false,
      snoozed: false,
      snoozePresets: state.snoozePresets,
    });
    expect(menu.map((item) => item.id)).toEqual(["group:rename", "group:permanent", "snooze"]);
    expect(menu[2]?.children?.map((item) => item.id)).toEqual(["snooze:one", "snooze:custom"]);
  });
});
