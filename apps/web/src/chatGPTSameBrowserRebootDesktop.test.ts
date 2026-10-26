// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { rebootChatGPTDesktop } from "./chatGPTSameBrowserRebootDesktop";
import { buildChatGPTSessionHandoffPrompt } from "./chatGPTSessionHandoff";

const environmentId = EnvironmentId.make("reboot-desktop-lab");
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
const observe = vi.fn(async (..._args: unknown[]) => ({
  observedGuestUrl: null as string | null,
  activity: "idle",
  status: "done_or_idle",
}));
const read = vi.fn(async (..._args: unknown[]) => ({}));

vi.mock("./chatGPTBrowserSessions", () => ({
  readChatGPTBrowserSessions: () => [session],
}));
vi.mock("./chatGPTRebootAnyState", () => ({
  findRebootBrowserSlot: async () => "slot",
  replaceRebootBrowserSlot: (...args: unknown[]) => reset(...args),
  archivePriorRebootUnknownSend: () => true,
  recordPriorRebootState: vi.fn(),
}));
vi.mock("./chatGPTSessionControl", () => ({
  wakeChatGPTRebootPredecessor: (...args: unknown[]) => wake(...args),
  assertChatGPTRebootSafe: (...args: unknown[]) => loadedSafety(...args),
  navigateChatGPTRebootSafe: vi.fn(),
  inspectBrowserSession: (...args: unknown[]) => observe(...args),
  runChatGPTSessionControl: (...args: unknown[]) => read(...args),
  markChatGPTRebootGeneration: vi.fn(),
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
  observe.mockReset().mockResolvedValue({
    observedGuestUrl: null,
    activity: "idle",
    status: "done_or_idle",
  });
  read.mockReset().mockResolvedValue({});
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

describe("reboot coordinator without predecessor browser recovery", () => {
  it("preserves the original sidebar slot, backs up first, and never repeats an uncertain send", async () => {
    const input = {
      environmentId,
      operationId,
      sessionId,
      priorConversationId: conversationId,
      prompt: "Continue the same OpenRig seat",
      phase: "begin" as const,
    };
    const first = await rebootChatGPTDesktop(input);
    expect(first.status).toBe("unknown");
    expect(first.priorUrl).toBe(`https://chatgpt.com/c/${conversationId}`);
    expect(wake).not.toHaveBeenCalled();
    expect(loadedSafety).not.toHaveBeenCalled();
    expect(reset).toHaveBeenCalledExactlyOnceWith("slot");
    expect(sent).toHaveBeenCalledTimes(1);
    const second = await rebootChatGPTDesktop(input);
    expect(second).toEqual(first);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("reboots even if the old draft cannot be inspected", async () => {
    read.mockRejectedValueOnce(new Error("Old conversation cannot load"));
    const receipt = await rebootChatGPTDesktop({
      environmentId,
      operationId,
      sessionId,
      priorConversationId: conversationId,
      prompt: "Continue",
      phase: "begin",
    });
    expect(receipt.status).toBe("unknown");
    expect(reset).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("reboots without checking whether the predecessor is idle or errored", async () => {
    const receipt = await rebootChatGPTDesktop({
      environmentId,
      operationId,
      sessionId,
      priorConversationId: conversationId,
      prompt: "Continue",
      phase: "begin",
    });
    expect(receipt.status).toBe("unknown");
    expect(wake).not.toHaveBeenCalled();
    expect(loadedSafety).not.toHaveBeenCalled();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledTimes(1);
  });
});

describe("same-browser UNKNOWN receipt reconciliation", () => {
  it("accepts only the original bootstrap plus collapsed DOM suffix and a real first assistant reply", async () => {
    const prompt = "Continue the same canonical managed seat";
    const input = {
      environmentId,
      operationId,
      sessionId,
      priorConversationId: conversationId,
      prompt,
      phase: "begin" as const,
    };
    const first = await rebootChatGPTDesktop(input);
    expect(first.status).toBe("unknown");
    expect(first.sendStarted).toBe(true);

    const successor = "9f945488-0219-4331-a6ad-33d1453c3fa9";
    observe.mockResolvedValue({
      observedGuestUrl: `https://chatgpt.com/c/${successor}`,
      activity: "idle",
      status: "done_or_idle",
    });
    const user = buildChatGPTSessionHandoffPrompt(prompt, session.id, session.parentSessionId);
    const verifiedTurn = {
      conversationGuardValidated: true,
      verifiedConversationId: successor,
      session: {
        messages: [
          { role: "user", turn: 0, turnKey: "original", text: user + "\n…\nShow more" },
          {
            role: "assistant",
            turn: 0,
            turnKey: "original",
            text: "I have resumed the existing seat.",
          },
        ],
      },
    };
    // A single unexpected character is not recoverable by the display-only suffix normalization.
    read.mockResolvedValueOnce({
      ...verifiedTurn,
      session: {
        messages: [
          { role: "user", turn: 0, turnKey: "original", text: user + " \n…\nShow more" },
          verifiedTurn.session.messages[1],
        ],
      },
    });
    expect(
      await rebootChatGPTDesktop({ ...input, prompt: undefined, phase: "status" }),
    ).toMatchObject({ status: "unknown" });

    read.mockResolvedValue(verifiedTurn);
    expect(
      await rebootChatGPTDesktop({ ...input, prompt: undefined, phase: "status" }),
    ).toMatchObject({ status: "submitted", successorConversationId: successor });
    expect(
      await rebootChatGPTDesktop({ ...input, prompt: undefined, phase: "finalize" }),
    ).toMatchObject({
      status: "committed",
      sessionId,
      priorUrl: `https://chatgpt.com/c/${conversationId}`,
      successorConversationId: successor,
    });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(4);
  });
});
