// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { guardedNativeChatGPTReload } from "./guardedNativeChatGPTReload";

const ENV = EnvironmentId.make("native-reload");
const SESSION = "d4502b30-a672-43d2-93be-7e98dbd72242";
const CURRENT = "https://chatgpt.com/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SAVED = CURRENT;
const probe = vi.fn(async () => ({ status: "empty", url: CURRENT, text: "" }));
vi.mock("./inspectPersistentChatGPTPage", () => ({
  inspectPersistentChatGPTPage: () => probe(),
}));

const fixture = (url = CURRENT) => {
  const calls: Array<{ operation: string; identity?: { sessionId: string }; expression?: string }> = [];
  const bridge = vi.fn(async (request: { operation: string; identity?: { sessionId: string }; expression?: string }) => {
    calls.push(request);
    if (request.operation === "snapshot") return { url, destroyed: false };
    if (request.operation === "evaluate") return { result: true };
    throw new Error("Unexpected request");
  });
  return { calls, bridge };
};

beforeEach(() => {
  probe.mockReset().mockResolvedValue({ status: "empty", url: CURRENT, text: "" });
});

describe("guarded native recovery and browser engine isolation", () => {
  it("reloads only the exact native owner, with the final draft and attachment check in its navigation turn", async () => {
    const { calls, bridge } = fixture();
    const result = await guardedNativeChatGPTReload({
      environmentId: ENV, sessionId: SESSION, currentUrl: CURRENT,
      savedUrl: SAVED, working: false, force: false, bridge: bridge as never,
    });
    expect(result.nativeReloadIssued).toBe(true);
    expect(calls.map((call) => call.operation)).toEqual(["snapshot", "evaluate"]);
    expect(calls[1]?.identity?.sessionId).toBe(SESSION);
    expect(calls[1]?.expression).toContain("location.reload()");
    expect(calls[1]?.expression).toContain("probe.status !== 'empty'");
    expect(calls[1]?.expression).toContain("input[type=\"file\"]");
    expect(probe).toHaveBeenCalledTimes(2);
  });
  it("rejects native human drafts before any navigation", async () => {
    const { calls, bridge } = fixture();
    probe.mockResolvedValue({ status: "nonempty", text: "Human draft", url: CURRENT });
    await expect(guardedNativeChatGPTReload({
      environmentId: ENV, sessionId: SESSION, currentUrl: CURRENT,
      savedUrl: SAVED, working: false, force: true, bridge: bridge as never,
    })).rejects.toThrow(/draft/i);
    expect(calls.map((call) => call.operation)).toEqual(["snapshot"]);
  });
  it("recovers a verified empty native home to the exact saved URL", async () => {
    const { calls, bridge } = fixture("https://chatgpt.com/");
    probe.mockResolvedValue({ status: "empty", url: "https://chatgpt.com/", text: "" });
    const result = await guardedNativeChatGPTReload({
      environmentId: ENV, sessionId: SESSION, currentUrl: "https://chatgpt.com/",
      savedUrl: SAVED, working: false, force: false, bridge: bridge as never,
    });
    expect(result).toEqual({ requestedNavigation: true, recoveredUrl: SAVED });
    expect(calls[1]?.expression).toContain("location.assign");
  });
  it("does not touch a changed native page or replace a working page without force", async () => {
    const { calls, bridge } = fixture("https://chatgpt.com/c/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    await expect(guardedNativeChatGPTReload({
      environmentId: ENV, sessionId: SESSION, currentUrl: CURRENT,
      savedUrl: SAVED, working: false, force: true, bridge: bridge as never,
    })).rejects.toThrow(/changed/i);
    expect(calls).toHaveLength(1);
    await expect(guardedNativeChatGPTReload({
      environmentId: ENV, sessionId: SESSION, currentUrl: CURRENT,
      savedUrl: SAVED, working: true, force: false, bridge: bridge as never,
    })).rejects.toThrow(/working/i);
    expect(calls).toHaveLength(1);
  });
});
