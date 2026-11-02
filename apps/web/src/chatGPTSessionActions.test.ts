import { describe, expect, it, vi } from "vite-plus/test";
import { deriveChatGPTSession } from "./chatGPTSessionModel";
import {
  availableChatGPTSessionActions,
  chatGPTNativeActionMenu,
  primaryChatGPTSessionAction,
  runChatGPTSessionAction,
  type ChatGPTSessionActionContext,
} from "./chatGPTSessionActions";

const NOW = 1_000_000;
const context = (
  signals: Parameters<typeof deriveChatGPTSession>[0],
  extra: Partial<ChatGPTSessionActionContext> = {},
): ChatGPTSessionActionContext => ({
  model: deriveChatGPTSession(signals, NOW), ...extra,
});

describe("ChatGPT session actions", () => {
  it("puts the authoritative primary action first, and makes unsnooze explicit", () => {
    const normal = context({ age: "inactive" });
    expect(primaryChatGPTSessionAction(normal)?.id).toBe("open");
    expect(availableChatGPTSessionActions(normal)[0]?.id).toBe("open");
    expect(availableChatGPTSessionActions(normal).some((action) => action.id === "unsnooze")).toBe(false);

    const parked = context({ age: "inactive", snoozedUntil: NOW + 60_000 });
    expect(availableChatGPTSessionActions(parked)[0]?.id).toBe("unsnooze");
    expect(availableChatGPTSessionActions(parked).some((action) => action.id === "snooze")).toBe(false);
    expect(chatGPTNativeActionMenu(parked).some((item) => item.id === "registry:unsnooze")).toBe(true);
  });

  it("uses delivery evidence rather than enabling a send or auto-replay", async () => {
    const unconfirmed = context({ uncertainSend: true }, { canSend: true });
    const actions = availableChatGPTSessionActions(unconfirmed).map((action) => action.id);
    expect(actions[0]).toBe("check_delivery");
    expect(actions.includes("send")).toBe(false);
    expect(actions.includes("keep_working")).toBe(false);
    const executor = vi.fn(async () => ({ ok: true }));
    expect(await runChatGPTSessionAction("send", "exact-id", unconfirmed, executor)).toEqual({
      ok: false, message: "Action unavailable for this session.",
    });
    expect(executor).not.toHaveBeenCalled();
    await runChatGPTSessionAction("check_delivery", "exact-id", unconfirmed, executor);
    expect(executor).toHaveBeenCalledWith("check_delivery", "exact-id");
  });

  it("respects guarded capabilities and never constructs ID-free reboot", async () => {
    const normal = context({ age: "inactive" });
    expect(availableChatGPTSessionActions(normal).some((action) => action.id === "agent_reboot")).toBe(false);
    const guarded = context({ age: "inactive" }, { canReboot: true, canReload: true });
    expect(chatGPTNativeActionMenu(guarded).map((item) => item.id)).toContain("registry:agent_reboot");
    const caller = vi.fn(async () => ({ ok: true }));
    await runChatGPTSessionAction("agent_reboot", "target-id", guarded, caller);
    expect(caller).toHaveBeenCalledWith("agent_reboot", "target-id");
  });

  it("does not offer a hidden or unavailable session unsafe actions", () => {
    const hidden = context({ hidden: true });
    const ids = availableChatGPTSessionActions(hidden).map((action) => action.id);
    expect(ids.includes("hide")).toBe(false);
    expect(ids.includes("unhide")).toBe(true);
    expect(ids.includes("snooze")).toBe(false);
    expect(ids.includes("reload")).toBe(false);
  });
});
