// @vitest-environment node
// @ts-expect-error jsdom test runtime is installed without its type declarations.
import { JSDOM } from "jsdom";
import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useBrowserSurfaceStore } from "../../browser/browserSurfaceStore";
import {
  CHATGPT_GUEST_HIBERNATE_AFTER_MS,
  isChatGPTGuestHibernated,
  useChatGPTGuestHibernation,
  wakeChatGPTGuest,
} from "../../browser/chatGPTGuestHibernation";
import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import {
  chatGPTBrowserLastWorkingKey,
  chatGPTBrowserThreadRef,
} from "../../chatGPTBrowserSessions";

const mocks = vi.hoisted(() => ({
  execute: vi.fn<(expression: string) => Promise<string>>(),
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

function ActivityObserver({ snoozed = false }: { snoozed?: boolean }) {
  const activity = useChatGPTBrowserSessionActivity(environmentId, sessionId, snoozed);
  return (
    <span
      role="status"
      aria-label={activity.label}
      data-recovery-problem={activity.recoveryProblem ?? ""}
    >
      {activity.age}
    </span>
  );
}

let renderer: ReactTestRenderer | undefined;
let webview: HTMLElement;
const surfaceOwner = Symbol("test surface");
const runtimeId = previewRuntimeTabId(
  chatGPTBrowserThreadRef(environmentId, sessionId),
  "epoch-1",
  "tab-1",
);
let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM("", { url: "https://chatgpt.com/c/1" });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("localStorage", dom.window.localStorage);
  vi.stubGlobal("location", dom.window.location);
  vi.stubGlobal("Element", dom.window.Element);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("NodeFilter", dom.window.NodeFilter);
  vi.stubGlobal("Event", dom.window.Event);
  vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
  vi.stubGlobal("StorageEvent", dom.window.StorageEvent);
  vi.stubGlobal("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-10-10T12:00:00.000Z"));
  window.localStorage.clear();
  mocks.execute.mockReset();
  mocks.nav._tag = "Success";
  mocks.overlay.loading = false;

  webview = document.createElement("webview");
  webview.dataset.previewTab = runtimeId;
  Object.defineProperty(webview, "executeJavaScript", {
    value: async (expression: string) => {
      const result = await mocks.execute(expression);
      return expression.includes("blank:") ? { blank: false, activity: result } : result;
    },
  });
  Object.assign(webview, { getURL: () => mocks.nav.url });
  document.body.appendChild(webview);
  // A shown guest: polled at the foreground rate and never hibernated.
  const surface = useBrowserSurfaceStore.getState();
  surface.claim(runtimeId, surfaceOwner, false);
  surface.present(runtimeId, surfaceOwner, { x: 0, y: 0, width: 1, height: 1 }, true, 0, 0);
});
afterEach(() => {
  useBrowserSurfaceStore.getState().release(runtimeId, surfaceOwner);
  useChatGPTGuestHibernation.setState({ hibernated: {}, woken: {}, touchedAt: {} });
  if (renderer) act(() => renderer?.unmount());
  renderer = undefined;
  webview.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  dom.window.close();
});

describe("ChatGPT guest hibernation", () => {
  it("replaces live/error status with snoozed and stops inspection until unsnoozed", async () => {
    mocks.execute.mockResolvedValue("invalid: unavailable");
    await act(async () => {
      renderer = create(<ActivityObserver />);
    });
    expect(renderer!.root.findByType("span").props.children).toBe("invalid");
    await act(async () => {
      renderer!.update(<ActivityObserver snoozed />);
    });
    const status = renderer!.root.findByType("span");
    expect(status.props.children).toBe("snoozed");
    expect(status.props["data-recovery-problem"]).toBe("");
    const probes = mocks.execute.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.execute.mock.calls.length).toBe(probes);
    mocks.execute.mockResolvedValue("working");
    await act(async () => {
      renderer!.update(<ActivityObserver />);
    });
    expect(status.props.children).toBe("working");
  });

  it("unloads a hidden, long-idle conversation and stops probing it", async () => {
    useBrowserSurfaceStore.getState().release(runtimeId, surfaceOwner);
    mocks.execute.mockImplementation(async (expression) =>
      expression.includes("inspectChatGPTComposer")
        ? ({ status: "empty", url: mocks.nav.url, text: "" } as unknown as string)
        : "idle",
    );
    await act(async () => {
      renderer = create(<ActivityObserver />);
    });
    // A guest loaded at startup keeps a full idle window first.
    expect(isChatGPTGuestHibernated(runtimeId)).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHATGPT_GUEST_HIBERNATE_AFTER_MS + 6_000);
    });
    expect(isChatGPTGuestHibernated(runtimeId)).toBe(true);
    const row = renderer!.root.findByType("span");
    expect(row.props.children).toBe("unloaded");
    expect(row.props["aria-label"]).toContain("unloaded");
    expect(row.props["data-recovery-problem"]).toBe("");
    const probes = mocks.execute.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.execute.mock.calls.length).toBe(probes);
    await act(async () => {
      wakeChatGPTGuest(runtimeId);
    });
    expect(isChatGPTGuestHibernated(runtimeId)).toBe(false);
    expect(row.props.children).toBe("inactive");
    expect(row.props["aria-label"]).toContain("inactive");
  });

  it("keeps a hidden conversation loaded while it is working", async () => {
    useBrowserSurfaceStore.getState().release(runtimeId, surfaceOwner);
    mocks.execute.mockResolvedValue("working");
    await act(async () => {
      renderer = create(<ActivityObserver />);
    });
    expect(isChatGPTGuestHibernated(runtimeId)).toBe(false);
  });

  it.each(["interrupted", "delivery-timeout", "invalid: unavailable", "unknown: offline"])(
    "never unloads an unresolved %s guest after the idle window",
    async (activity) => {
      useBrowserSurfaceStore.getState().release(runtimeId, surfaceOwner);
      mocks.execute.mockResolvedValue(activity);
      await act(async () => {
        renderer = create(<ActivityObserver />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CHATGPT_GUEST_HIBERNATE_AFTER_MS + 12_000);
      });
      expect(isChatGPTGuestHibernated(runtimeId)).toBe(false);
    },
  );

  it("rechecks activity after composer probes rather than unloading a newly working guest", async () => {
    useBrowserSurfaceStore.getState().release(runtimeId, surfaceOwner);
    let activityChanged = false;
    mocks.execute.mockImplementation(async (expression) => {
      if (expression.includes("inspectChatGPTComposer")) {
        activityChanged = true;
        return { status: "empty", url: mocks.nav.url, text: "" } as unknown as string;
      }
      return activityChanged ? "working" : "idle";
    });
    await act(async () => {
      renderer = create(<ActivityObserver />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHATGPT_GUEST_HIBERNATE_AFTER_MS + 6_000);
    });
    expect(activityChanged).toBe(true);
    expect(isChatGPTGuestHibernated(runtimeId)).toBe(false);
  });
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
    expect(status.props["aria-label"]).toContain("Could not load this ChatGPT conversation");
  });

  it("publishes queued-recovery status for orange and load failures, then clears it on recovery", async () => {
    mocks.execute.mockResolvedValue("interrupted");
    await act(async () => {
      renderer = create(<ActivityObserver />);
    });
    const status = renderer!.root.findByType("span");
    expect(status.props["data-recovery-problem"]).toBe("interrupted");

    mocks.execute.mockResolvedValue("delivery-timeout");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(status.props["data-recovery-problem"]).toBe("delivery-timeout");

    mocks.execute.mockResolvedValue("invalid: Could not load this ChatGPT conversation");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(status.props["data-recovery-problem"]).toBe("load-failure");

    mocks.execute.mockResolvedValue("idle");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(status.props["data-recovery-problem"]).toBe("");
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
    expect(status.props["aria-label"]).toBe("ChatGPT message delivery timed out; please try again");
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
