// @vitest-environment jsdom
import { EnvironmentId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(() => "spawned-session"),
  sendInitial: vi.fn(async () => {}),
  navigate: vi.fn(),
  createProject: vi.fn(),
  openThread: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../chatGPTBrowserAutomation", () => ({
  sendInitialChatGPTPrompt: mocks.sendInitial,
}));
vi.mock("../../chatGPTBrowserSessions", () => ({
  useChatGPTBrowserSessions: () => ({ createSession: mocks.createSession }),
}));
vi.mock("../../desktopAppActivation", () => ({
  handleDesktopAppActivationRequest: vi.fn(),
}));
vi.mock("../../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => mocks.openThread,
}));
vi.mock("../../lib/projectPaths", () => ({
  findProjectByPath: vi.fn(),
  inferProjectTitleFromPath: vi.fn(),
}));
vi.mock("../../lib/utils", () => ({ newProjectId: vi.fn() }));
vi.mock("../../state/entities", () => ({
  readProjects: vi.fn(() => []),
  waitForProject: vi.fn(async () => {}),
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => ({
    environmentId: "local",
    connection: { phase: "connected" },
    serverConfig: { environment: { platform: { os: "win32" } } },
  }),
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: { create: "create" },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { snapshot: { _tag: "Some" } } }),
}));
vi.mock("../../state/shell", () => ({
  environmentShell: { stateAtom: vi.fn(() => "shell") },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => mocks.createProject,
}));

import { DesktopAppActivationCoordinator } from "./DesktopAppActivationCoordinator";

describe("background ChatGPT activation", () => {
  let renderer: ReactTestRenderer | undefined;
  let onRequest: ((request: unknown) => void) | null;
  const complete = vi.fn(async (_response: unknown) => {});
  const setReady = vi.fn(async (_ready: boolean) => {});
  const appActivation = {
    onRequest: vi.fn((callback: (request: unknown) => void) => {
      onRequest = callback;
      return () => {
        onRequest = null;
      };
    }),
    complete,
    setReady,
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.createSession.mockClear();
    mocks.sendInitial.mockClear();
    mocks.navigate.mockClear();
    complete.mockClear();
    setReady.mockClear();
    onRequest = null;
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { appActivation },
    });
  });

  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "desktopBridge");
  });

  it("creates and sends a subagent prompt without navigating away from the selected T3 page", async () => {
    await act(async () => {
      renderer = create(<DesktopAppActivationCoordinator />);
    });
    expect(setReady).toHaveBeenCalledWith(true);
    expect(onRequest).not.toBeNull();
    const request = {
      version: 1 as const,
      requestId: "background-spawn",
      type: "chatgpt.spawn" as const,
      title: "Agent B",
      prompt: "Please review the code",
    };
    await act(async () => onRequest?.(request));

    expect(mocks.createSession).toHaveBeenCalledExactlyOnceWith("Agent B");
    expect(mocks.sendInitial).toHaveBeenCalledExactlyOnceWith({
      environmentId: EnvironmentId.make("local"),
      sessionId: "spawned-session",
      prompt: "Please review the code",
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith({
      version: 1,
      requestId: request.requestId,
      ok: true,
      sessionId: "spawned-session",
      messageSent: true,
    });
  });
});
