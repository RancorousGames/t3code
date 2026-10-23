import { assert, describe, it } from "@effect/vitest";
import {
  compileNativeSpawnExecutionPlanV1,
  type NativeSpawnExecutionEvidenceV1,
  type NativeSpawnExecutionPlanV1,
} from "./NativeSpawnExecutionPlan.ts";
import {
  assertT3ProviderFrameV1,
  createIsolatedT3OpenRigApprovalProtocol,
  createT3OpenRigApprovalClient,
  createT3OpenRigApprovalClientV2,
  assertT3CanonicalV2AuthorityObservation,
  assertT3CanonicalV2Correlation,
  type IsolatedT3ApprovalHarnessV1,
  type NativeSpawnOutcomeV1,
  type T3ProviderFrameV1,
  type T3ProviderFrameReplyV1,
} from "./T3OpenRigApprovalClient.ts";

const THREAD = "e4c83f52-9bee-4ea8-bf26-13e4b1cb9840";
const MESSAGE = "8d0431ae-b271-483e-a52e-54f843f7ba1c";
const RESERVATION = "e6e37647-34b7-42ee-9aa0-c5dc58bfbd12";

async function rejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert.isDefined(error, "must fail closed");
  assert.isTrue(pattern.test(String(error)), `expected ${pattern} in ${String(error)}`);
}

function facts(): NativeSpawnExecutionEvidenceV1 {
  return {
    operationKind: "create-and-start",
    origin: "desktop-managed-local",
    threadId: THREAD,
    initialMessageId: MESSAGE,
    initialMessageText: "Write a focused review.",
    composedProviderPrompt: "Write a focused review.",
    title: "Review",
    environmentId: "environment:main",
    serverGeneration: "desktop:1234:gen-1",
    projectId: "project:alpha",
    providerInstanceId: "codex",
    driver: "codex",
    modelSlug: "gpt-5.6",
    providerState: {
      ready: true,
      authenticated: true,
      installed: true,
      available: true,
      adapterRegistered: true,
      projectEnabled: true,
      catalogModels: ["gpt-5.6", "gpt-6-luna"],
    },
    effectiveOptions: [{ id: "reasoningEffort", value: "medium" }],
    optionsCompiledFromFinalAdapterSettings: true,
    reasoningEffort: "medium",
    runtimeMode: "approval-required",
    interactionMode: "default",
    attachments: [],
    context: [],
    workspace: {
      root: "D:/repo",
      executionPath: "D:/repo",
      strategy: "root",
      branch: null,
      baseRef: null,
      fullyResolvedWithoutEffects: true,
    },
    sourceThreadId: null,
    sourceRunId: null,
    sourceProviderSessionId: null,
    importedOrReused: false,
  };
}

type Fake = {
  harness: IsolatedT3ApprovalHarnessV1;
  sent: T3ProviderFrameV1[];
  updatePlan: (p: NativeSpawnExecutionPlanV1) => void;
  updateOutcome: (value: NativeSpawnOutcomeV1) => void;
  onFrame: (fn: (frame: T3ProviderFrameV1) => Promise<T3ProviderFrameReplyV1>) => void;
};

function fake(plan: NativeSpawnExecutionPlanV1): Fake {
  let current = plan;
  let observed: NativeSpawnOutcomeV1 = { kind: "indeterminate", reason: "missing-receipt" };
  let counter = 1;
  const sent: T3ProviderFrameV1[] = [];
  let handler = async (frame: T3ProviderFrameV1): Promise<T3ProviderFrameReplyV1> => {
    switch (frame.method) {
      case "provider.request":
        return {
          method: frame.method,
          requestId: frame.requestId,
          operationId: frame.operationId,
          descriptorSha256: frame.descriptorSha256,
          status: "pending_approval",
          stateVersion: 1,
        };
      case "provider.reserve":
        return {
          method: frame.method,
          requestId: frame.requestId,
          operationId: frame.operationId,
          descriptorSha256: frame.descriptorSha256,
          status: "reserved_for_execution",
          reservationId: RESERVATION,
          stateVersion: 2,
          createPermittedOnce: true,
        };
      case "provider.outcome":
        return {
          method: frame.method,
          requestId: frame.requestId,
          operationId: frame.operationId,
          reservationId: frame.reservationId,
          status: observed.kind,
        };
    }
  };
  return {
    sent,
    updatePlan: (next) => {
      current = next;
    },
    updateOutcome: (next) => {
      observed = next;
    },
    onFrame: (next) => {
      handler = next;
    },
    harness: {
      getCurrentPlan: async () => current,
      nextRequestId: () => `45dac600-9b45-4d58-8e36-${(counter++).toString(16).padStart(12, "0")}`,
      observePersistedOutcome: async () => observed,
      sendFrame: async (frame) => {
        sent.push(frame);
        return handler(frame);
      },
    },
  };
}

describe("inactive T3OpenRigApprovalClient", () => {
  it("production constructor always hard denies, even for exact Luna", async () => {
    const lunaPlan = await compileNativeSpawnExecutionPlanV1({
      ...facts(),
      modelSlug: "gpt-6-luna",
    });
    const actual = createT3OpenRigApprovalClient();
    await rejects(actual.request(lunaPlan), /not implemented/);
    await rejects(actual.reserve(lunaPlan, "command:create"), /not enrolled/);
    await rejects(
      actual.outcome(lunaPlan, { kind: "indeterminate", reason: "process-crashed" }),
      /not enrolled/,
    );
  });

  it("allows only strict typed bounded provider correlation, never operator method/authority data", () => {
    const base: T3ProviderFrameV1 = {
      protocolVersion: 1,
      requestId: "45dac600-9b45-4d58-8e36-000000000001",
      method: "provider.request",
      operationId: THREAD,
      descriptorSha256: "a".repeat(64),
    };
    assertT3ProviderFrameV1(base);
    const opaque = {
      ...base,
      operationId: "thread:mcp:provider%3Asession:key%25with%2Fslash:0",
    };
    assertT3ProviderFrameV1(opaque);
    for (const [bad, description] of [
      [{ ...base, method: "operator.decide" }, "operator"],
      [{ ...base, claimedOperator: "human@kernel" }, "operator claim"],
      [{ ...base, descriptor: { verificationState: "verified" } }, "client descriptor"],
      [{ ...base, descriptorSha256: "not-a-digest" }, "digest"],
      [{ ...base, operationId: "mcp:fake" }, "not opaque"],
      [{ ...base, requestId: "not-uuid" }, "request ID"],
      [{ ...base, operationId: "thread:mcp:a:key%2f:0" }, "lowercase percent"],
    ] as const) {
      assert.throws(() => assertT3ProviderFrameV1(bad), undefined, undefined, description);
    }
    assert.throws(() =>
      assertT3ProviderFrameV1({
        protocolVersion: 1,
        requestId: base.requestId,
        method: "provider.reserve",
        operationId: THREAD,
        descriptorSha256: base.descriptorSha256,
        expectedVersion: 0,
      }),
    );
  });

  it("isolated fake request/reserve makes a private one-attempt binding; no runtime spawn integration", async () => {
    const plan = await compileNativeSpawnExecutionPlanV1(facts());
    const simulation = fake(plan);
    const client = createIsolatedT3OpenRigApprovalProtocol(simulation.harness);
    const pending = await client.request(plan);
    assert.deepEqual(pending, {
      operationId: THREAD,
      descriptorSha256: plan.descriptorSha256,
      expectedVersion: 1,
    });
    const reserved = await client.reserve(plan, "command:exact-create");
    assert.equal(reserved.binding.operationId, THREAD);
    assert.equal(reserved.binding.initialMessageId, MESSAGE);
    assert.equal(reserved.binding.reservationId, RESERVATION);
    assert.deepEqual(reserved.binding.expectedEffects, [
      "thread.create",
      "message.dispatch",
      "provider.start",
    ]);
    assert.throws(() => JSON.stringify(reserved.permit), /cannot be serialized/);
    reserved.permit.claimOnce(reserved.binding);
    assert.throws(() => reserved.permit.claimOnce(reserved.binding), /already spent/);
    await rejects(client.reserve(plan, "command:exact-create"), /No unspent/);
    await rejects(client.request(plan), /Duplicate request/);
    assert.deepEqual(
      simulation.sent.map((frame) => frame.method),
      ["provider.request", "provider.reserve"],
    );
    assert.isTrue(simulation.sent.every((frame) => Object.keys(frame).length <= 6));
    assert.isTrue(simulation.sent.every((frame) => !("human" in frame) && !("permit" in frame)));
  });

  it("burns a simulated attempt when wrong child, message, command or effect scope is claimed", async () => {
    const plan = await compileNativeSpawnExecutionPlanV1(facts());
    const simulation = fake(plan);
    const client = createIsolatedT3OpenRigApprovalProtocol(simulation.harness);
    await client.request(plan);
    const { binding, permit } = await client.reserve(plan, "command:one");
    assert.throws(
      () =>
        permit.claimOnce({
          ...binding,
          initialMessageId: THREAD,
        }),
      /binding changed/,
    );
    assert.throws(() => permit.claimOnce(binding), /already spent/);
    assert.equal(simulation.sent.length, 2);
  });

  it("never retries a lost reserve response or supplies a permit", async () => {
    const plan = await compileNativeSpawnExecutionPlanV1(facts());
    const simulation = fake(plan);
    let attempts = 0;
    simulation.onFrame(async (frame) => {
      if (frame.method === "provider.reserve") {
        attempts++;
        throw new Error("reply disappeared after canonical CAS");
      }
      return {
        method: "provider.request",
        requestId: frame.requestId,
        operationId: frame.operationId,
        descriptorSha256: plan.descriptorSha256,
        status: "pending_approval",
        stateVersion: 1,
      };
    });
    const client = createIsolatedT3OpenRigApprovalProtocol(simulation.harness);
    await client.request(plan);
    await rejects(client.reserve(plan, "command:once"), /reply disappeared/);
    await rejects(client.reserve(plan, "command:once"), /No unspent/);
    assert.equal(attempts, 1);
    assert.equal(simulation.sent.filter((frame) => frame.method === "provider.reserve").length, 1);
  });

  it("rechecks generation/effective settings before reserve; drift burns attempt with no reserve RPC", async () => {
    const plan = await compileNativeSpawnExecutionPlanV1(facts());
    const simulation = fake(plan);
    const client = createIsolatedT3OpenRigApprovalProtocol(simulation.harness);
    await client.request(plan);
    const drift = await compileNativeSpawnExecutionPlanV1({
      ...facts(),
      serverGeneration: "desktop:1234:gen-2",
    });
    simulation.updatePlan(drift);
    await rejects(client.reserve(plan, "command:once"), /plan drift/);
    await rejects(client.reserve(plan, "command:once"), /No unspent/);
    assert.deepEqual(
      simulation.sent.map((frame) => frame.method),
      ["provider.request"],
    );
  });

  it("rejects wrong reserve version/digest and mismatched original descriptor", async () => {
    const plan = await compileNativeSpawnExecutionPlanV1(facts());
    const simulation = fake(plan);
    simulation.onFrame(async (frame) =>
      frame.method === "provider.request"
        ? {
            method: frame.method,
            requestId: frame.requestId,
            operationId: frame.operationId,
            descriptorSha256: frame.descriptorSha256,
            status: "pending_approval",
            stateVersion: 1,
          }
        : {
            method: "provider.reserve",
            requestId: frame.requestId,
            operationId: frame.operationId,
            descriptorSha256: "0".repeat(64),
            status: "reserved_for_execution",
            reservationId: RESERVATION,
            stateVersion: 2,
            createPermittedOnce: true,
          },
    );
    const client = createIsolatedT3OpenRigApprovalProtocol(simulation.harness);
    await client.request(plan);
    await rejects(client.reserve(plan, "command:one"), /positive single-use/);
    const tampered = { ...plan, descriptor: { ...plan.descriptor, modelSlug: "codex-cheat" } };
    const second = createIsolatedT3OpenRigApprovalProtocol(fake(plan).harness);
    await rejects(second.request(tampered), /altered after immutable/);
  });

  it("outcome needs actual matching persisted receipt, never user-claimed success", async () => {
    const plan = await compileNativeSpawnExecutionPlanV1(facts());
    const simulation = fake(plan);
    const client = createIsolatedT3OpenRigApprovalProtocol(simulation.harness);
    await client.request(plan);
    await client.reserve(plan, "command:create");
    const falseLaunched: NativeSpawnOutcomeV1 = {
      kind: "launched",
      threadId: THREAD,
      providerInstanceId: "codex",
      driver: "codex",
      modelSlug: "gpt-5.6",
      initialMessageId: MESSAGE,
      persistenceReceiptId: "receipt:1",
    };
    await rejects(client.outcome(plan, falseLaunched), /not observed in T3 persisted/);
    await rejects(client.outcome(plan, falseLaunched), /Outcome without exact/);
    assert.deepEqual(
      simulation.sent.map((frame) => frame.method),
      ["provider.request", "provider.reserve"],
    );
  });

  it("reports only a verified simulated launched or indeterminate terminal outcome", async () => {
    for (const result of [
      { kind: "indeterminate", reason: "process-crashed" } as const,
      {
        kind: "launched",
        threadId: THREAD,
        providerInstanceId: "codex",
        driver: "codex",
        modelSlug: "gpt-5.6",
        initialMessageId: MESSAGE,
        persistenceReceiptId: "receipt:create:1",
      } as const,
    ]) {
      const plan = await compileNativeSpawnExecutionPlanV1(facts());
      const simulation = fake(plan);
      simulation.updateOutcome(result);
      const client = createIsolatedT3OpenRigApprovalProtocol(simulation.harness);
      await client.request(plan);
      await client.reserve(plan, "command:once");
      assert.equal(await client.outcome(plan, result), result.kind);
      await rejects(client.outcome(plan, result), /Outcome without exact/);
      assert.deepEqual(
        simulation.sent.map((frame) => frame.method),
        ["provider.request", "provider.reserve", "provider.outcome"],
      );
    }
  });

  it("never treats an opaque MCP operation as supported UUID admission", async () => {
    const plan = await compileNativeSpawnExecutionPlanV1(facts());
    const simulation = fake(plan);
    const client = createIsolatedT3OpenRigApprovalProtocol(simulation.harness);
    const forged = { ...plan, operationId: "thread:mcp:one:key%2F:0" };
    await rejects(client.request(forged), /Plan identity/);
    assert.equal(simulation.sent.length, 0);
  });
});

describe("canonical A V2 provider-only inactive wire", () => {
  const project = "project:fixture:alpha";
  const child = "thread:project:project%3Afixture%3Aalpha:11111111-1111-4111-8111-111111111111";
  const digest = "a".repeat(64);
  const requestId = "45dac600-9b45-4d58-8e36-000000000001";

  it("accepts only version-1 transport envelope with actual canonical-A V2 ID", () => {
    const base = {
      protocolVersion: 1,
      requestId,
      method: "provider.request",
      operationId: child,
      descriptorSha256: digest,
    } as const;
    assertT3CanonicalV2Correlation(base, project);
    assertT3CanonicalV2Correlation(
      {
        ...base,
        method: "provider.reserve",
        expectedVersion: 2,
      },
      project,
    );
    assertT3CanonicalV2Correlation(
      {
        ...base,
        method: "provider.admitExactLuna",
        expectedVersion: 1,
      },
      project,
    );
    assertT3CanonicalV2Correlation(
      {
        protocolVersion: 1,
        requestId,
        method: "provider.outcome",
        operationId: child,
        reservationId: RESERVATION,
      },
      project,
    );
    for (const bad of [
      { ...base, method: "operator.decide" },
      { ...base, claimedIsHuman: true },
      { ...base, operationId: "thread:mcp:one:key%2F:0" },
      { ...base, operationId: child.replace("project%3A", "project%3a") },
      { ...base, descriptorSha256: "v1-upgrade" },
      { ...base, method: "provider.admitExactLuna", expectedVersion: 0 },
    ]) {
      assert.throws(() => assertT3CanonicalV2Correlation(bad, project));
    }
  });

  it("preserves non-human exact Luna admission provenance in a strict source-only row shape", () => {
    const base = {
      requestVersion: 2,
      operationId: child,
      descriptorSha256: digest,
      admissionTrack: "exact_luna_policy",
      stateVersion: 2,
      status: "exempt_admitted",
      humanDestination: null,
      decidedBy: null,
      policyId: "exact-codex-gpt-6-luna-v1",
      policyEvidenceSha256: "b".repeat(64),
    } as const;
    assertT3CanonicalV2AuthorityObservation(base, { operationId: child, descriptorSha256: digest });
    assertT3CanonicalV2AuthorityObservation(
      {
        ...base,
        stateVersion: 1,
        status: "pending_policy_admission",
        policyId: null,
        policyEvidenceSha256: null,
      },
      { operationId: child, descriptorSha256: digest },
    );
    for (const mismatch of [
      { ...base, decidedBy: "human@kernel" },
      { ...base, humanDestination: "human@kernel" },
      { ...base, policyId: null },
      { ...base, status: "approved" },
      { ...base, descriptorSha256: "c".repeat(64) },
      { ...base, requestVersion: 1 },
      { ...base, admissionTrack: "human" },
    ]) {
      assert.throws(() =>
        assertT3CanonicalV2AuthorityObservation(mismatch, {
          operationId: child,
          descriptorSha256: digest,
        }),
      );
    }
  });

  it("separates human and Luna policy track even for structurally matching state", () => {
    const human = {
      requestVersion: 2,
      operationId: child,
      descriptorSha256: digest,
      admissionTrack: "human",
      stateVersion: 2,
      status: "approved",
      humanDestination: "human@kernel",
      decidedBy: "human@kernel",
      policyId: null,
      policyEvidenceSha256: null,
    } as const;
    assertT3CanonicalV2AuthorityObservation(human, {
      operationId: child,
      descriptorSha256: digest,
    });
    assert.throws(() =>
      assertT3CanonicalV2AuthorityObservation(
        { ...human, decidedBy: null },
        { operationId: child, descriptorSha256: digest },
      ),
    );
    assert.throws(() =>
      assertT3CanonicalV2AuthorityObservation(
        { ...human, admissionTrack: "exact_luna_policy" },
        { operationId: child, descriptorSha256: digest },
      ),
    );
  });

  it("no injected harness exists for V2 and all production methods HARD DENY", async () => {
    // No verified candidate, fake positive v2 authority state or mock permit.
    const client = createT3OpenRigApprovalClientV2();
    const unreachableCandidate = {} as Parameters<typeof client.request>[0];
    await rejects(client.request(unreachableCandidate), /no enrolled source-run/);
    await rejects(client.admitExactLuna(unreachableCandidate), /separate trusted authority/);
    await rejects(client.reserve(unreachableCandidate), /cannot reserve/);
    await rejects(client.outcome(unreachableCandidate), /no authenticated persisted outcome/);
    // Historical V1 protocol remains test-only; the actual V1 production
    // constructor also cannot gain a positive reservation by version confusion.
    await rejects(createT3OpenRigApprovalClient().request({} as never), /not implemented/);
  });
});
