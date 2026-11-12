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
    expect(menu[0]?.id).toBe("copy:t3-id");
    expect(menu[0]?.label).toBe("Copy T3 session ID");
    expect(menu.find((item) => item.id === "copy")?.children?.length).toBe(4);
    expect(menu.find((item) => item.id === "copy")?.children?.find((item) => item.id === "copy:url")?.label)
      .toBe("ChatGPT URL");
    const parent = menu.find((item) => item.id === "parent");
    expect(parent?.children?.map((item) => item.id)).toEqual(["parent:set", "parent:detach"]);
    expect(parent?.children?.[0]?.children?.[0]?.id).toBe("parent:another");
    expect(menu.find((item) => item.id === "stop")?.disabled).toBe(true);
    expect(menu.find((item) => item.id === "task:open")?.disabled).toBe(true);
    expect(menu.find((item) => item.id === "reboot")).toBeDefined();
    expect(menu.find((item) => item.id === "schedule:resume")).toMatchObject({
      label: "Schedule resume", disabled: false, checked: false,
    });
    expect(menu.findIndex((item) => item.id === "schedule:resume")).toBe(
      menu.findIndex((item) => item.id === "schedule:prompt") - 1,
    );
    expect(menu.find((item) => item.id === "schedule:prompt")).toBeDefined();
    expect(menu.findIndex((item) => item.id === "schedule:prompt")).toBeLessThan(
      menu.findIndex((item) => item.id === "caffy"),
    );
    expect(menu.find((item) => item.id === "caffy")?.children?.map((item) => item.id))
      .toEqual(["caffy:auto", "caffy:pause", "caffy:startup", "caffy:stop"]);
  });
  it("disables URL copy when the conversation URL is unavailable", () => {
    const menu = buildChatGPTSessionContextMenu({ ...state, hasConversationUrl: false });
    expect(menu.find((item) => item.id === "copy")?.children?.find((item) => item.id === "copy:url")?.disabled)
      .toBe(true);
  });
  it("unifies capacity and periodic auto-continue behind one configuration dialog", () => {
    const menu = buildChatGPTSessionContextMenu({ ...state, caffy: {
      mode: "periodic", startup: false, onceOnly: false, paused: false,
      createdAt: 1000, expiresAt: 1000 + 3 * 60 * 60_000, intervalMinutes: 1440,
    } });
    expect(menu.find((item) => item.id === "caffy")?.label).toContain("Periodic auto-continue");
    expect(menu.find((item) => item.id === "caffy")?.children?.[0]?.id).toBe("caffy:auto");
    expect(menu.find((item) => item.id === "schedule:resume")?.disabled).toBe(true);
  });
  it("marks a one-shot default resume as already scheduled without replacing another policy", () => {
    const menu = buildChatGPTSessionContextMenu({ ...state, caffy: {
      mode: "queued", startup: false, onceOnly: true, paused: false,
      createdAt: 1000, expiresAt: null, intervalMinutes: 20,
      repeatPrompt: null, delayedPrompt: null,
    } });
    expect(menu.find(item => item.id === "schedule:resume")).toMatchObject({
      checked: true, disabled: false,
    });
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

it("offers the same scheduling and auto-continue controls regardless of working state", () => {
  const active = buildChatGPTSessionContextMenu({ ...state, working: true });
  const idle = buildChatGPTSessionContextMenu({ ...state, working: false });
  expect(active.find(item => item.id === "stop")?.disabled).toBe(false);
  expect(idle.find(item => item.id === "stop")?.disabled).toBe(true);
  expect(active.find(item => item.id === "caffy")?.children?.map(item => item.id))
    .toEqual(idle.find(item => item.id === "caffy")?.children?.map(item => item.id));
});
