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
    const parent = menu.find((item) => item.id === "parent");
    expect(parent?.children?.map((item) => item.id)).toEqual(["parent:set", "parent:detach"]);
    expect(parent?.children?.[0]?.children?.[0]?.id).toBe("parent:another");
    expect(menu.find((item) => item.id === "stop")?.disabled).toBe(true);
    expect(menu.find((item) => item.id === "task:open")?.disabled).toBe(true);
    expect(menu.find((item) => item.id === "reboot")).toBeDefined();
    expect(menu.find((item) => item.id === "awake")?.children?.length).toBe(4);
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
