import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const sessionId = "8f9c3cc9-99f2-4c6a-9ed5-72bd6814ac44";
const key = "t3code:chatgpt-browser-engine";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("configured ChatGPT browser backend", () => {
  for (const engine of ["native", "webview"] as const) {
    it(`routes sessions exclusively to ${engine} after a fresh owner starts`, async () => {
      const persisted = new Map([[key, engine]]);
      const lifetime = new Map<string, string>();
      vi.stubGlobal("localStorage", { getItem: (k: string) => persisted.get(k) ?? null });
      vi.stubGlobal("sessionStorage", {
        getItem: (k: string) => lifetime.get(k) ?? null,
        setItem: (k: string, value: string) => lifetime.set(k, value),
      });
      const { configuredChatGPTBrowserEngine, isPersistentChatGPTSessionOptedIn } =
        await import("./persistentChatGPTSessionMode");
      expect(configuredChatGPTBrowserEngine()).toBe(engine);
      expect(isPersistentChatGPTSessionOptedIn(sessionId)).toBe(engine === "native");
      expect(isPersistentChatGPTSessionOptedIn("legacy-session-id")).toBe(false);
      // Changing Settings does not hot-swap an existing browser owner mid-send.
      persisted.set(key, engine === "native" ? "webview" : "native");
      expect(isPersistentChatGPTSessionOptedIn(sessionId)).toBe(engine === "native");
    });
  }
});
