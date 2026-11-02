// @vitest-environment jsdom
import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const nativeMode = vi.hoisted(() => ({ enabled: false }));
vi.mock("../../browser/persistentChatGPTSessionMode", () => ({
  isPersistentChatGPTSessionOptedIn: () => nativeMode.enabled,
}));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("prewarm-component"),
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../previewStateStore", () => ({
  readThreadPreviewState: () => ({ activeTabId: null, serverEpoch: null }),
}));
vi.mock("./ChatGPTBrowserSessionRuntime", () => ({
  ChatGPTBrowserSessionRuntime: (props: { sessionId: string; quiet: boolean }) => (
    <div data-prewarmed={props.sessionId} data-quiet={props.quiet} />
  ),
}));

import { ChatGPTBrowserPrewarm } from "./ChatGPTBrowserPrewarm";
import { chatGPTPrewarmKey } from "../../chatGPTBrowserPrewarm";
import { useChatGPTBrowserSessions } from "../../chatGPTBrowserSessions";

const env = EnvironmentId.make("prewarm-component");
let renderer: ReactTestRenderer | undefined;
let controls: ReturnType<typeof useChatGPTBrowserSessions>;

function TestRoot() {
  controls = useChatGPTBrowserSessions(env);
  return <ChatGPTBrowserPrewarm />;
}

function spareId(): string | null {
  const nodes = renderer?.root.findAllByProps({ "data-quiet": true });
  return nodes?.[0]?.props["data-prewarmed"] ?? null;
}

beforeEach(() => {
  nativeMode.enabled = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  document.body.replaceChildren();
});
afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("ChatGPT spare lifetime", () => {
  it("preloads a native hidden Chrome page and adopts it without a second load", async () => {
    nativeMode.enabled = true;
    let loaded = false;
    const requests: string[] = [];
    vi.stubGlobal("desktopBridge", {
      stableChatGPTViewRequest: async (request: { operation: string }) => {
        requests.push(request.operation);
        if (request.operation === "snapshot") {
          if (!loaded) throw new Error("Unknown embedded ChatGPT session.");
          return { destroyed: false, url: "https://chatgpt.com/" };
        }
        if (request.operation === "attach") {
          loaded = true;
          return { destroyed: false, url: "https://chatgpt.com/" };
        }
        if (request.operation === "evaluate") return { result: true };
        throw new Error("Unexpected bridge call");
      },
    });
    await act(async () => {
      renderer = create(<TestRoot />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const warmId = controls.prewarmedSessionId;
    expect(requests).toContain("attach");
    expect(requests).toContain("evaluate");
    expect(renderer?.root.findAllByProps({ "data-quiet": true })).toHaveLength(0);
    let adopted = "";
    await act(async () => {
      adopted = controls.createSession(undefined, { explicitlyUserCreated: true });
    });
    expect(adopted).toBe(warmId);
    expect(controls.prewarmedSessionId).not.toBe(adopted);
    expect(requests.filter((op) => op === "attach")).toHaveLength(1);
  });

  it("creates exactly one offscreen session without adding it to sidebar sessions", async () => {
    await act(async () => {
      renderer = create(<TestRoot />);
    });
    const first = spareId();
    expect(first).toBeTruthy();
    expect(controls.prewarmedSessionId).toBe(first);
    expect(window.localStorage.getItem(chatGPTPrewarmKey(env))).toBe(JSON.stringify(first));
    expect(controls.sessions.every((session) => session.id !== first)).toBe(true);
    expect(renderer?.root.findAllByProps({ "data-quiet": true })).toHaveLength(1);

    await act(async () => {
      renderer?.unmount();
      renderer = create(<TestRoot />);
    });
    expect(spareId()).toBe(first); // reuses the persistent spare owner after reload

    await act(async () => {
      controls.setPrewarmedSessionId("fresh-spare");
    });
    expect(spareId()).toBe("fresh-spare");
    expect(controls.sessions.every((session) => session.id !== "fresh-spare")).toBe(true);
  });
});
