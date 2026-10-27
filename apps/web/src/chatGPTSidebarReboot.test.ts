// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { beginSidebarReboot, pendingSidebarReboot, reconcileSidebarReboot } from "./chatGPTSidebarReboot";

const { reboot } = vi.hoisted(() => ({ reboot: vi.fn() }));
vi.mock("./chatGPTSameBrowserRebootDesktop", () => ({
  rebootChatGPTDesktop: reboot,
}));
vi.mock("./chatGPTBrowserSessions", () => ({
  readChatGPTBrowserSessions: () => [{ id: "exact-t3-slot", title: "Worker" }],
}));

const environmentId = EnvironmentId.make("sidebar-reboot-test");
const sessionId = "exact-t3-slot";
const operationId = "e48ed9c2-2dbc-41d3-b0cc-4096fcad5e21";
const journal = `t3code:chatgpt-browser:refresh:v1:${environmentId}`;
let storage: Map<string, string>;

beforeEach(() => {
  storage = new Map();
  reboot.mockReset();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    },
  });
  vi.stubGlobal("crypto", { getRandomValues: (buffer: Uint8Array) => {
    buffer.set(operationId.replaceAll("-", "").match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
    return buffer;
  } });
});

describe("sidebar Agent Reboot exact-target receipt control", () => {
  it("submits only to the specified T3 UUID and never starts over an UNKNOWN request", async () => {
    const receipt = { sessionId, operationId, status: "unknown" };
    reboot.mockImplementationOnce(async () => {
      storage.set(journal, JSON.stringify([receipt]));
      return receipt;
    });
    expect(await beginSidebarReboot({
      environmentId, sessionId, prompt: "Resume the task",
    })).toEqual(receipt);
    expect(reboot).toHaveBeenCalledExactlyOnceWith({
      environmentId, sessionId, operationId, prompt: "Resume the task", phase: "begin",
    });
    await expect(beginSidebarReboot({
      environmentId, sessionId, prompt: "Resume the task again",
    })).rejects.toThrow("Check its existing receipt");
    expect(reboot).toHaveBeenCalledTimes(1);
    expect(pendingSidebarReboot(environmentId, sessionId)).toEqual(receipt);
  });

  it("reconciles with the SAME operation and never calls begin/send on an uncertain reboot", async () => {
    storage.set(journal, JSON.stringify([{ sessionId, operationId, status: "unknown" }]));
    reboot.mockResolvedValueOnce({ sessionId, operationId, status: "submitted" });
    reboot.mockResolvedValueOnce({ sessionId, operationId, status: "committed" });
    expect(await reconcileSidebarReboot(environmentId, sessionId))
      .toMatchObject({ status: "committed" });
    expect(reboot.mock.calls).toEqual([
      [{ environmentId, sessionId, operationId, phase: "status" }],
      [{ environmentId, sessionId, operationId, phase: "finalize" }],
    ]);
  });

  it("leaves pending status intact until an assistant response is verified", async () => {
    storage.set(journal, JSON.stringify([{ sessionId, operationId, status: "unknown" }]));
    reboot.mockResolvedValueOnce({ sessionId, operationId, status: "submitted" });
    reboot.mockRejectedValueOnce(new Error("First assistant response is not verified."));
    expect(await reconcileSidebarReboot(environmentId, sessionId))
      .toMatchObject({ status: "submitted" });
    expect(reboot).toHaveBeenCalledTimes(2);
  });

  it("fails closed on unreadable receipts and absent exact sessions", async () => {
    storage.set(journal, "{broken json");
    await expect(beginSidebarReboot({
      environmentId, sessionId, prompt: "Resume",
    })).rejects.toThrow();
    expect(reboot).not.toHaveBeenCalled();
    storage.delete(journal);
    await expect(beginSidebarReboot({
      environmentId, sessionId: "wrong-session", prompt: "Resume",
    })).rejects.toThrow("exact T3 session");
    expect(reboot).not.toHaveBeenCalled();
  });
});
