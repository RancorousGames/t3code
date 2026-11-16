import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const state = vi.hoisted(() => ({
  bindings: [] as ResolvedKeybindingsConfig,
  pathname: "/browser",
  paletteOpen: false,
  createSession: vi.fn(() => "created-session-id"),
  toggleReturnMarker: vi.fn(),
  toast: vi.fn(),
  marker: undefined as "armed" | "working" | "ready" | undefined,
  activity: "idle" as "idle" | "working" | "unknown",
  navigate: vi.fn(),
  requestAttention: vi.fn(),
  cancelAttention: vi.fn(),
  acknowledgeAttention: vi.fn(),
  latestAttention: vi.fn(() => undefined as { id: string; sessionId: string } | undefined),
  openAttention: vi.fn(),
  clearReturnMarker: vi.fn(),
  setSessionHidden: vi.fn(),
  setSessionSnooze: vi.fn(),
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
  useChatGPTBrowserSessions: () => ({
    createSession: state.createSession, toggleSessionReturnMarker: state.toggleReturnMarker,
    clearSessionReturnMarker: state.clearReturnMarker,
    setSessionHidden: state.setSessionHidden, setSessionSnooze: state.setSessionSnooze,
  }),
  readChatGPTBrowserSessions: () => [{ id: "selected-session", title: "Selected session", returnMarker: state.marker }],
}));

vi.mock(import("../chatGPTAgentAttention"), async (original) => ({
  ...(await original()),
  requestAgentAttention: state.requestAttention as never,
  cancelManualAgentAttention: state.cancelAttention as never,
  latestAgentAttention: state.latestAttention as never,
  openAgentAttention: state.openAttention as never,
}));

vi.mock(import("../chatGPTPersistentAttention"), async (original) => ({
  ...(await original()),
  acknowledgeChatGPTSessionAttention: state.acknowledgeAttention,
}));

vi.mock(import("../chatGPTProviderActivity"), async (original) => ({
  ...(await original()),
  readChatGPTProviderActivity: () => state.activity,
}));
vi.mock(import("./ui/toast"), async (original) => ({
  ...(await original()),
  toastManager: { add: state.toast },
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

describe("Return marker shortcut", () => {
  it("arms idle sessions without an immediate yellow highlight, confirms the change and toggles off", async () => {
    state.pathname = "/browser/selected-session";
    state.activity = "idle";
    state.marker = undefined;
    state.toggleReturnMarker.mockClear();
    state.toast.mockClear();
    await using _view = await render(<ChatGPTNewSessionShortcut />);

    await act(() => dispatchMenuAction("chatgpt.return-marker"));
    expect(state.toggleReturnMarker).toHaveBeenLastCalledWith("selected-session", "idle");
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Persistent attention enabled" }));
    expect(state.requestAttention).toHaveBeenCalledWith(
      expect.any(String), "selected-session", expect.any(String), "manual",
    );

    state.marker = "armed";
    await act(() => dispatchMenuAction("chatgpt.return-marker"));
    expect(state.toggleReturnMarker).toHaveBeenCalledTimes(2);
    expect(state.toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Persistent attention disabled" }));
    expect(state.cancelAttention).toHaveBeenCalledWith(["selected-session"]);
  });

  it("arms working sessions rather than highlighting them prematurely", async () => {
    state.pathname = "/browser/selected-session";
    state.activity = "working";
    state.marker = undefined;
    state.toggleReturnMarker.mockClear();
    await using _view = await render(<ChatGPTNewSessionShortcut />);

    await act(() => dispatchMenuAction("chatgpt.return-marker"));
    expect(state.toggleReturnMarker).toHaveBeenCalledWith("selected-session", "working");
    expect(state.toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Persistent attention enabled" }));
  });
});

describe("Open last GMA session shortcut", () => {
  it("opens and acknowledges the most recently requesting session", async () => {
    state.pathname = "/browser/selected-session";
    state.latestAttention.mockReturnValue({ id: "request", sessionId: "selected-session" });
    state.acknowledgeAttention.mockClear();
    state.navigate.mockClear();
    await using _view = await render(<ChatGPTNewSessionShortcut />);
    await act(() => dispatchMenuAction("chatgpt.open-last-attention"));
    expect(state.acknowledgeAttention).toHaveBeenCalledWith("remote",
      expect.objectContaining({ id: "selected-session" }));
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/browser/$browserSessionId", params: { browserSessionId: "selected-session" },
    });
    state.latestAttention.mockReturnValue(undefined);
  });
});

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
