// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const shared = vi.hoisted(() => ({
  url: "https://chatgpt.com/",
  saved: "https://chatgpt.com/c/6ad64bc9-020c-83eb-a38c-85834fa7118b",
  activity: "idle",
  uiActivity: "idle",
  safe: true,
  draft: "",
  unknownSend: false,
}));
vi.mock("./browser/chatGPTGuestHibernation", () => ({
  isChatGPTGuestHibernated: () => false,
  touchChatGPTGuest: () => {},
  wakeChatGPTGuest: () => {},
}));
vi.mock("./browser/previewRuntimeTabId", () => ({
  previewRuntimeTabId: () => "unit-runtime",
}));
vi.mock("./previewStateStore", () => ({
  readThreadPreviewState: () => ({
    activeTabId: "target-tab",
    serverEpoch: "epoch",
    sessions: { "target-tab": { navStatus: { _tag: "Success", url: shared.url } } },
    desktopByTabId: { "target-tab": { loading: false } },
  }),
}));
vi.mock("./chatGPTBrowserSessions", () => ({
  chatGPTBrowserThreadRef: (_env: unknown, id: string) => ({ threadId: id }),
  chatGPTBrowserLastUrlKey: (_env: unknown, id: string) => `saved:${id}`,
  chatGPTBrowserLastWorkingKey: () => "last-working",
}));
vi.mock("./components/preview/previewBridge", () => ({
  previewBridge: {
    navigate: vi.fn(async (_runtime: string, url: string) => {
      shared.url = url;
    }),
    refresh: vi.fn(),
  },
}));
vi.mock("./chatGPTWebviewAutomation", () => ({
  chatGPTWebviewAutomation: {
    evaluate: vi.fn(async (_runtime: string, options: { expression: string }) =>
      options.expression.startsWith("(() => {const el=document.querySelector(")
        ? shared.draft
        : shared.safe,
    ),
  },
}));
vi.mock("./components/sidebar/chatGPTConversationRecovery", () => ({
  hasChatGPTLoadFailure: () => false,
  recordRecoveryAttempt: vi.fn(),
}));
vi.mock("./chatGPTRecoveryDiagnostics", () => ({
  readChatGPTRecoveryEvents: () => [],
  readChatGPTRecoveryState: () => null,
  recordChatGPTRecoveryEvent: vi.fn(),
}));
vi.mock("./chatGPTSessionCompletion", () => ({
  validChatGPTCompletion: () => null,
}));

import { runChatGPTSessionControl } from "./chatGPTSessionControl";
import { previewBridge } from "./components/preview/previewBridge";
import { chatGPTWebviewAutomation } from "./chatGPTWebviewAutomation";

const session = { id: "existing-inactive-session", title: "Inactive" };
const changeState = (state: "hidden" | "unhidden" | "closed") =>
  runChatGPTSessionControl({
    environmentId: "local" as never,
    sessions: [session],
    sessionId: session.id,
    action: "change_state",
    state,
  });
const reload = (force?: boolean) =>
  runChatGPTSessionControl({
    environmentId: "local" as never,
    sessions: [session],
    sessionId: session.id,
    action: "reload",
    ...(force === undefined ? {} : { force }),
  });

beforeEach(() => {
  shared.url = "https://chatgpt.com/";
  shared.saved = "https://chatgpt.com/c/6ad64bc9-020c-83eb-a38c-85834fa7118b";
  shared.activity = "idle";
  shared.uiActivity = "idle";
  shared.safe = true;
  shared.draft = "";
  shared.unknownSend = false;
  const guest = {
    dataset: { previewTab: "unit-runtime" },
    executeJavaScript: async () => ({
      url: shared.url,
      activity: shared.activity,
      uiActivity: shared.uiActivity,
      lastText: "",
      lastRole: null,
      assistantHasContent: false,
      totalTurns: 0,
      messages: [],
      stuck: false,
      connectionInterrupted: false,
    }),
  };
  vi.stubGlobal("document", { querySelectorAll: () => [guest] });
  const storage = {
    getItem: (key: string) =>
      key === `saved:${session.id}`
        ? JSON.stringify(shared.saved)
        : shared.unknownSend && key.includes("chatgpt-unknown-send-fence")
          ? "pending"
          : null,
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { localStorage: storage });
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe("hidden-session list contract", () => {
  const hidden = { id: "previously-hidden", title: "Hidden worker", hidden: true };
  const list = (includeHidden?: boolean) =>
    runChatGPTSessionControl({
      environmentId: "local" as never,
      sessions: [session, hidden],
      action: "list",
      which: "all",
      ...(includeHidden === undefined ? {} : { includeHidden }),
    });

  it("excludes hidden even for which=all unless opted in, without reviving the hidden guest", async () => {
    const ordinary = (await list()) as { sessions: Array<{ id: string }> };
    expect(ordinary.sessions.map((entry) => entry.id)).toEqual([session.id]);
    const optedIn = (await list(true)) as { sessions: Array<{ id: string; hidden: boolean }> };
    expect(optedIn.sessions.map((entry) => entry.id)).toEqual([session.id, hidden.id]);
    expect(optedIn.sessions[1]?.hidden).toBe(true);
    expect(optedIn.sessions[1]).toHaveProperty("latestMessageFirstFiveWords", null);
  });
});

describe("exact-session state changes", () => {
  it("allows a safe local close, but rejects a nonempty composer draft", async () => {
    await expect(changeState("closed")).resolves.toMatchObject({
      action: "change_state",
      state: "closed",
      sessionId: session.id,
    });
    shared.draft = "unfinished work";
    await expect(changeState("closed")).rejects.toThrow(/composer draft/);
  });

  it("closes only the addressed container during active generation, but cannot hide it", async () => {
    shared.activity = "working";
    shared.uiActivity = "working";
    await expect(changeState("closed")).resolves.toMatchObject({
      action: "change_state",
      sessionId: session.id,
      state: "closed",
    });
    await expect(changeState("hidden")).rejects.toThrow(/generating/);
  });

  it("preserves drafts and UNKNOWN sends even while generating", async () => {
    shared.activity = "working";
    shared.uiActivity = "working";
    shared.draft = "unsent draft";
    await expect(changeState("closed")).rejects.toThrow(/composer draft/);
    shared.draft = "";
    shared.unknownSend = true;
    await expect(changeState("closed")).rejects.toThrow(/UNKNOWN send/);
  });

  it("only affects the addressed session state, not other sessions", async () => {
    await expect(changeState("hidden")).resolves.toMatchObject({
      sessionId: session.id,
      state: "hidden",
    });
    await expect(
      runChatGPTSessionControl({
        environmentId: "local" as never,
        sessions: [session],
        action: "change_state",
        sessionId: "different-session",
        state: "closed",
      }),
    ).rejects.toThrow(/Unknown ChatGPT session id/);
  });
});

describe("existing blank ChatGPT homepage recovery through normal OMCP reload", () => {
  it("navigates exactly the attached inactive session to its saved canonical URL without force", async () => {
    const result = await reload();
    expect(result).toMatchObject({
      sessionId: session.id,
      recoveredUrl: shared.saved,
      requestedNavigation: true,
    });
    expect(previewBridge!.navigate).toHaveBeenCalledExactlyOnceWith("unit-runtime", shared.saved);
    expect(chatGPTWebviewAutomation.evaluate).toHaveBeenCalledTimes(2);
    expect(previewBridge!.refresh).not.toHaveBeenCalled();
  });

  it("cancels a selection-triggered recovery before navigation if the user switched tabs", async () => {
    await expect(
      runChatGPTSessionControl({
        environmentId: "local" as never,
        sessions: [session],
        sessionId: session.id,
        action: "reload",
        shouldContinue: () => false,
      }),
    ).rejects.toThrow(/no longer selected/);
    expect(previewBridge!.navigate).not.toHaveBeenCalled();
    expect(previewBridge!.refresh).not.toHaveBeenCalled();
  });

  it("refuses no saved canonical URL or a nonempty/drafted homepage", async () => {
    shared.saved = "https://chatgpt.com/";
    await expect(reload()).rejects.toThrow(/No canonical saved/);
    shared.saved = "https://chatgpt.com/c/6ad64bc9-020c-83eb-a38c-85834fa7118b";
    shared.safe = false;
    await expect(reload()).rejects.toThrow(/draft/);
    expect(previewBridge!.navigate).not.toHaveBeenCalled();
  });

  it("refuses to disrupt active generation even when force is supplied", async () => {
    shared.activity = "working";
    shared.uiActivity = "working";
    await expect(reload(true)).rejects.toThrow(/working session/);
    expect(previewBridge!.navigate).not.toHaveBeenCalled();
  });

  it("requires force for an orange interrupted session while allowing a regular inactive reload", async () => {
    shared.uiActivity = "interrupted";
    await expect(reload()).rejects.toThrow(/orange/);
    await expect(reload(true)).resolves.toMatchObject({ requestedNavigation: true });
  });

  it("refreshes a healthy idle canonical conversation normally without force", async () => {
    shared.url = shared.saved;
    await expect(reload()).resolves.toMatchObject({ reloaded: true, sessionId: session.id });
    expect(previewBridge!.refresh).toHaveBeenCalledExactlyOnceWith("unit-runtime");
    expect(previewBridge!.navigate).not.toHaveBeenCalled();
  });

  it("refuses to refresh an unrelated conversation navigated into the same session", async () => {
    shared.url = "https://chatgpt.com/c/6ad64bc9-020c-83eb-a38c-85834fa7118c";
    await expect(reload()).rejects.toThrow(/unrelated conversation/);
    expect(previewBridge!.refresh).not.toHaveBeenCalled();
  });
});
