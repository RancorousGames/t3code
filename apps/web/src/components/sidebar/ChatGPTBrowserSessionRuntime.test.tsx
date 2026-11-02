import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  state: {
    serverEpoch: null as string | null,
    activeTabId: null as string | null,
    snapshot: null as { tabId: string; navStatus: { _tag: string; url: string } } | null,
    sessions: {} as Record<string, unknown>,
    desktopByTabId: {} as Record<string, { hasWebContents: boolean }>,
  },
  refresh: vi.fn(async () => {}),
  open: vi.fn(async () => ({ _tag: "Success", value: {} })),
  close: vi.fn(),
  setUrl: vi.fn(),
  lastUrl: "https://chatgpt.com/c/saved",
  list: vi.fn(async () => ({
    _tag: "Success",
    value: {
      sessions: [] as Array<{ tabId: string; navStatus: { _tag: string; url: string } }>,
      serverEpoch: "server-1",
      revision: 0,
    },
  })),
}));

vi.mock("../../previewStateStore", () => ({
  useThreadPreviewState: () => mocks.state,
  readThreadPreviewState: () => mocks.state,
  reconcilePreviewServerSessions: (
    _ref: unknown,
    result: { sessions: (typeof mocks.state.snapshot)[]; serverEpoch: string },
  ) => {
    const snapshot = result.sessions[0] ?? null;
    mocks.state = { ...mocks.state, serverEpoch: result.serverEpoch, snapshot };
  },
}));
vi.mock("../../state/preview", () => ({
  previewEnvironment: { open: "open", close: "close", list: "list" },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.close }));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => mocks.list }));
vi.mock("../../hooks/useLocalStorage", () => ({
  useLocalStorage: (key: string) =>
    key.startsWith("t3code:chatgpt-browser:last-url:")
      ? [mocks.lastUrl, mocks.setUrl]
      : key.startsWith("t3code:chatgpt-browser:sessions:")
        ? [[], vi.fn()]
        : ["", vi.fn()],
}));
vi.mock("../preview/usePreviewSession", () => ({ usePreviewSession: () => {} }));
vi.mock("../preview/openPreviewSession", () => ({ openPreviewSession: mocks.open }));
vi.mock("../preview/previewBridge", () => ({ previewBridge: { refresh: mocks.refresh } }));

import { ChatGPTBrowserSessionRuntime } from "./ChatGPTBrowserSessionRuntime";

let renderer: ReactTestRenderer | undefined;
let sessionNumber = 0;
const environmentId = EnvironmentId.make("local");

async function mount(suspended = false) {
  const sessionId = `session-${++sessionNumber}`;
  await act(async () => {
    renderer = create(
      <ChatGPTBrowserSessionRuntime
        environmentId={environmentId}
        sessionId={sessionId}
        suspended={suspended}
      />,
    );
  });
  return sessionId;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.lastUrl = "https://chatgpt.com/c/saved";
  mocks.state = {
    serverEpoch: null,
    activeTabId: null,
    snapshot: null,
    sessions: {},
    desktopByTabId: {},
  };
});
afterEach(() => {
  vi.useRealTimers();
  if (renderer) act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("ChatGPT session startup", () => {
  it("opens a new session at ChatGPT even before an owner has a server epoch", async () => {
    mocks.lastUrl = "https://chatgpt.com";
    await mount();
    expect(mocks.list).toHaveBeenCalledOnce();
    expect(mocks.open).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://chatgpt.com" }),
    );
  });

  it("does not wait for preview events to restore a saved URL after restart", async () => {
    await mount();
    expect(mocks.open).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://chatgpt.com/c/saved" }),
    );
  });

  it("automatically retries a transient startup React update-depth failure once", async () => {
    vi.useFakeTimers();
    mocks.list.mockRejectedValueOnce(new Error("Minified React error #185"));
    await mount();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.open).toHaveBeenCalledTimes(1);
    // A second transient error must remain actionable, not trigger a retry loop.
    vi.useRealTimers();
  });

  it("reuses an existing server tab discovered after a renderer restart", async () => {
    mocks.list.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        serverEpoch: "server-1",
        revision: 1,
        sessions: [
          {
            tabId: "existing-tab",
            navStatus: { _tag: "Success", url: "https://chatgpt.com/c/existing" },
          },
        ],
      },
    });
    await mount();
    expect(mocks.list).toHaveBeenCalledOnce();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("falls back to ChatGPT when the saved URL is blank or about:blank", async () => {
    for (const url of ["", "  ", "about:blank"]) {
      mocks.lastUrl = url;
      await mount();
      expect(mocks.open).toHaveBeenLastCalledWith(
        expect.objectContaining({ url: "https://chatgpt.com" }),
      );
      act(() => renderer?.unmount());
      renderer = undefined;
    }
  });

  it("records a conversation URL when navigation completes", async () => {
    mocks.state.snapshot = {
      tabId: "tab-1",
      navStatus: { _tag: "Success", url: "https://chatgpt.com/c/new-conversation" },
    };
    await mount();
    expect(mocks.setUrl).toHaveBeenCalledWith("https://chatgpt.com/c/new-conversation");
  });

  it("does not overwrite a saved conversation URL with an empty browser page", async () => {
    mocks.state.snapshot = { tabId: "tab-1", navStatus: { _tag: "Success", url: "about:blank" } };
    await mount();
    expect(mocks.setUrl).not.toHaveBeenCalled();
  });

  it.each([
    "https://chatgpt.com/",
    "https://chatgpt.com/?src=history_search",
    "https://chatgpt.com/auth/login",
    "https://accounts.google.com/v3/signin/identifier",
  ])("preserves the saved conversation when the guest redirects to %s", async (url) => {
    mocks.state.snapshot = { tabId: "tab-1", navStatus: { _tag: "Success", url } };
    await mount();
    expect(mocks.setUrl).not.toHaveBeenCalled();
  });

  it("opens the saved conversation without refreshing its initial load", async () => {
    mocks.state.serverEpoch = "server-1";
    await mount();
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(mocks.open).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://chatgpt.com/c/saved" }),
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("does not eagerly refresh an existing session when the desktop page attaches", async () => {
    mocks.state = {
      serverEpoch: "server-1",
      activeTabId: "tab-1",
      snapshot: {
        tabId: "tab-1",
        navStatus: { _tag: "Success", url: "https://chatgpt.com/c/saved" },
      },
      sessions: { "tab-1": {} },
      desktopByTabId: {},
    };
    const sessionId = await mount();
    expect(mocks.refresh).not.toHaveBeenCalled();
    mocks.state = { ...mocks.state, desktopByTabId: { "tab-1": { hasWebContents: true } } };
    await act(async () => {
      renderer?.update(
        <ChatGPTBrowserSessionRuntime
          environmentId={environmentId}
          sessionId={sessionId}
          suspended={false}
        />,
      );
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    await act(async () => {
      renderer?.unmount();
      renderer = create(
        <ChatGPTBrowserSessionRuntime
          environmentId={environmentId}
          sessionId={sessionId}
          suspended={false}
        />,
      );
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("does not reopen a session while it is closing", async () => {
    mocks.state.serverEpoch = "server-1";
    await mount(true);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
