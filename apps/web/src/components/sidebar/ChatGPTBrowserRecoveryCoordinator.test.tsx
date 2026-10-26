// @vitest-environment node
// @ts-expect-error jsdom is installed for tests but @types/jsdom is not in this workspace.
import { JSDOM } from "jsdom";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(async (_id: string) => {}),
  navigate: vi.fn(async (_id: string, _url: string) => {}),
  stop: vi.fn(async (_id: string) => {}),
  type: vi.fn(async (_id: string, _text: string) => {}),
  press: vi.fn(async (_id: string, _keys: { key: string; expectedConversationId: string }) => {}),
  result: vi.fn(async (id: string) => ({
    activity: "invalid: Could not load this ChatGPT conversation",
    url: `https://chatgpt.com/c/${id}`,
  })),
  loading: false,
  navTag: "Success",
  urlOverride: null as string | null,
  guestUrlOverride: null as string | null,
}));

vi.mock("../../chatGPTBrowserSessions", () => ({
  chatGPTBrowserThreadRef: (_environment: string, id: string) => ({ threadId: id }),
  chatGPTBrowserLastUrlKey: (_environment: string, id: string) => `saved:${id}`,
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
      [`tab:${ref.threadId}`]: {
        navStatus: {
          _tag: mocks.navTag,
          ...(mocks.navTag === "Success"
            ? { url: mocks.urlOverride ?? `https://chatgpt.com/c/${ref.threadId}` }
            : {}),
        },
      },
    },
    desktopByTabId: {
      [`tab:${ref.threadId}`]: { hasWebContents: false, loading: mocks.loading },
    },
  }),
}));
vi.mock("../preview/previewBridge", () => ({
  previewBridge: { refresh: mocks.refresh, navigate: mocks.navigate },
}));

import {
  ChatGPTBrowserRecoveryCoordinator,
  nextRedRetryDelay,
  type ChatGPTRecoveryPhase,
} from "./ChatGPTBrowserRecoveryCoordinator";
import { recordSessionClick } from "./chatGPTConversationRecovery";
import {
  readChatGPTRecoveryMetrics,
  aggregateChatGPTRecoveryMetrics,
} from "../../chatGPTRecoveryMetrics";
import { useBrowserSurfaceStore } from "../../browser/browserSurfaceStore";
import {
  tryAcquireChatGPTRecoveryMutation,
  clearChatGPTRecoveryMutationGateForTests,
} from "../../chatGPTRecoveryMutationGate";

let renderer: ReactTestRenderer | undefined;
const phaseChanges = vi.fn<(id: string, phase: ChatGPTRecoveryPhase | null) => void>();

async function mount(
  ids = ["comit", "other"],
  wakeupIds: readonly string[] = [],
  redIds: readonly string[] = [],
) {
  for (const id of ids) {
    const webview = document.createElement("webview");
    webview.dataset.previewTab = `runtime:${id}`;
    Object.defineProperty(webview, "getURL", {
      value: () => mocks.guestUrlOverride ?? `https://chatgpt.com/c/${id}`,
    });
    Object.defineProperty(webview, "executeJavaScript", {
      value: async (expression: string) => {
        if (expression.includes('result:"stop_clicked"')) {
          await mocks.stop(id);
          return { result: "stop_clicked" };
        }
        if (expression.includes('"continue_typed"') && expression.includes("insertText")) {
          await mocks.type(id, "Continue.");
          return { result: "continue_typed" };
        }
        if (expression.includes('result:"continue_clicked"')) {
          await mocks.press(id, { key: "Enter", expectedConversationId: id });
          return { result: "continue_clicked" };
        }
        const result = await mocks.result(id);
        return {
          draftEmpty: true,
          stopVisible: result.activity === "interrupted" || result.activity === "delivery-timeout",
          lastUserTurnKey: `user:${id}`,
          lastUserTurn: 0,
          totalTurns: 1,
          lastRole: "user",
          assistantHasContent: false,
          ...result,
        };
      },
    });
    document.body.append(webview);
  }
  await act(async () => {
    renderer = create(
      <ChatGPTBrowserRecoveryCoordinator
        environmentId={"local" as never}
        sessionIds={ids}
        wakeupIds={wakeupIds}
        redIds={redIds}
        onPhaseChange={phaseChanges}
      />,
    );
  });
}

let dom: JSDOM;
beforeEach(() => {
  dom = new JSDOM("", { url: "https://chatgpt.com/c/comit" });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("location", dom.window.location);
  vi.stubGlobal("localStorage", dom.window.localStorage);
  vi.stubGlobal("sessionStorage", dom.window.sessionStorage);
  vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
  vi.stubGlobal("Element", dom.window.Element);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("NodeFilter", dom.window.NodeFilter);
  vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
  vi.stubGlobal("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(new Date("2026-10-13T18:00:00Z"));
  localStorage.clear();
  document.body.innerHTML = "";
  mocks.result.mockReset().mockImplementation(async (id: string) => ({
    activity: "invalid: Could not load this ChatGPT conversation",
    url: `https://chatgpt.com/c/${id}`,
  }));
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  mocks.navigate.mockReset().mockResolvedValue(undefined);
  mocks.stop.mockReset().mockResolvedValue(undefined);
  mocks.type.mockReset().mockResolvedValue(undefined);
  mocks.press.mockReset().mockResolvedValue(undefined);
  mocks.loading = false;
  mocks.navTag = "Success";
  mocks.urlOverride = null;
  mocks.guestUrlOverride = null;
  phaseChanges.mockClear();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
});
afterEach(async () => {
  if (renderer) act(() => renderer?.unmount());
  // Allow an interrupted asynchronous scan to release its global lock.
  await Promise.resolve();
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  dom.window.close();
  // A test with a never-settling bridge models a renderer teardown. The real
  // renderer process would discard these in-memory reservations entirely.
  clearChatGPTRecoveryMutationGateForTests();
});

describe("serialized ChatGPT browser recovery", () => {
  it("keeps the mutation lease through remount and an ambiguous refresh bridge timeout", async () => {
    let finishBridge: (() => void) | undefined;
    mocks.refresh
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishBridge = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer?.unmount();
      renderer = undefined;
    });
    document.body.innerHTML = "";
    await mount(["comit"]);
    // The old bridge promise remains unresolved even after its 8-second UI deadline.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(55_000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(tryAcquireChatGPTRecoveryMutation("local", "comit", "manual", "reload")).toBeNull();
    // Positive settlement (not merely timeout/unmount) releases the environment lease.
    finishBridge!();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75_000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });

  it("never starts background recovery during an active manual reload lease", async () => {
    const manual = tryAcquireChatGPTRecoveryMutation("local", "comit", "manual", "reload");
    expect(manual).not.toBeNull();
    try {
      await mount(["comit"]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(42_000);
      });
      expect(mocks.refresh).not.toHaveBeenCalled();
    } finally {
      manual?.release();
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(42_000);
    });
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("runtime:comit");
  });

  it("counts actual automatic attempts and closes only after observed assistant progress", async () => {
    await mount(["comit"], [], ["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(22_000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    let episode = readChatGPTRecoveryMetrics("local").ledger?.episodes[0];
    expect(episode).toMatchObject({
      category: "red",
      source: "automatic",
      outcome: "active",
      attemptCount: 1,
      actions: { reload: 1, stop: 0, continue: 0 },
    });
    expect(aggregateChatGPTRecoveryMetrics("local").successRate).toBeNull();
    // An acknowledged refresh is not an assistant response. Only a verified
    // same-conversation activity progression can close the incident.
    mocks.result.mockImplementation(async (id: string) => ({
      activity: "working",
      url: `https://chatgpt.com/c/${id}`,
      lastRole: "assistant",
      assistantHasContent: true,
      lastText: "assistant advanced",
    }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(22_000);
    });
    episode = readChatGPTRecoveryMetrics("local").ledger?.episodes[0];
    expect(episode?.outcome).toBe("recovered");
    expect(episode?.attemptCount).toBe(1);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("recovers confirmed red sessions with 30-second global spacing and 120-second per-session cooldown", async () => {
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(22_000);
    });
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("runtime:comit");
    expect(phaseChanges).toHaveBeenCalledWith("comit", "checking");
    expect(phaseChanges).toHaveBeenCalledWith("comit", "refreshing");
    expect(phaseChanges).toHaveBeenCalledWith("comit", "queued");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenLastCalledWith("runtime:other");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(95_000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(3);
    expect(mocks.refresh).toHaveBeenLastCalledWith("runtime:comit");
  });

  it("keeps the refresh spinner visible while the page begins navigating", async () => {
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(phaseChanges).toHaveBeenLastCalledWith("comit", "refreshing");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_199);
    });
    expect(phaseChanges).toHaveBeenLastCalledWith("comit", "refreshing");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(phaseChanges).toHaveBeenCalledWith("comit", "queued");
  });

  it("wakes a dark-grey background guest long enough to discover an error without selecting it", async () => {
    mocks.result.mockImplementation(async (id: string) => ({
      activity: useBrowserSurfaceStore.getState().activityByTabId[`runtime:${id}`]
        ? "invalid: Could not load this ChatGPT conversation"
        : "idle",
      url: `https://chatgpt.com/c/${id}`,
    }));
    await mount(["comit"], ["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(23_000);
    });
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("runtime:comit");
    expect(phaseChanges).toHaveBeenCalledWith("comit", "queued");
    expect(useBrowserSurfaceStore.getState().activityByTabId["runtime:comit"]).toBeUndefined();
  });

  it("rotates limited background probes so lower-ranked grey tabs are not starved", async () => {
    const discovered = new Set<string>();
    const ids = ["a", "b", "c", "d", "e"];
    mocks.result.mockImplementation(async (id: string) => {
      if (useBrowserSurfaceStore.getState().activityByTabId[`runtime:${id}`]) {
        discovered.add(id);
      }
      return { activity: "idle", url: `https://chatgpt.com/c/${id}` };
    });
    await mount(ids, ids);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(54_000);
    });
    expect(discovered).toEqual(new Set(ids));
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(Object.keys(useBrowserSurfaceStore.getState().activityByTabId)).toHaveLength(0);
  });

  it("keeps independently confirmed failures queued while retrying only one at a time", async () => {
    await mount(["comit", "other"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(22_000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(phaseChanges).toHaveBeenCalledWith("comit", "queued");
    expect(phaseChanges).toHaveBeenCalledWith("other", "queued");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenLastCalledWith("runtime:other");
  });

  it("does not lose a confirmed recovery queue entry when the guest becomes uninspectable", async () => {
    let activity = "invalid: Could not load this ChatGPT conversation";
    mocks.result.mockImplementation(async (id: string) => ({
      activity,
      url: `https://chatgpt.com/c/${id}`,
    }));
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(22_000);
    });
    expect(phaseChanges).toHaveBeenCalledWith("comit", "queued");
    activity = "invalid: the ChatGPT composer is unavailable";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(phaseChanges).not.toHaveBeenCalledWith("comit", null);
    activity = "idle";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(phaseChanges).toHaveBeenLastCalledWith("comit", null);
  });

  it("survives prolonged unverifiable red probes without a terminal gate", async () => {
    let guestReadable = true;
    mocks.result.mockImplementation(async (id: string) => ({
      activity: "invalid: Could not load this ChatGPT conversation",
      url: guestReadable ? `https://chatgpt.com/c/${id}` : "https://chatgpt.com/c/unknown",
    }));
    await mount(["comit"], ["comit"], ["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(22_000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    guestReadable = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45 * 60_000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(localStorage.getItem("t3code:chatgpt-browser:bounded-recovery:local")!).escalation,
    ).toBeUndefined();
    expect(
      JSON.parse(localStorage.getItem("t3code:chatgpt-browser:recovery-log:local")!).some(
        (event: { event: string; detail: string }) =>
          event.event === "diagnostic" && event.detail === "guest_url_or_health_unverifiable",
      ),
    ).toBe(true);
    guestReadable = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60_000);
    });
    expect(mocks.refresh.mock.calls.length).toBeGreaterThan(1);
    expect(mocks.refresh).toHaveBeenLastCalledWith("runtime:comit");
  });

  it("releases the temporary background painting lease without refreshing a healthy guest", async () => {
    mocks.result.mockImplementation(async (id: string) => ({
      activity: "idle",
      url: `https://chatgpt.com/c/${id}`,
    }));
    await mount(["comit"], ["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(22_000);
    });
    expect(mocks.result).toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(phaseChanges).not.toHaveBeenCalledWith("comit", "queued");
    expect(useBrowserSurfaceStore.getState().activityByTabId["runtime:comit"]).toBeUndefined();
  });

  it("rotates equally recent failures by oldest previous attempt", async () => {
    recordSessionClick("local", "comit", ["comit", "other"]);
    recordSessionClick("local", "other", ["comit", "other"]);
    await mount(["comit", "other"], [], ["comit", "other"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("runtime:comit");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(mocks.refresh).toHaveBeenLastCalledWith("runtime:other");
  });

  it("never inspects a hidden session even if it was the most recently clicked", async () => {
    recordSessionClick("local", "hidden", ["comit", "hidden"]);
    await mount(["comit"]);
    const hidden = document.createElement("webview");
    hidden.dataset.previewTab = "runtime:hidden";
    Object.defineProperty(hidden, "executeJavaScript", {
      value: (_expression: string) => mocks.result("hidden"),
    });
    document.body.append(hidden);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150_000);
    });
    expect(mocks.refresh).toHaveBeenCalledWith("runtime:comit");
    expect(mocks.refresh).not.toHaveBeenCalledWith("runtime:hidden");
  });

  it("does not refresh a session hidden while the error probe is still running", async () => {
    let resolveProbe: ((value: { activity: string; url: string }) => void) | undefined;
    mocks.result.mockImplementation(
      () =>
        new Promise((resolve) => {
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
      resolveProbe?.({
        activity: "invalid: Could not load this ChatGPT conversation",
        url: "https://chatgpt.com/c/comit",
      });
      await Promise.resolve();
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("never refreshes a page without the confirmed failure panel", async () => {
    mocks.result.mockImplementation(async (id: string) => ({
      activity: "idle",
      url: `https://chatgpt.com/c/${id}`,
    }));
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.result).toHaveBeenCalled();
    expect(phaseChanges).not.toHaveBeenCalledWith("comit", "refreshing");
  });

  it("recovers a confirmed failure despite a permanently Loading navigation overlay", async () => {
    mocks.navTag = "Loading";
    mocks.loading = true;
    localStorage.setItem("saved:comit", JSON.stringify("https://chatgpt.com/c/comit"));
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("runtime:comit");
  });

  it("does not refresh a loading page without a trusted saved conversation identity", async () => {
    mocks.navTag = "Loading";
    mocks.loading = true;
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.result).not.toHaveBeenCalled();
  });

  it("refuses a stale error panel after the guest changes conversation", async () => {
    mocks.urlOverride = "https://chatgpt.com/c/comit";
    mocks.result.mockImplementation(async () => ({
      activity: "invalid: Could not load this ChatGPT conversation",
      url: "https://chatgpt.com/c/other",
    }));
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it.each(["interrupted", "delivery-timeout"])(
    "attempts recovery of a persistent orange %s session after a grace period",
    async (problem) => {
      mocks.result.mockImplementation(async (id: string) => ({
        activity: problem,
        url: `https://chatgpt.com/c/${id}`,
      }));
      await mount(["comit"]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(619_999);
      });
      expect(mocks.refresh).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("runtime:comit");
    },
  );

  it("cancels an interrupted recovery when the connection heals, requiring a fresh grace period", async () => {
    let activity = "interrupted";
    mocks.result.mockImplementation(async (id: string) => ({
      activity,
      url: `https://chatgpt.com/c/${id}`,
    }));
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    activity = "working";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    activity = "interrupted";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(570_000);
    });
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("runtime:comit");
  });

  it("does not refresh an orange session that resumes during the second safety check", async () => {
    let inspections = 0;
    mocks.result.mockImplementation(async (id: string) => ({
      activity: ++inspections >= 4 ? "working" : "interrupted",
      url: `https://chatgpt.com/c/${id}`,
    }));
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(690_000);
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("does not dispatch another mutation after bridge timeout until its original action settles", async () => {
    let finishBridge: (() => void) | undefined;
    mocks.refresh
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishBridge = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(phaseChanges).toHaveBeenCalledWith("comit", "refreshing");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(phaseChanges).toHaveBeenCalledWith("comit", "queued");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    // Timeout is an UNKNOWN host outcome, not permission to run a new reload.
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    finishBridge!();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(mocks.refresh).toHaveBeenLastCalledWith("runtime:other");
  });
});

describe("persistent orange recovery safety", () => {
  it("reloads an exact stuck turn, stops the orphan, then submits exactly one Continue", async () => {
    let activity = "interrupted";
    mocks.result.mockImplementation(async (id: string) => ({
      activity,
      url: `https://chatgpt.com/c/${id}`,
    }));
    mocks.stop.mockImplementation(async () => {
      activity = "idle";
    });
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(621_000);
    });
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("runtime:comit");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(24_000);
    });
    expect(mocks.stop).toHaveBeenCalledExactlyOnceWith("comit");
    expect(mocks.type).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(24_000);
    });
    expect(mocks.type).toHaveBeenCalledExactlyOnceWith("comit", "Continue.");
    expect(mocks.press).toHaveBeenCalledExactlyOnceWith("comit", {
      key: "Enter",
      expectedConversationId: "comit",
    });
    expect(
      JSON.parse(localStorage.getItem("t3code:chatgpt-browser:bounded-recovery:local")!).orange
        .comit.stage,
    ).toBe("continue_issued");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(mocks.press).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer?.unmount();
      renderer = undefined;
    });
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(mocks.press).toHaveBeenCalledTimes(1);
  });

  it("never overwrites a draft and continues diagnostic-only rechecks", async () => {
    let activity = "interrupted";
    let hasDraft = false;
    mocks.result.mockImplementation(async (id: string) => ({
      activity,
      url: `https://chatgpt.com/c/${id}`,
      draftEmpty: !hasDraft,
    }));
    mocks.refresh.mockImplementation(async () => {
      hasDraft = true;
    });
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700_000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.type).not.toHaveBeenCalled();
    expect(
      JSON.parse(localStorage.getItem("t3code:chatgpt-browser:bounded-recovery:local")!).orange
        .comit.reason,
    ).toBe("orphan_stop_unavailable_or_draft_present");
  });

  it("marks an ambiguous STOP outcome for human reconciliation and never sends", async () => {
    mocks.result.mockImplementation(async (id: string) => ({
      activity: "interrupted",
      url: `https://chatgpt.com/c/${id}`,
    }));
    mocks.stop.mockRejectedValue(new Error("guest detached during click"));
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700_000);
    });
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.type).not.toHaveBeenCalled();
    expect(
      JSON.parse(localStorage.getItem("t3code:chatgpt-browser:bounded-recovery:local")!).orange
        .comit.reason,
    ).toBe("stop_outcome_ambiguous");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it("cancels stop/continue if a generation resumes after the reload", async () => {
    let activity = "interrupted";
    mocks.result.mockImplementation(async (id: string) => ({
      activity,
      url: `https://chatgpt.com/c/${id}`,
    }));
    mocks.refresh.mockImplementation(async () => {
      activity = "working";
    });
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750_000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.press).not.toHaveBeenCalled();
  });

  it("halts destructive retries for a permanent auth failure", async () => {
    mocks.result.mockImplementation(async (id: string) => ({
      activity: "invalid: Could not load this ChatGPT conversation",
      permanentReason: "auth",
      url: `https://chatgpt.com/c/${id}`,
    }));
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(240_000);
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(
      JSON.parse(localStorage.getItem("t3code:chatgpt-browser:recovery-log:local")!).some(
        (entry: { event: string; detail: string }) =>
          entry.event === "diagnostic" && entry.detail === "auth",
      ),
    ).toBe(true);
  });

  it("keeps transient red retries alive on a fixed cadence, resetting on health", async () => {
    let activity = "invalid: Could not load this ChatGPT conversation";
    mocks.result.mockImplementation(async (id: string) => ({
      activity,
      url: `https://chatgpt.com/c/${id}`,
    }));
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16 * 60_000);
    });
    const state = JSON.parse(
      localStorage.getItem("t3code:chatgpt-browser:bounded-recovery:local")!,
    );
    expect(state.red.comit.attempts).toBeGreaterThan(3);
    expect(mocks.refresh.mock.calls.length).toBeGreaterThan(3);
    activity = "idle";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(
      JSON.parse(localStorage.getItem("t3code:chatgpt-browser:bounded-recovery:local")!).red.comit,
    ).toBeUndefined();
  });
});

describe("orange delivery ambiguity and retry bounds", () => {
  it("never duplicates a Continue after an indeterminate send click", async () => {
    let activity = "interrupted";
    mocks.result.mockImplementation(async (id: string) => ({
      activity,
      url: `https://chatgpt.com/c/${id}`,
    }));
    mocks.stop.mockImplementation(async () => {
      activity = "idle";
    });
    mocks.press.mockRejectedValue(new Error("click bridge disconnected"));
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(693_000);
    });
    expect(mocks.press).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(localStorage.getItem("t3code:chatgpt-browser:bounded-recovery:local")!).orange
        .comit.reason,
    ).toBe("continue_dispatch_ambiguous_or_failed");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(mocks.press).toHaveBeenCalledTimes(1);
  });

  it("never replays an ambiguous legacy orange action after remount", async () => {
    localStorage.setItem(
      "t3code:chatgpt-browser:bounded-recovery:local",
      JSON.stringify({
        red: {},
        orange: {
          comit: {
            conversationId: "comit",
            userTurnKey: "user:comit",
            userTurn: 0,
            problem: "interrupted",
            firstSeenAt: Date.now() - 3_600_000,
            stage: "needs_human",
            stageAt: Date.now() - 3_600_000,
          },
        },
        escalation: { comit: { reason: "stop_outcome_ambiguous" } },
      }),
    );
    mocks.result.mockImplementation(async (id: string) => ({
      activity: "interrupted",
      url: `https://chatgpt.com/c/${id}`,
    }));
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25 * 60_000);
    });
    expect(mocks.result.mock.calls.length).toBeGreaterThan(10);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.press).not.toHaveBeenCalled();
  });

  it("never reloads a guest whose live conversation ID has diverged", async () => {
    mocks.result.mockImplementation(async () => ({
      activity: "interrupted",
      url: "https://chatgpt.com/c/different-id",
    }));
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150_000);
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.type).not.toHaveBeenCalled();
  });

  it("uses the identical fixed red retry delay for attempt 1 and attempt 50", () => {
    const values = [
      nextRedRetryDelay("comit", 1),
      nextRedRetryDelay("comit", 50),
      nextRedRetryDelay("other", 50),
      nextRedRetryDelay("comit", 100_000),
    ];
    expect(values).toEqual([120_000, 120_000, 120_000, 120_000]);
  });
});

describe("recovering lost ChatGPT conversation routes", () => {
  const homepage = {
    activity: "idle",
    url: "https://chatgpt.com/",
    totalTurns: 0,
    lastRole: null,
    assistantHasContent: false,
    draftEmpty: true,
    stopVisible: false,
  };

  it("navigates from a blank root to the exact retained conversation, without refreshing root", async () => {
    mocks.navTag = "Success";
    mocks.urlOverride = "https://chatgpt.com/";
    mocks.result.mockResolvedValue(homepage);
    localStorage.setItem(
      "saved:comit",
      JSON.stringify("https://chatgpt.com/c/comit?src=history_search"),
    );
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(
      "runtime:comit",
      "https://chatgpt.com/c/comit?src=history_search",
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("preserves deliberate new chats with no retained conversation and guards drafts or working sessions", async () => {
    mocks.navTag = "Success";
    mocks.urlOverride = "https://chatgpt.com/";
    mocks.result.mockResolvedValue(homepage);
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    act(() => renderer?.unmount());
    renderer = undefined;
    localStorage.setItem("saved:comit", JSON.stringify("https://chatgpt.com/c/comit"));
    mocks.result.mockImplementation(async () => ({ ...homepage, draftEmpty: false }));
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    act(() => renderer?.unmount());
    renderer = undefined;
    mocks.result.mockImplementation(async () => ({
      ...homepage,
      activity: "working",
      stopVisible: true,
    }));
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("does not navigate if the guest stopped being a homepage before the second inspection", async () => {
    mocks.navTag = "Success";
    mocks.urlOverride = "https://chatgpt.com/";
    localStorage.setItem("saved:comit", JSON.stringify("https://chatgpt.com/c/comit"));
    let inspections = 0;
    mocks.result.mockImplementation(async () => {
      inspections++;
      return inspections >= 2 ? { ...homepage, url: "https://chatgpt.com/c/another" } : homepage;
    });
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("restores a guest homepage even when the preview status still records the old conversation", async () => {
    mocks.navTag = "Success";
    mocks.urlOverride = "https://chatgpt.com/c/comit";
    mocks.guestUrlOverride = "https://chatgpt.com/";
    mocks.result.mockImplementation(async () => ({
      activity: "idle",
      url: "https://chatgpt.com/",
      totalTurns: 0,
      lastRole: null,
      assistantHasContent: false,
      draftEmpty: true,
      stopVisible: false,
    }));
    localStorage.setItem("saved:comit", JSON.stringify("https://chatgpt.com/c/comit"));
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(
      "runtime:comit",
      "https://chatgpt.com/c/comit",
    );
  });

  it("restores a guest homepage while the preview remains Loading, with a saved identity", async () => {
    mocks.navTag = "Loading";
    mocks.guestUrlOverride = "https://chatgpt.com/";
    mocks.result.mockImplementation(async () => ({
      activity: "idle",
      url: "https://chatgpt.com/",
      totalTurns: 0,
      lastRole: null,
      assistantHasContent: false,
      draftEmpty: true,
      stopVisible: false,
    }));
    localStorage.setItem("saved:comit", JSON.stringify("https://chatgpt.com/c/comit"));
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith(
      "runtime:comit",
      "https://chatgpt.com/c/comit",
    );
  });

  it("serializes retroactive homepage recoveries with the existing global cooldown", async () => {
    mocks.navTag = "Success";
    mocks.urlOverride = "https://chatgpt.com/";
    mocks.result.mockResolvedValue(homepage);
    localStorage.setItem("saved:comit", JSON.stringify("https://chatgpt.com/c/comit"));
    localStorage.setItem("saved:other", JSON.stringify("https://chatgpt.com/c/other"));
    await mount(["comit", "other"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(41_000);
    });
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(mocks.navigate).toHaveBeenCalledTimes(2);
  });
});

describe("red error panel without an editor", () => {
  it("retries a confirmed load-error panel without a composer or per-session backoff", async () => {
    mocks.result.mockImplementation(async (id: string) => ({
      activity: "invalid: Could not load this ChatGPT conversation",
      url: `https://chatgpt.com/c/${id}`,
      draftEmpty: null,
      stopVisible: false,
    }));
    await mount(["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(22_000);
    });
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("runtime:comit");
    expect(
      JSON.parse(localStorage.getItem("t3code:chatgpt-browser:bounded-recovery:local")!).red.comit
        .attempts,
    ).toBe(1);
  });

  it("waits a full minute before recovering a persistently missing composer", async () => {
    mocks.result.mockImplementation(async (id: string) => ({
      activity: "invalid: the ChatGPT composer is unavailable",
      url: `https://chatgpt.com/c/${id}`,
      draftEmpty: null,
      stopVisible: false,
    }));
    await mount(["comit"], ["comit"], ["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(23_000);
    });
    expect(phaseChanges).toHaveBeenCalledWith("comit", "queued");
    expect(mocks.refresh).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("runtime:comit");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    // A reload must respect the fixed 120-second cooldown, not a 20-second loop.
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100_000);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });

  it("does not refresh if a missing composer reappears before the grace ends", async () => {
    let activity = "invalid: the ChatGPT composer is unavailable";
    mocks.result.mockImplementation(async (id: string) => ({
      activity,
      url: `https://chatgpt.com/c/${id}`,
      draftEmpty: activity === "idle" ? true : null,
      stopVisible: false,
    }));
    await mount(["comit"], ["comit"], ["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(42_000);
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
    activity = "idle";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100_000);
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
    activity = "invalid: the ChatGPT composer is unavailable";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("runtime:comit");
  });

  it("never auto-refreshes unrelated invalid states without a load-error panel", async () => {
    mocks.result.mockImplementation(async (id: string) => ({
      activity: "invalid: this page is not on ChatGPT",
      url: `https://chatgpt.com/c/${id}`,
      draftEmpty: null,
      stopVisible: false,
    }));
    await mount(["comit"], ["comit"], ["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150_000);
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("keeps an unverified red page queued without refreshing a different conversation", async () => {
    mocks.result.mockResolvedValue({
      activity: "invalid: the ChatGPT composer is unavailable",
      url: "https://chatgpt.com/c/another",
    });
    await mount(["comit"], ["comit"], ["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(62_000);
    });
    expect(phaseChanges).toHaveBeenCalledWith("comit", "queued");
    expect(phaseChanges).not.toHaveBeenCalledWith("comit", null);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("ignores a legacy terminal escalation and retries the same confirmed red load failure", async () => {
    localStorage.setItem(
      "t3code:chatgpt-browser:bounded-recovery:local",
      JSON.stringify({
        red: {},
        orange: {},
        escalation: {
          comit: {
            reason: "guest_url_or_health_unverifiable",
            at: Date.now(),
            conversationId: "comit",
          },
        },
      }),
    );
    mocks.result.mockImplementation(async (id: string) => ({
      activity: "invalid: Could not load this ChatGPT conversation",
      url: `https://chatgpt.com/c/${id}`,
      draftEmpty: null,
      stopVisible: false,
    }));
    await mount(["comit"], ["comit"], ["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(23_000);
    });
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("runtime:comit");
    expect(
      JSON.parse(localStorage.getItem("t3code:chatgpt-browser:bounded-recovery:local")!).escalation,
    ).toBeUndefined();
  });

  it("does not refresh a red composer error when the draft is nonempty", async () => {
    mocks.result.mockImplementation(async (id: string) => ({
      activity: "invalid: the ChatGPT composer is unavailable",
      url: `https://chatgpt.com/c/${id}`,
      draftEmpty: false,
      stopVisible: false,
    }));
    await mount(["comit"], ["comit"], ["comit"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(63_000);
    });
    expect(phaseChanges).toHaveBeenCalledWith("comit", "queued");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
