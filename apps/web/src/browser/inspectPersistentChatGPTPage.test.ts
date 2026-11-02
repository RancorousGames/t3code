import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { inspectPersistentChatGPTPage } from "./inspectPersistentChatGPTPage";

afterEach(() => vi.unstubAllGlobals());

describe("native Chromium read-only inspection", () => {
  it("never evaluates an unloaded or misbound native owner", async () => {
    for (const residency of ["missing", "mismatch", "unavailable"]) {
      const bridge = vi.fn(async () => ({ residency }));
      vi.stubGlobal("window", { desktopBridge: { stableChatGPTViewRequest: bridge } });
      expect(await inspectPersistentChatGPTPage("local", "8f9c3cc9-99f2-4c6a-9ed5-72bd6814ac44", "1+1")).toBeNull();
      expect(bridge).toHaveBeenCalledTimes(1);
      expect(bridge.mock.calls[0]?.[0]).toMatchObject({ operation: "probe" });
    }
  });

  it("reads only the same verified resident owner", async () => {
    const bridge = vi.fn(async (input: { operation: string }) =>
      input.operation === "probe"
        ? { residency: "resident", destroyed: false, url: "https://chatgpt.com/" }
        : { result: 2 });
    vi.stubGlobal("window", { desktopBridge: { stableChatGPTViewRequest: bridge } });
    expect(await inspectPersistentChatGPTPage<number>("local", "8f9c3cc9-99f2-4c6a-9ed5-72bd6814ac44", "1+1")).toBe(2);
    expect(bridge.mock.calls.map(([request]) => request.operation)).toEqual(["probe", "evaluate"]);
  });
});
