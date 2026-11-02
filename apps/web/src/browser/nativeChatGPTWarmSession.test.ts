import { describe, expect, it, vi } from "vite-plus/test";
import { nativeChatGPTResidency, warmMissingNativeChatGPT } from "./nativeChatGPTWarmSession";

const env = "local";
const id = "11111111-1111-4111-8111-111111111111";
const url = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";

describe("native Chrome warm attach never reloads an already loaded page", () => {
  it("treats an existing page as occupied even when it has no DOM webview", async () => {
    const bridge = vi.fn(async () => ({ residency: "resident", destroyed: false, url })) as never;
    expect(await nativeChatGPTResidency(bridge, env, id)).toBe("resident");
    expect(await warmMissingNativeChatGPT(bridge, env, id, url)).toBe(false);
    expect(bridge).toHaveBeenCalledTimes(2);
    expect(bridge).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "attach" }));
  });

  it("only attaches when the native registry explicitly reports the session missing", async () => {
    const bridge = vi.fn(async (request: { operation: string }) => {
      if (request.operation === "probe") return { residency: "missing" };
      return { destroyed: false, url };
    }) as never;
    expect(await warmMissingNativeChatGPT(bridge, env, id, url)).toBe(true);
    expect(bridge).toHaveBeenLastCalledWith({
      operation: "attach", identity: { environmentId: env, sessionId: id, profileId: "default" }, url,
    });
  });

  it("never attaches after a transient or ambiguous probe failure", async () => {
    const bridge = vi.fn(async () => { throw new Error("IPC timeout"); }) as never;
    expect(await nativeChatGPTResidency(bridge, env, id)).toBe("unknown");
    expect(await warmMissingNativeChatGPT(bridge, env, id, url)).toBe(false);
    expect(bridge).toHaveBeenCalledTimes(2);
  });
});
