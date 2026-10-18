// @vitest-environment jsdom
import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const preview = vi.hoisted(() => ({
  attached: true,
  loading: false,
  url: "https://chatgpt.com/",
  hasWebContents: true,
  navTag: "Success",
}));

vi.mock("./browser/previewRuntimeTabId", () => ({
  previewRuntimeTabId: (_ref: unknown, _epoch: unknown, tabId: string) => `runtime:${tabId}`,
}));
vi.mock("./previewStateStore", () => ({
  readThreadPreviewState: () => ({
    serverEpoch: "epoch",
    activeTabId: "spare-tab",
    sessions: {
      "spare-tab": {
        navStatus: { _tag: preview.navTag, url: preview.url },
      },
    },
    desktopByTabId: {
      "spare-tab": { loading: preview.loading, hasWebContents: preview.hasWebContents },
    },
  }),
}));

import { markChatGPTSpareReady, releaseChatGPTSpare } from "./chatGPTBrowserPrewarm";
import { useChatGPTBrowserSessions } from "./chatGPTBrowserSessions";

const env = EnvironmentId.make("prewarm-integration");
let harness: ReturnType<typeof useChatGPTBrowserSessions>;
let renderer: ReactTestRenderer | undefined;

function Harness() {
  harness = useChatGPTBrowserSessions(env);
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  preview.attached = true;
  preview.loading = false;
  preview.url = "https://chatgpt.com/";
  preview.hasWebContents = true;
  preview.navTag = "Success";
  document.body.replaceChildren();
  const webview = document.createElement("webview");
  webview.dataset.previewTab = "runtime:spare-tab";
  document.body.append(webview);
  await act(async () => {
    renderer = create(<Harness />);
  });
});
afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  releaseChatGPTSpare(env, "prepared-session");
});

describe("ChatGPT browser session creation with one warm spare", () => {
  it("adopts the ready webview's owner and immediately provisions a different spare", async () => {
    await act(async () => {
      harness.setPrewarmedSessionId("prepared-session");
    });
    markChatGPTSpareReady(env, "prepared-session");
    let created: string | undefined;
    await act(async () => {
      created = harness.createSession("New work");
    });
    expect(created).toBe("prepared-session");
    expect(harness.sessions.find((session) => session.id === created)?.title).toBe("New work");
    expect(harness.prewarmedSessionId).not.toBe(created);
    expect(harness.prewarmedSessionId).toBeTruthy();
    expect(harness.sessions.some((session) => session.id === harness.prewarmedSessionId)).toBe(
      false,
    );

    // Only one browser can claim a prepared owner, even if the second click is immediate.
    let second: string | undefined;
    await act(async () => {
      second = harness.createSession();
    });
    expect(second).not.toBe(created);
    expect(second).not.toBe(harness.prewarmedSessionId);
    expect(harness.sessions).toHaveLength(3); // default ChatGPT 1 + two new sessions
  });

  it("uses normal session opening when a spare is still loading or has navigated away", async () => {
    await act(async () => {
      harness.setPrewarmedSessionId("prepared-session");
    });
    markChatGPTSpareReady(env, "prepared-session");
    preview.loading = true;
    let created: string | undefined;
    await act(async () => {
      created = harness.createSession();
    });
    expect(created).not.toBe("prepared-session");
    expect(harness.prewarmedSessionId).toBe("prepared-session");

    preview.loading = false;
    preview.url = "https://chatgpt.com/c/existing-chat";
    await act(async () => {
      created = harness.createSession();
    });
    expect(created).not.toBe("prepared-session");
    expect(harness.prewarmedSessionId).toBe("prepared-session");

    preview.url = "https://chatgpt.com/";
    preview.hasWebContents = false;
    await act(async () => {
      created = harness.createSession();
    });
    expect(created).not.toBe("prepared-session");
    expect(harness.prewarmedSessionId).toBe("prepared-session");
  });
});
