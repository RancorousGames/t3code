import type { DesktopOpenRigAgent, DesktopOpenRigExecutionProfile, DesktopOpenRigManagedSession, DesktopOpenRigSeatSessions, DesktopOpenRigManagedBrowserLifecycleResult } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (children: unknown) => children,
}));
vi.mock("../ui/sidebar", () => ({
  SidebarMenu: ({ children }: { children: unknown }) => children,
  SidebarMenuItem: ({ children }: { children: unknown }) => children,
}));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => <button {...props} />,
}));
vi.mock("../ui/textarea", () => ({
  Textarea: (props: Record<string, unknown>) => <textarea {...props} />,
}));

import { OpenRigAgentsSidebarEntry } from "./OpenRigAgentsSidebarEntry";

const agent: DesktopOpenRigAgent = {
  id: "seat/worker", name: "Builder", status: "idle", role: "worker", task: "Phase 1",
  bound: false, bindingKind: null, sessionId: null, sessionTitle: null,
};
function session(id: string, primary: boolean): DesktopOpenRigManagedSession {
  return {
    id, seatId: agent.id, operationId: `00000000-0000-4000-8000-${id === "session-a" ? "000000000001" : "000000000002"}`,
    mode: "native", status: "active", primary,
    target: { kind: "t3-thread", environmentId: "local", threadId: id },
    targetKey: "native:" + id, projectId: "p", environmentId: "local", threadId: id,
    conversationId: null, attachedTabUuid: null, parentSeatId: null, parentManagedSessionId: null,
    provenance: "managed", intent: { title: id === "session-a" ? "First conversation" : "Second conversation" },
    createdAt: "2026-10-19T09:00:00Z", updatedAt: "2026-10-19T09:01:00Z",
    error: null, observed: { available: true, status: "idle" }, modelCompletionVerified: false,
  };
}
function ledger(sessions: DesktopOpenRigManagedSession[] = [session("session-a", true), session("session-b", false)]): DesktopOpenRigSeatSessions {
  return {
    version: 1, seatId: agent.id, primarySessionId: sessions.find((s) => s.primary)?.id ?? null,
    sessions, legacyBinding: null, legacyAutoImported: false, pendingRecoveryCount: 0,
    launchPolicy: { explicitOperationIdRequired: true, duplicateOperationRetrySafe: false,
      automaticUnknownRetry: false, implicitAdoption: false },
  };
}

function savedProfile(): NonNullable<DesktopOpenRigExecutionProfile["profile"]> {
  return {
    seatId: agent.id, workspaceRoot: "D:\\ExistingProject", environmentId: "desktop-env-1",
    runtime: "codex", providerInstanceId: "operatorChosenCodex", model: "gpt-6",
    runtimeMode: "approval-required", provenance: "operator-explicit-t3-provider-catalog",
    createdAt: "2026-10-19T10:00:00Z", updatedAt: "2026-10-19T10:00:00Z",
  };
}
function executionProfile(ready = true, configured = true): DesktopOpenRigExecutionProfile {
  const profile = configured ? savedProfile() : null;
  const rigSpec = {
    runtime: "codex", cwd: null, workspace: null, model: "do-not-infer-rig-model",
    providerInstanceId: null, runtimeMode: null, environmentId: null,
  };
  return {
    version: 1, seatId: agent.id, profile, rigSpec,
    effective: profile ?? rigSpec,
    nativeLaunchReady: ready,
    missing: configured ? [] : ["workspaceRoot", "runtimeMode", "providerInstanceIdOrUniqueCatalogMatch"],
    legacySessionsAutoAdopted: false, requiresOperatorApproval: !configured,
    providerSelectionAuthority: "T3 exact live provider catalog", overwriteRigSpec: false,
  };
}
const list = vi.fn<() => Promise<DesktopOpenRigAgent[]>>();
const readProfile = vi.fn(async (_seatId: string): Promise<DesktopOpenRigExecutionProfile> => executionProfile());
const configureProfile = vi.fn(async (_input: unknown): Promise<DesktopOpenRigExecutionProfile> => executionProfile());
const listManaged = vi.fn(async (_seatId: string): Promise<DesktopOpenRigSeatSessions> => ledger());
const start = vi.fn(async (_input: unknown): Promise<DesktopOpenRigSeatSessions> => ledger());
const primary = vi.fn(async (_input: unknown): Promise<DesktopOpenRigSeatSessions> =>
  ledger([session("session-a", false), session("session-b", true)]));
const send = vi.fn(async (_input: unknown) => {});
const listSessions = vi.fn(async () => [
  { id: "old", title: "Unmanaged", kind: "t3-thread",
    target: { kind: "t3-thread", environmentId: "local", threadId: "thread-old" }, project: null, status: "idle", provider: "codex" },
  { id: "volatile", title: "Temporary tab", kind: "legacy-browser",
    target: { kind: "legacy-browser", sessionId: "browser-id" }, project: null, status: "idle", provider: null },
]);
const adopt = vi.fn(async (_input: unknown): Promise<DesktopOpenRigSeatSessions> => ledger());
const detach = vi.fn(async (_input: unknown): Promise<DesktopOpenRigSeatSessions> => ledger([]));
const reconcile = vi.fn(async (_input: unknown): Promise<DesktopOpenRigSeatSessions> => ledger());
const lifecycle = vi.fn(async (_input: unknown): Promise<DesktopOpenRigManagedBrowserLifecycleResult> => {
  throw new Error("Synthetic lifecycle receipt not configured");
});
let renderer: ReactTestRenderer | undefined;

async function mount() {
  await act(async () => { renderer = create(<OpenRigAgentsSidebarEntry />); });
  await act(async () => {
    renderer!.root.findByProps({ "aria-label": "Open workspace for OpenRig agent Builder" }).props.onClick();
  });
}
function click(label: string) {
  renderer!.root.findAllByType("button").find((button) => button.props.children === label)?.props.onClick();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  list.mockReset().mockResolvedValue([agent]);
  listManaged.mockReset().mockResolvedValue(ledger());
  readProfile.mockReset().mockResolvedValue(executionProfile());
  configureProfile.mockReset().mockResolvedValue(executionProfile());
  start.mockReset().mockResolvedValue(ledger());
  primary.mockReset().mockResolvedValue(ledger([session("session-a", false), session("session-b", true)]));
  send.mockReset();
  listSessions.mockClear();
  adopt.mockReset().mockResolvedValue(ledger());
  detach.mockReset().mockResolvedValue(ledger([]));
  reconcile.mockReset().mockResolvedValue(ledger());
  lifecycle.mockReset().mockRejectedValue(new Error("Synthetic lifecycle receipt not configured"));
  vi.stubGlobal("window", {
    desktopBridge: {
      listOpenRigAgents: list, listOpenRigManagedSessions: listManaged,
      readOpenRigExecutionProfile: readProfile,
      configureOpenRigExecutionProfile: configureProfile,
      startOpenRigManagedSession: start, selectOpenRigPrimarySession: primary,
      sendOpenRigAgentMessage: send, listOpenRigSessions: listSessions,
      adoptOpenRigManagedSession: adopt, detachOpenRigManagedSession: detach,
      reconcileOpenRigChatGPTManagedSession: reconcile,
      runOpenRigManagedBrowserLifecycle: lifecycle,
    },
    setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    innerWidth: 1920, innerHeight: 1080,
    localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
  });
  vi.stubGlobal("document", {
    visibilityState: "visible", activeElement: null,
    body: { nodeType: 1 },
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
});
afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("canonical Work tab task status", () => {
  const canonicalNode = {
    id: agent.id, rigId: "rig-1", rigName: "sample", name: agent.name,
    logicalId: "builder", role: "worker", parentIds: [], childIds: [],
  };
  const task = {
    qitemId: "qitem-real", summary: "Implement signed-off task", state: "in-progress",
    sourceSession: "manager@sample", destinationSession: "builder@sample",
    handedOffFrom: "qitem-parent", handedOffTo: null,
    chainOfRecord: ["qitem-parent"], evidenceRef: "handoff-evidence",
    closureReason: null, closureTarget: null, resolution: null,
    claimedAt: "2026-10-21T13:00:00Z",
    tsCreated: "2026-10-21T12:00:00Z", tsUpdated: "2026-10-21T13:00:00Z",
    lastNudgeAttempt: null, lastNudgeResult: "accepted:t3-browser;task_not_claimed",
    lastTransition: {
      transitionId: 8, ts: "2026-10-21T13:00:00Z", state: "in-progress",
      actorSession: "builder@sample", transitionNote: null,
      closureReason: null, closureTarget: null,
    },
  };
  const good = {
    schema: "openrig-t3-agent-tasks/v1" as const,
    available: true as const,
    agent: { agentId: agent.id, rigId: "rig-1", rigName: "sample",
      canonicalSession: "builder@sample" },
    limit: 25, tasks: [task], hasMore: false,
  };
  function install(readTasks: (agentId: string) => Promise<unknown>, nodes = [canonicalNode]) {
    Object.assign(window.desktopBridge!, {
      discoverOpenRigSeats: async () => ({ source: "openrig-rigspec", seats: nodes }),
      readOpenRigAgentTasks: readTasks,
    });
  }
  async function openWork() {
    await mount();
    await act(async () => {
      renderer!.root.findByProps({ id: "openrig-workspace-tab-work" }).props.onClick();
    });
  }
  async function refreshWorkspace() {
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Refresh workspace for Builder" }).props.onClick();
    });
  }

  it("reads ONLY when Work is opened, shows loading and actual canonical ID/state/evidence", async () => {
    let resolve!: (value: typeof good) => void;
    const read = vi.fn((_id: string) => new Promise<typeof good>((done) => { resolve = done; }));
    install(read);
    await openWork();
    expect(read).toHaveBeenCalledExactlyOnceWith(agent.id);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Loading canonical queue tasks");
    await act(async () => { resolve(good); });
    const output = JSON.stringify(renderer!.toJSON());
    for (const expected of ["qitem-real", "in-progress", "Implement signed-off task",
      "manager@sample", "builder@sample", "qitem-parent", "handoff-evidence",
      "Delivery diagnostic (not completion)"]) expect(output).toContain(expected);
    expect(output).not.toContain("No queued tasks");
  });

  it("never paints unavailable or errors as a healthy empty queue; refresh is bounded to this seat", async () => {
    const read = vi.fn(async (_id: string) => ({ ...good, tasks: [] }));
    install(read);
    await openWork();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Canonical task read succeeded. No queued tasks");
    read.mockResolvedValueOnce({ ...good, available: false, tasks: [],
      error: "canonical_task_read_model_unavailable" } as never);
    await refreshWorkspace();
    let output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("Canonical queue read model is unavailable");
    expect(output).not.toContain("Canonical task read succeeded. No queued tasks");
    read.mockRejectedValueOnce(new Error("network failed"));
    await refreshWorkspace();
    output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("Task read failed");
    expect(output).not.toContain("Canonical task read succeeded. No queued tasks");
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls.every(([id]) => id === agent.id)).toBe(true);
  });

  it("renders pending, blocked and done as persisted queue states, not delivery status", async () => {
    const rows = ["pending", "blocked", "done"].map((state, index) => ({
      ...task, qitemId: `qitem-state-${index}`, state,
      lastNudgeResult: "accepted:t3-browser;task_not_claimed",
    }));
    install(vi.fn(async () => ({ ...good, tasks: rows })));
    await openWork();
    const output = JSON.stringify(renderer!.toJSON());
    for (const state of ["pending", "blocked", "done"]) {
      expect(output).toContain(`Canonical task state: ${state}`);
    }
    expect(output).toContain("Delivery diagnostic (not completion)");
    expect(output).not.toContain("Canonical task read succeeded. No queued tasks");
  });

  it("does not display a previous seat's delayed task response after a seat switch", async () => {
    const other = { ...agent, id: "node-other", name: "Other" };
    list.mockResolvedValue([agent, other]);
    const otherNode = { ...canonicalNode, id: other.id, name: other.name, logicalId: "other" };
    let release!: (value: typeof good) => void;
    const read = vi.fn((id: string) => id === agent.id
      ? new Promise<typeof good>((done) => { release = done; })
      : Promise.resolve({ ...good,
          agent: { ...good.agent, agentId: other.id, canonicalSession: "other@sample" },
          tasks: [{ ...task, qitemId: "qitem-other", state: "done", destinationSession: "other@sample" }] }));
    install(read, [canonicalNode, otherNode]);
    await openWork();
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Open workspace for OpenRig agent Other" }).props.onClick();
    });
    expect(read).toHaveBeenCalledWith(other.id);
    await act(async () => { release(good); });
    const output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("qitem-other");
    expect(output).not.toContain("qitem-real");
    expect(output).toContain("done");
  });
});


describe("managed ChatGPT lifecycle in existing Sessions tab", () => {
  const conversationId = "6ad5f3db-fadc-83eb-8eec-eed954bc6db6";
  const browserId = "t3-browser-exact";
  function chatGPT(primary = true): DesktopOpenRigManagedSession {
    return {
      ...session("session-a", primary),
      mode: "chatgpt", status: "active", primary,
      target: { kind: "chatgpt-conversation", conversationId },
      conversationId, attachedTabUuid: browserId, targetKey: "chatgpt:" + conversationId,
    };
  }
  function response(action: "suspend" | "resume" | "stop" | "recover") {
    return {
      version: 1 as const, seatId: agent.id, managedSessionId: "session-a",
      primarySessionId: action === "stop" ? null : "session-a",
      browserSessionId: browserId, conversationId, action,
      effect: {
        suspend: "t3_archived_local_browser_unmounted_no_model_completion_claim",
        resume: "t3_archive_restored_reattachment_on_render",
        recover: "safe_saved_conversation_navigation_requested_not_verified_loaded",
        stop: "local_t3_session_closed_not_chatgpt_cloud_deleted",
      }[action] as DesktopOpenRigManagedBrowserLifecycleResult["effect"],
      providerAcknowledged: true as const, modelCompletionVerified: false as const,
      managedStatus: (action === "stop" ? "detached" : "active") as "active" | "detached",
      managedPrimaryUnchanged: action !== "stop",
      source: "t3-existing-desktop-session-control" as const,
      receipt: { sessionId: browserId, acknowledged: true, action },
    };
  }
  async function openSession() {
    await mount();
    await act(async () => {
      renderer!.root.findByProps({ id: "openrig-workspace-tab-sessions" }).props.onClick();
    });
  }
  it("renders explicit lifecycle controls only for the exact owned active ChatGPT primary; not native, pending, uncertain or non-primary", async () => {
    listManaged.mockResolvedValue(ledger([chatGPT(), session("session-b", false)]));
    await openSession();
    const output = JSON.stringify(renderer!.toJSON());
    for (const item of ["Archive idle browser", "Restore archived browser", "Recover blank homepage",
      "Close local T3 record", "Detach ownership"]) expect(output).toContain(item);
    expect(output).not.toContain("Confirm permanent local close");
    expect(output).not.toContain("Reparent");
    expect(lifecycle).not.toHaveBeenCalled();
    for (const candidate of [
      session("session-a", true),
      { ...chatGPT(), status: "pending" as const },
      { ...chatGPT(), status: "indeterminate" as const },
      { ...chatGPT(), attachedTabUuid: null },
      { ...chatGPT(), primary: false },
    ]) {
      await act(async () => { listManaged.mockResolvedValue(ledger([candidate])); click("Refresh sessions"); });
      expect(JSON.stringify(renderer!.toJSON())).not.toContain("Archive idle browser");
    }
    await act(async () => {
      listManaged.mockResolvedValue(ledger([{ ...chatGPT(), mode: "adopt" }]));
      click("Refresh sessions");
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Archive idle browser");
    expect(lifecycle).not.toHaveBeenCalled();
  });
  it.each(["suspend", "resume", "recover"] as const)(
    "renders true server receipt and action-specific safety for %s",
    async (action) => {
      const label = {
        suspend: "Archive idle browser", resume: "Restore archived browser",
        recover: "Recover blank homepage",
      }[action];
      listManaged.mockResolvedValue(ledger([chatGPT()]));
      lifecycle.mockImplementation(async () => response(action));
      await openSession();
      await act(async () => { click(label); });
      expect(lifecycle).toHaveBeenCalledExactlyOnceWith({ seatId: agent.id, sessionId: "session-a", action });
      const output = JSON.stringify(renderer!.toJSON());
      expect(output).toContain("Server receipt:");
      expect(output).toContain("model completion unverified");
      expect(output).toContain(browserId);
      expect(output).toContain(conversationId);
      if (action === "suspend") expect(output).toContain("no running model was paused");
      if (action === "recover") expect(output).toContain("page load is NOT verified");
      if (action === "resume") expect(output).toContain("reattaches on render");
    },
  );
  it("disables lifecycle on older desktop without an installed typed IPC, preserving local history", async () => {
    listManaged.mockResolvedValue(ledger([chatGPT()]));
    await openSession();
    delete (window.desktopBridge as { runOpenRigManagedBrowserLifecycle?: unknown }).runOpenRigManagedBrowserLifecycle;
    await act(async () => { click("Refresh sessions"); });
    const archive = renderer!.root.findAllByType("button").find(b => b.props.children === "Archive idle browser");
    expect(archive?.props.disabled).toBe(true);
    expect(JSON.stringify(renderer!.toJSON())).toContain("require a compatible T3 desktop build");
    expect(lifecycle).not.toHaveBeenCalled();
  });
  it("requires a second deliberate stop click; still offers separate detach, never cloud deletion", async () => {
    listManaged.mockResolvedValue(ledger([chatGPT()]));
    lifecycle.mockResolvedValue(response("stop"));
    await openSession();
    await act(async () => { click("Close local T3 record…"); });
    expect(lifecycle).not.toHaveBeenCalled();
    let output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("Confirm permanent local close");
    expect(output).toContain("not cloud deletion");
    expect(output).toContain("Detach ownership");
    await act(async () => { click("Cancel local close"); });
    expect(lifecycle).not.toHaveBeenCalled();
    await act(async () => { click("Close local T3 record…"); });
    await act(async () => { click("Confirm permanent local close"); });
    expect(lifecycle).toHaveBeenCalledExactlyOnceWith({
      seatId: agent.id, sessionId: "session-a", action: "stop", confirm: "close-local-t3-session",
    });
    output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("permanent LOCAL record close");
    expect(output).toContain("cloud conversation remains");
    expect(detach).not.toHaveBeenCalled();
  });
  it("shows 409 refusal without retry and blocks duplicate uncertain 503/timeout", async () => {
    listManaged.mockResolvedValue(ledger([chatGPT()]));
    lifecycle.mockRejectedValueOnce(new Error("OpenRig bridge HTTP 409: unfinished draft"));
    await openSession();
    await act(async () => { click("Archive idle browser"); });
    expect(JSON.stringify(renderer!.toJSON())).toContain("unfinished draft");
    expect(lifecycle).toHaveBeenCalledTimes(1);
    lifecycle.mockRejectedValueOnce(new Error("OpenRig bridge HTTP 503: local close happened but detach uncertain"));
    await act(async () => { click("Restore archived browser"); });
    expect(JSON.stringify(renderer!.toJSON())).toContain("outcome unconfirmed");
    expect(JSON.stringify(renderer!.toJSON())).toContain("disabled until");
    await act(async () => { click("Recover blank homepage"); });
    expect(lifecycle).toHaveBeenCalledTimes(2);
  });
  it("resets pending destructive close on switching to another seat, no stolen or resent action", async () => {
    const other = { ...agent, id: "node-other", name: "Other" };
    list.mockResolvedValue([agent, other]);
    listManaged.mockImplementation(async (id: string) => id === agent.id
      ? ledger([chatGPT()]) : { ...ledger([]), seatId: other.id });
    await openSession();
    await act(async () => { click("Close local T3 record…"); });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Confirm permanent local close");
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Open workspace for OpenRig agent Other" }).props.onClick();
    });
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Confirm permanent local close");
    expect(lifecycle).not.toHaveBeenCalled();
  });
});

describe("OpenRig managed seat sidebar", () => {
  it("opens the existing agent network popout without a spawn-approval decision writer", async () => {
    await mount();
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Open OpenRig agent network" }).props.onClick();
    });
    const output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("Agent network");
    expect(output).toContain("Seat-to-seat messages");
    expect(output).toContain("sender identity is");
    expect(output).toContain("not enforced yet");
    expect(output).not.toContain("Approve once");
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Close agent network" }).props.onClick();
    });
    expect(renderer!.root.findByProps({ "aria-label": "Open OpenRig agent network" }).props["aria-expanded"]).toBe(false);
    expect(renderer!.root.findAllByProps({ "aria-label": "Close agent network" })).toHaveLength(0);
  });
  it("shows explicit profile readiness and retains managed primary/history unchanged", async () => {
    await mount();
    const output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain('"Native execution: ","Ready"');
    expect(output).toContain("operatorChosenCodex / gpt-6");
    expect(output).toContain("First conversation");
    expect(output).toContain("Second conversation");
    expect(output).toContain("Primary");
    expect(output).toContain("History");
    expect(readProfile).toHaveBeenCalledWith(agent.id);
    expect(configureProfile).not.toHaveBeenCalled();
  });

  it("blocks native start on unready seats and never infers a model from RigSpec or T3", async () => {
    readProfile.mockResolvedValue(executionProfile(false, false));
    await mount();
    let output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain('"Native execution: ","Not ready"');
    expect(output).toContain("workspaceRoot");
    expect(output).toContain("providerInstanceIdOrUniqueCatalogMatch");
    expect(output).toContain("OPENRIG_T3_NATIVE_CREATE_ENABLED=1");
    await act(async () => { click("Start session"); });
    expect(start).not.toHaveBeenCalled();
    await act(async () => { click("Configure execution profile"); });
    expect(renderer!.root.findByProps({ "aria-label": "Native profile model for Builder" }).props.value).toBe("");
    expect(renderer!.root.findByProps({ "aria-label": "Native profile provider instance for Builder" }).props.value).toBe("");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Enter the actual existing Windows workspace");
    expect(configureProfile).not.toHaveBeenCalled();
    output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain('"Seat runtime: ","codex"');
  });

  it("saves only operator-entered exact profile fields and keeps existing sessions and primary", async () => {
    readProfile.mockResolvedValue(executionProfile(false, false));
    configureProfile.mockResolvedValue(executionProfile(true, true));
    await mount();
    await act(async () => { click("Configure execution profile"); });
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Native profile workspace for Builder" }).props.onChange({ currentTarget: { value: "D:\\ExistingProject" } });
      renderer!.root.findByProps({ "aria-label": "Native profile provider instance for Builder" }).props.onChange({ currentTarget: { value: "operatorChosenCodex" } });
      renderer!.root.findByProps({ "aria-label": "Native profile model for Builder" }).props.onChange({ currentTarget: { value: "gpt-6" } });
      renderer!.root.findByProps({ "aria-label": "Native profile runtime mode for Builder" }).props.onChange({ currentTarget: { value: "approval-required" } });
      renderer!.root.findByProps({ "aria-label": "Native profile environment for Builder" }).props.onChange({ currentTarget: { value: "desktop-env-1" } });
    });
    await act(async () => { click("Save explicit execution profile"); });
    expect(configureProfile).toHaveBeenCalledExactlyOnceWith({
      seatId: agent.id, workspaceRoot: "D:\\ExistingProject", providerInstanceId: "operatorChosenCodex",
      model: "gpt-6", runtimeMode: "approval-required", environmentId: "desktop-env-1",
    });
    const output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("Native launch is ready");
    expect(output).toContain("First conversation");
    expect(output).toContain("Second conversation");
    expect(output).toContain("Primary");
    expect(output).toContain("History");
    expect(start).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
    expect(primary).not.toHaveBeenCalled();
  });

  it("preserves explicit draft and reports catalog 409 without silent fallback or POST retry", async () => {
    readProfile.mockResolvedValue(executionProfile(false, false));
    configureProfile.mockRejectedValue(new Error("OpenRig bridge HTTP 409: Provider instance/model unavailable or does not match seat runtime"));
    await mount();
    await act(async () => { click("Configure execution profile"); });
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Native profile workspace for Builder" }).props.onChange({ currentTarget: { value: "D:\\ExistingProject" } });
      renderer!.root.findByProps({ "aria-label": "Native profile provider instance for Builder" }).props.onChange({ currentTarget: { value: "exactCodex" } });
      renderer!.root.findByProps({ "aria-label": "Native profile model for Builder" }).props.onChange({ currentTarget: { value: "model-x" } });
      renderer!.root.findByProps({ "aria-label": "Native profile runtime mode for Builder" }).props.onChange({ currentTarget: { value: "auto" } });
    });
    await act(async () => { click("Save explicit execution profile"); });
    expect(JSON.stringify(renderer!.toJSON())).toContain("HTTP 409");
    expect(JSON.stringify(renderer!.toJSON())).toContain("verify the live catalog");
    expect(renderer!.root.findByProps({ "aria-label": "Native profile model for Builder" }).props.value).toBe("model-x");
    expect(configureProfile).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("fails closed on unreadable native profile but still permits explicit ChatGPT", async () => {
    readProfile.mockRejectedValue(new Error("OpenRig bridge HTTP 503: profile unavailable"));
    listManaged.mockResolvedValue(ledger([]));
    start.mockImplementation(async (value: unknown) => ledger([{
      ...session("session-a", false), operationId: (value as { operationId: string }).operationId,
      mode: "chatgpt", status: "pending", target: null, targetKey: null,
      environmentId: null, threadId: null, primary: false,
    }]));
    await mount();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Execution profile unavailable");
    await act(async () => { click("Start session"); });
    expect(start).not.toHaveBeenCalled();
    await act(async () => { click("Launch options"); });
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Runtime for Builder" }).props.onChange({ currentTarget: { value: "chatgpt" } });
    });
    await act(async () => { click("Start session"); });
    expect(start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ seatId: agent.id, kind: "chatgpt" }));
  });

  it("allows additional explicit ChatGPT execution while native seat is unready", async () => {
    readProfile.mockResolvedValue(executionProfile(false, false));
    start.mockImplementation(async (value: unknown) => ledger([{
      ...session("session-a", false), operationId: (value as { operationId: string }).operationId,
      mode: "chatgpt", status: "pending", target: null, targetKey: null,
      threadId: null, environmentId: null, primary: false,
    }]));
    await mount();
    await act(async () => { click("Launch options"); });
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Runtime for Builder" }).props.onChange({ currentTarget: { value: "chatgpt" } });
    });
    await act(async () => { click("New session"); });
    expect(start).toHaveBeenCalledTimes(1);
    const input = start.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toMatchObject({ seatId: agent.id, kind: "chatgpt" });
    expect(input).not.toHaveProperty("workspaceRoot");
    expect(input).not.toHaveProperty("providerInstanceId");
    expect(input).not.toHaveProperty("model");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Waiting for a verified /c/ conversation URL");
    expect(configureProfile).not.toHaveBeenCalled();
  });

  it("projects every owned session, distinguishing primary, with no legacy picker on the normal path", async () => {
    await mount();
    const output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("First conversation");
    expect(output).toContain("Second conversation");
    expect(output).toContain("Primary");
    expect(output).toContain("History");
    expect(listManaged).toHaveBeenCalledWith(agent.id);
    expect(listSessions).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
    expect(output).not.toContain("Unmanaged");
  });

  it("starts an empty seat through OpenRig with one operation UUID and no implicit provider choice", async () => {
    listManaged.mockResolvedValue(ledger([]));
    start.mockImplementation(async (value: unknown) => ledger([{
      ...session("session-a", true),
      operationId: (value as { operationId: string }).operationId,
    }]));
    await mount();
    expect(JSON.stringify(renderer!.toJSON())).toContain("No OpenRig-managed sessions");
    await act(async () => { click("Start session"); });
    expect(start).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(renderer!.toJSON())).toContain("ONE initial message");
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("initial prompt was not sent");
    const input = start.mock.calls[0]?.[0] as { seatId: string; operationId: string };
    expect(input.seatId).toBe(agent.id);
    expect(input.operationId).toMatch(/^[a-f0-9-]{36}$/i);
    expect(input).not.toHaveProperty("kind");
    expect(input).not.toHaveProperty("workspaceRoot");
    expect(adopt).not.toHaveBeenCalled();
  });

  it("selects only an owned active session as primary and sends only by seat ID", async () => {
    await mount();
    await act(async () => { click("Make primary"); });
    expect(primary).toHaveBeenCalledExactlyOnceWith({ seatId: agent.id, sessionId: "session-b" });
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Message to Builder" }).props.onChange({ currentTarget: { value: "Status?" } });
    });
    await act(async () => {
      renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} });
    });
    expect(send).toHaveBeenCalledWith({ id: agent.id, message: "Status?" });
  });

  it("keeps indeterminate launch visible and blocks duplicate POST until explicit acknowledgment", async () => {
    listManaged.mockResolvedValue(ledger([]));
    start.mockRejectedValue(new Error("OpenRig bridge HTTP 503: indeterminate"));
    await mount();
    await act(async () => { click("Start session"); });
    const output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("Launch outcome uncertain");
    expect(output).toContain("do not retry");
    await act(async () => { click("Start session"); });
    expect(start).toHaveBeenCalledTimes(1);
    await act(async () => { click("I inspected this operation; allow a separate launch"); });
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Launch outcome uncertain");
  });

  it("disables sending without active primary and does not pretend a pending ChatGPT tab is a conversation", async () => {
    const pending = { ...session("session-a", false), mode: "chatgpt" as const, status: "pending" as const,
      target: null, conversationId: null, threadId: null, environmentId: null, targetKey: null };
    listManaged.mockResolvedValue(ledger([pending]));
    await mount();
    expect(JSON.stringify(renderer!.toJSON())).toContain("No routable active managed primary");
    expect(renderer!.root.findAllByProps({ "aria-label": "Message to Builder" })).toHaveLength(0);
    expect(renderer!.root.findAllByType("a")).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps legacy bindings visible but never enables managed send without an active primary", async () => {
    listManaged.mockResolvedValue({ ...ledger([]), legacyBinding: { sessionId: "browser-legacy" } });
    list.mockResolvedValue([{ ...agent, bound: true, sessionId: "browser-legacy", sessionTitle: "Old window" }]);
    await mount();
    const output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("Legacy conversation still recorded");
    expect(output).toContain("cannot receive seat messages");
    expect(renderer!.root.findAllByProps({ "aria-label": "Message to Builder" })).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("treats native exact-provider gate 409 as pre-creation, but holds uncertain 503 and duplicate operations", async () => {
    listManaged.mockResolvedValue(ledger([]));
    start.mockRejectedValueOnce(new Error("OpenRig bridge HTTP 409: T3 exact-provider persisted native create is not deployed/enabled"))
      .mockRejectedValueOnce(new Error("OpenRig bridge HTTP 409: Operation already recorded as indeterminate"));
    await mount();
    await act(async () => { click("Start session"); });
    let output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("rejected launch before creation");
    expect(output).toContain("OPENRIG_T3_NATIVE_CREATE_ENABLED=1");
    expect(output).not.toContain("Launch outcome uncertain");
    await act(async () => { click("Start session"); });
    output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("Launch outcome uncertain");
    expect(start).toHaveBeenCalledTimes(2);
    await act(async () => { click("Start session"); });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("presents bootstrap as automatic and forwards only explicitly entered parent references", async () => {
    listManaged.mockResolvedValue(ledger([]));
    start.mockImplementation(async (value: unknown) => ledger([{ ...session("session-a", false),
      operationId: (value as { operationId: string }).operationId,
      mode: "chatgpt", status: "pending", target: null, targetKey: null,
      threadId: null, environmentId: null, primary: false }]));
    await mount();
    await act(async () => { click("Launch options"); });
    let output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("never T3's selected/default provider");
    expect(output).toContain("bootstrap for both runtimes");
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Runtime for Builder" }).props.onChange({ currentTarget: { value: "chatgpt" } });
      renderer!.root.findByProps({ "aria-label": "Parent OpenRig seat for Builder" }).props.onChange({ currentTarget: { value: "parent-seat" } });
      renderer!.root.findByProps({ "aria-label": "Parent managed session for Builder" }).props.onChange({ currentTarget: { value: "parent-session" } });
    });
    await act(async () => { click("Start session"); });
    const input = start.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input).toMatchObject({ seatId: agent.id, kind: "chatgpt",
      parentSeatId: "parent-seat", parentManagedSessionId: "parent-session" });
    expect(input).not.toHaveProperty("initialPrompt");
    output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("ChatGPT spawn accepted OpenRig's bootstrap");
    expect(output).toContain("verified /c/ conversation URL");
  });

  it("shows read-only native recovery evidence without implying safe retry or model completion", async () => {
    const uncertain = { ...session("session-a", false), status: "indeterminate" as const, primary: false,
      target: null, targetKey: null,
      recoveryEvidence: { threadFound: true, exactEnvironmentAndProvider: true,
        initialMessageAcknowledged: false, safeToRetryLaunch: false as const, reconciliationRequired: true } };
    listManaged.mockResolvedValue(ledger([uncertain]));
    await mount();
    const output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("Exact thread observed; reconciliation required");
    expect(output).toContain("Initial-message acknowledgment not verified");
    expect(output).toContain("no automatic retry");
    expect(renderer!.root.findAllByProps({ "aria-label": "Message to Builder" })).toHaveLength(0);
  });

  it("keeps manual adoption behind Advanced and requires an explicit selected conversation", async () => {
    listManaged.mockResolvedValue(ledger([]));
    await mount();
    expect(listSessions).not.toHaveBeenCalled();
    await act(async () => { click("Advanced: adopt existing unmanaged conversation"); });
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Unmanaged");
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "T3 session for Builder" }).props.onChange({ currentTarget: { value: "old" } });
    });
    await act(async () => { click("Adopt into OpenRig"); });
    expect(adopt).toHaveBeenCalledTimes(1);
    const input = adopt.mock.calls[0]?.[0] as {
      seatId: string; operationId: string; target: unknown;
    };
    expect(input).toMatchObject({
      seatId: agent.id, target: { kind: "t3-thread", environmentId: "local", threadId: "thread-old" },
    });
    expect(input.operationId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("only offers URL reconciliation for pending ChatGPT with a known attached tab", async () => {
    const pending = {
      ...session("session-a", false),
      mode: "chatgpt" as const,
      status: "pending" as const,
      target: null, conversationId: null, threadId: null, environmentId: null,
      targetKey: null, attachedTabUuid: "tab-1",
    };
    listManaged.mockResolvedValue(ledger([pending]));
    await mount();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Reconcile URL");
    expect(renderer!.root.findAllByType("a")).toHaveLength(0);
    await act(async () => { click("Reconcile URL"); });
    expect(reconcile).toHaveBeenCalledExactlyOnceWith({ seatId: agent.id, sessionId: "session-a" });
    expect(start).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation before detaching ownership and leaves provider history intact", async () => {
    await mount();
    expect(detach).not.toHaveBeenCalled();
    await act(async () => { click("Detach ownership"); });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Confirm detach");
    expect(detach).not.toHaveBeenCalled();
    await act(async () => { click("Confirm detach"); });
    expect(detach).toHaveBeenCalledExactlyOnceWith({ seatId: agent.id, sessionId: "session-a" });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Provider history remains intact");
    expect(send).not.toHaveBeenCalled();
  });

  it("never offers volatile browser-window UUIDs as managed-adoption targets", async () => {
    listManaged.mockResolvedValue(ledger([]));
    await mount();
    await act(async () => { click("Advanced: adopt existing unmanaged conversation"); });
    const output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("Unmanaged");
    expect(output).not.toContain("Temporary tab");
  });

  it("retains unsent text and reports delivery failure rather than success", async () => {
    send.mockRejectedValue(new Error("Guard failed"));
    await mount();
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Message to Builder" }).props.onChange({ currentTarget: { value: "Do not lose" } });
    });
    await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Delivery unknown");
    expect(renderer!.root.findByProps({ "aria-label": "Message to Builder" }).props.value).toBe("Do not lose");
    await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(renderer!.toJSON())).toContain("Previous delivery is unknown");
    await act(async () => { click("I inspected history; allow a new send"); });
    await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    expect(send).toHaveBeenCalledTimes(2); // Only after explicit operator release.
  });

  it("distinguishes verified pre-POST rejection from unknown delivery and allows retry", async () => {
    send.mockRejectedValueOnce(new Error("OpenRig message not sent: seat has no routable active managed primary."))
      .mockResolvedValueOnce(undefined);
    await mount();
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Message to Builder" }).props.onChange({ currentTarget: { value: "Status" } });
    });
    await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    const output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("Not sent");
    expect(output).not.toContain("Previous delivery is unknown");
    await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(renderer!.toJSON())).toContain("T3 confirmed delivery");
  });

  it("holds in-flight sends across switching workspace tabs without sending twice", async () => {
    let resolveSend!: () => void;
    send.mockImplementation(() => new Promise<void>((resolve) => { resolveSend = resolve; }));
    await mount();
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Message to Builder" }).props.onChange({ currentTarget: { value: "One send" } });
    });
    await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    await act(async () => { renderer!.root.findByProps({ id: "openrig-workspace-tab-work" }).props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ id: "openrig-workspace-tab-overview" }).props.onClick(); });
    await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => { resolveSend(); });
    expect(JSON.stringify(renderer!.toJSON())).toContain("T3 confirmed delivery");
  });
});
