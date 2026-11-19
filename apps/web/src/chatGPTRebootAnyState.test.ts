// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import {
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

beforeEach(() => {
  storage.clear();
  activeTab = "tab";
  mount = true;
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
      const slot = await findRebootBrowserSlot(environmentId, sessionId);
      expect(slot).toEqual({ kind: "webview", runtimeId: "same-slot" });
      await replaceRebootBrowserSlot(slot);
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
});
