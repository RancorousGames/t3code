// @vitest-environment node
import { EnvironmentId } from "@t3tools/contracts";
// @ts-expect-error -- jsdom's types are absent in this workspace install.
import { JSDOM } from "jsdom";
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

vi.mock("./lib/utils", () => {
  let nextId = 0;
  return { randomUUID: () => `fresh-session-${++nextId}` };
});
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopeThreadRef: (_environmentId: unknown, threadId: unknown) => ({ threadId }),
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
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://app.t3.codes/",
  });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
  vi.stubGlobal("StorageEvent", dom.window.StorageEvent);
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
  it("separates manually opened blank guest from a subsequent backend spawn", async () => {
    await act(async () => {
      harness.setPrewarmedSessionId("prepared-session");
    });
    markChatGPTSpareReady(env, "prepared-session");
    let manual = "";
    let backend = "";
    await act(async () => {
      manual = harness.createSession("User's blank new chat");
      backend = harness.createSession("Backend worker", { spawnRequestId: "backend-request-1" });
    });
    expect(manual).toBe("prepared-session");
    expect(backend).not.toBe(manual);
    expect(
      harness.sessions.find((session) => session.id === manual)?.spawnRequestId,
    ).toBeUndefined();
    expect(harness.sessions.find((session) => session.id === backend)?.spawnRequestId).toBe(
      "backend-request-1",
    );
    expect(harness.sessions).toHaveLength(3);
  });

  it("backend spawns do not consume the user warm spare and reserve separate guests concurrently", async () => {
    await act(async () => {
      harness.setPrewarmedSessionId("prepared-session");
    });
    markChatGPTSpareReady(env, "prepared-session");
    let first = "";
    let second = "";
    await act(async () => {
      first = harness.createSession("Backend A", { spawnRequestId: "backend-request-a" });
      second = harness.createSession("Backend B", { spawnRequestId: "backend-request-b" });
    });
    expect(first).not.toBe(second);
    expect(first).not.toBe("prepared-session");
    expect(second).not.toBe("prepared-session");
    expect(harness.prewarmedSessionId).toBe("prepared-session");
    expect(harness.sessions).toHaveLength(3);
    expect(harness.sessions.find((session) => session.id === first)?.spawnRequestId).toBe(
      "backend-request-a",
    );
    expect(harness.sessions.find((session) => session.id === second)?.spawnRequestId).toBe(
      "backend-request-b",
    );
    let manual = "";
    await act(async () => {
      manual = harness.createSession();
    });
    expect(manual).toBe("prepared-session");
    expect(harness.sessions).toHaveLength(4);
  });
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
