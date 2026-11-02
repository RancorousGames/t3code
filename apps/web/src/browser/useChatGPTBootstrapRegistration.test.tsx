// @vitest-environment node
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const sessionId = "11111111-1111-4111-8111-111111111111";
const markerId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const url = `https://chatgpt.com/c/${conversationId}`;

const mocks = vi.hoisted(() => {
  const register = vi.fn();
  const resolveTitle = vi.fn();
  return {
    register,
    resolveTitle,
    bridge: vi.fn(),
    title: vi.fn(async () => "Repair browser identity"),
    sessions: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        bootstrapIdentity: { state: "awaiting_marker" as const },
      },
    ],
  };
});

vi.mock("./persistentChatGPTSessionMode", () => ({
  isPersistentChatGPTSessionOptedIn: () => true,
}));
vi.mock("./mountedChatGPTGuest", () => ({ findMountedChatGPTGuest: () => null }));
vi.mock("../previewStateStore", () => ({
  readThreadPreviewState: () => ({ activeTabId: null, serverEpoch: null }),
}));
vi.mock("../chatGPTBrowserSessions", () => ({
  chatGPTBrowserThreadRef: (environmentId: string, id: string) => ({
    environmentId,
    threadId: id,
  }),
  readChatGPTBrowserSessions: () => mocks.sessions,
  useChatGPTBrowserSessions: () => ({
    sessions: mocks.sessions,
    registerBootstrapMarker: mocks.register,
    resolveBootstrapTitle: mocks.resolveTitle,
  }),
}));

import { useChatGPTBootstrapRegistration } from "./useChatGPTBootstrapRegistration";

function Harness() {
  useChatGPTBootstrapRegistration("local" as never, sessionId);
  return null;
}

let renderer: ReactTestRenderer | undefined;
async function mount() {
  await act(async () => {
    renderer = create(<Harness />);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.register.mockReset();
  mocks.resolveTitle.mockReset();
  mocks.title.mockReset().mockResolvedValue("Repair browser identity");
  mocks.bridge.mockReset();
  vi.stubGlobal("window", {
    desktopBridge: {
      stableChatGPTViewRequest: mocks.bridge,
      readChatGPTBootstrapTitle: mocks.title,
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("native Chromium Bootstrap registration", () => {
  it("registers a marker from a native view without a preview tab or mounted webview", async () => {
    mocks.bridge.mockImplementation(async (input: { operation: string }) =>
      input.operation === "probe" || input.operation === "snapshot"
        ? { residency: "resident", url, destroyed: false }
        : { result: { conversationId, markerId, proposedTitle: "Repair browser identity" } },
    );
    await mount();
    expect(mocks.register).toHaveBeenCalledWith(sessionId, {
      conversationId,
      markerId,
      proposedTitle: "Repair browser identity",
    });
    expect(mocks.title).toHaveBeenCalledWith(markerId);
    expect(mocks.resolveTitle).toHaveBeenCalledWith(
      sessionId,
      markerId,
      conversationId,
      "Repair browser identity",
    );
    expect(mocks.bridge.mock.calls.map(([input]) => input.operation)).toEqual([
      "probe",
      "evaluate",
      "snapshot",
    ]);
  });

  it("does not assign an ID when native Chromium navigates during the probe", async () => {
    let snapshots = 0;
    mocks.bridge.mockImplementation(async (input: { operation: string }) =>
      input.operation === "probe" || input.operation === "snapshot"
        ? {
            residency: "resident",
            url:
              ++snapshots === 1
                ? url
                : "https://chatgpt.com/c/44444444-4444-4444-8444-444444444444",
          }
        : { result: { conversationId, markerId } },
    );
    await mount();
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.title).not.toHaveBeenCalled();
  });
});
