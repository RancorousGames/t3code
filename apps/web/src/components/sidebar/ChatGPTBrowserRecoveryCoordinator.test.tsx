// @vitest-environment jsdom
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(async (_id: string) => {}),
  result: vi.fn(async (_expression: string) => true),
  loading: false,
  url: "https://chatgpt.com/c/comit",
}));

vi.mock("../../chatGPTBrowserSessions", () => ({
  chatGPTBrowserThreadRef: (_environment: string, id: string) => ({ threadId: id }),
  isChatGPTConversationUrl: (url: string) => url.startsWith("https://chatgpt.com/c/"),
}));
vi.mock("../../browser/previewRuntimeTabId", () => ({
  previewRuntimeTabId: (ref: { threadId: string }) => `runtime:${ref.threadId}`,
}));
vi.mock("../../previewStateStore", () => ({
  readThreadPreviewState: (ref: { threadId: string }) => ({
    serverEpoch: "epoch",
    activeTabId: `tab:${ref.threadId}`,
    sessions: {
      [`tab:${ref.threadId}`]: { navStatus: { _tag: "Success", url: mocks.url } },
    },
    desktopByTabId: {
      [`tab:${ref.threadId}`]: { hasWebContents: true, loading: mocks.loading },
    },
  }),
}));
vi.mock("../preview/previewBridge", () => ({
  previewBridge: { refresh: mocks.refresh },
}));

import { ChatGPTBrowserRecoveryCoordinator } from "./ChatGPTBrowserRecoveryCoordinator";
import { recordSessionClick } from "./chatGPTConversationRecovery";

let renderer: ReactTestRenderer | undefined;

async function mount(ids = ["comit", "other"]) {
  for (const id of ids) {
    const webview = document.createElement("webview");
    webview.dataset.previewTab = `runtime:${id}`;
    Object.defineProperty(webview, "executeJavaScript", { value: mocks.result });
    document.body.append(webview);
  }
  await act(async () => {
    renderer = create(
      <ChatGPTBrowserRecoveryCoordinator environmentId={"local" as never} sessionIds={ids} />,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(new Date("2026-10-13T18:00:00Z"));
  localStorage.clear();
  document.body.innerHTML = "";
  mocks.result.mockReset().mockResolvedValue(true);
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  mocks.loading = false;
  mocks.url = "https://chatgpt.com/c/comit";
});
afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("serialized ChatGPT browser recovery", () => {
  it("refreshes one broken session at a time, 30 seconds apart, with a 2-minute per-tab cooldown", async () => {
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("runtime:comit");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenLastCalledWith("runtime:other");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(3);
    expect(mocks.refresh).toHaveBeenLastCalledWith("runtime:comit");
  });

  it("prioritizes the most recently clicked broken tab after restoring stored click history", async () => {
    recordSessionClick("local", "comit", ["comit", "other"]);
    recordSessionClick("local", "other", ["comit", "other"]);
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("runtime:other");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(mocks.refresh).toHaveBeenLastCalledWith("runtime:comit");
  });

  it("never inspects a hidden session even if it was the most recently clicked", async () => {
    recordSessionClick("local", "hidden", ["comit", "hidden"]);
    await mount(["comit"]);
    const hidden = document.createElement("webview");
    hidden.dataset.previewTab = "runtime:hidden";
    Object.defineProperty(hidden, "executeJavaScript", { value: mocks.result });
    document.body.append(hidden);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("runtime:comit");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150_000);
    });
    expect(mocks.refresh).not.toHaveBeenCalledWith("runtime:hidden");
  });

  it("does not refresh a session hidden while the error probe is still running", async () => {
    let resolveProbe: ((value: boolean) => void) | undefined;
    mocks.result.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(mocks.result).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer?.update(
        <ChatGPTBrowserRecoveryCoordinator environmentId={"local" as never} sessionIds={[]} />,
      );
    });
    await act(async () => {
      resolveProbe?.(true);
      await Promise.resolve();
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("leaves healthy conversations and pages which are still loading alone", async () => {
    mocks.result.mockResolvedValue(false);
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.result).toHaveBeenCalled();
  });

  it("does not inspect a loading page", async () => {
    mocks.loading = true;
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.result).not.toHaveBeenCalled();
  });
});
