import type { ScopedThreadRef } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  portalContainer: undefined as unknown,
  menuAction: undefined as ((action: string) => void) | undefined,
  findInPage: vi.fn(),
  stopFindInPage: vi.fn(),
}));

vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (element: unknown, container: unknown) => {
    state.portalContainer = container;
    return element;
  },
}));

vi.mock("../../browser/previewRuntimeTabId", () => ({
  previewRuntimeTabId: () => "runtime-tab",
}));
vi.mock("../../previewStateStore", () => ({
  useThreadPreviewState: () => ({ activeTabId: "tab", serverEpoch: "epoch" }),
}));

import { ChatGPTBrowserFindBar } from "./ChatGPTBrowserFindBar";

const threadRef = { environmentId: "local", threadId: "chatgpt-session:test" } as ScopedThreadRef;
let renderer: ReactTestRenderer;
let guest: EventTarget;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("navigator", { platform: "Win32" });
  guest = Object.assign(new EventTarget(), {
    dataset: { previewTab: "runtime-tab" },
    findInPage: state.findInPage,
    stopFindInPage: state.stopFindInPage,
    getBoundingClientRect: () => ({ top: 60, right: 920 }),
  });
  vi.stubGlobal("document", { querySelectorAll: () => [guest], body: {} });
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      desktopBridge: {
        onMenuAction: (listener: typeof state.menuAction) => {
          state.menuAction = listener;
          return () => {
            state.menuAction = undefined;
          };
        },
      },
    }),
  );
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("ChatGPT browser find bar", () => {
  it("searches only the selected guest and supports next, previous, and close", async () => {
    await act(() => {
      renderer = create(<ChatGPTBrowserFindBar threadRef={threadRef} />);
    });
    expect(renderer.toJSON()).toBeNull();

    await act(() => state.menuAction?.("chatgpt.find"));
    const input = renderer.root.findByProps({ "aria-label": "Find in page" });
    await act(() => input.props.onChange({ target: { value: "Rome" } }));
    expect(state.findInPage).toHaveBeenLastCalledWith("Rome", { findNext: true });

    const update = Object.assign(new Event("found-in-page"), {
      result: { matches: 8, activeMatchOrdinal: 3 },
    });
    await act(() => {
      guest.dispatchEvent(update);
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("3/8");

    await act(() => renderer.root.findByProps({ "aria-label": "Next match" }).props.onClick());
    expect(state.findInPage).toHaveBeenLastCalledWith("Rome", { findNext: false, forward: true });

    await act(() => renderer.root.findByProps({ "aria-label": "Previous match" }).props.onClick());
    expect(state.findInPage).toHaveBeenLastCalledWith("Rome", { findNext: false, forward: false });

    await act(() => renderer.root.findByProps({ "aria-label": "Close find" }).props.onClick());
    expect(renderer.toJSON()).toBeNull();
    expect(state.stopFindInPage).toHaveBeenCalledWith("clearSelection");
  });

  it("opens on host Ctrl+F but ignores Ctrl+Shift+F and other modifiers", async () => {
    await act(() => {
      renderer = create(<ChatGPTBrowserFindBar threadRef={threadRef} />);
    });
    const press = (overrides: Record<string, unknown> = {}) => {
      const event = Object.assign(new Event("keydown", { cancelable: true }), {
        key: "f",
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        isComposing: false,
        ...overrides,
      });
      window.dispatchEvent(event);
      return event;
    };
    await act(() => {
      expect(press({ shiftKey: true }).defaultPrevented).toBe(false);
    });
    expect(renderer.toJSON()).toBeNull();

    await act(() => {
      expect(press().defaultPrevented).toBe(true);
    });
    expect(renderer.root.findByProps({ "aria-label": "Find in page" })).toBeDefined();
    expect(state.portalContainer).toBe(document.body);
    expect(renderer.root.findByProps({ role: "search" }).props.className).toContain("fixed");
  });
});
