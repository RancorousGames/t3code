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
const wake = vi.fn();
const reset = vi.fn(async (_slot: string, _url?: string) => {});
const requestMount = vi.fn();
const storage = new Map<string, string>();
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
  wake.mockClear();
  reset.mockClear();
  requestMount.mockClear();
  vi.stubGlobal("window", {
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
      expect(await findRebootBrowserSlot(environmentId, sessionId)).toBe("same-slot");
      await replaceRebootBrowserSlot("same-slot");
      expect(requestMount).toHaveBeenCalledWith(environmentId, sessionId);
      expect(reset).toHaveBeenCalledWith("same-slot", "https://chatgpt.com/");
    },
  );

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
