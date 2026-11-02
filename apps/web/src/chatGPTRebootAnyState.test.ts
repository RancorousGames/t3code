// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import {
  archivePriorRebootUnknownSend,
  findRebootBrowserSlot,
  recordPriorRebootState,
  replaceRebootBrowserSlot,
} from "./chatGPTRebootAnyState";

const environmentId = EnvironmentId.make("reboot-all-states");
const sessionId = "browser-id";
const operationId = "operation";
const priorConversationId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
let activeTab: string | null = "tab";
let mount: boolean = true;
let oldUnknown: object | null = null;
let native = false;
const nativeBridge = vi.fn(async (_request: { operation: string; url?: string; identity?: object }): Promise<unknown> => ({
  url: "https://chatgpt.com/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  destroyed: false,
}));
const wake = vi.fn();
const reset = vi.fn(async (_slot: string, _url?: string) => {});
const requestMount = vi.fn();
const storage = new Map<string, string>();
vi.mock("./browser/persistentChatGPTSessionMode", () => ({
  isPersistentChatGPTSessionOptedIn: () => native,
}));
vi.mock("./browser/chatGPTGuestHibernation", () => ({
  wakeChatGPTGuest: (...a: unknown[]) => wake(...a),
}));
vi.mock("./browser/hostedBrowserGuestReset", () => ({
  resetHostedBrowserGuest: (...a: [string, string]) => reset(...a),
}));
vi.mock("./browser/previewRuntimeTabId", () => ({ previewRuntimeTabId: () => "same-slot" }));
vi.mock("./chatGPTBrowserSessions", () => ({
  chatGPTBrowserThreadRef: () => "thread",
  chatGPTBrowserLastUrlKey: () => "last-url",
}));
vi.mock("./chatGPTDeliveryMountRequest", () => ({
  requestChatGPTDeliveryMount: (...a: unknown[]) => requestMount(...a),
  releaseChatGPTDeliveryMount: vi.fn(),
}));
vi.mock("./previewStateStore", () => ({
  readThreadPreviewState: () => ({
    activeTabId: activeTab,
    snapshot: null,
    serverEpoch: "epoch",
  }),
}));
vi.mock("./chatGPTUncertainSendFence", () => ({
  readDurableUnknownChatGPTSend: () => oldUnknown,
}));

beforeEach(() => {
  storage.clear();
  activeTab = "tab";
  mount = true;
  oldUnknown = null;
  native = false;
  nativeBridge.mockClear().mockImplementation(async () => ({
    url: "https://chatgpt.com/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", destroyed: false,
  }));
  wake.mockClear();
  reset.mockClear();
  requestMount.mockClear();
  vi.stubGlobal("window", {
    desktopBridge: { stableChatGPTViewRequest: nativeBridge },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
  });
  vi.stubGlobal("document", {
    querySelectorAll: () => (mount ? [{ dataset: { previewTab: "same-slot" } }] : []),
  });
});

describe("Agent Reboot all-state host path", () => {
  it.each(["working", "pending", "hidden", "hibernated", "errored", "unavailable"])(
    "does not inspect or reject the predecessor's %s status",
    async () => {
      const slot = await findRebootBrowserSlot(environmentId, sessionId);
      expect(slot).toEqual({ kind: "webview", runtimeId: "same-slot" });
      await replaceRebootBrowserSlot(slot);
      expect(requestMount).toHaveBeenCalledWith(environmentId, sessionId);
      expect(reset).toHaveBeenCalledWith("same-slot", "https://chatgpt.com/");
    },
  );

  it("finds the exact native Chromium slot without waiting for a legacy preview mount", async () => {
    native = true;
    mount = false;
    activeTab = null;
    const slot = await findRebootBrowserSlot(environmentId, sessionId, 50);
    expect(slot).toEqual({ kind: "native", environmentId, sessionId });
    expect(requestMount).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(nativeBridge).not.toHaveBeenCalled(); // No side effects before durable reboot intent.
    await replaceRebootBrowserSlot(slot);
    expect(nativeBridge).toHaveBeenCalledWith({
      operation: "navigate",
      identity: { environmentId, sessionId, profileId: "default" },
      url: "https://chatgpt.com/",
    });
    expect(reset).not.toHaveBeenCalled();
  });

  it("attaches an unloaded native slot only after explicit reboot navigation begins", async () => {
    native = true;
    nativeBridge.mockImplementation(async ({ operation }: { operation: string }) => {
      if (operation === "snapshot")
        throw new Error("ChatGPT view identity or environment/profile binding mismatch.");
      if (operation === "attach") return { url: "https://chatgpt.com/", destroyed: false };
      throw new Error("Unexpected native operation");
    });
    const slot = await findRebootBrowserSlot(environmentId, sessionId);
    expect(nativeBridge).not.toHaveBeenCalled();
    await replaceRebootBrowserSlot(slot);
    expect(nativeBridge).toHaveBeenCalledWith({
      operation: "attach",
      identity: { environmentId, sessionId, profileId: "default" },
      url: "https://chatgpt.com/",
    });
    expect(nativeBridge.mock.calls.some(([request]) => request.operation === "navigate")).toBe(false);
  });

  it("does not replace a native page after an indeterminate registry inspection", async () => {
    native = true;
    nativeBridge.mockRejectedValue(new Error("Native Chromium IPC disconnected"));
    const slot = await findRebootBrowserSlot(environmentId, sessionId);
    await expect(replaceRebootBrowserSlot(slot)).rejects.toThrow(/could not be verified/i);
    expect(nativeBridge).toHaveBeenCalledTimes(1); // Snapshot only, never attach/reload.
  });

  it("fails closed when the native Chromium bridge is absent", async () => {
    native = true;
    vi.stubGlobal("window", { localStorage: window.localStorage });
    await expect(findRebootBrowserSlot(environmentId, sessionId)).rejects.toThrow(/bridge unavailable/i);
    expect(requestMount).not.toHaveBeenCalled();
  });

  it("retains previous URL and unverifiable draft status", () => {
    recordPriorRebootState(
      environmentId,
      sessionId,
      priorConversationId,
      operationId,
      "unavailable",
    );
    expect(
      JSON.parse(
        storage.get(
          `t3code:chatgpt-reboot-predecessor:v1:${environmentId}:${sessionId}:${operationId}`,
        )!,
      ),
    ).toMatchObject({ priorConversationId, draftBackup: "unavailable" });
  });

  it("archives a prior conversation's UNKNOWN send without treating it as delivered", () => {
    const oldKey = `t3code:chatgpt-unknown-send-fence:v1:${environmentId}:${sessionId}`;
    const receipt = {
      version: 2,
      reservedAt: Date.now(),
      conversationUrl: `https://chatgpt.com/c/${priorConversationId}`,
    };
    oldUnknown = receipt;
    storage.set(oldKey, JSON.stringify(receipt));
    expect(
      archivePriorRebootUnknownSend(environmentId, sessionId, priorConversationId, operationId),
    ).toBe(true);
    expect(storage.has(oldKey)).toBe(false);
    const archived = JSON.parse(
      storage.get(
        `t3code:chatgpt-reboot-unknown-archive:v1:${environmentId}:${sessionId}:${operationId}`,
      )!,
    );
    expect(archived).toMatchObject({
      delivery: "UNKNOWN",
      operationId,
      originalConversationUrl: receipt.conversationUrl,
    });
  });
});
