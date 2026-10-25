import { describe, expect, it, vi } from "vite-plus/test";
import {
  refreshSameBrowser,
  normalizeChatGPTRefreshBootstrap,
  type RefreshPorts,
  type RefreshReceipt,
} from "./chatGPTSameBrowserRefresh";

function fixture() {
  let saved: RefreshReceipt[] = [];
  const input = {
    operationId: "operation",
    sessionId: "browser",
    priorConversationId: "old",
    bootstrapHash: "hash",
  };
  const ports: RefreshPorts = {
    read: () => structuredClone(saved),
    write: (value) => {
      saved = structuredClone(value);
    },
    assertSafe: vi.fn(async () => {}),
    navigate: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    observe: vi.fn(async () => ({
      conversationId: "new",
      bootstrapHash: "hash",
      assistantReplied: true,
    })),
  };
  return { input, ports };
}

describe("same browser refresh durable navigation intent", () => {
  it("keeps the browser, archives old URL and rotates generation only once", async () => {
    const { input, ports } = fixture();
    expect(await refreshSameBrowser(input, "begin", ports)).toMatchObject({
      sessionId: "browser",
      priorUrl: "https://chatgpt.com/c/old",
      successorConversationId: "new",
      generation: 1,
      status: "submitted",
    });
    await refreshSameBrowser(input, "begin", ports);
    expect(await refreshSameBrowser(input, "finalize", ports)).toMatchObject({
      status: "committed",
    });
    expect(ports.navigate).toHaveBeenCalledTimes(1);
    expect(ports.send).toHaveBeenCalledTimes(1);
  });
  it("persists before navigation and never retries UNKNOWN after restart", async () => {
    const { input, ports } = fixture();
    ports.navigate = vi.fn(async () => {
      expect(ports.read()[0]?.status).toBe("unknown");
      throw new Error("lost ack");
    });
    await expect(refreshSameBrowser(input, "begin", ports)).rejects.toThrow("lost ack");
    ports.observe = vi.fn(async () => ({
      conversationId: "old",
      bootstrapHash: null,
      assistantReplied: false,
    }));
    expect(await refreshSameBrowser(input, "begin", { ...ports })).toMatchObject({
      status: "unknown",
    });
    expect(ports.navigate).toHaveBeenCalledTimes(1);
    expect(ports.send).not.toHaveBeenCalled();
  });
  it("restores a failed navigation from verified empty home", async () => {
    const { input, ports } = fixture();
    ports.navigate = vi
      .fn()
      .mockRejectedValueOnce(new Error("navigation failed"))
      .mockResolvedValue(undefined);
    await expect(refreshSameBrowser(input, "begin", ports)).rejects.toThrow();
    ports.observe = vi.fn(async () => ({
      conversationId: null,
      bootstrapHash: null,
      assistantReplied: false,
    }));
    expect(await refreshSameBrowser(input, "restore", ports)).toMatchObject({ status: "restored" });
    expect(ports.navigate).toHaveBeenLastCalledWith("https://chatgpt.com/c/old");
  });
  it("never restores or resends an ambiguous submit", async () => {
    const { input, ports } = fixture();
    ports.send = vi.fn(async () => {
      throw new Error("unknown submit");
    });
    await expect(refreshSameBrowser(input, "begin", ports)).rejects.toThrow("unknown submit");
    await expect(refreshSameBrowser(input, "restore", ports)).rejects.toThrow(
      "Submit may have started",
    );
    expect(await refreshSameBrowser(input, "status", ports)).toMatchObject({ status: "submitted" });
    expect(ports.send).toHaveBeenCalledTimes(1);
  });
  it.each(["old", "unrelated"])("rejects old identity or unmatched bootstrap %s", async (id) => {
    const { input, ports } = fixture();
    ports.observe = vi.fn(async () => ({
      conversationId: id,
      bootstrapHash: id === "old" ? "hash" : "wrong",
      assistantReplied: true,
    }));
    expect(await refreshSameBrowser(input, "begin", ports)).toMatchObject({ status: "unknown" });
  });
  it("requires a first assistant reply, blocks concurrent operations and mismatched IDs", async () => {
    const { input, ports } = fixture();
    ports.observe = vi.fn(async () => ({
      conversationId: "new",
      bootstrapHash: "hash",
      assistantReplied: false,
    }));
    await refreshSameBrowser(input, "begin", ports);
    await expect(refreshSameBrowser(input, "finalize", ports)).rejects.toThrow("First assistant");
    await expect(
      refreshSameBrowser({ ...input, operationId: "other" }, "begin", ports),
    ).rejects.toThrow("unresolved");
    await expect(
      refreshSameBrowser({ ...input, bootstrapHash: "different" }, "begin", ports),
    ).rejects.toThrow("different inputs");
  });
  it("fails before navigation on draft, active generation or failed backup", async () => {
    const { input, ports } = fixture();
    ports.assertSafe = vi.fn(async () => {
      throw new Error("unsafe");
    });
    await expect(refreshSameBrowser(input, "begin", ports)).rejects.toThrow("unsafe");
    expect(ports.read()).toEqual([]);
    expect(ports.navigate).not.toHaveBeenCalled();
  });
  it("can revisit archived old history only after safely backing up the new completed generation", async () => {
    const { input, ports } = fixture();
    await refreshSameBrowser(input, "begin", ports);
    await refreshSameBrowser(input, "finalize", ports);
    ports.assertSafe = vi.fn(async (id) => {
      if (id !== "new") throw new Error("wrong guard");
    });
    const restored = await refreshSameBrowser(input, "restore", ports);
    expect(restored).toMatchObject({
      status: "committed",
      historyRestoreIssued: true,
      successorConversationId: "new",
    });
    await refreshSameBrowser(input, "restore", ports);
    expect(ports.navigate).toHaveBeenCalledTimes(2);
    expect(ports.navigate).toHaveBeenLastCalledWith("https://chatgpt.com/c/old");
  });
  it("refuses all navigation when persistence cannot be verified", async () => {
    const { input, ports } = fixture();
    ports.write = () => {};
    await expect(refreshSameBrowser(input, "begin", ports)).rejects.toThrow(
      "persistence unconfirmed",
    );
    expect(ports.navigate).not.toHaveBeenCalled();
  });
});

describe("refresh bootstrap DOM expansion affordance", () => {
  const submitted = "Exact OpenRig handoff\n\nT3 Code local inter-session routing\nend";
  it("normalizes only the actual ChatGPT collapsed-message suffix", () => {
    expect(normalizeChatGPTRefreshBootstrap(submitted + "\n…\nShow more")).toBe(submitted);
    expect(normalizeChatGPTRefreshBootstrap(submitted)).toBe(submitted);
  });
  it("preserves altered or interior user content so its hash cannot be accepted", () => {
    expect(normalizeChatGPTRefreshBootstrap(submitted + "\n…\nShow less")).not.toBe(submitted);
    expect(normalizeChatGPTRefreshBootstrap("other\n…\nShow more")).not.toBe(submitted);
    expect(normalizeChatGPTRefreshBootstrap(submitted + "\n…\nShow more\nextra")).not.toBe(
      submitted,
    );
  });
});
