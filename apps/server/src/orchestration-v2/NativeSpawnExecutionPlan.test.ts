import { assert, describe, it } from "@effect/vitest";
import {
  canonicalNativeSpawnJson,
  compileNativeSpawnExecutionPlanV1,
  compileNativeSpawnExecutionPlanV2Candidate,
  canonicalNativeSpawnV2DigestBytes,
  inspectCanonicalV2NativeChildId,
  assertCanonicalV2RealFirstMessageId,
  type NativeSpawnExecutionEvidenceV2,
  inspectNativeSpawnOpaquePair,
  inspectNativeSpawnOperationId,
  nativeSpawnSha256,
  type NativeSpawnExecutionEvidenceV1,
} from "./NativeSpawnExecutionPlan.ts";

async function assertRejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.isDefined(caught, "expected rejection");
  assert.isTrue(pattern.test(String(caught)), `expected ${pattern} in ${String(caught)}`);
}

const THREAD = "e4c83f52-9bee-4ea8-bf26-13e4b1cb9840";
const MESSAGE = "8d0431ae-b271-483e-a52e-54f843f7ba1c";
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const evidence = (): NativeSpawnExecutionEvidenceV1 => ({
  operationKind: "create-and-start",
  origin: "desktop-managed-local",
  threadId: THREAD,
  initialMessageId: MESSAGE,
  initialMessageText: "Inspect the code.",
  composedProviderPrompt: "Inspect the code.",
  title: "Review",
  environmentId: "environment:local",
  serverGeneration: "generation:process-1234",
  projectId: "project:alpha",
  providerInstanceId: "codex",
  driver: "codex",
  modelSlug: "gpt-5.6",
  providerState: {
    installed: true,
    authenticated: true,
    ready: true,
    available: true,
    adapterRegistered: true,
    projectEnabled: true,
    catalogModels: ["gpt-5.6", "gpt-6-luna"],
  },
  effectiveOptions: [
    { id: "reasoningEffort", value: "medium" },
    { id: "serviceTier", value: "auto" },
  ],
  optionsCompiledFromFinalAdapterSettings: true,
  reasoningEffort: "medium",
  runtimeMode: "approval-required",
  interactionMode: "default",
  attachments: [],
  context: [],
  workspace: {
    root: "D:/project",
    executionPath: "D:/project",
    strategy: "root",
    branch: null,
    baseRef: null,
    fullyResolvedWithoutEffects: true,
  },
  sourceThreadId: null,
  sourceRunId: null,
  sourceProviderSessionId: null,
  importedOrReused: false,
});

describe("inactive NativeSpawnExecutionPlanV1", () => {
  it("uses OpenRig-compatible canonical ordering and SHA-256", async () => {
    assert.equal(
      canonicalNativeSpawnJson({ z: 1, b: { d: 4, a: 3 } }),
      '{"b":{"a":3,"d":4},"z":1}',
    );
    assert.equal(
      await nativeSpawnSha256("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const plan = await compileNativeSpawnExecutionPlanV1(evidence());
    const expected = await nativeSpawnSha256(
      canonicalNativeSpawnJson({
        requestVersion: 1,
        operationId: plan.operationId,
        descriptor: plan.descriptor,
      }),
    );
    assert.equal(plan.descriptorSha256, expected);
    assert.equal(
      plan.descriptor.executionBinding.roleComposedPromptSha256,
      plan.descriptor.initialPromptSha256,
    );
    assert.equal(plan.descriptor.executionBinding.attachmentsSha256, await nativeSpawnSha256("[]"));
    assert.equal(plan.descriptor.executionBinding.contextSha256, await nativeSpawnSha256("[]"));
    assert.notEqual(plan.descriptor.executionBinding.attachmentsSha256, EMPTY);
    assert.equal(plan.admission, "inactive_unverified");
    assert.equal(plan.descriptor.callerProvenance, "unverified");
    assert.equal(plan.descriptor.executionBinding.verificationState, "unresolved");
    assert.isNull(plan.descriptor.executionBinding.effectiveModelOptions);
    assert.deepEqual(plan.exactEffectiveOptions, evidence().effectiveOptions);
  });

  it("keeps real T3 thread and first-message IDs exactly, never replaces by OpenRig UUID", async () => {
    const plan = await compileNativeSpawnExecutionPlanV1(evidence());
    assert.equal(plan.operationId, THREAD);
    assert.equal(plan.initialMessageId, MESSAGE);
    assert.equal(plan.descriptor.initialMessageId, MESSAGE);
    assert.equal(inspectNativeSpawnOperationId(THREAD), "uuid");
    await assertRejects(
      compileNativeSpawnExecutionPlanV1({
        ...evidence(),
        threadId: "thread:project:alpha:e4c83f52-9bee-4ea8-bf26-13e4b1cb9840",
      }),
      /child operation ID/,
    );
    await assertRejects(
      compileNativeSpawnExecutionPlanV1({
        ...evidence(),
        initialMessageId: "message:thread:alpha:ordinal:1:8d0431ae-b271-483e-a52e-54f843f7ba1c",
      }),
      /UUID child and first-message IDs/,
    );
  });

  it("preserves valid percent-encoded MCP correlation IDs but does NOT admit them", async () => {
    const ids = [
      [
        "thread:mcp:provider%3Asession%2Fme:key%25round:0",
        "message:mcp:provider%3Asession%2Fme:key%25round:0",
      ],
      ["thread:mcp:abc!~*'()-:key%2Bvalue:99999", "message:mcp:abc!~*'()-:key%2Bvalue:99999"],
    ];
    for (const [child, message] of ids) {
      assert.equal(inspectNativeSpawnOperationId(child!), "future-mcp-opaque");
      inspectNativeSpawnOpaquePair(child!, message!);
      await assertRejects(
        compileNativeSpawnExecutionPlanV1({
          ...evidence(),
          threadId: child!,
          initialMessageId: message!,
        }),
        /UUID child and first-message IDs/,
      );
    }
    for (const child of [
      "thread:mcp:one:key%2f:0",
      "thread:mcp:one:key%X0:0",
      "thread:mcp:one::0",
      "thread:mcp:one:two:01",
      "thread:mcp:one:two:999999999",
      "thread:delegated-task:command%3Amcp",
      "mcp:e4c83f52-9bee-4ea8-bf26-13e4b1cb9840",
      `thread:mcp:${"x".repeat(113)}:key:0`,
    ]) {
      assert.throws(() => inspectNativeSpawnOperationId(child));
    }
    assert.throws(() =>
      inspectNativeSpawnOpaquePair("thread:mcp:a:key%2F:0", "message:mcp:a:key%2f:0"),
    );
  });

  it("rejects promptless, incomplete composition and unsupported operation/origin", async () => {
    await assertRejects(
      compileNativeSpawnExecutionPlanV1({
        ...evidence(),
        initialMessageText: "",
      }),
      /composed first-message/,
    );
    await assertRejects(
      compileNativeSpawnExecutionPlanV1({
        ...evidence(),
        composedProviderPrompt: "A hidden system role.\n\nInspect the code.",
      }),
      /mismatched/,
    );
    await assertRejects(
      compileNativeSpawnExecutionPlanV1({
        ...evidence(),
        operationKind: "fork" as never,
      }),
      /create-and-start/,
    );
    await assertRejects(
      compileNativeSpawnExecutionPlanV1({
        ...evidence(),
        origin: "sdk-delegation" as never,
      }),
      /local Desktop/,
    );
    await assertRejects(
      compileNativeSpawnExecutionPlanV1({
        ...evidence(),
        importedOrReused: true as never,
      }),
      /local Desktop/,
    );
  });

  it("rejects missing provider/adapter/catalog readiness and unresolved defaults", async () => {
    const base = evidence();
    for (const field of [
      "installed",
      "authenticated",
      "ready",
      "available",
      "adapterRegistered",
      "projectEnabled",
    ] as const) {
      await assertRejects(
        compileNativeSpawnExecutionPlanV1({
          ...base,
          providerState: { ...base.providerState, [field]: false },
        }),
        /not authoritatively ready/,
      );
    }
    await assertRejects(
      compileNativeSpawnExecutionPlanV1({
        ...base,
        modelSlug: "model-not-in-catalog",
      }),
      /not authoritatively ready/,
    );
    await assertRejects(
      compileNativeSpawnExecutionPlanV1({
        ...base,
        optionsCompiledFromFinalAdapterSettings: false,
      }),
      /defaults are unresolved/,
    );
    await assertRejects(
      compileNativeSpawnExecutionPlanV1({
        ...base,
        effectiveOptions: [{ id: "customNumber", value: 5 as never }],
      }),
      /unrepresentable effective option/,
    );
    await assertRejects(
      compileNativeSpawnExecutionPlanV1({
        ...base,
        effectiveOptions: [
          { id: "z", value: true },
          { id: "a", value: "low" },
        ],
      }),
      /unsorted/,
    );
    await assertRejects(
      compileNativeSpawnExecutionPlanV1({
        ...base,
        effectiveOptions: [
          { id: "effort", value: "high" },
          { id: "effort", value: "low" },
        ],
      }),
      /duplicated/,
    );
  });

  it("binds context/content/options/workspace drift and rejects unrepresentable manifests", async () => {
    const base = evidence();
    const original = await compileNativeSpawnExecutionPlanV1(base);
    const context = await compileNativeSpawnExecutionPlanV1({
      ...base,
      context: [{ id: "role:assistant", sha256: "f".repeat(64) }],
    });
    const attachment = await compileNativeSpawnExecutionPlanV1({
      ...base,
      attachments: [{ id: "image.png", sha256: "a".repeat(64) }],
    });
    const options = await compileNativeSpawnExecutionPlanV1({
      ...base,
      effectiveOptions: [{ id: "reasoningEffort", value: "high" }],
    });
    const workspace = await compileNativeSpawnExecutionPlanV1({
      ...base,
      workspace: {
        ...base.workspace,
        executionPath: "D:/project/.worktrees/child",
        branch: "child-a",
      },
    });
    const generation = await compileNativeSpawnExecutionPlanV1({
      ...base,
      serverGeneration: "generation:other",
    });
    for (const drift of [context, attachment, options, workspace, generation]) {
      assert.notEqual(drift.executionEvidenceSha256, original.executionEvidenceSha256);
    }
    for (const drift of [context, attachment, options, workspace]) {
      assert.notEqual(drift.descriptorSha256, original.descriptorSha256);
    }
    // OpenRig descriptor lacks a generation field, so this must remain unverified
    // until enrollment binds server generation independently.
    assert.equal(generation.descriptorSha256, original.descriptorSha256);
    await assertRejects(
      compileNativeSpawnExecutionPlanV1({
        ...base,
        attachments: [{ id: "image.png", sha256: "" }],
      }),
      /unhashed/,
    );
    await assertRejects(
      compileNativeSpawnExecutionPlanV1({
        ...base,
        context: null as never,
      }),
      /Missing complete context/,
    );
    await assertRejects(
      compileNativeSpawnExecutionPlanV1({
        ...base,
        context: [
          { id: "z", sha256: "a".repeat(64) },
          { id: "a", sha256: "b".repeat(64) },
        ],
      }),
      /Unsorted/,
    );
    await assertRejects(
      compileNativeSpawnExecutionPlanV1({
        ...base,
        workspace: { ...base.workspace, fullyResolvedWithoutEffects: false },
      }),
      /cannot be resolved/,
    );
  });

  it("treats exact Luna as structurally representable but never self-authorizing", async () => {
    const plan = await compileNativeSpawnExecutionPlanV1({
      ...evidence(),
      modelSlug: "gpt-6-luna",
    });
    assert.equal(plan.descriptor.modelSlug, "gpt-6-luna");
    assert.equal(plan.admission, "inactive_unverified");
    assert.equal(plan.descriptor.callerProvenance, "unverified");
  });
});

const V2_PROJECT = "project:fixture:alpha";
const V2_THREAD = "thread:project:project%3Afixture%3Aalpha:11111111-1111-4111-8111-111111111111";
const V2_MESSAGE = `message:thread:${encodeURIComponent(V2_THREAD)}:ordinal:1:22222222-2222-4222-8222-222222222222`;
const V2_TEXT = "Exact composed provider prompt including all selected instructions.";
async function v2Evidence(): Promise<NativeSpawnExecutionEvidenceV2> {
  const hash = await nativeSpawnSha256(V2_TEXT);
  return {
    operationKind: "create-and-start",
    operationId: V2_THREAD,
    firstMessageId: V2_MESSAGE,
    actualProjectId: V2_PROJECT,
    environmentId: "env:primary",
    enrollment: {
      serverInstanceId: "server:primary",
      serverGenerationId: "generation:one",
      enrollmentLeaseId: "lease:one",
      backendProcessId: 1234,
      backendStartedAtEpochMs: 100,
      leaseExpiresAtEpochMs: 500,
    },
    sourceRun: {
      callerKind: "native-provider-run",
      sourceThreadId: "thread:parent",
      sourceRunId: "run:actual",
      sourceProviderSessionId: "provider-session:actual",
      commandId: "command:preallocated",
    },
    providerInstanceId: "codex",
    driver: "codex",
    modelSlug: "gpt-6-luna",
    selectedFromEnrolledCatalog: true,
    providerInstalledAuthenticatedReadyEnabled: true,
    finalEffectiveOptions: [
      { id: "reasoningEffort", value: "medium" },
      { id: "serviceTier", value: "auto" },
    ],
    modelOptionsCompiledFromFinalAdapter: true,
    promptText: V2_TEXT,
    material: {
      attachments: [
        {
          id: "file.png",
          contentSha256: "a".repeat(64),
          sizeBytes: 30,
          materializedVersion: "file:v2",
        },
      ],
      context: [{ id: "role", contentSha256: "b".repeat(64), materializedVersion: "ctx:v3" }],
      roleInstructionsSha256: "c".repeat(64),
      composedProviderPromptSha256: hash,
      adapterSettingsVersion: "adapter:2",
      providerSettingsVersion: "provider:8",
      inheritedDefaultsSha256: "d".repeat(64),
      toolProfileSha256: "e".repeat(64),
      runtimePermissionProfileSha256: "f".repeat(64),
      projectSettingsVersion: "project:4",
      workspaceSettingsVersion: "workspace:5",
    },
    workspace: {
      root: "D:/repo",
      strategy: "worktree",
      executionPath: "D:/repo/wt/child",
      branch: "child",
      baseRef: "a".repeat(40),
      frozenBeforeEffects: true,
    },
    alreadyPersistedOrLaunched: false,
  };
}

describe("inactive canonical A V2 real-ID and manifest alignment", () => {
  it("respects source-proven nested E(project), E(full thread) and actual first-message ID", () => {
    assert.equal(
      inspectCanonicalV2NativeChildId(V2_THREAD, V2_PROJECT),
      "allocator-project-thread",
    );
    assert.equal(
      V2_MESSAGE,
      `message:thread:${encodeURIComponent(V2_THREAD)}:ordinal:1:22222222-2222-4222-8222-222222222222`,
    );
    assert.include(V2_MESSAGE, "project%253Afixture%253Aalpha");
    assertCanonicalV2RealFirstMessageId(V2_THREAD, V2_PROJECT, V2_MESSAGE);
    assert.throws(() => inspectCanonicalV2NativeChildId(V2_THREAD, "project:someone-else"));
    assert.throws(() => assertCanonicalV2RealFirstMessageId(V2_THREAD, V2_PROJECT, MESSAGE));
    assert.throws(() =>
      inspectCanonicalV2NativeChildId(
        "thread:project:project%3afixture%3Aalpha:11111111-1111-4111-8111-111111111111",
        V2_PROJECT,
      ),
    );
    assert.throws(() =>
      inspectCanonicalV2NativeChildId(
        "thread:project:project%3Afixture%3Aalpha:11111111-1111-1111-8111-111111111111",
        V2_PROJECT,
      ),
    ); // Actual T3 allocator is v4, not A's broader suffix regexp.
  });

  it("accepts actual UUID only as an ID and never fabricates a message", () => {
    assert.equal(inspectCanonicalV2NativeChildId(THREAD, V2_PROJECT), "actual-uuid");
    assertCanonicalV2RealFirstMessageId(THREAD, V2_PROJECT, MESSAGE);
    assertCanonicalV2RealFirstMessageId(
      THREAD,
      V2_PROJECT,
      `message:thread:${encodeURIComponent(THREAD)}:ordinal:1:${MESSAGE}`,
    );
    assert.throws(() => assertCanonicalV2RealFirstMessageId(THREAD, V2_PROJECT, "message:fake"));
    assert.throws(() => inspectCanonicalV2NativeChildId("thread:mcp:one:key%2F:0", V2_PROJECT));
  });

  it("keeps canonical v1 hash byte-for-byte while v2 envelope is requestVersion 2", async () => {
    const v1 = await compileNativeSpawnExecutionPlanV1(evidence());
    const old = await nativeSpawnSha256(
      canonicalNativeSpawnJson({
        requestVersion: 1,
        operationId: v1.operationId,
        descriptor: v1.descriptor,
      }),
    );
    assert.equal(v1.descriptorSha256, old);
    // Pure byte-digest primitive; synthetic descriptor is NOT a verified/admitted candidate.
    const structural = { descriptorVersion: 2, binding: { z: "abc", a: "def" } };
    const digest = await canonicalNativeSpawnV2DigestBytes(V2_THREAD, structural);
    const independentCanonical =
      '{"descriptor":{"binding":{"a":"def","z":"abc"},"descriptorVersion":2},"operationId":"' +
      V2_THREAD +
      '","requestVersion":2}';
    assert.equal(digest, await nativeSpawnSha256(independentCanonical));
    assert.notEqual(
      digest,
      await nativeSpawnSha256(
        canonicalNativeSpawnJson({
          requestVersion: 1,
          operationId: V2_THREAD,
          descriptor: structural,
        }),
      ),
    );
  });

  it("returns a fully frozen V2 candidate but no verified descriptor, digest or authorization", async () => {
    const candidate = await compileNativeSpawnExecutionPlanV2Candidate(await v2Evidence());
    assert.equal(candidate.version, 2);
    assert.equal(candidate.admission, "inactive_unverified");
    assert.equal(candidate.verificationState, "unresolved");
    assert.equal(candidate.callerProvenance, "unverified");
    assert.isNull(candidate.descriptorSha256);
    assert.equal(candidate.operationId, V2_THREAD);
    assert.equal(candidate.initialMessageId, V2_MESSAGE);
    assert.isTrue(Object.isFrozen(candidate));
    assert.isTrue(Object.isFrozen(candidate.sourceRunCandidate));
    assert.isTrue(Object.isFrozen(candidate.enrollmentCandidate));
    assert.isTrue(Object.isFrozen(candidate.workspace));
  });

  it("sensitive material/settings/generation/base-ref drift changes candidate fingerprint", async () => {
    const base = await v2Evidence();
    const first = await compileNativeSpawnExecutionPlanV2Candidate(base);
    const changes = [
      { ...base, sourceRun: { ...base.sourceRun, sourceRunId: "run:changed" } },
      { ...base, enrollment: { ...base.enrollment, serverGenerationId: "generation:changed" } },
      { ...base, material: { ...base.material, adapterSettingsVersion: "adapter:changed" } },
      {
        ...base,
        material: {
          ...base.material,
          attachments: [{ ...base.material.attachments[0]!, materializedVersion: "file:changed" }],
        },
      },
      { ...base, workspace: { ...base.workspace, baseRef: "b".repeat(40) } },
    ] satisfies NativeSpawnExecutionEvidenceV2[];
    for (const changed of changes) {
      const next = await compileNativeSpawnExecutionPlanV2Candidate(changed);
      assert.notEqual(first.candidateEvidenceSha256, next.candidateEvidenceSha256);
    }
    assert.notEqual(
      first.immutableMaterialManifestSha256,
      (await compileNativeSpawnExecutionPlanV2Candidate(changes[2]!))
        .immutableMaterialManifestSha256,
    );
  });

  it("rejects absent run/material/permission/lease and unknown base; no synthetic verified", async () => {
    const base = await v2Evidence();
    const cases: NativeSpawnExecutionEvidenceV2[] = [
      { ...base, sourceRun: { ...base.sourceRun, sourceRunId: "" } },
      { ...base, sourceRun: { ...base.sourceRun, sourceProviderSessionId: "" } },
      { ...base, enrollment: { ...base.enrollment, serverGenerationId: "" } },
      { ...base, enrollment: { ...base.enrollment, backendProcessId: 0 } },
      { ...base, material: { ...base.material, attachments: null as never } },
      { ...base, material: { ...base.material, runtimePermissionProfileSha256: "" } },
      {
        ...base,
        material: {
          ...base.material,
          attachments: [
            {
              id: "file.png",
              contentSha256: "a".repeat(64),
              sizeBytes: -1,
              materializedVersion: "file",
            },
          ],
        },
      },
      { ...base, workspace: { ...base.workspace, baseRef: null } },
      { ...base, workspace: { ...base.workspace, frozenBeforeEffects: false } },
      {
        ...base,
        finalEffectiveOptions: [
          { id: "z", value: true },
          { id: "a", value: false },
        ],
      },
      { ...base, selectedFromEnrolledCatalog: false },
      { ...base, promptText: "different prompt" },
      { ...base, firstMessageId: MESSAGE },
    ];
    for (const item of cases) {
      await assertRejects(compileNativeSpawnExecutionPlanV2Candidate(item), /./);
    }
  });
});
