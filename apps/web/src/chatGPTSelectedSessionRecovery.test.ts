// @vitest-environment node
// @ts-expect-error jsdom is present for tests; @types/jsdom is not installed.
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  url: "https://chatgpt.com/",
  saved: "https://chatgpt.com/c/6ad39e73-daf0-83ed-876a-eb393b15dfc9",
  hibernated: false,
  attached: true,
  idle: true,
  current: true,
  wake: vi.fn(),
  reload: vi.fn(),
  inspection: vi.fn(),
}));

vi.mock("./chatGPTBrowserSessions", () => ({
  readChatGPTBrowserSessions: () => [{ id: "blank-selected", title: "Selected session" }],
  chatGPTBrowserLastUrlKey: () => "saved:selected",
  chatGPTBrowserThreadRef: () => ({ threadId: "blank-selected" }),
}));
vi.mock("./chatGPTConversationIdentity", () => ({
  chatGPTConversationIdFromUrl: (value: string | null) => {
    const match = /^https:\/\/chatgpt\.com\/c\/([0-9a-f-]{36})/u.exec(value ?? "");
    return match?.[1] ?? null;
  },
}));
vi.mock("./previewStateStore", () => ({
  readThreadPreviewState: () => ({
    activeTabId: "tab", serverEpoch: "epoch",
  }),
}));
vi.mock("./browser/previewRuntimeTabId", () => ({
  previewRuntimeTabId: () => "selected-runtime",
}));
vi.mock("./browser/chatGPTGuestHibernation", () => ({
  isChatGPTGuestHibernated: () => mocks.hibernated,
  wakeChatGPTGuest: (...args: unknown[]) => {
    mocks.wake(...args);
    mocks.hibernated = false;
    mocks.attached = true;
  },
}));
vi.mock("./chatGPTSessionControl", () => ({
  inspectBrowserSession: (...args: unknown[]) => mocks.inspection(...args),
  runChatGPTSessionControl: (...args: unknown[]) => mocks.reload(...args),
}));

import { recoverSelectedBlankChatGPTSession } from "./chatGPTSelectedSessionRecovery";

let dom: JSDOM;
const start = (isCurrent = () => mocks.current) =>
  recoverSelectedBlankChatGPTSession({
    environmentId: "local" as never,
    sessionId: "blank-selected",
    isCurrent,
    maxWaitMs: 4_000,
  });

beforeEach(() => {
  dom = new JSDOM("", { url: "https://t3.local/" });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("localStorage", dom.window.localStorage);
  vi.stubGlobal("Event", dom.window.Event);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-10-21T13:00:00Z"));
  mocks.url = "https://chatgpt.com/";
  mocks.saved = "https://chatgpt.com/c/6ad39e73-daf0-83ed-876a-eb393b15dfc9";
  mocks.hibernated = false;
  mocks.attached = true;
  mocks.idle = true;
  mocks.current = true;
  mocks.wake.mockClear();
  mocks.reload.mockReset().mockImplementation(async (input: { shouldContinue: () => boolean }) => {
    if (!input.shouldContinue()) throw new Error("Selection changed");
    return { requestedNavigation: true, recoveredUrl: mocks.saved };
  });
  mocks.inspection.mockReset().mockImplementation(async () => ({
    observedGuestUrl: mocks.url,
    activity: mocks.idle ? "idle" : "working",
    status: mocks.idle ? "new" : "working",
    totalTurns: 0,
    lastRole: null,
    uiColor: mocks.idle ? "inactive" : "working",
  }));
  localStorage.setItem("saved:selected", JSON.stringify(mocks.saved));
  const element = document.createElement("webview");
  element.dataset.previewTab = "selected-runtime";
  document.body.appendChild(element);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  dom.window.close();
});

describe("click-select blank ChatGPT recovery", () => {
  it("restores a loaded blank guest after confirming an unchanged homepage", async () => {
    const outcome = start();
    await vi.advanceTimersByTimeAsync(1_200);
    expect(await outcome).toBe("recovered");
    expect(mocks.inspection).toHaveBeenCalledTimes(4);
    expect(mocks.reload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      action: "reload", sessionId: "blank-selected",
      shouldContinue: expect.any(Function),
    }));
    expect(mocks.wake).not.toHaveBeenCalled();
  });
  it("wakes an unloaded guest first, then restores the exact saved conversation", async () => {
    mocks.hibernated = true;
    mocks.attached = false;
    const promise = start();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await promise).toBe("recovered");
    expect(mocks.wake).toHaveBeenCalledOnce();
    expect(mocks.reload).toHaveBeenCalledOnce();
  });
  it("never refreshes a loaded healthy conversation", async () => {
    mocks.url = mocks.saved;
    expect(await start()).toBe("already-open");
    expect(mocks.reload).not.toHaveBeenCalled();
  });
  it("leaves a deliberate new chat with no saved URL untouched", async () => {
    localStorage.removeItem("saved:selected");
    expect(await start()).toBe("no-saved-conversation");
    expect(mocks.inspection).not.toHaveBeenCalled();
    expect(mocks.reload).not.toHaveBeenCalled();
  });
  it("never recovers an active generation or an unconfirmed draft", async () => {
    mocks.idle = false;
    expect(await start()).toBe("unsafe-or-unavailable");
    expect(mocks.reload).not.toHaveBeenCalled();
    mocks.idle = true;
    mocks.reload.mockRejectedValueOnce(new Error("Draft changed"));
    const attempt = start();
    await vi.advanceTimersByTimeAsync(1_200);
    expect(await attempt).toBe("unsafe-or-unavailable");
  });
  it("cancels navigation when another session becomes selected", async () => {
    const attempt = start();
    await vi.advanceTimersByTimeAsync(300);
    mocks.current = false;
    await vi.advanceTimersByTimeAsync(900);
    expect(await attempt).toBe("cancelled");
    expect(mocks.reload).not.toHaveBeenCalled();
  });
});
