// @vitest-environment jsdom
import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import {
  chatGPTBrowserLastWorkingKey,
  chatGPTBrowserThreadRef,
} from "../../chatGPTBrowserSessions";

const mocks = vi.hoisted(() => ({
  execute: vi.fn<() => Promise<string>>(),
  nav: { _tag: "Success" as string, url: "https://chatgpt.com/c/1" },
  overlay: { loading: false },
}));
vi.mock("../../previewStateStore", () => ({
  useThreadPreviewState: () => ({ activeTabId: "tab-1", serverEpoch: "epoch-1" }),
  readThreadPreviewState: () => ({
    sessions: { "tab-1": { navStatus: mocks.nav } },
    desktopByTabId: { "tab-1": mocks.overlay },
  }),
}));

import { useChatGPTBrowserSessionActivity } from "./ChatGPTBrowserSessionActivity";

const environmentId = EnvironmentId.make("test-environment");
const sessionId = "test-session";
const storageKey = chatGPTBrowserLastWorkingKey(environmentId, sessionId);

function ActivityObserver() {
  const activity = useChatGPTBrowserSessionActivity(environmentId, sessionId);
  return <span title={activity.label}>{activity.age}</span>;
}

let renderer: ReactTestRenderer | undefined;
let webview: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-10-10T12:00:00.000Z"));
  window.localStorage.clear();
  mocks.execute.mockReset();
  mocks.nav._tag = "Success";
  mocks.overlay.loading = false;

  webview = document.createElement("webview");
  webview.dataset.previewTab = previewRuntimeTabId(
    chatGPTBrowserThreadRef(environmentId, sessionId),
    "epoch-1",
    "tab-1",
  );
  Object.defineProperty(webview, "executeJavaScript", {
    value: mocks.execute,
  });
  document.body.appendChild(webview);
});
afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = undefined;
  webview.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ChatGPT browser session activity persistence", () => {
  it("detects the conversation error while cached navigation is still Loading", async () => {
    mocks.nav._tag = "Loading";
    mocks.overlay.loading = true;
    mocks.execute.mockResolvedValue("invalid: Could not load this ChatGPT conversation");
    await act(async () => {
      renderer = create(<ActivityObserver />);
    });
    const status = renderer!.root.findByType("span");
    expect(status.props.children).toBe("invalid");
    expect(status.props.title).toContain("Could not load this ChatGPT conversation");
  });

  it("rechecks an error that appears after an initially idle page without refreshing", async () => {
    mocks.execute
      .mockResolvedValueOnce("idle")
      .mockResolvedValue("invalid: Could not load this ChatGPT conversation");
    await act(async () => {
      renderer = create(<ActivityObserver />);
    });
    expect(renderer!.root.findByType("span").props.children).toBe("inactive");
    mocks.nav._tag = "Loading";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(renderer!.root.findByType("span").props.children).toBe("invalid");
  });

  it("does not mark hydration as a composer failure while the page is loading", async () => {
    mocks.nav._tag = "Loading";
    mocks.execute.mockResolvedValue("invalid: the ChatGPT composer is unavailable");
    await act(async () => {
      renderer = create(<ActivityObserver />);
    });
    expect(renderer!.root.findByType("span").props.children).toBe("unknown");
  });

  it("retries after a hung guest JavaScript inspection instead of polling forever", async () => {
    mocks.execute
      .mockImplementationOnce(() => new Promise<string>(() => {}))
      .mockResolvedValue("invalid: Could not load this ChatGPT conversation");
    await act(async () => {
      renderer = create(<ActivityObserver />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(renderer!.root.findByType("span").props.children).toBe("unknown");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(renderer!.root.findByType("span").props.children).toBe("invalid");
  });

  it("marks delivery timeouts orange regardless of previously recorded work", async () => {
    const now = Date.now();
    window.localStorage.setItem(storageKey, JSON.stringify(now - 60_000));
    mocks.execute.mockResolvedValue("delivery-timeout");
    await act(async () => {
      renderer = create(<ActivityObserver />);
    });
    const status = renderer!.root.findByType("span");
    expect(status.props.children).toBe("delivery-timeout");
    expect(status.props.title).toBe("ChatGPT message delivery timed out; please try again");
    // An error must not rewrite the previous working timestamp.
    expect(JSON.parse(window.localStorage.getItem(storageKey)!)).toBe(now - 60_000);
    mocks.execute.mockResolvedValue("idle");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(renderer!.root.findByType("span").props.children).toBe("recent");
  });

  it("persists the last observed working time and records the stop time", async () => {
    mocks.execute.mockResolvedValueOnce("working").mockResolvedValue("idle");
    await act(async () => {
      renderer = create(<ActivityObserver />);
    });
    expect(renderer!.root.findByType("span").props.children).toBe("working");
    const startedAt = Date.now();
    expect(JSON.parse(window.localStorage.getItem(storageKey)!)).toBe(startedAt);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(renderer!.root.findByType("span").props.children).toBe("recent");
    expect(JSON.parse(window.localStorage.getItem(storageKey)!)).toBe(startedAt + 2_000);
  });

  it("recovers recent work history after the activity tracker remounts", async () => {
    const tenMinutesAgo = Date.now() - 10 * 60 * 1_000;
    window.localStorage.setItem(storageKey, JSON.stringify(tenMinutesAgo));
    mocks.execute.mockResolvedValue("idle");
    await act(async () => {
      renderer = create(<ActivityObserver />);
    });
    expect(renderer!.root.findByType("span").props.children).toBe("recent");
    expect(JSON.parse(window.localStorage.getItem(storageKey)!)).toBe(tenMinutesAgo);
  });
});
