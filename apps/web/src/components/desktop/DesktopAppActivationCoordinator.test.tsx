// @vitest-environment node
// react-test-renderer needs only a controlled window bridge; using Node keeps
// the repository test setup (shared HostProcess/node:sea) in its native host.
import { EnvironmentId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(() => "spawned-session"),
  sendInitial: vi.fn(async () => {}),
  navigate: vi.fn(),
  createProject: vi.fn(),
  openThread: vi.fn(),
  projects: [] as Array<Record<string, unknown>>,
  threads: [] as Array<Record<string, unknown>>,
  createNativeThread: vi.fn(async (_args: { input: Record<string, unknown> }) => ({ _tag: "Success" })),
  startNativeTurn: vi.fn(async (): Promise<unknown> => ({ _tag: "Success" })),
  waitForThreadShell: vi.fn(async () => true),
  nativeProjection: vi.fn(async (): Promise<unknown> => ({ _tag: "Success", value: { messages: [] as Array<{ id: string; role: string }> } })),
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: vi.fn((error) => error),
}));
vi.mock("../../hooks/useLocalStorage", () => ({
  getLocalStorageItem: vi.fn(),
  setLocalStorageItem: vi.fn(),
}));
vi.mock("../../chatGPTSessionControl", () => ({
  runChatGPTSessionControl: vi.fn(),
}));
vi.mock("../../chatGPTSessionLineage", () => ({
  resolveExplicitChatGPTParent: vi.fn(),
}));
vi.mock("../../chatGPTSessionGrouping", () => ({
  applyConfirmedChatGPTSessionMetadata: vi.fn(),
  matchRegisteredProject: vi.fn(),
}));
vi.mock("../../previewStateStore", () => ({
  beginPreviewSessionClose: vi.fn(),
  cancelPreviewSessionClose: vi.fn(),
  clearThreadPreviewState: vi.fn(),
  readThreadPreviewState: vi.fn(),
}));
vi.mock("../../state/preview", () => ({
  previewEnvironment: { close: "close" },
}));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: { v2: { threadProjection: "projection" } },
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { create: "native-create", startTurn: "native-start" },
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: (name: string) =>
    name === "native-create" ? mocks.createNativeThread : mocks.startNativeTurn,
}));
vi.mock("../../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => mocks.nativeProjection,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../../chatGPTBrowserAutomation", () => ({
  sendInitialChatGPTPrompt: mocks.sendInitial,
}));
vi.mock("../../chatGPTBrowserSessions", () => ({
  useChatGPTBrowserSessions: () => ({ createSession: mocks.createSession }),
  readChatGPTBrowserSessions: () => [],
}));
vi.mock("../../desktopAppActivation", () => ({
  handleDesktopAppActivationRequest: vi.fn(),
}));
vi.mock("../../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => mocks.openThread,
}));
vi.mock("../../lib/projectPaths", () => ({
  findProjectByPath: (projects: Array<{ workspaceRoot: string }>, path: string) =>
    projects.find((project) => project.workspaceRoot.toLowerCase() === path.toLowerCase()),
  inferProjectTitleFromPath: () => "t3code",
  normalizeProjectPathForComparison: (path: string) =>
    path.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase(),
}));
vi.mock("../../lib/utils", () => ({ newProjectId: vi.fn(() => "c5b2d999-7c69-4709-93c9-735d76b463c7") }));
vi.mock("../../state/entities", () => ({
  readProjects: vi.fn(() => mocks.projects),
  readThreadShells: vi.fn(() => mocks.threads),
  waitForThreadShell: mocks.waitForThreadShell,
  waitForProject: vi.fn(async () => {}),
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => ({
    environmentId: "local",
    connection: { phase: "connected" },
    serverConfig: {
      environment: { platform: { os: "win32" } },
      settings: { providerInstances: { opencode: { driver: "opencode", enabled: true } }, projectSettingsOverrides: {} },
      providers: [
        { instanceId: "codex", driver: "codex", enabled: true, installed: true, status: "ready",
          availability: "available", models: [{ slug: "gpt-5-codex" }] },
        { instanceId: "claudeAgent", driver: "claudeAgent", enabled: true, installed: true, status: "ready",
          availability: "available", models: [{ slug: "claude-sonnet-4-5" }] },
        { instanceId: "opencode", driver: "opencode", enabled: true, installed: true, status: "ready",
          availability: "available", models: [{ slug: "opencode/deepseek-v4.1-flash-free" }] },
      ],
    },
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
    vi.stubGlobal("window", {});
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.createSession.mockClear();
    mocks.sendInitial.mockClear();
    mocks.navigate.mockClear();
    mocks.createNativeThread.mockClear();
    mocks.startNativeTurn.mockClear();
    mocks.waitForThreadShell.mockClear();
    mocks.nativeProjection.mockClear();
    mocks.nativeProjection.mockResolvedValue({ _tag: "Success", value: { messages: [] } });
    mocks.projects = [];
    mocks.threads = [];
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
    Reflect.deleteProperty(window, "desktopBridge");
    vi.unstubAllGlobals();
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
      parentSessionId: null,
      messageSent: true,
    });
  });
});


describe("managed native provider desktop activation", () => {
  let renderer: ReactTestRenderer | undefined;
  let onRequest: ((request: unknown) => void) | null;
  const complete = vi.fn(async (_response: unknown) => {});
  const projectId = "c5b2d999-7c69-4709-93c9-735d76b463c7";
  const threadId = "7a046ce0-4a77-4b4a-a78c-66d3699d5c00";
  const initialMessageId = "763df61c-87b0-48b4-a771-01d72a303516";
  const workspaceRoot = "D:\\SSDProjects\\Tools\\t3code";
  const createRequest = {
    version: 1 as const, requestId: "native-create",
    type: "t3.threads" as const,
    action: "create" as const,
    environmentId: "local", workspaceRoot,
    runtime: "codex" as const, providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
    runtimeMode: "approval-required" as const,
    title: "Managed worker", clientRequestId: threadId,
  };
  beforeEach(async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    onRequest = null;
    complete.mockClear();
    mocks.openThread.mockClear();
    mocks.createNativeThread.mockReset();
    mocks.createNativeThread.mockResolvedValue({ _tag: "Success" });
    mocks.startNativeTurn.mockReset();
    mocks.startNativeTurn.mockResolvedValue({ _tag: "Success" });
    mocks.navigate.mockClear();
    mocks.projects = [{ id: projectId, environmentId: "local", title: "t3code", workspaceRoot }];
    mocks.threads = [];
    mocks.waitForThreadShell.mockReset();
    mocks.waitForThreadShell.mockResolvedValue(true);
    mocks.nativeProjection.mockReset();
    mocks.nativeProjection.mockResolvedValue({ _tag: "Success", value: { messages: [] } });
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { appActivation: {
        onRequest: (callback: (request: unknown) => void) => {
          onRequest = callback;
          return () => { onRequest = null; };
        },
        complete,
        setReady: vi.fn(async () => {}),
      } },
    });
    await act(async () => { renderer = create(<DesktopAppActivationCoordinator />); });
  });
  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount());
    renderer = undefined;
    Reflect.deleteProperty(window, "desktopBridge");
    vi.unstubAllGlobals();
  });
  const deliver = async (request: unknown) => {
    await act(async () => { onRequest?.(request); });
    return complete.mock.lastCall?.[0] as {
      ok: boolean; code?: string; data?: Record<string, unknown>;
    };
  };
  it("persists an exact provider thread, never calls UI open-workspace draft or route navigation", async () => {
    mocks.createNativeThread.mockImplementation(async ({ input }: { input: Record<string, unknown> }) => {
      mocks.threads = [{
        id: input.threadId, environmentId: "local", projectId,
        providerInstanceId: "codex", modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode, interactionMode: "default", deletedAt: null,
      }];
      return { _tag: "Success" };
    });
    const response = await deliver(createRequest);
    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      action: "create", environmentId: "local", projectId, threadId,
      providerInstanceId: "codex", created: true, messageSent: false, workspaceRoot,
    });
    expect(mocks.createNativeThread).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: expect.objectContaining({
        threadId, projectId, title: createRequest.title,
        modelSelection: createRequest.modelSelection,
        runtimeMode: "approval-required", interactionMode: "default",
        branch: null, worktreePath: null,
      }),
    });
    expect(mocks.openThread).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.startNativeTurn).not.toHaveBeenCalled();
  });
  it("creates OpenCode from the explicit ready catalog with exact Altraea root and durable first-message receipt", async () => {
    const altraeaRoot = "D:\\SSDProjects\\SettlingAltraea";
    mocks.projects = [{ id: projectId, environmentId: "local", title: "SettlingAltraea", workspaceRoot: altraeaRoot }];
    const openCodeRequest = {
      ...createRequest,
      requestId: "opencode-root",
      workspaceRoot: altraeaRoot,
      runtime: "opencode" as const,
      providerInstanceId: "opencode",
      modelSelection: { instanceId: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
      firstMessage: "Review changes and report commit scope.",
      initialMessageId,
    };
    mocks.createNativeThread.mockImplementation(async ({ input }: { input: Record<string, unknown> }) => {
      mocks.threads = [{
        id: input.threadId, environmentId: "local", projectId,
        providerInstanceId: "opencode", modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode, interactionMode: "default", deletedAt: null,
      }];
      return { _tag: "Success" };
    });
    mocks.nativeProjection.mockResolvedValue({
      _tag: "Success", value: { messages: [{ id: initialMessageId, role: "user" }] },
    });
    const receipt = await deliver(openCodeRequest);
    expect(receipt.ok).toBe(true);
    expect(receipt.data).toMatchObject({
      action: "create", environmentId: "local", projectId, threadId,
      workspaceRoot: altraeaRoot, runtime: "opencode", providerInstanceId: "opencode",
      modelSelection: { instanceId: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
      created: true, messageSent: true, messageId: initialMessageId,
    });
    expect(mocks.createNativeThread).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: expect.objectContaining({
        threadId, projectId, modelSelection: openCodeRequest.modelSelection,
        runtimeMode: "approval-required", interactionMode: "default",
        branch: null, worktreePath: null,
      }),
    });
    expect(mocks.startNativeTurn).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: expect.objectContaining({
        threadId,
        modelSelection: openCodeRequest.modelSelection,
        dispatchMode: "queue",
        message: expect.objectContaining({ messageId: initialMessageId, text: openCodeRequest.firstMessage, role: "user" }),
      }),
    });
    expect(mocks.openThread).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("rejects cross-driver OpenCode requests and noncatalog models without spawning or composer fallback", async () => {
    for (const override of [
      { runtime: "claude", providerInstanceId: "opencode", modelSelection: { instanceId: "opencode", model: "opencode/deepseek-v4.1-flash-free" } },
      { runtime: "opencode", providerInstanceId: "codex", modelSelection: { instanceId: "codex", model: "gpt-5-codex" } },
      { runtime: "opencode", providerInstanceId: "opencode", modelSelection: { instanceId: "opencode", model: "unknown/deepseek" } },
      { runtime: "cursor", providerInstanceId: "opencode", modelSelection: { instanceId: "opencode", model: "opencode/deepseek-v4.1-flash-free" } },
    ]) {
      const receipt = await deliver({ ...createRequest, ...override, requestId: "invalid-driver-model-" + override.runtime });
      expect(receipt.ok).toBe(false);
    }
    expect(mocks.createNativeThread).not.toHaveBeenCalled();
    expect(mocks.startNativeTurn).not.toHaveBeenCalled();
    expect(mocks.openThread).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("fails closed on a requested model/provider not in the ready environment catalog", async () => {
    const response = await deliver({
      ...createRequest, modelSelection: { instanceId: "codex", model: "not-listed" },
    });
    expect(response.ok).toBe(false);
    expect(response.code).toBe("invalid-request");
    expect(mocks.createNativeThread).not.toHaveBeenCalled();
    expect(mocks.openThread).not.toHaveBeenCalled();
  });
  it("rejects a false success when the persisted native shell is missing", async () => {
    const response = await deliver(createRequest);
    expect(response.ok).toBe(false);
    expect(response.code).toBe("thread-open-failed");
    expect(mocks.createNativeThread).toHaveBeenCalledTimes(1);
    expect(mocks.openThread).not.toHaveBeenCalled();
    expect(mocks.startNativeTurn).not.toHaveBeenCalled();
  });
  it("only acknowledges firstMessage after native projection confirms matching message ID", async () => {
    mocks.createNativeThread.mockImplementation(async ({ input }: { input: Record<string, unknown> }) => {
      mocks.threads = [{
        id: input.threadId, environmentId: "local", projectId,
        providerInstanceId: "codex", modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode, interactionMode: "default", deletedAt: null,
      }];
      return { _tag: "Success" };
    });
    const promptRequest = { ...createRequest, firstMessage: "Do work", initialMessageId };
    const first = await deliver(promptRequest);
    expect(first.ok).toBe(false);
    expect(first.code).toBe("thread-open-failed");
    expect(mocks.startNativeTurn).toHaveBeenCalledTimes(1);
    expect(mocks.openThread).not.toHaveBeenCalled();
    complete.mockClear();
    mocks.startNativeTurn.mockClear();
    mocks.threads = [];
    mocks.nativeProjection.mockResolvedValue({
      _tag: "Success",
      value: { messages: [{ id: initialMessageId, role: "user" }] },
    });
    const second = await deliver(promptRequest);
    expect(second.ok).toBe(true);
    expect(second.data).toMatchObject({ messageSent: true, messageId: initialMessageId });
    expect(mocks.startNativeTurn).toHaveBeenCalledTimes(1);
  });

  const opaqueIds = [
    "mcp:d92d7667-7b13-4bd8-868f-230ede021e8b",
    "thread:mcp:source%3Aworker%2Fchild:0",
  ];
  const nativeRequest = (action: "list" | "read" | "send", id?: string) => ({
    version: 1 as const, requestId: "native-read-send-" + action,
    type: "t3.threads" as const, action, environmentId: "local",
    ...(id ? { threadId: id } : {}),
    ...(action === "read" ? { count: 2 } : {}),
    ...(action === "send" ? {
      message: "Continue existing worker",
      clientRequestId: "6ad41909-57c8-43ed-a20f-742a43cd06a6",
    } : {}),
  });
  const prepareExistingThread = (id: string) => {
    mocks.threads = [{
      id, environmentId: "local", projectId, title: "NOT A ROUTING KEY",
      providerInstanceId: "codex", runtimeMode: "approval-required",
      interactionMode: "default", deletedAt: null,
      modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
    }];
  };

  it("advertises exact running-environment opaque read AND send capability on existing list only", async () => {
    prepareExistingThread(opaqueIds[0]!);
    const result = await deliver(nativeRequest("list"));
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      environmentId: "local",
      nativeThreadMessaging: {
        version: 1, environmentId: "local",
        threadIdGrammar: "t3-native-opaque-read-send-v1",
        readOpaqueThreadIds: true,
        sendOpaqueThreadIds: true,
      },
      threads: [{ id: opaqueIds[0] }],
    });
    expect(mocks.startNativeTurn).not.toHaveBeenCalled();
    expect(mocks.createNativeThread).not.toHaveBeenCalled();
    expect(mocks.openThread).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it.each(opaqueIds)("reads the exact opaque durable recipient %s without decoding or title fallback", async (id) => {
    prepareExistingThread(id);
    mocks.nativeProjection.mockResolvedValue({
      _tag: "Success",
      value: { visibleTurnItems: [
        { position: 1, item: { id: "user-message", role: "user" } },
      ] },
    });
    const result = await deliver(nativeRequest("read", id));
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      environmentId: "local", threadId: id,
      messages: [{ position: 1, item: { id: "user-message", role: "user" } }],
    });
    expect(mocks.nativeProjection).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local", input: { threadId: id },
    });
    expect(mocks.startNativeTurn).not.toHaveBeenCalled();
    expect(mocks.createNativeThread).not.toHaveBeenCalled();
  });

  it.each(opaqueIds)("sends only to the exact opaque native recipient %s and echoes client message ID", async (id) => {
    prepareExistingThread(id);
    const result = await deliver(nativeRequest("send", id));
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      environmentId: "local", threadId: id,
      messageId: "6ad41909-57c8-43ed-a20f-742a43cd06a6", messageSent: true,
    });
    expect(mocks.startNativeTurn).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: expect.objectContaining({
        threadId: id,
        message: {
          messageId: "6ad41909-57c8-43ed-a20f-742a43cd06a6",
          role: "user", text: "Continue existing worker", attachments: [],
        },
        dispatchMode: "queue",
      }),
    });
    expect(mocks.createNativeThread).not.toHaveBeenCalled();
  });

  it("rejects wrong recipient/environment and failed queue without a false send receipt", async () => {
    prepareExistingThread(opaqueIds[0]!);
    for (const request of [
      { ...nativeRequest("read", opaqueIds[1]), requestId: "wrong-recipient" },
      { ...nativeRequest("send", opaqueIds[1]), requestId: "wrong-recipient-send" },
      { ...nativeRequest("send", opaqueIds[0]), requestId: "wrong-env", environmentId: "different-env" },
    ]) {
      const rejected = await deliver(request);
      expect(rejected.ok).toBe(false);
      expect(mocks.startNativeTurn).not.toHaveBeenCalled();
      expect(mocks.nativeProjection).not.toHaveBeenCalled();
    }
    mocks.startNativeTurn.mockResolvedValue({ _tag: "Failure", error: new Error("held") });
    const failed = await deliver({ ...nativeRequest("send", opaqueIds[0]), requestId: "failed-send" });
    expect(failed.ok).toBe(false);
    expect(failed.data?.messageSent).not.toBe(true);
    expect(mocks.createNativeThread).not.toHaveBeenCalled();
  });
});
