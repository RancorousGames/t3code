import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  bindOpenRigSeat,
  assertOpenRigSendAcknowledged,
  decodeOpenRigAgents,
  decodeOpenRigSessions,
  decodeOpenRigSeatTopology,
  fetchOpenRigSeatTopology,
  fetchOpenRigAgents,
  fetchOpenRigAgentTasks,
  readOpenRigPolicyForBrowserSend,
  fetchOpenRigOperatorInbox,
  fetchOpenRigHumanResponse,
  invokeOpenRigSpeech,
  trimOpenRigSpeech,
  fetchOpenRigSessions,
  sendOpenRigMessage,
  runOpenRigSeatBrowserLifecycle,
  unbindOpenRigSeat,
} from "./openRig.ts";


describe("C05 optional read-only browser policy intake from frozen backend wire", () => {
  const browserSessionId = "b5fc0249-28e7-48c6-9591-6761b3fa3748";
  const conversationId = "6ad81f45-bd10-83ed-8128-6a3d584c876c";
  const input = { browserSessionId, conversationId };
  const seat = { id: "node-manager", rigId: "rig-one", rigName: "omni-command",
    logicalId: "project.manager", name: "T3 PM", role: "project-manager", parentIds: [], childIds: [] };
  const topology = { source: "openrig-rigspec-and-managed-ledger", seats: [seat] };
  const primary = {
    id: "managed-1", seatId: seat.id, operationId: "11111111-1111-4111-8111-111111111111",
    mode: "adopt", status: "active", primary: true,
    target: { kind: "chatgpt-conversation", conversationId, preferredBrowserSessionId: browserSessionId },
    targetKey: "chatgpt:" + conversationId, projectId: null, environmentId: null, threadId: null,
    conversationId, attachedTabUuid: browserSessionId,
    parentSeatId: null, parentManagedSessionId: null, provenance: "adopted",
    intent: {}, createdAt: "2026-10-21T15:00:00Z", updatedAt: "2026-10-21T15:00:00Z",
    error: null, observed: {}, modelCompletionVerified: false,
  };
  const ledger = { version: 1, seatId: seat.id, primarySessionId: primary.id,
    sessions: [primary], legacyBinding: null, legacyAutoImported: false,
    pendingRecoveryCount: 0, launchPolicy: {
      explicitOperationIdRequired: true, duplicateOperationRetrySafe: false,
      automaticUnknownRetry: false, implicitAdoption: false,
    } };
  const offer = (i: number) => ({
    qitemId: `qitem-${String(i).padStart(3, "0")}`,
    summary: null, body: `FULL BODY ${i}\n${"X".repeat(51)}`,
    sourceSession: "claimed-human@elsewhere", destinationSession: "project-manager@omni-command",
    state: "pending", priority: "routine", tags: ["coordination:policy"],
    expiresAt: "2020-01-01T00:00:00Z", claimedAt: null,
    tsCreated: "2026-10-21T15:00:00Z", tsUpdated: "2026-10-21T15:00:00Z",
    lastTransition: null,
  });
  const page = (items: ReturnType<typeof offer>[], nextCursor: string | null = null) => ({
    schema: "openrig-t3-policy-intake/v1", available: true, view: "policy",
    agent: { agentId: seat.id, rigId: seat.rigId, rigName: seat.rigName,
      canonicalSession: "project-manager@omni-command" },
    selector: { state: "pending", priority: "routine", tag: "coordination:policy", unclaimed: true },
    expirySemantics: "metadata_only_not_enforced",
    deliverySemantics: "read_only_not_offered_to_model_or_acknowledged",
    limit: 25, policies: items, hasMore: nextCursor !== null, nextCursor,
  });
  const feed = (pages: unknown[], options?: {ledger?: unknown; topology?: unknown}) => {
    const fetcher = vi.fn(async (url: string, request: RequestInit) => {
      expect(request.method).toBe("GET"); // Not a queue claim, ACK, spawn or send.
      expect(request.cache).toBe("no-store");
      expect(request.redirect).toBe("error");
      if (url.endsWith("/coordination/discover"))
        return Response.json(options?.topology ?? topology);
      if (url.endsWith("/agents/node-manager/sessions"))
        return Response.json(options?.ledger ?? ledger);
      if (url.includes("/tasks?view=policy&limit=25")) {
        const index = url.includes("&cursor=") ? Number(new URL(url).searchParams.get("cursor")?.slice(1)) : 0;
        return Response.json(pages[index] ?? { error: "missing_fixture" });
      }
      throw new Error("UNEXPECTED_URL " + url);
    }) as typeof fetch;
    return fetcher;
  };

  it("reads all 60+ entries over three fixed pages, dedupes a qitem only in this send, and preserves full expired bodies", async () => {
    const first = Array.from({length:25}, (_,i) => offer(i));
    const second = [offer(24), ...Array.from({length:24}, (_,i) => offer(i+25))];
    const third = Array.from({length:13}, (_,i) => offer(i+49));
    const fetcher = feed([page(first,"p1"),page(second,"p2"),page(third)]);
    const actual = await readOpenRigPolicyForBrowserSend(input, fetcher);
    expect(actual.status).toBe("ready");
    if (actual.status !== "ready") throw new Error(actual.reason);
    expect(actual.policies).toHaveLength(62);
    expect(actual.policies[61]?.body).toBe(offer(61).body);
    expect(actual.policies[0]?.expiresAt).toBe("2020-01-01T00:00:00Z");
    expect(actual).toMatchObject({agentId:seat.id,managedSessionId:primary.id,
      browserSessionId, conversationId, canonicalSession:"project-manager@omni-command"});
    const urls = vi.mocked(fetcher).mock.calls.map(([url])=>String(url));
    expect(urls.filter(u=>u.includes("/tasks?"))).toHaveLength(3);
    expect(urls).not.toContain(expect.stringContaining("/send"));
    const again = await readOpenRigPolicyForBrowserSend(input, feed([page([offer(0)])]));
    expect(again.status).toBe("ready"); // No cross-send suppression or ACK.
  });

  it("requires exact active chatgpt primary, not native, orphan, stale or foreign browser", async () => {
    const cases = [
      { ...primary, status:"pending" },
      { ...primary, mode:"native", target: {kind:"t3-thread", environmentId:"local",threadId:"x"} },
      { ...primary, attachedTabUuid: "b9999999-28e7-48c6-9591-6761b3fa3748" },
      { ...primary, conversationId: "6ad80000-bd10-83ed-8128-6a3d584c876c" },
      { ...primary, primary:false },
    ];
    for(const altered of cases){
      const result=await readOpenRigPolicyForBrowserSend(input,feed([],{ledger:{
        ...ledger, sessions:[altered],
        ...(altered.primary === false ? {primarySessionId:null} : {}),
      }}));
      expect(result).toMatchObject({status:"deferred",reason:"managed_primary_not_unique_or_not_active"});
    }
  });

  it("defers full enrichment on offline or wrong-shape endpoint while keeping HTTP strictly read-only", async () => {
    const offline = vi.fn(async ()=>{throw new Error("ECONNREFUSED")}) as unknown as typeof fetch;
    expect(await readOpenRigPolicyForBrowserSend(input,offline)).toMatchObject({
      status:"deferred", reason:"policy_offline_or_invalid_response",
    });
    for(const response of [
      page([offer(1)],"p1"), // partial continuation
      {...page([offer(1)]),schema:"openrig-t3-agent-tasks/v1",tasks:[]},
      {...page([offer(1)]),agent:{...page([],null).agent,agentId:"wrong"}},
      {...page([offer(1)]),policies:[{...offer(1), destinationSession:"other@rig"}]},
      {...page([offer(1)]),policies:[{...offer(1), body:"X".repeat(120_000)}]},
    ]){
      const fetcher=feed([response]);
      const result=await readOpenRigPolicyForBrowserSend(input,fetcher);
      expect(result.status).toBe("deferred");
    }
  });

  it("defers cursor loops, stale or duplicate canonical seat, and 503 without retries", async () => {
    const loop=feed([page([offer(1)],"p0")]);
    expect((await readOpenRigPolicyForBrowserSend(input,loop)).status).toBe("deferred");
    const foreign=feed([page([offer(1)])],{topology:{...topology,seats:[
      seat,{...seat,id:"node-second",role:"project-manager"},
    ]}});
    expect((await readOpenRigPolicyForBrowserSend(input,foreign)).status).toBe("deferred");
    const unavailable=vi.fn(async()=>Response.json({error:"canonical_task_read_model_unavailable"},{
      status:503,
    })) as typeof fetch;
    expect((await readOpenRigPolicyForBrowserSend(input,unavailable)).status).toBe("deferred");
    expect(unavailable).toHaveBeenCalledOnce();
  });
});

describe("live full-daemon RigSpec topology provenance", () => {
  const seat = {
    id: "node-real", rigId: "rig-real", rigName: "omni-command", name: "Worker C",
    logicalId: "execution-worker-c", role: "worker", parentIds: ["manager-real"], childIds: [],
  };

  it("accepts real full daemon managed-ledger source without inferring or mutating node identity", async () => {
    const payload = { source: "openrig-rigspec-and-managed-ledger", seats: [seat],
      callerIdentity: "UNKNOWN", relation: "all" };
    expect(decodeOpenRigSeatTopology(payload)).toEqual({
      source: "openrig-rigspec-and-managed-ledger", seats: [seat],
    });
    const fetcher = vi.fn(async () => Response.json(payload)) as typeof fetch;
    expect(await fetchOpenRigSeatTopology(fetcher)).toEqual({
      source: "openrig-rigspec-and-managed-ledger", seats: [seat],
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7433/api/integrations/t3/coordination/discover",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("keeps legacy RigSpec label but rejects a foreign discovery source or malformed nodes", () => {
    expect(decodeOpenRigSeatTopology({
      source: "openrig-rigspec", seats: [seat],
    })).toEqual({ source: "openrig-rigspec", seats: [seat] });
    expect(() => decodeOpenRigSeatTopology({ source: "claimed-by-browser", seats: [seat] }))
      .toThrow("Invalid OpenRig seat topology");
    expect(() => decodeOpenRigSeatTopology({
      source: "openrig-rigspec-and-managed-ledger", seats: [{ ...seat, id: "" }],
    })).toThrow("Invalid OpenRig agent");
  });
});

describe("human decision v2 desktop IPC and transport provenance", () => {
  const answer = {
    version: 2 as const,
    destination: "human@kernel",
    qitemId: "qitem-contract-1234",
    answers: [{ questionId: "scope", value: ["alpha", "beta"] }],
  };
  const receipt = {
    version: 2,
    qitemId: answer.qitemId,
    actor: "human@kernel",
    status: "recorded",
    complete: true,
    answeredCount: 1,
    remainingQuestionIds: [],
    replyQitemId: "qitem-reply-1234",
    acceptedIntoQueue: true,
    delivery: "queued",
    deliveredToAgent: false,
  };
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("never sends a human answer without a desktop-main-only 24+ character token", async () => {
    vi.stubEnv("OPENRIG_T3_HUMAN_ANSWER_TOKEN", "");
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(fetchOpenRigHumanResponse(answer, fetcher)).rejects.toThrow("not configured");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("POSTs to exact queue id with separate secret header and transport provenance, not general agent send", async () => {
    const secret = "desktop-main-private-secret-with-more-than-24-characters";
    vi.stubEnv("OPENRIG_T3_HUMAN_ANSWER_TOKEN", secret);
    vi.stubEnv("OPENRIG_AUTH_BEARER_TOKEN", "");
    const fetcher = vi.fn(async () => Response.json(receipt)) as typeof fetch;
    expect(await fetchOpenRigHumanResponse(answer, fetcher)).toEqual(receipt);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7433/api/integrations/t3/human-inbox/qitem-contract-1234/answer",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        redirect: "error",
        headers: expect.objectContaining({
          "x-openrig-human-answer-token": secret,
          "x-openrig-human-intent": "t3-desktop-ipc",
        }),
        body: JSON.stringify({
          version: 2,
          destination: "human@kernel",
          answers: [{ questionId: "scope", value: ["alpha", "beta"] }],
        }),
      }),
    );
    expect(JSON.stringify(vi.mocked(fetcher).mock.calls)).not.toContain("sourceType");
  });

  it("refuses false or mismatched receipts; fails closed on phase1 503 and conflicts", async () => {
    vi.stubEnv("OPENRIG_T3_HUMAN_ANSWER_TOKEN", "desktop-private-secret-of-sufficient-length");
    const unavailable = vi.fn(async () =>
      Response.json(
        { acceptedIntoQueue: false, error: "human_answer_writer_unavailable" },
        { status: 503 },
      ),
    ) as typeof fetch;
    await expect(fetchOpenRigHumanResponse(answer, unavailable)).rejects.toThrow("HTTP 503");
    const conflict = vi.fn(async () =>
      Response.json({ acceptedIntoQueue: false, error: "conflict" }, { status: 409 }),
    ) as typeof fetch;
    await expect(fetchOpenRigHumanResponse(answer, conflict)).rejects.toThrow("HTTP 409");
    const mismatch = vi.fn(async () =>
      Response.json({ ...receipt, qitemId: "qitem-other" }),
    ) as typeof fetch;
    await expect(fetchOpenRigHumanResponse(answer, mismatch)).rejects.toThrow("matching durable");
    const noQueueCommit = vi.fn(async () =>
      Response.json({ ...receipt, acceptedIntoQueue: false }),
    ) as typeof fetch;
    await expect(fetchOpenRigHumanResponse(answer, noQueueCommit)).rejects.toThrow(
      "matching durable",
    );
  });

  it("rejects untrusted recipient, malformed qitem id and oversized answers before networking", async () => {
    vi.stubEnv("OPENRIG_T3_HUMAN_ANSWER_TOKEN", "desktop-private-secret-of-sufficient-length");
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(
      fetchOpenRigHumanResponse({ ...answer, destination: "forged@external" }, fetcher),
    ).rejects.toThrow("target");
    await expect(
      fetchOpenRigHumanResponse({ ...answer, qitemId: "../agent/send" }, fetcher),
    ).rejects.toThrow("target");
    await expect(
      fetchOpenRigHumanResponse(
        { ...answer, answers: [{ questionId: "scope", value: ["x".repeat(121)] }] },
        fetcher,
      ),
    ).rejects.toThrow("answers");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("OpenRig local AISpeak notification adapter", () => {
  it("limits previews to the Python script's 20-word requirement AND 160 characters", () => {
    const source = Array.from({ length: 40 }, (_, i) => "word" + i).join(" ");
    const result = trimOpenRigSpeech(source);
    expect(result.trim().split(/\s+/u)).toHaveLength(20);
    expect(result.length).toBeLessThanOrEqual(160);
    expect(trimOpenRigSpeech("     ")).toBe("");
  });

  it("uses a fixed, existing local script with an argument array and no shell", async () => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const assertScript = vi.fn(async () => {});
    await invokeOpenRigSpeech(
      Array.from({ length: 30 }, () => "word").join(" "),
      run as never,
      assertScript,
    );
    expect(assertScript).toHaveBeenCalledWith(
      String.raw`B:\GDrive\Tools\13AITools\AISpeak\aispeak.py`,
    );
    expect(run).toHaveBeenCalledWith(
      "python",
      [
        String.raw`B:\GDrive\Tools\13AITools\AISpeak\aispeak.py`,
        "--silent",
        Array.from({ length: 20 }, () => "word").join(" "),
      ],
      expect.objectContaining({ windowsHide: true, timeout: 6000, maxBuffer: 32768 }),
    );
    await expect(invokeOpenRigSpeech("", run as never, assertScript)).rejects.toThrow(
      "Nothing to read",
    );
  });
});

describe("canonical OpenRig task-read MAIN bridge", () => {
  const seat = "node-42";
  const agent = { agentId: seat, rigId: "rig-1", rigName: "sample", canonicalSession: "builder@sample" };
  const task = {
    qitemId: "qitem-canonical-1", summary: "Review actual source", state: "in-progress",
    sourceSession: "manager@sample", destinationSession: "builder@sample",
    handedOffFrom: "qitem-prior", handedOffTo: null, chainOfRecord: ["qitem-prior"],
    evidenceRef: "handoff-document", closureReason: null, closureTarget: null,
    resolution: null, claimedAt: "2026-10-21T13:00:00Z",
    tsCreated: "2026-10-21T12:00:00Z", tsUpdated: "2026-10-21T13:00:00Z",
    lastNudgeAttempt: "2026-10-21T12:00:00Z",
    lastNudgeResult: "accepted:t3-browser;task_not_claimed",
    lastTransition: {
      transitionId: 17, ts: "2026-10-21T13:00:00Z", state: "in-progress",
      actorSession: "builder@sample", transitionNote: null,
      closureReason: null, closureTarget: null,
    },
  };
  const success = { schema: "openrig-t3-agent-tasks/v1", available: true, agent,
    limit: 25, tasks: [task], hasMore: false };
  const failure = (error: string, status: number) =>
    Response.json({ schema: "openrig-t3-agent-tasks/v1", available: false, error }, { status });

  it("GETs the exact fixed node route and preserves canonical states, lineage and delivery diagnostics", async () => {
    const fetcher = vi.fn(async () => Response.json(success)) as typeof fetch;
    expect(await fetchOpenRigAgentTasks(seat, fetcher)).toEqual(success);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7433/api/integrations/t3/agents/node-42/tasks?limit=25",
      expect.objectContaining({ method: "GET", cache: "no-store", redirect: "error",
        headers: { Accept: "application/json" } }),
    );
    expect(JSON.stringify(vi.mocked(fetcher).mock.calls)).not.toContain("operationId");
    const slashId = "seat/worker";
    const encodedFetcher = vi.fn(async () =>
      Response.json({ ...success, agent: { ...agent, agentId: slashId } })) as typeof fetch;
    await fetchOpenRigAgentTasks(slashId, encodedFetcher);
    expect(encodedFetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7433/api/integrations/t3/agents/seat%2Fworker/tasks?limit=25",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("distinguishes real empty from unavailable, unknown and ambiguous canonical seat", async () => {
    const empty = { ...success, tasks: [] };
    expect(await fetchOpenRigAgentTasks(seat,
      vi.fn(async () => Response.json(empty)) as typeof fetch)).toEqual(empty);
    for (const [status, error] of [
      [400, "limit_must_be_1_to_100"], [404, "agent_not_found"],
      [409, "ambiguous_canonical_seat"], [503, "canonical_task_read_model_unavailable"],
    ] as const) {
      expect(await fetchOpenRigAgentTasks(seat,
        vi.fn(async () => failure(error, status)) as typeof fetch)).toEqual({
        schema: "openrig-t3-agent-tasks/v1", available: false, error,
      });
    }
  });

  it("rejects malformed node identity, foreign responses and lying HTTP status/schema", async () => {
    const fetcher = vi.fn(async () => Response.json(success)) as typeof fetch;
    for (const id of ["", " ", "../node", "node/../other", "node?limit=100", "bad%2Fnode", " x"]) {
      await expect(fetchOpenRigAgentTasks(id, fetcher)).rejects.toThrow("node ID");
    }
    expect(fetcher).not.toHaveBeenCalled();
    await expect(fetchOpenRigAgentTasks(seat,
      vi.fn(async () => Response.json({ ...success, agent: { ...agent, agentId: "foreign" } })) as typeof fetch))
      .rejects.toThrow("mismatch");
    await expect(fetchOpenRigAgentTasks(seat,
      vi.fn(async () => Response.json({ ...success, tasks: [{ ...task, state: null }] })) as typeof fetch))
      .rejects.toThrow("Invalid OpenRig canonical task");
    await expect(fetchOpenRigAgentTasks(seat,
      vi.fn(async () => Response.json({ ...success, tasks: [{ ...task, destinationSession: "other@rig" }] })) as typeof fetch))
      .rejects.toThrow("mismatch");
    await expect(fetchOpenRigAgentTasks(seat,
      vi.fn(async () => failure("agent_not_found", 503)) as typeof fetch))
      .rejects.toThrow("error mismatch");
    await expect(fetchOpenRigAgentTasks(seat,
      vi.fn(async () => Response.json({ schema: "openrig-t3-agent-tasks/v1", available: false,
        error: "canonical_task_read_model_unavailable" })) as typeof fetch))
      .rejects.toThrow("mismatch");
  });
});


describe("exact managed primary ChatGPT lifecycle MAIN proxy", () => {
  const seatId = "seat/with space?#%";
  const sessionId = "managed/session?#";
  const browserSessionId = "browser-exact";
  const conversationId = "6ad5f3db-fadc-83eb-8eec-eed954bc6db6";
  const url = "https://chatgpt.com/c/" + conversationId;
  const current = {
    id: sessionId, seatId, operationId: "11111111-1111-4111-8111-111111111111",
    mode: "chatgpt", status: "active", primary: true,
    target: { kind: "chatgpt-conversation", conversationId },
    targetKey: "chatgpt-conversation:" + conversationId,
    projectId: null, environmentId: null, threadId: null, conversationId,
    attachedTabUuid: browserSessionId, parentSeatId: null, parentManagedSessionId: null,
    provenance: {}, intent: {}, createdAt: "2026-10-20T00:00:00Z",
    updatedAt: "2026-10-21T00:00:00Z", error: null, observed: null,
    modelCompletionVerified: false,
  };
  const projection = (
    session: Omit<typeof current, "attachedTabUuid" | "conversationId"> & {
      attachedTabUuid: string | null; conversationId: string | null;
    } = current, primarySessionId: string | null = sessionId,
  ) => ({
    version: 1, seatId, primarySessionId, sessions: [{ ...session, primary: primarySessionId === session.id }],
    legacyBinding: null, legacyAutoImported: false, pendingRecoveryCount: 0,
    launchPolicy: { explicitOperationIdRequired: true, duplicateOperationRetrySafe: false,
      automaticUnknownRetry: false, implicitAdoption: false },
  });
  const effect = {
    suspend: "t3_archived_local_browser_unmounted_no_model_completion_claim",
    resume: "t3_archive_restored_reattachment_on_render",
    recover: "safe_saved_conversation_navigation_requested_not_verified_loaded",
    stop: "local_t3_session_closed_not_chatgpt_cloud_deleted",
  } as const;
  const receipts = {
    suspend: { sessionId: browserSessionId, action: "archive", persisted: true, acknowledged: true,
      archive: { conversationUrl: url } },
    resume: { sessionId: browserSessionId, action: "restore", persisted: true, acknowledged: true,
      restored: true, conversationUrl: url },
    recover: { sessionId: browserSessionId, requestedNavigation: true, recoveredUrl: url },
    stop: { sessionId: browserSessionId, action: "change_state", persisted: true,
      acknowledged: true, state: "closed", closed: true, scope: "local-t3-session" },
  };
  const accepted = (action: keyof typeof effect) => ({
    version: 1, seatId, managedSessionId: sessionId,
    primarySessionId: action === "stop" ? null : sessionId,
    browserSessionId, conversationId, action, effect: effect[action],
    providerAcknowledged: true, modelCompletionVerified: false,
    managedStatus: action === "stop" ? "detached" : "active",
    managedPrimaryUnchanged: action !== "stop",
    source: "t3-existing-desktop-session-control", receipt: receipts[action],
  });
  function makeFetcher(action: keyof typeof effect, body: unknown = accepted(action)) {
    let posted = false;
    return vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method === "POST") {
        posted = true;
        return Response.json(body);
      }
      return Response.json(projection(
        action === "stop" && posted ? { ...current, status: "detached" } : current,
        action === "stop" && posted ? null : sessionId,
      ));
    });
  }
  it.each(["suspend", "resume", "recover", "stop"] as const)(
    "correlates exact seat/browser/conversation, control receipt and readback for %s",
    async (action) => {
      const fetcher = makeFetcher(action);
      const input = action === "stop"
        ? { seatId, sessionId, action, confirm: "close-local-t3-session" as const }
        : { seatId, sessionId, action };
      const result = await runOpenRigSeatBrowserLifecycle(input, fetcher);
      expect(result).toMatchObject(accepted(action));
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(fetcher.mock.calls[1]?.[0]).toBe(
        "http://127.0.0.1:7433/api/integrations/t3/agents/seat%2Fwith%20space%3F%23%25/sessions/managed%2Fsession%3F%23/lifecycle",
      );
      expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual(action === "stop"
        ? { action, confirm: "close-local-t3-session" } : { action });
      expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "POST", cache: "no-store", redirect: "error" });
    },
  );
  it("allows an exact adopted ChatGPT primary, not a native thread", async () => {
    const adopted = { ...current, mode: "adopt" };
    const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      init?.method === "POST" ? Response.json(accepted("resume")) : Response.json(projection(adopted)));
    expect(await runOpenRigSeatBrowserLifecycle({ seatId, sessionId, action: "resume" }, fetcher))
      .toMatchObject(accepted("resume"));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("refuses native/non-primary/foreign/uncertain sessions before any POST", async () => {
    for (const changed of [
      { ...current, mode: "native" },
      { ...current, status: "indeterminate" },
      { ...current, seatId: "foreign" },
      { ...current, attachedTabUuid: null },
      { ...current, conversationId: null },
    ]) {
      const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) => Response.json(projection(changed)));
      await expect(runOpenRigSeatBrowserLifecycle({ seatId, sessionId, action: "suspend" }, fetcher)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) => Response.json(projection(current, null)));
    await expect(runOpenRigSeatBrowserLifecycle({ seatId, sessionId, action: "resume" }, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid stop confirmation, unsafe fields and unsupported action without network", async () => {
    const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) => Response.json({}));
    for (const input of [
      { seatId, sessionId, action: "stop" },
      { seatId, sessionId, action: "resume", confirm: "close-local-t3-session" },
      { seatId, sessionId, action: "reparent" },
      { seatId, sessionId, action: "recover", force: true },
    ]) {
      await expect(runOpenRigSeatBrowserLifecycle(input as never, fetcher)).rejects.toThrow("Invalid managed browser lifecycle");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects mismatched or fabricated 200 receipts, does not repeat POST", async () => {
    for (const body of [
      { ...accepted("suspend"), seatId: "other" },
      { ...accepted("suspend"), browserSessionId: "other-tab" },
      { ...accepted("suspend"), modelCompletionVerified: true },
      { ...accepted("suspend"), effect: effect.stop },
      { ...accepted("suspend"), receipt: { ...receipts.suspend, sessionId: "other-tab" } },
      { ...accepted("suspend"), receipt: { ...receipts.suspend, acknowledged: false } },
      { ...accepted("suspend"), managedPrimaryUnchanged: false },
      { ...accepted("suspend"), providerAcknowledged: false },
    ]) {
      const fetcher = makeFetcher("suspend", body);
      await expect(runOpenRigSeatBrowserLifecycle({ seatId, sessionId, action: "suspend" }, fetcher))
        .rejects.toThrow(/receipt/);
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    }
  });
  it("surfaces 400/404/409/503 refusals and timeout with zero automatic retry", async () => {
    for (const code of [400, 404, 409, 503]) {
      const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => init?.method === "POST"
        ? Response.json({ error: "backend refusal", retrySafe: false }, { status: code })
        : Response.json(projection()));
      await expect(runOpenRigSeatBrowserLifecycle({ seatId, sessionId, action: "recover" }, fetcher))
        .rejects.toThrow("HTTP " + code);
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    }
    const timeout = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method === "POST") throw new Error("request timed out");
      return Response.json(projection());
    });
    await expect(runOpenRigSeatBrowserLifecycle({ seatId, sessionId, action: "stop", confirm: "close-local-t3-session" }, timeout))
      .rejects.toThrow("request timed out");
    expect(timeout).toHaveBeenCalledTimes(2);
  });
  it("rejects local close receipt without verified durable detached state", async () => {
    const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      init?.method === "POST" ? Response.json(accepted("stop")) : Response.json(projection()));
    await expect(runOpenRigSeatBrowserLifecycle({ seatId, sessionId, action: "stop", confirm: "close-local-t3-session" }, fetcher))
      .rejects.toThrow("ledger has not confirmed");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe("local OpenRig desktop proxy", () => {
  it("reads the canonical recipient-scoped human inbox, including action flags", async () => {
    const sample = {
      available: true,
      address: "human@kernel",
      addresses: [{ address: "human@kernel", label: "Local operator seat" }],
      items: [
        {
          id: "q-001",
          sender: "builder@rig",
          subject: "Approval",
          body: "Review the proof",
          createdAt: "2026-10-18T13:00:00.000Z",
          state: "blocked",
          requiresAction: true,
          sourceType: "human_gate",
        },
      ],
      pendingCount: 1,
      count: 1,
      truncated: false,
    };
    const fetcher = vi.fn(async () => Response.json(sample)) as typeof fetch;
    expect(await fetchOpenRigOperatorInbox("human@kernel", fetcher)).toEqual(sample);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7433/api/integrations/t3/human-inbox?destination=human%40kernel&limit=50",
      expect.objectContaining({ method: "GET", redirect: "error", cache: "no-store" }),
    );
  });

  it("preserves HTTP 503 unavailable rather than misreporting an empty inbox", async () => {
    const unavailable = {
      available: false,
      reason: "Full OpenRig queue daemon not running",
      address: "human@kernel",
      addresses: [{ address: "human@kernel", label: "Local operator seat" }],
      items: [],
      pendingCount: null,
      count: 0,
      truncated: false,
    };
    const fetcher = vi.fn(async () => Response.json(unavailable, { status: 503 })) as typeof fetch;
    expect(await fetchOpenRigOperatorInbox("human@kernel", fetcher)).toEqual(unavailable);
    await expect(fetchOpenRigOperatorInbox("x@external", fetcher)).rejects.toThrow(
      "destination mismatch",
    );
    expect(await fetchOpenRigOperatorInbox("human@kernel", fetcher)).toMatchObject({
      available: false,
      pendingCount: null,
    });
  });

  it("rejects unknown recipient, malformed result, wrong destination and fictitious addresses", async () => {
    const forbidden = vi.fn(async () =>
      Response.json({ error: "unknown_human_address" }, { status: 400 }),
    ) as typeof fetch;
    await expect(fetchOpenRigOperatorInbox("human-operator@external", forbidden)).rejects.toThrow();
    await expect(fetchOpenRigOperatorInbox("not-an-address", forbidden)).rejects.toThrow("Invalid");
    expect(forbidden).toHaveBeenCalledTimes(1);
    const mismatched = vi.fn(async () =>
      Response.json({
        available: true,
        address: "other@external",
        addresses: [],
        items: [],
        pendingCount: 0,
        count: 0,
        truncated: false,
      }),
    ) as typeof fetch;
    await expect(fetchOpenRigOperatorInbox("human@kernel", mismatched)).rejects.toThrow(
      "destination mismatch",
    );
  });

  it("accepts bridge agent lists and keeps task/status metadata", () => {
    expect(
      decodeOpenRigAgents({
        agents: [
          {
            id: "opaque:42",
            name: "Implementer",
            status: "working",
            role: "worker",
            task: "T3 sidebar",
          },
        ],
      }),
    ).toEqual([
      {
        id: "opaque:42",
        name: "Implementer",
        status: "working",
        role: "worker",
        task: "T3 sidebar",
        bound: false,
        bindingKind: null,
        sessionId: null,
        sessionTitle: null,
      },
    ]);
    expect(decodeOpenRigAgents([{ id: "x", name: "Idle", status: "idle" }])).toEqual([
      {
        id: "x",
        name: "Idle",
        status: "idle",
        role: null,
        task: null,
        bound: false,
        bindingKind: null,
        sessionId: null,
        sessionTitle: null,
      },
    ]);
    expect(() => decodeOpenRigAgents({ sessions: [] })).toThrow("Invalid OpenRig agents response");
  });

  it("fetches only the fixed loopback agents endpoint, without redirects", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        agents: [{ id: "r-1", name: "Researcher", status: "idle", task: "Review" }],
      }),
    ) as typeof fetch;
    expect(await fetchOpenRigAgents(fetcher)).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7433/api/integrations/t3/agents",
      expect.objectContaining({ method: "GET", redirect: "error", cache: "no-store" }),
    );
  });

  it("lists existing T3 sessions and links/unlinks them to OpenRig seats", async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) =>
      init.method === "DELETE"
        ? Response.json({ unbound: true })
        : url.endsWith("/binding")
          ? Response.json({ binding: { nodeId: "seat/1", target: JSON.parse(String(init.body)).target } })
          : url.endsWith("/bind")
            ? Response.json({ binding: { nodeId: "seat/1", sessionId: "browser-1" } })
            : Response.json({
        conversations: [
          {
            id: "browser:browser-1",
            title: "Wartribes",
            project: "Wartribes",
            status: "done_or_idle",
            kind: "legacy-browser",
            target: { kind: "legacy-browser", sessionId: "browser-1" },
          },
          {
            id: "t3:local:thread-a",
            title: "Global Manager",
            project: "Tools",
            status: "idle",
            kind: "t3-thread",
            target: { kind: "t3-thread", environmentId: "local", threadId: "thread-a" },
          },
        ],
      }),
    ) as typeof fetch;
    expect(decodeOpenRigSessions({ conversations: [] })).toEqual([]);
    expect(await fetchOpenRigSessions(fetcher)).toEqual([
      {
        id: "browser:browser-1",
        title: "Wartribes",
        project: "Wartribes",
        status: "done_or_idle",
        kind: "legacy-browser",
        provider: null,
        target: { kind: "legacy-browser", sessionId: "browser-1" },
      },
      {
        id: "t3:local:thread-a",
        title: "Global Manager",
        project: "Tools",
        status: "idle",
        kind: "t3-thread",
        provider: null,
        target: { kind: "t3-thread", environmentId: "local", threadId: "thread-a" },
      },
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7433/api/integrations/t3/conversations",
      expect.objectContaining({ method: "GET" }),
    );
    await bindOpenRigSeat({ id: "seat/1", sessionId: "browser-1" }, fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7433/api/integrations/t3/agents/seat%2F1/bind",
      expect.objectContaining({ method: "POST", body: '{"sessionId":"browser-1"}' }),
    );
    await bindOpenRigSeat(
      {
        id: "seat/1",
        target: {
          kind: "t3-thread",
          environmentId: "local",
          threadId: "thread-a",
        },
      },
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7433/api/integrations/t3/agents/seat%2F1/binding",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          target: { kind: "t3-thread", environmentId: "local", threadId: "thread-a" },
        }),
      }),
    );
    await unbindOpenRigSeat("seat/1", fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7433/api/integrations/t3/agents/seat%2F1/bind",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  const nativeTarget = { kind: "t3-thread", environmentId: "env1", threadId: "thread1" };
  function managedLedger(seatId: string) {
    return { version: 1, seatId, primarySessionId: "managed-session-1", legacyBinding: null,
      legacyAutoImported: false, pendingRecoveryCount: 0,
      launchPolicy: { explicitOperationIdRequired: true, duplicateOperationRetrySafe: false,
        automaticUnknownRetry: false, implicitAdoption: false },
      sessions: [{ id: "managed-session-1", seatId, operationId: "11111111-1111-4111-8111-111111111111",
        mode: "native", status: "active", primary: true, target: nativeTarget,
        targetKey: "t3:env1:thread1", projectId: "project1", environmentId: "env1", threadId: "thread1",
        conversationId: null, attachedTabUuid: null, parentSeatId: null, parentManagedSessionId: null,
        provenance: "openrig-managed-launch", intent: {}, createdAt: "2026-10-19T00:00:00Z",
        updatedAt: "2026-10-19T00:00:00Z", error: null, observed: { available: true },
        modelCompletionVerified: false }],
    };
  }

  it("sends an opaque ID as one encoded segment and a message body", async () => {
    const fetcher = vi.fn(async (url: string) => url.endsWith("/sessions")
      ? Response.json(managedLedger("agent/with space?#%")) : Response.json({
      target: { kind: "t3-thread", environmentId: "env1", threadId: "thread1" },
      result: { messageSent: true, messageId: "request-1", threadId: "thread1", environmentId: "env1" },
    })) as typeof fetch;
    await sendOpenRigMessage({ id: "agent/with space?#%", message: "Status please" }, fetcher);
    const [readUrl, readOptions] = vi.mocked(fetcher).mock.calls[0]!;
    expect(readUrl).toBe("http://127.0.0.1:7433/api/integrations/t3/agents/agent%2Fwith%20space%3F%23%25/sessions");
    expect(readOptions).toEqual(expect.objectContaining({ method: "GET" }));
    const [url, options] = vi.mocked(fetcher).mock.calls[1]!;
    expect(url).toBe(
      "http://127.0.0.1:7433/api/integrations/t3/agents/agent%2Fwith%20space%3F%23%25/send",
    );
    expect(options).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: "Status please" }),
      }),
    );
    await expect(sendOpenRigMessage({ id: "", message: "x" }, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never sends through legacy binding when there is no managed primary", async () => {
    const onlyLegacy = { ...managedLedger("seat1"), primarySessionId: null, sessions: [],
      legacyBinding: { nodeId: "seat1", sessionId: "browser-1" } };
    const fetcher = vi.fn(async () => Response.json(onlyLegacy)) as typeof fetch;
    await expect(sendOpenRigMessage({ id: "seat1", message: "test" }, fetcher))
      .rejects.toThrow("no routable active managed primary");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.mocked(fetcher).mock.calls[0]![1]?.method).toBe("GET");
  });

  it("never treats HTTP 200, malformed, stale or unguarded receipts as delivery", async () => {
    expect(() => assertOpenRigSendAcknowledged({})).toThrow("acknowledgement");
    const target = { kind: "t3-thread", environmentId: "env1", threadId: "thread1" };
    expect(() => assertOpenRigSendAcknowledged({ target, result: { messageSent: true, messageId: "id", threadId: "other", environmentId: "env1" } })).toThrow("acknowledgement");
    expect(() => assertOpenRigSendAcknowledged({
      target: { kind: "chatgpt-conversation", conversationId: "abc" },
      result: { messageSent: true, conversationGuardValidated: false, verifiedConversationId: "abc" },
    })).toThrow("acknowledgement");
    expect(() => assertOpenRigSendAcknowledged({
      target: { kind: "chatgpt-conversation", conversationId: "abc" },
      result: { messageSent: true, conversationGuardValidated: true, verifiedConversationId: "abc" },
    })).not.toThrow();
    expect(() => assertOpenRigSendAcknowledged({
      sessionId: "browser-1", result: { messageSent: true, sessionId: "browser-1" },
    })).toThrow("acknowledgement");
    const fetcher = vi.fn(async (url: string) => url.endsWith("/sessions")
      ? Response.json(managedLedger("seat1"))
      : Response.json({ target, result: { messageSent: false } })) as typeof fetch;
    await expect(sendOpenRigMessage({ id: "seat1", message: "test" }, fetcher)).rejects.toThrow("outcome unknown");
  });

  it("rejects HTTP 200 binding responses with no matching durable target", async () => {
    const fake = vi.fn(async () => Response.json({ ok: true })) as typeof fetch;
    await expect(bindOpenRigSeat({
      id: "seat1", target: { kind: "t3-thread", environmentId: "env1", threadId: "thread1" },
    }, fake)).rejects.toThrow("confirm");
    await expect(unbindOpenRigSeat("seat1", fake)).rejects.toThrow("confirm");
  });

  it("rejects upstream errors; sending is never reported successful on 500", async () => {
    const fetcher = vi.fn(async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(fetchOpenRigAgents(fetcher)).rejects.toThrow("HTTP 500");
    await expect(sendOpenRigMessage({ id: "agent", message: "hello" }, fetcher)).rejects.toThrow(
      "HTTP 500",
    );
  });
});
