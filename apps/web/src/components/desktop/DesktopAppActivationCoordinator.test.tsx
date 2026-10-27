// @vitest-environment node
// react-test-renderer needs only a controlled window bridge; using Node keeps
// the repository test setup (shared HostProcess/node:sea) in its native host.
import { EnvironmentId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(() => "spawned-session"),
  publishProvider: vi.fn(async () => ({
    _tag: "Success",
    value: { ok: true, data: { work: null } },
  })),
  guestRef: vi.fn((_environmentId: unknown, id: string) => ({ threadId: id })),
  sendInitial: vi.fn(async () => ({ delivery: "user_turn_observed", sendAttempted: true })),
  recordSpawn: vi.fn(),
  readSpawn: vi.fn(() => [] as Array<{ sessionId: string; requestId: string }>),
  browserSessions: [] as Array<{
    id: string;
    title: string;
    parentSessionId?: string;
    hidden?: boolean;
  }>,
  runControl: vi.fn(),
  inspect: vi.fn(),
  mount: vi.fn(),
  releaseMount: vi.fn(),
  savedUrl: null as string | null,
  hydrated: true,
  navigate: vi.fn(),
  createProject: vi.fn(),
  openThread: vi.fn(),
  projects: [] as Array<Record<string, unknown>>,
  threads: [] as Array<Record<string, unknown>>,
  createNativeThread: vi.fn(async (_args: { input: Record<string, unknown> }) => ({
    _tag: "Success",
  })),
  startNativeTurn: vi.fn(async (): Promise<unknown> => ({ _tag: "Success" })),
  waitForThreadShell: vi.fn(async () => true),
  nativeProjection: vi.fn(async (): Promise<unknown> => ({
    _tag: "Success",
    value: { messages: [] as Array<{ id: string; role: string }> },
  })),
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: vi.fn((error) => error),
}));
vi.mock("../../hooks/useLocalStorage", () => ({
  getLocalStorageItem: vi.fn(() => mocks.savedUrl),
  setLocalStorageItem: vi.fn(),
}));
vi.mock("../../chatGPTSessionPersistedStore", () => ({
  getChatGPTSessionPersistedStore: () => ({ persist: { hasHydrated: () => mocks.hydrated } }),
}));
vi.mock("../../chatGPTSessionControl", () => ({
  runChatGPTSessionControl: mocks.runControl,
  inspectBrowserSession: mocks.inspect,
}));
vi.mock("../../chatGPTDeliveryMountRequest", () => ({
  requestChatGPTDeliveryMount: mocks.mount,
  releaseChatGPTDeliveryMount: mocks.releaseMount,
}));
vi.mock("../../chatGPTSessionGrouping", () => ({
  applyConfirmedChatGPTSessionMetadata: vi.fn((sessions) => sessions),
  matchRegisteredProject: vi.fn(() => null),
}));
vi.mock("../../previewStateStore", () => ({
  beginPreviewSessionClose: vi.fn(),
  cancelPreviewSessionClose: vi.fn(),
  clearThreadPreviewState: vi.fn(),
  readThreadPreviewState: vi.fn(() => ({ snapshot: null, serverEpoch: null })),
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
vi.mock("../../state/agentProvider", () => ({ agentProviderCall: "agent-provider" }));
vi.mock("../../agentProviderBrowser", () => ({ executeAgentProviderBrowserWork: vi.fn() }));
vi.mock("../../chatGPTBrowserAutomation", () => ({
  sendInitialChatGPTPrompt: mocks.sendInitial,
}));
vi.mock("../../chatGPTSpawnReceipts", () => ({
  recordChatGPTSpawnCreated: mocks.recordSpawn,
  readChatGPTSpawnReceipts: mocks.readSpawn,
}));
vi.mock("../../chatGPTBrowserSessions", () => ({
  useChatGPTBrowserSessions: () => ({
    createSession: mocks.createSession,
    setSessionCompletion: vi.fn(),
  }),
  chatGPTBrowserThreadRef: mocks.guestRef,
  chatGPTBrowserLastUrlKey: (_environmentId: unknown, id: string) => "last-url:" + id,
  readChatGPTBrowserSessions: () => mocks.browserSessions,
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
vi.mock("../../lib/utils", () => ({
  newProjectId: vi.fn(() => "c5b2d999-7c69-4709-93c9-735d76b463c7"),
  randomUUID: vi.fn(() => "6b922542-cd54-4dcf-8e45-67c6e97bc69b"),
}));
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
      settings: {
        providerInstances: { opencode: { driver: "opencode", enabled: true } },
        projectSettingsOverrides: {},
      },
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          status: "ready",
          availability: "available",
          models: [{ slug: "gpt-5-codex" }],
        },
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: true,
          installed: true,
          status: "ready",
          availability: "available",
          models: [{ slug: "claude-sonnet-4-5" }],
        },
        {
          instanceId: "opencode",
          driver: "opencode",
          enabled: true,
          installed: true,
          status: "ready",
          availability: "available",
          models: [{ slug: "opencode/deepseek-v4.1-flash-free" }],
        },
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
  useAtomCommand: (name: string) =>
    name === "agent-provider" ? mocks.publishProvider : mocks.createProject,
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
    vi.stubGlobal("window", {
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout,
      crypto: globalThis.crypto,
    });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.createSession.mockReset();
    mocks.createSession.mockReturnValue("spawned-session");
    mocks.publishProvider.mockClear();
    mocks.sendInitial.mockReset();
    mocks.sendInitial.mockResolvedValue({ delivery: "user_turn_observed", sendAttempted: true });
    mocks.recordSpawn.mockClear();
    mocks.readSpawn.mockReset();
    mocks.readSpawn.mockReturnValue([]);
    mocks.runControl.mockReset();
    mocks.inspect.mockReset();
    mocks.mount.mockReset();
    mocks.releaseMount.mockReset();
    mocks.savedUrl = null;
    mocks.hydrated = true;
    mocks.navigate.mockClear();
    mocks.createNativeThread.mockClear();
    mocks.startNativeTurn.mockClear();
    mocks.waitForThreadShell.mockClear();
    mocks.nativeProjection.mockClear();
    mocks.nativeProjection.mockResolvedValue({ _tag: "Success", value: { messages: [] } });
    mocks.projects = [];
    mocks.threads = [];
    mocks.browserSessions = [];
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

  it("refuses missing T3 recipients without creating, mounting or sending, regardless of ID shape or guard", async () => {
    const missing = "8844dff8-f152-4f3c-8d4f-f0d6c6997c9a";
    const conversation = "6ada88be-7e48-83eb-a735-75dbd1161d46";
    await act(async () => {
      renderer = create(<DesktopAppActivationCoordinator />);
    });
    for (const action of ["read", "send", "reconcile_send"] as const) {
      for (const sessionId of [missing, conversation]) {
        await act(async () =>
          onRequest?.({
            version: 1,
            type: "chatgpt.sessions",
            action,
            sessionId,
            requestId: `${action}-${sessionId}`,
            expectedConversationId: sessionId,
            ...(action !== "read" ? { message: "Should not be sent" } : {}),
          }),
        );
        expect(complete.mock.lastCall?.[0]).toMatchObject({
          ok: false,
          message: "T3 browser session is missing; original recipient retained, no message sent.",
        });
      }
    }
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.mount).not.toHaveBeenCalled();
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.runControl).not.toHaveBeenCalled();
  });

  it("refuses unhydrated or hidden recipients before any delivery side effects", async () => {
    const id = "b5fc0249-28e7-48c6-9591-6761b3fa3748";
    mocks.browserSessions = [{ id, title: "Hidden", hidden: true }];
    await act(async () => {
      renderer = create(<DesktopAppActivationCoordinator />);
    });
    await act(async () =>
      onRequest?.({
        version: 1,
        type: "chatgpt.sessions",
        action: "send",
        requestId: "hidden-send",
        sessionId: id,
        message: "Never typed",
      }),
    );
    expect(complete.mock.lastCall?.[0]).toMatchObject({
      ok: false,
      message: expect.stringContaining("T3 browser session is missing"),
    });
    mocks.hydrated = false;
    mocks.browserSessions = [{ id, title: "Available" }];
    await act(async () =>
      onRequest?.({
        version: 1,
        type: "chatgpt.sessions",
        action: "read",
        requestId: "unhydrated-read",
        sessionId: id,
      }),
    );
    expect(complete.mock.lastCall?.[0]).toMatchObject({
      ok: false,
      message: expect.stringContaining("not hydrated"),
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.mount).not.toHaveBeenCalled();
    expect(mocks.runControl).not.toHaveBeenCalled();
  });

  it("resolves deliberate conversation opening without causing any message send", async () => {
    const id = "b5fc0249-28e7-48c6-9591-6761b3fa3748";
    const conversation = "6ada88be-7e48-83eb-a735-75dbd1161d46";
    mocks.browserSessions = [{ id, title: "Existing" }];
    mocks.savedUrl = `https://chatgpt.com/c/${conversation}`;
    await act(async () => {
      renderer = create(<DesktopAppActivationCoordinator />);
    });
    await act(async () =>
      onRequest?.({
        version: 1,
        type: "chatgpt.sessions",
        action: "open",
        requestId: "open-existing",
        sessionId: conversation,
      }),
    );
    expect(complete.mock.lastCall?.[0]).toMatchObject({
      ok: true,
      data: { action: "open", sessionId: id, conversationId: conversation, created: false },
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
    mocks.savedUrl = null;
    await act(async () =>
      onRequest?.({
        version: 1,
        type: "chatgpt.sessions",
        action: "open",
        requestId: "open-new",
        sessionId: conversation,
      }),
    );
    expect(mocks.createSession).toHaveBeenCalledExactlyOnceWith("Conversation 6ada88be", {
      initialConversationUrl: `https://chatgpt.com/c/${conversation}`,
    });
    expect(complete.mock.lastCall?.[0]).toMatchObject({
      ok: true,
      data: { action: "open", sessionId: "spawned-session", created: true },
    });
    expect(mocks.mount).not.toHaveBeenCalled();
    expect(mocks.runControl).not.toHaveBeenCalled();
  });

  it("wakes an unloaded recipient for guarded read preflight before a direct send", async () => {
    const sessionId = "b5fc0249-28e7-48c6-9591-6761b3fa3748";
    const conversationId = "6ad81f45-bd10-83ed-8128-6a3d584c876c";
    mocks.browserSessions = [{ id: sessionId, title: "Unloaded manager" }];
    mocks.savedUrl = "https://chatgpt.com/c/" + conversationId;
    mocks.inspect.mockResolvedValue({
      status: "done_or_idle",
      activity: "idle",
      observedGuestUrl: mocks.savedUrl,
    });
    mocks.runControl.mockResolvedValue({
      sessionId,
      conversationGuardValidated: true,
      verifiedConversationId: conversationId,
      session: { status: "done_or_idle", activity: "idle", observedGuestUrl: mocks.savedUrl },
    });
    await act(async () => {
      renderer = create(<DesktopAppActivationCoordinator />);
    });
    await act(async () =>
      onRequest?.({
        version: 1,
        requestId: "unloaded-read",
        type: "chatgpt.sessions",
        action: "read",
        sessionId,
        wakeForSend: true,
        count: 1,
      }),
    );
    expect(mocks.mount, JSON.stringify(complete.mock.calls)).toHaveBeenCalledWith(
      EnvironmentId.make("local"),
      sessionId,
    );
    expect(mocks.runControl).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "read",
        sessionId,
        expectedConversationId: conversationId,
      }),
    );
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "unloaded-read",
        ok: true,
      }),
    );
  });

  it("wakes direct T3 sends without a caller-supplied conversation guard", async () => {
    const sessionId = "b5fc0249-28e7-48c6-9591-6761b3fa3748";
    const conversationId = "6ad81f45-bd10-83ed-8128-6a3d584c876c";
    mocks.browserSessions = [{ id: sessionId, title: "Unloaded manager" }];
    mocks.savedUrl = "https://chatgpt.com/c/" + conversationId;
    mocks.inspect.mockResolvedValue({
      status: "done_or_idle",
      activity: "idle",
      observedGuestUrl: mocks.savedUrl,
    });
    mocks.runControl.mockImplementation(async (input) =>
      input.action === "send"
        ? {
            sessionId,
            messageSent: true,
            delivery: "user_turn_observed",
            verifiedConversationId: conversationId,
            conversationGuardValidated: true,
          }
        : {
            sessionId,
            session: { status: "done_or_idle", activity: "idle" },
            verifiedConversationId: conversationId,
            conversationGuardValidated: true,
          },
    );
    await act(async () => {
      renderer = create(<DesktopAppActivationCoordinator />);
    });
    await act(async () =>
      onRequest?.({
        version: 1,
        requestId: "unloaded-direct-send",
        type: "chatgpt.sessions",
        action: "send",
        sessionId,
        message: "Delivery test only",
      }),
    );
    expect(mocks.mount, JSON.stringify(complete.mock.calls)).toHaveBeenCalledWith(
      EnvironmentId.make("local"),
      sessionId,
    );
    expect(mocks.runControl).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "send",
        sessionId,
        expectedConversationId: conversationId,
        message: "Delivery test only",
      }),
    );
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "unloaded-direct-send",
        ok: true,
      }),
    );
  });

  it("dispatches to a working exact recipient and releases the mount without navigating", async () => {
    const sessionId = "b5fc0249-28e7-48c6-9591-6761b3fa3748";
    const conversationId = "6ad81f45-bd10-83ed-8128-6a3d584c876c";
    mocks.browserSessions = [{ id: sessionId, title: "Background" }];
    mocks.savedUrl = `https://chatgpt.com/c/${conversationId}`;
    mocks.inspect.mockResolvedValue({ status: "working", observedGuestUrl: mocks.savedUrl });
    mocks.runControl.mockResolvedValue({ messageSent: true });
    await act(async () => {
      renderer = create(<DesktopAppActivationCoordinator />);
    });
    await act(async () =>
      onRequest?.({
        version: 1,
        requestId: "working-send",
        type: "chatgpt.sessions",
        action: "send",
        sessionId,
        expectedConversationId: conversationId,
        message: "Continue",
      }),
    );
    expect(mocks.runControl).toHaveBeenCalledTimes(1);
    expect(mocks.runControl).toHaveBeenCalledWith(
      expect.objectContaining({ action: "send", sessionId }),
    );
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.releaseMount).toHaveBeenCalledWith(EnvironmentId.make("local"), sessionId);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "working-send", ok: true }),
    );
  });

  it("drops an obsolete conversation immediately when saved and observed replacement agree", async () => {
    const sessionId = "b5fc0249-28e7-48c6-9591-6761b3fa3748";
    const oldId = "6ad81f45-bd10-83ed-8128-6a3d584c876c";
    const newId = "6ae0de06-71b8-83ed-b9bd-18484203b7c8";
    mocks.browserSessions = [{ id: sessionId, title: "Rebooted" }];
    mocks.savedUrl = `https://chatgpt.com/c/${newId}`;
    mocks.inspect.mockResolvedValue({ status: "working", observedGuestUrl: mocks.savedUrl });
    await act(async () => {
      renderer = create(<DesktopAppActivationCoordinator />);
    });
    await act(async () =>
      onRequest?.({
        version: 1,
        requestId: "obsolete",
        type: "chatgpt.sessions",
        action: "send",
        sessionId,
        expectedConversationId: oldId,
        message: "Old message",
      }),
    );
    expect(mocks.inspect).toHaveBeenCalledTimes(1);
    expect(mocks.runControl).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "obsolete",
        ok: false,
        message: "T3 browser session is missing; original recipient retained, no message sent.",
      }),
    );
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

    expect(mocks.createSession).toHaveBeenCalledExactlyOnceWith("Agent B", {
      spawnRequestId: "background-spawn",
    });
    expect(mocks.sendInitial).toHaveBeenCalledExactlyOnceWith({
      environmentId: EnvironmentId.make("local"),
      sessionId: "spawned-session",
      requestId: "background-spawn",
      prompt: "Please review the code",
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.recordSpawn).toHaveBeenCalledExactlyOnceWith(
      EnvironmentId.make("local"),
      request.requestId,
      "spawned-session",
    );
    expect(complete).toHaveBeenCalledWith({
      version: 1,
      requestId: request.requestId,
      ok: true,
      sessionId: "spawned-session",
      parentSessionId: null,
      messageSent: true,
    });
  });

  it.each([
    { delivery: "unknown", sendAttempted: true, reason: "detached after Enter" },
    { delivery: "not_sent", sendAttempted: false, reason: "composer missing" },
  ])("returns a durable created UUID with prompt delivery $delivery", async (promptReceipt) => {
    mocks.sendInitial.mockResolvedValue(promptReceipt);
    await act(async () => {
      renderer = create(<DesktopAppActivationCoordinator />);
    });
    await act(async () =>
      onRequest?.({
        version: 1,
        requestId: "ambiguous-initial-send",
        type: "chatgpt.spawn",
        title: "Worker",
        prompt: "Do the job",
      }),
    );
    expect(complete).toHaveBeenCalledWith({
      version: 1,
      requestId: "ambiguous-initial-send",
      ok: true,
      data: {
        action: "spawn",
        created: true,
        sessionId: "spawned-session",
        parentSessionId: null,
        messageSent: false,
        promptDelivery: promptReceipt.delivery,
        sendAttempted: promptReceipt.sendAttempted,
        reason: promptReceipt.reason,
      },
    });
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.sendInitial).toHaveBeenCalledTimes(1);
  });

  it("keeps simultaneous backend spawn reservations distinct and never sends them through a manual session", async () => {
    mocks.createSession
      .mockReturnValueOnce("exclusive-worker-a")
      .mockReturnValueOnce("exclusive-worker-b");
    await act(async () => {
      renderer = create(<DesktopAppActivationCoordinator />);
    });
    await act(async () => {
      onRequest?.({
        version: 1,
        requestId: "spawn-a",
        type: "chatgpt.spawn",
        title: "A",
        prompt: "job A",
      });
      onRequest?.({
        version: 1,
        requestId: "spawn-b",
        type: "chatgpt.spawn",
        title: "B",
        prompt: "job B",
      });
    });
    expect(mocks.createSession).toHaveBeenNthCalledWith(1, "A", { spawnRequestId: "spawn-a" });
    expect(mocks.createSession).toHaveBeenNthCalledWith(2, "B", { spawnRequestId: "spawn-b" });
    expect(mocks.sendInitial).toHaveBeenNthCalledWith(1, {
      environmentId: EnvironmentId.make("local"),
      sessionId: "exclusive-worker-a",
      requestId: "spawn-a",
      prompt: "job A",
    });
    expect(mocks.sendInitial).toHaveBeenNthCalledWith(2, {
      environmentId: EnvironmentId.make("local"),
      sessionId: "exclusive-worker-b",
      requestId: "spawn-b",
      prompt: "job B",
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("makes a lost spawn response recoverable by requestId via read-only session list", async () => {
    mocks.readSpawn.mockReturnValue([{ requestId: "lost-response", sessionId: "spawned-session" }]);
    mocks.runControl.mockResolvedValue({
      which: "all",
      sessions: [{ id: "spawned-session", title: "Worker" }],
      total: 1,
    });
    await act(async () => {
      renderer = create(<DesktopAppActivationCoordinator />);
    });
    await act(async () =>
      onRequest?.({
        version: 1,
        requestId: "lookup",
        type: "chatgpt.sessions",
        action: "list",
        which: "all",
        includeHidden: true,
      }),
    );
    expect(complete).toHaveBeenCalledWith({
      version: 1,
      requestId: "lookup",
      ok: true,
      data: {
        which: "all",
        total: 1,
        sessions: [{ id: "spawned-session", title: "Worker", spawnRequestId: "lost-response" }],
      },
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.sendInitial).not.toHaveBeenCalled();
  });

  it("persists an exact explicit parent in the spawn metadata and receipt", async () => {
    const parentId = "385e7c81-23f5-48f3-89de-c1f9c63893d2";
    mocks.browserSessions = [
      { id: parentId, title: "Manager" },
      { id: "active-other", title: "Active unrelated" },
    ];
    await act(async () => {
      renderer = create(<DesktopAppActivationCoordinator />);
    });
    await act(async () =>
      onRequest?.({
        version: 1,
        requestId: "explicit-parent",
        type: "chatgpt.spawn",
        title: "Worker",
        prompt: "Do bounded work",
        parentSessionId: parentId,
      }),
    );
    expect(mocks.createSession).toHaveBeenCalledExactlyOnceWith("Worker", {
      spawnRequestId: "explicit-parent",
      parentSessionId: parentId,
    });
    expect(complete).toHaveBeenCalledWith({
      version: 1,
      requestId: "explicit-parent",
      ok: true,
      sessionId: "spawned-session",
      messageSent: true,
      parentSessionId: parentId,
    });
  });

  it("rejects unknown or hidden explicit parents before session creation or prompt delivery", async () => {
    mocks.browserSessions = [{ id: "known-hidden", title: "Hidden manager", hidden: true }];
    await act(async () => {
      renderer = create(<DesktopAppActivationCoordinator />);
    });
    for (const parentSessionId of ["unknown", "known-hidden"]) {
      await act(async () =>
        onRequest?.({
          version: 1,
          requestId: parentSessionId,
          type: "chatgpt.spawn",
          title: "Worker",
          prompt: "Do bounded work",
          parentSessionId,
        }),
      );
      expect(complete.mock.lastCall?.[0]).toMatchObject({
        requestId: parentSessionId,
        ok: false,
        code: "invalid-request",
      });
    }
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.sendInitial).not.toHaveBeenCalled();
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
    version: 1 as const,
    requestId: "native-create",
    type: "t3.threads" as const,
    action: "create" as const,
    environmentId: "local",
    workspaceRoot,
    runtime: "codex" as const,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
    runtimeMode: "approval-required" as const,
    title: "Managed worker",
    clientRequestId: threadId,
  };
  beforeEach(async () => {
    vi.stubGlobal("window", {
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout,
      crypto: globalThis.crypto,
    });
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
      value: {
        appActivation: {
          onRequest: (callback: (request: unknown) => void) => {
            onRequest = callback;
            return () => {
              onRequest = null;
            };
          },
          complete,
          setReady: vi.fn(async () => {}),
        },
      },
    });
    await act(async () => {
      renderer = create(<DesktopAppActivationCoordinator />);
    });
  });
  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount());
    renderer = undefined;
    Reflect.deleteProperty(window, "desktopBridge");
    vi.unstubAllGlobals();
  });
  const deliver = async (request: unknown) => {
    await act(async () => {
      onRequest?.(request);
    });
    return complete.mock.lastCall?.[0] as {
      ok: boolean;
      code?: string;
      data?: Record<string, unknown>;
    };
  };
  it("persists an exact provider thread, never calls UI open-workspace draft or route navigation", async () => {
    mocks.createNativeThread.mockImplementation(
      async ({ input }: { input: Record<string, unknown> }) => {
        mocks.threads = [
          {
            id: input.threadId,
            environmentId: "local",
            projectId,
            providerInstanceId: "codex",
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: "default",
            deletedAt: null,
          },
        ];
        return { _tag: "Success" };
      },
    );
    const response = await deliver(createRequest);
    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      action: "create",
      environmentId: "local",
      projectId,
      threadId,
      providerInstanceId: "codex",
      created: true,
      messageSent: false,
      workspaceRoot,
    });
    expect(mocks.createNativeThread).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: expect.objectContaining({
        threadId,
        projectId,
        title: createRequest.title,
        modelSelection: createRequest.modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      }),
    });
    expect(mocks.openThread).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.startNativeTurn).not.toHaveBeenCalled();
  });
  it("creates OpenCode from the explicit ready catalog with exact Altraea root and durable first-message receipt", async () => {
    const altraeaRoot = "D:\\SSDProjects\\SettlingAltraea";
    mocks.projects = [
      {
        id: projectId,
        environmentId: "local",
        title: "SettlingAltraea",
        workspaceRoot: altraeaRoot,
      },
    ];
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
    mocks.createNativeThread.mockImplementation(
      async ({ input }: { input: Record<string, unknown> }) => {
        mocks.threads = [
          {
            id: input.threadId,
            environmentId: "local",
            projectId,
            providerInstanceId: "opencode",
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: "default",
            deletedAt: null,
          },
        ];
        return { _tag: "Success" };
      },
    );
    mocks.nativeProjection.mockResolvedValue({
      _tag: "Success",
      value: { messages: [{ id: initialMessageId, role: "user" }] },
    });
    const receipt = await deliver(openCodeRequest);
    expect(receipt.ok).toBe(true);
    expect(receipt.data).toMatchObject({
      action: "create",
      environmentId: "local",
      projectId,
      threadId,
      workspaceRoot: altraeaRoot,
      runtime: "opencode",
      providerInstanceId: "opencode",
      modelSelection: { instanceId: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
      created: true,
      messageSent: true,
      messageId: initialMessageId,
    });
    expect(mocks.createNativeThread).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: expect.objectContaining({
        threadId,
        projectId,
        modelSelection: openCodeRequest.modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      }),
    });
    expect(mocks.startNativeTurn).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: expect.objectContaining({
        threadId,
        modelSelection: openCodeRequest.modelSelection,
        dispatchMode: "queue",
        message: expect.objectContaining({
          messageId: initialMessageId,
          text: openCodeRequest.firstMessage,
          role: "user",
        }),
      }),
    });
    expect(mocks.openThread).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("rejects cross-driver OpenCode requests and noncatalog models without spawning or composer fallback", async () => {
    for (const override of [
      {
        runtime: "claude",
        providerInstanceId: "opencode",
        modelSelection: { instanceId: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
      },
      {
        runtime: "opencode",
        providerInstanceId: "codex",
        modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
      },
      {
        runtime: "opencode",
        providerInstanceId: "opencode",
        modelSelection: { instanceId: "opencode", model: "unknown/deepseek" },
      },
      {
        runtime: "cursor",
        providerInstanceId: "opencode",
        modelSelection: { instanceId: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
      },
    ]) {
      const receipt = await deliver({
        ...createRequest,
        ...override,
        requestId: "invalid-driver-model-" + override.runtime,
      });
      expect(receipt.ok).toBe(false);
    }
    expect(mocks.createNativeThread).not.toHaveBeenCalled();
    expect(mocks.startNativeTurn).not.toHaveBeenCalled();
    expect(mocks.openThread).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("fails closed on a requested model/provider not in the ready environment catalog", async () => {
    const response = await deliver({
      ...createRequest,
      modelSelection: { instanceId: "codex", model: "not-listed" },
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
    mocks.createNativeThread.mockImplementation(
      async ({ input }: { input: Record<string, unknown> }) => {
        mocks.threads = [
          {
            id: input.threadId,
            environmentId: "local",
            projectId,
            providerInstanceId: "codex",
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: "default",
            deletedAt: null,
          },
        ];
        return { _tag: "Success" };
      },
    );
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
    version: 1 as const,
    requestId: "native-read-send-" + action,
    type: "t3.threads" as const,
    action,
    environmentId: "local",
    ...(id ? { threadId: id } : {}),
    ...(action === "read" ? { count: 2 } : {}),
    ...(action === "send"
      ? {
          message: "Continue existing worker",
          clientRequestId: "6ad41909-57c8-43ed-a20f-742a43cd06a6",
        }
      : {}),
  });
  const prepareExistingThread = (id: string) => {
    mocks.threads = [
      {
        id,
        environmentId: "local",
        projectId,
        title: "NOT A ROUTING KEY",
        providerInstanceId: "codex",
        runtimeMode: "approval-required",
        interactionMode: "default",
        deletedAt: null,
        modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
      },
    ];
  };

  it("advertises exact running-environment opaque read AND send capability on existing list only", async () => {
    prepareExistingThread(opaqueIds[0]!);
    const result = await deliver(nativeRequest("list"));
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      environmentId: "local",
      nativeThreadMessaging: {
        version: 1,
        environmentId: "local",
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

  it.each(opaqueIds)(
    "reads the exact opaque durable recipient %s without decoding or title fallback",
    async (id) => {
      prepareExistingThread(id);
      mocks.nativeProjection.mockResolvedValue({
        _tag: "Success",
        value: { visibleTurnItems: [{ position: 1, item: { id: "user-message", role: "user" } }] },
      });
      const result = await deliver(nativeRequest("read", id));
      expect(result.ok).toBe(true);
      expect(result.data).toEqual({
        environmentId: "local",
        threadId: id,
        messages: [{ position: 1, item: { id: "user-message", role: "user" } }],
      });
      expect(mocks.nativeProjection).toHaveBeenCalledExactlyOnceWith({
        environmentId: "local",
        input: { threadId: id },
      });
      expect(mocks.startNativeTurn).not.toHaveBeenCalled();
      expect(mocks.createNativeThread).not.toHaveBeenCalled();
    },
  );

  it.each(opaqueIds)(
    "sends only to the exact opaque native recipient %s and echoes client message ID",
    async (id) => {
      prepareExistingThread(id);
      const result = await deliver(nativeRequest("send", id));
      expect(result.ok).toBe(true);
      expect(result.data).toEqual({
        environmentId: "local",
        threadId: id,
        messageId: "6ad41909-57c8-43ed-a20f-742a43cd06a6",
        messageSent: true,
      });
      expect(mocks.startNativeTurn).toHaveBeenCalledExactlyOnceWith({
        environmentId: "local",
        input: expect.objectContaining({
          threadId: id,
          message: {
            messageId: "6ad41909-57c8-43ed-a20f-742a43cd06a6",
            role: "user",
            text: "Continue existing worker",
            attachments: [],
          },
          dispatchMode: "queue",
        }),
      });
      expect(mocks.createNativeThread).not.toHaveBeenCalled();
    },
  );

  it("rejects wrong recipient/environment and failed queue without a false send receipt", async () => {
    prepareExistingThread(opaqueIds[0]!);
    for (const request of [
      { ...nativeRequest("read", opaqueIds[1]), requestId: "wrong-recipient" },
      { ...nativeRequest("send", opaqueIds[1]), requestId: "wrong-recipient-send" },
      {
        ...nativeRequest("send", opaqueIds[0]),
        requestId: "wrong-env",
        environmentId: "different-env",
      },
    ]) {
      const rejected = await deliver(request);
      expect(rejected.ok).toBe(false);
      expect(mocks.startNativeTurn).not.toHaveBeenCalled();
      expect(mocks.nativeProjection).not.toHaveBeenCalled();
    }
    mocks.startNativeTurn.mockResolvedValue({ _tag: "Failure", error: new Error("held") });
    const failed = await deliver({
      ...nativeRequest("send", opaqueIds[0]),
      requestId: "failed-send",
    });
    expect(failed.ok).toBe(false);
    expect(failed.data?.messageSent).not.toBe(true);
    expect(mocks.createNativeThread).not.toHaveBeenCalled();
  });
});
