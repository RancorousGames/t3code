import { describe, expect, it, vi } from "vite-plus/test";
import { nativeChatGPTPageStatus, warmMissingNativeChatGPT } from "./nativeChatGPTWarmSession";

const environmentId = "local";
const sessionId = "8f9c3cc9-99f2-4c6a-9ed5-72bd6814ac44";
const url = "https://chatgpt.com/";

describe("native Chromium non-mutating residency", () => {
  it("attaches only when the owner positively reports a missing page", async () => {
    const bridge = vi.fn(async (request: { operation: string }) => {
      if (request.operation === "probe") return { residency: "missing" };
      if (request.operation === "attach") return { url };
      throw new Error("Unexpected native operation");
    });
    expect(await warmMissingNativeChatGPT(bridge as never, environmentId, sessionId, url)).toBe(true);
    expect(bridge.mock.calls.map(([call]) => call.operation)).toEqual(["probe", "attach"]);
  });

  it("never reattaches a different profile or an unverified owner", async () => {
    for (const residency of ["mismatch", "unavailable", "unknown"]) {
      const bridge = vi.fn(async () => ({ residency }));
      expect(await nativeChatGPTPageStatus(bridge as never, environmentId, sessionId)).toMatchObject({
        residency: "unknown",
      });
      expect(await warmMissingNativeChatGPT(bridge as never, environmentId, sessionId, url)).toBe(false);
      expect(bridge.mock.calls).toHaveLength(2);
    }
  });

  it("does not reload an already resident native page", async () => {
    const bridge = vi.fn(async () => ({ residency: "resident", destroyed: false, url }));
    expect(await warmMissingNativeChatGPT(bridge as never, environmentId, sessionId, url)).toBe(false);
    expect(bridge.mock.calls).toHaveLength(1);
  });

  it("treats old owner implementations and transport failures as unknown", async () => {
    const bridge = vi.fn(async () => { throw new Error("Unsupported operation"); });
    expect(await nativeChatGPTPageStatus(bridge as never, environmentId, sessionId)).toMatchObject({
      residency: "unknown",
    });
    expect(await warmMissingNativeChatGPT(bridge as never, environmentId, sessionId, url)).toBe(false);
  });
});
