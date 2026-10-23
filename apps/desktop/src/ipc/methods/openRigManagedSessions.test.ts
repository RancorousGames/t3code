import { describe, expect, it, vi } from "vite-plus/test";

import {
  decodeOpenRigManagedSessions,
  fetchOpenRigExecutionProfile,
  configureOpenRigSeatExecutionProfile,
  adoptOpenRigSeatSession,
  detachOpenRigSeatSession,
  reconcileOpenRigChatGPTSeatSession,
  fetchOpenRigManagedSessions,
  selectOpenRigSeatPrimary,
  startOpenRigSeatSession,
} from "./openRig.ts";

const seatId = "seat/team-one";
const operationId = "11111111-1111-4111-8111-111111111111";
const sessionId = "ledger-session-a";
const initialMessageId = "22222222-2222-4222-8222-222222222222";

const session = {
  id: sessionId,
  seatId,
  operationId,
  mode: "native",
  status: "active",
  primary: true,
  target: { kind: "t3-thread" as const, environmentId: "local", threadId: operationId },
  targetKey: `t3:local:${operationId}`,
  projectId: "p",
  environmentId: "local",
  threadId: operationId,
  conversationId: null,
  attachedTabUuid: null,
  parentSeatId: null,
  parentManagedSessionId: null,
  provenance: "openrig-managed",
  intent: { kind: "native", environmentId: "local", providerInstanceId: "codex", runtimeMode: "auto", initialMessageId },
  createdAt: "2026-10-19T11:00:00.000Z",
  updatedAt: "2026-10-19T11:00:00.000Z",
  error: null,
  observed: { available: true, status: "idle" },
  modelCompletionVerified: false,
};
const ledger = {
  version: 1,
  seatId,
  primarySessionId: sessionId,
  sessions: [session],
  legacyBinding: null,
  legacyAutoImported: false,
  pendingRecoveryCount: 0,
  launchPolicy: {
    explicitOperationIdRequired: true,
    duplicateOperationRetrySafe: false,
    automaticUnknownRetry: false,
    implicitAdoption: false,
  },
};

const savedProfile = {
  seatId, workspaceRoot: "D:\\ExistingProject", environmentId: "exact-local-env",
  runtime: "codex", providerInstanceId: "chosenCodexInstance", model: "gpt-6",
  runtimeMode: "approval-required", provenance: "operator-explicit-t3-provider-catalog",
  createdAt: "2026-10-19T11:00:00Z", updatedAt: "2026-10-19T11:00:00Z",
};
const executionProfile = {
  version: 1, seatId, profile: savedProfile,
  rigSpec: { runtime: "codex", cwd: null, workspace: null, model: null,
    providerInstanceId: null, runtimeMode: null, environmentId: null },
  effective: savedProfile,
  nativeLaunchReady: false, missing: [], requiresOperatorApproval: false,
  providerSelectionAuthority: "T3 exact live provider catalog",
  overwriteRigSpec: false, legacySessionsAutoAdopted: false,
};
const exactProfileInput = {
  seatId, workspaceRoot: "D:\\ExistingProject", providerInstanceId: "chosenCodexInstance",
  model: "gpt-6", runtimeMode: "approval-required" as const,
  environmentId: "exact-local-env",
};

describe("OpenRig execution-profile desktop IPC boundary", () => {
  it("GETs only the exact seat profile and never infers provider or model", async () => {
    const missing = { ...executionProfile, profile: null, effective: executionProfile.rigSpec,
      nativeLaunchReady: false,
      missing: ["workspaceRoot", "model", "runtimeMode", "providerInstanceIdOrUniqueCatalogMatch"],
      requiresOperatorApproval: true };
    const fetcher = vi.fn(async () => Response.json(missing)) as typeof fetch;
    expect(await fetchOpenRigExecutionProfile(seatId, fetcher)).toEqual(missing);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:7433/api/integrations/t3/agents/seat%2Fteam-one/execution-profile",
      expect.objectContaining({ method: "GET", cache: "no-store", redirect: "error" }),
    );
    const wrong = vi.fn(async () => Response.json({ ...executionProfile, seatId: "another" })) as typeof fetch;
    await expect(fetchOpenRigExecutionProfile(seatId, wrong)).rejects.toThrow("wrong seat");
    const malformed = vi.fn(async () => Response.json({ ...executionProfile,
      providerSelectionAuthority: "implicit-editor-default" })) as typeof fetch;
    await expect(fetchOpenRigExecutionProfile(seatId, malformed)).rejects.toThrow();
  });

  it("PUTs only explicit Windows workspace/provider instance/model/mode/environment and verifies exact saved GET", async () => {
    const receipt = { version: 1, seatId, profile: savedProfile,
      overwriteRigSpec: false, legacySessionsAutoAdopted: false };
    const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
      Response.json(init.method === "PUT" ? receipt : executionProfile)) as typeof fetch;
    const result = await configureOpenRigSeatExecutionProfile(exactProfileInput, fetcher);
    expect(result).toEqual(executionProfile);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, options] = vi.mocked(fetcher).mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:7433/api/integrations/t3/agents/seat%2Fteam-one/execution-profile");
    expect(options).toEqual(expect.objectContaining({ method: "PUT", cache: "no-store", redirect: "error",
      body: JSON.stringify({ workspaceRoot: "D:\\ExistingProject",
        providerInstanceId: "chosenCodexInstance", model: "gpt-6",
        runtimeMode: "approval-required", environmentId: "exact-local-env" }) }));
    expect(JSON.parse(String(options?.body))).not.toHaveProperty("runtime"); // no driver override
    expect(vi.mocked(fetcher).mock.calls[1]![1]?.method).toBe("GET");
    expect(result.nativeLaunchReady).toBe(false); // persisted settings != enabled create gate
  });

  it("rejects malformed or partial input before PUT, with no provider selection defaults", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(configureOpenRigSeatExecutionProfile({
      ...exactProfileInput, workspaceRoot: "./current-open-workspace",
    }, fetcher)).rejects.toThrow("absolute Windows drive path");
    await expect(configureOpenRigSeatExecutionProfile({
      ...exactProfileInput, providerInstanceId: "selected provider from editor",
    }, fetcher)).rejects.toThrow("exact T3 provider instance ID");
    await expect(configureOpenRigSeatExecutionProfile({
      ...exactProfileInput, model: "",
    }, fetcher)).rejects.toThrow("exact nonempty");
    await expect(configureOpenRigSeatExecutionProfile({
      ...exactProfileInput, runtimeMode: "invalid-mode" as never,
    }, fetcher)).rejects.toThrow("explicit T3 runtime approval mode");
    await expect(configureOpenRigSeatExecutionProfile({
      ...exactProfileInput, environmentId: " ",
    }, fetcher)).rejects.toThrow("Environment ID");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves 409 provider-catalog rejections, verifies receipt, and never auto retries", async () => {
    const rejected = vi.fn(async () => Response.json({
      error: "Provider instance/model unavailable or does not match seat runtime",
    }, { status: 409 })) as typeof fetch;
    await expect(configureOpenRigSeatExecutionProfile(exactProfileInput, rejected))
      .rejects.toThrow("HTTP 409: Provider instance/model unavailable");
    expect(rejected).toHaveBeenCalledOnce();
    const inaccurate = vi.fn(async () => Response.json({ version: 1, seatId,
      profile: { ...savedProfile, model: "wrong" }, overwriteRigSpec: false,
      legacySessionsAutoAdopted: false })) as typeof fetch;
    await expect(configureOpenRigSeatExecutionProfile(exactProfileInput, inaccurate))
      .rejects.toThrow("did not confirm the exact provider-catalog");
    expect(inaccurate).toHaveBeenCalledOnce();
    const staleGet = vi.fn(async (_url: string, init: RequestInit) =>
      Response.json(init.method === "PUT" ? {
        version: 1, seatId, profile: savedProfile,
        overwriteRigSpec: false, legacySessionsAutoAdopted: false,
      } : { ...executionProfile, profile: { ...savedProfile, model: "old-model" } })) as typeof fetch;
    await expect(configureOpenRigSeatExecutionProfile(exactProfileInput, staleGet))
      .rejects.toThrow("did not confirm persisted execution settings");
    expect(staleGet).toHaveBeenCalledTimes(2);
  });
});

describe("OpenRig managed-session desktop IPC boundary", () => {
  it("reads authoritative seat ledger with no auto-adoption or synthetic primary", async () => {
    const fetcher = vi.fn(async () => Response.json(ledger)) as typeof fetch;
    expect(await fetchOpenRigManagedSessions(seatId, fetcher)).toEqual(ledger);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7433/api/integrations/t3/agents/seat%2Fteam-one/sessions",
      expect.objectContaining({ method: "GET", cache: "no-store", redirect: "error" }),
    );
    expect(() => decodeOpenRigManagedSessions({ ...ledger, seatId: "other" }, seatId))
      .toThrow("mismatch");
    expect(() => decodeOpenRigManagedSessions({
      ...ledger, sessions: [{ ...session, seatId: "other" }],
    }, seatId)).toThrow("foreign");
    expect(() => decodeOpenRigManagedSessions({
      ...ledger, primarySessionId: "missing",
    }, seatId)).toThrow("does not belong");
    expect(() => decodeOpenRigManagedSessions({
      ...ledger, sessions: [{ ...session, primary: false }],
    }, seatId)).toThrow("contradict");
  });

  it("launches only via OpenRig with explicit UUID and no inferred runtime or root", async () => {
    const receipt = {
      version: 1, seatId, session, primarySessionId: sessionId,
      initialDispatch: { state: "transport_accepted", messageId: initialMessageId, modelCompletionVerified: false }, retrySafe: false,
    };
    const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
      Response.json(init.method === "POST" ? receipt : ledger,
        init.method === "POST" ? { status: 201 } : undefined)) as typeof fetch;
    expect(await startOpenRigSeatSession({ seatId, operationId }, fetcher)).toEqual(ledger);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, options] = vi.mocked(fetcher).mock.calls[0]!;
    expect(url).toContain("/agents/seat%2Fteam-one/sessions");
    expect(options).toEqual(expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ operationId }),
    }));
    expect(String(options?.body)).not.toContain("provider");
    expect(String(options?.body)).not.toContain("workspaceRoot");
  });

  it("passes explicit runtime/root and prompt only when requested, without side-channel provider creation", async () => {
    const receipt = {
      version: 1, seatId, session, primarySessionId: sessionId,
      initialDispatch: { state: "transport_accepted", messageId: initialMessageId, modelCompletionVerified: false }, retrySafe: false,
    };
    const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
      Response.json(init.method === "POST" ? receipt : ledger,
        init.method === "POST" ? { status: 201 } : undefined)) as typeof fetch;
    await startOpenRigSeatSession({
      seatId, operationId, kind: "native",
      workspaceRoot: "D:\\Wartribes", title: "Build", initialPrompt: "Read AGENTS.md",
      parentSeatId: "parent-seat", parentManagedSessionId: "parent-session",
    }, fetcher);
    expect(JSON.parse(String(vi.mocked(fetcher).mock.calls[0]![1]?.body))).toEqual({
      operationId, kind: "native", workspaceRoot: "D:\\Wartribes",
      title: "Build", initialPrompt: "Read AGENTS.md",
      parentSeatId: "parent-seat", parentManagedSessionId: "parent-session",
    });
  });

  it("does not retry an ambiguous 503 launch or accept a hollow 200 receipt", async () => {
    const uncertain = vi.fn(async () =>
      Response.json({ error: "launch-indeterminate" }, { status: 503 })) as typeof fetch;
    await expect(startOpenRigSeatSession({ seatId, operationId }, uncertain))
      .rejects.toThrow("HTTP 503");
    expect(uncertain).toHaveBeenCalledOnce();
    const hollow = vi.fn(async (_url: string, init: RequestInit) =>
      Response.json(init.method === "POST" ? { ok: true } : ledger)) as typeof fetch;
    await expect(startOpenRigSeatSession({ seatId, operationId }, hollow))
      .rejects.toThrow("exact persisted launch");
    expect(hollow).toHaveBeenCalledTimes(1);
    const invalid = vi.fn() as unknown as typeof fetch;
    await expect(startOpenRigSeatSession({ seatId, operationId: "bad" }, invalid))
      .rejects.toThrow("UUID");
    await expect(startOpenRigSeatSession({
      seatId, operationId, parentManagedSessionId: "unknown",
    }, invalid)).rejects.toThrow("parent OpenRig seat ID");
    expect(invalid).not.toHaveBeenCalled();
  });

  it("requires a 201 persisted exact-provider native thread and matching one-shot bootstrap receipt", async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
      Response.json(init.method === "POST" ? {
        version: 1, seatId, session, primarySessionId: sessionId,
        initialDispatch: { state: "transport_accepted", messageId: initialMessageId, modelCompletionVerified: false },
        retrySafe: false,
      } : ledger)) as typeof fetch;
    await expect(startOpenRigSeatSession({ seatId, operationId }, fetcher))
      .rejects.toThrow("exact persisted launch");
    expect(fetcher).toHaveBeenCalledOnce();
    const invalidMessage = vi.fn(async () => Response.json({
      version: 1, seatId, session, primarySessionId: sessionId,
      initialDispatch: { state: "transport_accepted", messageId: "wrong", modelCompletionVerified: false },
      retrySafe: false,
    }, { status: 201 })) as typeof fetch;
    await expect(startOpenRigSeatSession({ seatId, operationId }, invalidMessage))
      .rejects.toThrow("exact persisted launch");
    expect(invalidMessage).toHaveBeenCalledOnce();
    const gate = vi.fn(async () => Response.json({
      error: "T3 exact-provider persisted native create is not deployed/enabled; open-workspace drafts are forbidden",
      retrySafe: false,
    }, { status: 409 })) as typeof fetch;
    await expect(startOpenRigSeatSession({ seatId, operationId }, gate))
      .rejects.toThrow("HTTP 409: T3 exact-provider");
    expect(gate).toHaveBeenCalledOnce();
  });

  it("permits ChatGPT launch with no initialPrompt but requires bootstrap transport receipt", async () => {
    const pending = { ...session, mode: "chatgpt", status: "pending", primary: false,
      target: null, targetKey: null, projectId: null, threadId: null, environmentId: null,
      attachedTabUuid: "t3-browser-tab" };
    const chatLedger = { ...ledger, primarySessionId: null, sessions: [pending] };
    const receipt = { version: 1, seatId, session: pending, primarySessionId: null,
      initialDispatch: { state: "transport_accepted", modelCompletionVerified: false }, retrySafe: false };
    const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
      Response.json(init.method === "POST" ? receipt : chatLedger,
        init.method === "POST" ? { status: 201 } : undefined)) as typeof fetch;
    expect(await startOpenRigSeatSession({ seatId, operationId, kind: "chatgpt" }, fetcher))
      .toEqual(chatLedger);
    expect(vi.mocked(fetcher).mock.calls[0]![1]?.body)
      .toEqual(JSON.stringify({ operationId, kind: "chatgpt" }));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("adopts only explicit exact targets via managed endpoint and rejects volatile browser UUIDs", async () => {
    const adopted = { ...session, mode: "adopt", provenance: "operator-explicit-adoption" };
    const after = { ...ledger, sessions: [adopted] };
    const receipt = {
      version: 1, seatId, session: adopted, primarySessionId: sessionId,
      provenance: "operator-explicit-adoption",
    };
    const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
      Response.json(init.method === "POST" ? receipt : after)) as typeof fetch;
    expect(await adoptOpenRigSeatSession({
      seatId, operationId, target: session.target,
    }, fetcher)).toEqual(after);
    const [url, options] = vi.mocked(fetcher).mock.calls[0]!;
    expect(url).toContain("/agents/seat%2Fteam-one/sessions/adopt");
    expect(JSON.parse(String(options?.body))).toEqual({ operationId, target: session.target });

    const forbidden = vi.fn() as unknown as typeof fetch;
    await expect(adoptOpenRigSeatSession({
      seatId, operationId, target: { kind: "legacy-browser", sessionId: "volatile-tab" },
    }, forbidden)).rejects.toThrow("not a durable conversation");
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("allows exact ChatGPT URL reconciliation without relaunching the provider", async () => {
    const pending = {
      ...session,
      mode: "chatgpt", status: "pending", primary: false,
      target: null, conversationId: null, targetKey: null,
      attachedTabUuid: "t3-webview-id",
    };
    const active = {
      ...pending,
      status: "active", primary: true,
      target: { kind: "chatgpt-conversation", conversationId: "a1b2c3d4-0000-4000-8000-001122334455" },
      conversationId: "a1b2c3d4-0000-4000-8000-001122334455",
    };
    const first = { ...ledger, primarySessionId: null, sessions: [pending] };
    const last = { ...ledger, primarySessionId: sessionId, sessions: [active] };
    let reads = 0;
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "GET") return Response.json(++reads === 1 ? first : last);
      return Response.json({ version: 1, seatId, session: active, primarySessionId: sessionId });
    }) as typeof fetch;
    expect(await reconcileOpenRigChatGPTSeatSession({ seatId, sessionId }, fetcher)).toEqual(last);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [url, options] = vi.mocked(fetcher).mock.calls[1]!;
    expect(url).toContain("/sessions/ledger-session-a/reconcile-chatgpt");
    expect(options?.method).toBe("POST");
    expect(options?.body).toBe("{}");
  });

  it("detaches ownership while requiring OpenRig to preserve the historical entry", async () => {
    const detached = { ...session, primary: false, status: "detached" };
    const last = { ...ledger, primarySessionId: null, sessions: [detached] };
    let reads = 0;
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "GET") return Response.json(++reads === 1 ? ledger : last);
      return Response.json({ version: 1, seatId, session: detached, primarySessionId: null });
    }) as typeof fetch;
    expect(await detachOpenRigSeatSession({ seatId, sessionId }, fetcher)).toEqual(last);
    const [url, options] = vi.mocked(fetcher).mock.calls[1]!;
    expect(url).toContain("/sessions/ledger-session-a");
    expect(options?.method).toBe("DELETE");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("changes primary only for owned active exact targets and confirms GET after POST", async () => {
    const receipt = { version: 1, seatId, session, primarySessionId: sessionId };
    const before = {
      ...ledger, primarySessionId: null, sessions: [{ ...session, primary: false }],
    };
    const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
      Response.json(init.method === "POST" ? receipt
        : vi.mocked(fetcher).mock.calls.filter((call) => call[1]?.method === "GET").length === 1 ? before : ledger)) as typeof fetch;
    expect(await selectOpenRigSeatPrimary({ seatId, sessionId }, fetcher)).toEqual(ledger);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetcher).mock.calls[1]![0]).toContain("/sessions/ledger-session-a/primary");
    expect(vi.mocked(fetcher).mock.calls[1]![1]).toEqual(expect.objectContaining({ method: "POST", body: "{}" }));
    const pending = {
      ...ledger, primarySessionId: null,
      sessions: [{ ...session, primary: false, status: "pending", target: null }],
    };
    const blocked = vi.fn(async () => Response.json(pending)) as typeof fetch;
    await expect(selectOpenRigSeatPrimary({ seatId, sessionId }, blocked))
      .rejects.toThrow("Only an active session");
    expect(blocked).toHaveBeenCalledOnce();
  });
});
