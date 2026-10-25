// @vitest-environment jsdom
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  registerWebview: vi.fn(async (_tabId: string, _id: number) => {}),
  config: { partition: "persist:existing-profile", webPreferences: "" },
}));
vi.mock("~/components/preview/previewBridge", () => ({ previewBridge: mocks }));
vi.mock("~/components/preview/usePreviewBridge", () => ({ usePreviewBridge: () => {} }));
vi.mock("~/hooks/useSettings", () => ({ useClientSettingsHydrated: () => true }));
vi.mock("./previewWebviewConfigState", () => ({ usePreviewWebviewConfig: () => mocks.config }));
vi.mock("./desktopTabLifetime", () => ({
  acquireDesktopTab: () => ({ ready: Promise.resolve(), release: () => {} }),
  withDesktopTab: () => {},
}));
vi.mock("./browserSurfaceStore", () => ({
  resolveBrowserSurfacePanelRect: () => null,
  useBrowserSurfaceStore: (selector: (state: unknown) => unknown) => selector({ byTabId: {}, activityByTabId: {} }),
}));
vi.mock("./browserRecording", () => ({ useActiveBrowserRecordingTabIds: () => new Set() }));
vi.mock("./BrowserDeviceToolbar", () => ({ BrowserDeviceToolbar: () => null }));
vi.mock("./BrowserViewportResizeHandles", () => ({ BrowserViewportResizeHandles: () => null }));
vi.mock("./useBrowserViewportResize", () => ({
  useBrowserViewportResize: () => ({
    effectiveViewport: { _tag: "fill" }, layout: {
      viewportX: 0, viewportY: 0, viewportWidth: 1280, viewportHeight: 800,
      viewportScale: 1, canvasWidth: 1280, canvasHeight: 800,
    },
  }),
}));

import { HostedBrowserWebview } from "./HostedBrowserWebview";
import { resetHostedBrowserGuest } from "./hostedBrowserGuestReset";

let renderer: ReactTestRenderer | undefined;
let guests: HTMLElement[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  mocks.registerWebview.mockReset().mockResolvedValue(undefined);
  guests = [];
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    renderer = create(<HostedBrowserWebview
      threadRef={{ environmentId: "env", threadId: "same-session" } as never}
      tabId="same-tab" runtimeTabId="same-runtime" initialUrl="https://chatgpt.com/"
      viewport={{ _tag: "fill" }} pictureInPicture={false} profileId="existing-profile" zoomFactor={1}
    />, { createNodeMock: (element) => {
      const node = document.createElement(element.type === "webview" ? "webview" : "div");
      if (element.type === "webview") {
        const id = guests.length + 10;
        Object.assign(node, { getWebContentsId: () => id, getURL: () => "https://chatgpt.com/c/current" });
        guests.push(node);
      }
      return node;
    } });
  });
}

it("replaces a nonresponsive guest, retains the logical tab/profile/current URL, and confirms a different ID", async () => {
  await mount();
  let reset: ReturnType<typeof resetHostedBrowserGuest>;
  await act(async () => {
    reset = resetHostedBrowserGuest("same-runtime");
    expect(resetHostedBrowserGuest("same-runtime")).toBe(reset);
  });
  await expect(reset!).resolves.toEqual({ previousWebContentsId: 10, webContentsId: 11 });
  const webview = renderer!.root.findByType("webview");
  expect(webview.props.src).toBe("https://chatgpt.com/c/current");
  expect(webview.props.partition).toBe("persist:existing-profile");
  expect(webview.props["data-preview-server-tab"]).toBe("same-tab");
  expect(mocks.registerWebview).toHaveBeenLastCalledWith("same-runtime", 11);
  expect(guests).toHaveLength(2);
});

it("reports an unconfirmed reset when the replacement cannot register, and never reports success for the old guest", async () => {
  await mount();
  mocks.registerWebview.mockRejectedValue(new Error("registration failed"));
  let reset: ReturnType<typeof resetHostedBrowserGuest>;
  let failure: Promise<unknown>;
  await act(async () => {
    reset = resetHostedBrowserGuest("same-runtime", "https://chatgpt.com/");
    failure = reset.catch((error: unknown) => error);
  });
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(await failure!).toEqual(expect.objectContaining({ message: expect.stringContaining("unconfirmed") }));
});
