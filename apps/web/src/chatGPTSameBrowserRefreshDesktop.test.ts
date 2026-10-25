// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { refreshChatGPTDesktop } from "./chatGPTSameBrowserRefreshDesktop";

const environmentId = EnvironmentId.make("refresh-desktop-lab");
const sessionId = "1c045bfd-08d7-49b8-83b4-142ba0d250f8";
const conversationId = "6adad1ef-d298-83ed-a7a8-b8ec03d44abd";
const operationId = "10c8696f-2550-4bda-8b38-3a1534528c76";
const session = { id: sessionId, title: "COORDINATOR", parentSessionId: null };
const guest = { runtimeId: "slot", webview: {} };
const offline = vi.fn(async (..._args: unknown[]): Promise<typeof guest | null> => guest);
const reset = vi.fn(async (..._args: unknown[]) => {});
const wake = vi.fn(async (..._args: unknown[]) => {
  throw new Error("Old conversation cannot load");
});
const loadedSafety = vi.fn(async (..._args: unknown[]) => {
  throw new Error("Old conversation cannot load");
});
const sent = vi.fn(async (..._args: unknown[]) => ({ delivery: "user_turn_observed" as const }));

vi.mock("./chatGPTBrowserSessions", () => ({
  readChatGPTBrowserSessions: () => [session],
}));
vi.mock("./chatGPTRefreshOffline", () => ({
  inspectErroredRefreshPredecessor: (...args: unknown[]) => offline(...args),
  navigateOfflineChatGPTRefresh: (...args: unknown[]) => reset(...args),
}));
vi.mock("./chatGPTSessionControl", () => ({
  wakeChatGPTRefreshPredecessor: (...args: unknown[]) => wake(...args),
  assertChatGPTRefreshSafe: (...args: unknown[]) => loadedSafety(...args),
  navigateChatGPTRefreshSafe: vi.fn(),
  inspectBrowserSession: async () => ({ observedGuestUrl: null }),
  runChatGPTSessionControl: vi.fn(),
}));
vi.mock("./chatGPTBrowserAutomation", () => ({
  sendInitialChatGPTPrompt: (...args: unknown[]) => sent(...args),
}));
let store = new Map<string, string>();
const backup = vi.fn(async (input: { url: string }) => ({
  url: input.url,
  path: "private-backup",
  uncertainSendPresent: false,
}));

beforeEach(() => {
  store = new Map<string, string>();
  offline.mockReset().mockResolvedValue(guest);
  reset.mockClear();
  wake.mockClear();
  loadedSafety.mockClear();
  sent.mockClear();
  backup.mockClear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    },
    desktopBridge: { savePrivateChatGPTDraftSnapshot: backup },
  });
});

describe("refresh coordinator without predecessor browser recovery", () => {
  it("preserves the original sidebar slot, backs up first, and never repeats an uncertain send", async () => {
    const input = {
      environmentId,
      operationId,
      sessionId,
      priorConversationId: conversationId,
      prompt: "Continue the same OpenRig seat",
      phase: "begin" as const,
    };
    const first = await refreshChatGPTDesktop(input);
    expect(first.status).toBe("unknown");
    expect(first.priorUrl).toBe(`https://chatgpt.com/c/${conversationId}`);
    expect(wake).not.toHaveBeenCalled();
    expect(loadedSafety).not.toHaveBeenCalled();
    expect(backup).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledExactlyOnceWith(
      environmentId,
      session,
      conversationId,
      guest,
      "https://chatgpt.com/",
    );
    expect(sent).toHaveBeenCalledTimes(1);
    const second = await refreshChatGPTDesktop(input);
    expect(second).toEqual(first);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("fails before saving a refresh intent when private draft backup fails", async () => {
    backup.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      refreshChatGPTDesktop({
        environmentId,
        operationId,
        sessionId,
        priorConversationId: conversationId,
        prompt: "Continue",
        phase: "begin",
      }),
    ).rejects.toThrow("disk full");
    expect(reset).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it("does not bypass the normal safety path unless the predecessor is definitely errored", async () => {
    offline.mockResolvedValue(null);
    await expect(
      refreshChatGPTDesktop({
        environmentId,
        operationId,
        sessionId,
        priorConversationId: conversationId,
        prompt: "Continue",
        phase: "begin",
      }),
    ).rejects.toThrow("Old conversation cannot load");
    expect(wake).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
  });
});
