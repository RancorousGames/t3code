import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const state = vi.hoisted(() => ({
  bindings: [] as ResolvedKeybindingsConfig,
  pathname: "/browser",
  paletteOpen: false,
  createSession: vi.fn(() => "created-session-id"),
  navigate: vi.fn(),
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => state.bindings) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
  useLocation: (({ select }: { select: (location: { pathname: string }) => string }) =>
    select({ pathname: state.pathname })) as never,
}));
vi.mock(import("../env"), async (original) => ({
  ...(await original()),
  isElectron: true,
}));
vi.mock(import("../commandPaletteBus"), async (original) => ({
  ...(await original()),
  isCommandPaletteOpen: () => state.paletteOpen,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => "remote",
}));
vi.mock(import("../chatGPTBrowserSessions"), async (original) => ({
  ...(await original()),
  useChatGPTBrowserSessions: () => ({ createSession: state.createSession }),
}));

import { dispatchMenuAction } from "../shortcuts/dispatcher";
import { ChatGPTNewSessionShortcut } from "./ChatGPTNewSessionShortcut";

function ctrlY(target: EventTarget = window, repeat = false) {
  const event = new KeyboardEvent("keydown", {
    key: "y",
    code: "KeyY",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    repeat,
  });
  target.dispatchEvent(event);
  return event;
}

describe("new ChatGPT session shortcut", () => {
  it("creates a manual session on Ctrl+Y or a forwarded guest action, never on key repeats or capture", async () => {
    state.createSession.mockClear();
    state.navigate.mockClear();
    state.bindings = [
      {
        command: "chatgpt.newSession",
        shortcut: {
          key: "y",
          ctrlKey: true,
          metaKey: false,
          modKey: false,
          altKey: false,
          shiftKey: false,
        },
      },
    ];
    state.pathname = "/browser";
    state.paletteOpen = false;
    await using _view = await render(<ChatGPTNewSessionShortcut />);

    await act(() => {
      expect(ctrlY().defaultPrevented).toBe(true);
      ctrlY(window, true);
      dispatchMenuAction("chatgpt.newSession");
    });
    expect(state.createSession).toHaveBeenCalledTimes(2);
    expect(state.createSession).toHaveBeenCalledWith(undefined, { explicitlyUserCreated: true });
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/browser/$browserSessionId",
      params: { browserSessionId: "created-session-id" },
    });

    const capture = document.createElement("input");
    capture.setAttribute("data-keybinding-capture", "");
    document.body.append(capture);
    try {
      await act(() => ctrlY(capture));
      expect(state.createSession).toHaveBeenCalledTimes(2);
      state.paletteOpen = true;
      await act(() => {
        ctrlY();
        dispatchMenuAction("chatgpt.newSession");
      });
      expect(state.createSession).toHaveBeenCalledTimes(2);
    } finally {
      capture.remove();
    }
  });
});
