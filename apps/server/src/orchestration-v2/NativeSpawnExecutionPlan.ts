/**
 * Inactive, source-only T3 -> OpenRig spawn intent compiler.
 *
 * A structurally complete plan is NOT an enrolled/server-verified descriptor,
 * an approval, or permission to create a thread. Nothing in this module can
 * upgrade the descriptor to verificationState="verified".
 */

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const SHA256 = /^[a-f\d]{64}$/;
const MAX_DESCRIPTOR_BYTES = 16_384;
const ENCODED_SEGMENT = /^(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-F]{2})+$/;

function canonicalMcpSegment(value: string): boolean {
  if (value.length < 1 || value.length > 112 || !ENCODED_SEGMENT.test(value)) return false;
  try {
    // Validation only: the original opaque ID is never decoded or rewritten.
    return encodeURIComponent(decodeURIComponent(value)) === value;
  } catch {
    return false;
  }
}
const BATCH_INDEX = /^(?:0|[1-9][0-9]{0,7})$/;

export class NativeSpawnPlanUnrepresentableError extends Error {
  readonly code = "native_spawn_plan_unrepresentable" as const;
  constructor(message: string) {
    super(message);
    this.name = "NativeSpawnPlanUnrepresentableError";
  }
}

function reject(reason: string): never {
  throw new NativeSpawnPlanUnrepresentableError(reason);
}

function required(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048 ||
    value.trim() !== value
  ) {
    reject(`Missing, ambiguous or invalid ${field}.`);
  }
}

export function canonicalNativeSpawnJson(input: unknown): string {
  const walk = (value: unknown): unknown => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(walk);
    if (
      value !== null &&
      typeof value === "object" &&
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => {
            if (key === "__proto__" || (value as Record<string, unknown>)[key] === undefined) {
              reject("Unstable canonical descriptor field.");
            }
            return [key, walk((value as Record<string, unknown>)[key])];
          }),
      );
    }
    return reject("Non-JSON execution-plan input.");
  };
  return JSON.stringify(walk(input));
}

function deepFreezePlan<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreezePlan(item);
    Object.freeze(value);
  }
  return value;
}

export const nativeSpawnSha256 = async (input: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export type NativeSpawnOption = Readonly<{ id: string; value: string | boolean }>;
export type NativeSpawnContent = Readonly<{ id: string; sha256: string }>;

export interface NativeSpawnDescriptorV1 {
  readonly kind: "provider-native";
  readonly origin: "t3-native-ipc";
  readonly environmentId: string;
  readonly providerInstanceId: string;
  readonly driver: string;
  readonly modelSlug: string;
  readonly modelOptions: Readonly<Record<string, string | boolean>>;
  readonly reasoningEffort: string | null;
  readonly runtimeMode: string;
  readonly workspaceRoot: string;
  readonly projectId: string;
  readonly targetSeatId: null;
  readonly verifiedCallerSeatId: null;
  readonly verifiedSourceThreadId: null;
  readonly callerProvenance: "unverified";
  readonly parentSeatId: null;
  readonly parentThreadId: null;
  readonly title: string;
  readonly initialPromptSha256: string;
  readonly initialMessageId: string;
  readonly executionBinding: {
    readonly verificationState: "unresolved";
    readonly operationKind: "create-and-start";
    readonly effectiveModelOptions: null;
    readonly roleComposedPromptSha256: string;
    readonly attachmentsSha256: string;
    readonly contextSha256: string;
    readonly interactionMode: string;
    readonly workspaceStrategy: string;
    readonly resolvedExecutionPath: string;
    readonly resolvedBranch: string | null;
  };
}

/**
 * These fields have to come from a future trusted, *pure* runtime/adapter
 * compiler, not directly from a renderer or untrusted native-create request.
 * The compiler below only proves representability, never truth of the source.
 */
export interface NativeSpawnExecutionEvidenceV1 {
  readonly operationKind: "create-and-start";
  readonly origin: "desktop-managed-local";
  readonly threadId: string;
  /** T3's exact already allocated first user-message ID, not OpenRig's fallback. */
  readonly initialMessageId: string;
  readonly initialMessageText: string;
  /** Complete text actually sent to the provider; no hidden default expansion. */
  readonly composedProviderPrompt: string;
  readonly title: string;
  readonly environmentId: string;
  readonly serverGeneration: string;
  readonly projectId: string;
  readonly providerInstanceId: string;
  readonly driver: string;
  readonly modelSlug: string;
  readonly providerState: Readonly<{
    installed: boolean;
    authenticated: boolean;
    ready: boolean;
    available: boolean;
    adapterRegistered: boolean;
    projectEnabled: boolean;
    catalogModels: readonly string[];
  }>;
  /** Already compiled effective options, including adapter/provider defaults. */
  readonly effectiveOptions: readonly NativeSpawnOption[];
  readonly optionsCompiledFromFinalAdapterSettings: boolean;
  readonly reasoningEffort: string | null;
  readonly runtimeMode: string;
  readonly interactionMode: string;
  readonly attachments: readonly NativeSpawnContent[];
  readonly context: readonly NativeSpawnContent[];
  readonly workspace: Readonly<{
    root: string;
    executionPath: string;
    strategy: string;
    branch: string | null;
    baseRef: string | null;
    fullyResolvedWithoutEffects: boolean;
  }>;
  /** No unknown caller/source-run may be upgraded to verified. */
  readonly sourceThreadId: null;
  readonly sourceRunId: null;
  readonly sourceProviderSessionId: null;
  readonly importedOrReused: false;
}

export interface NativeSpawnExecutionPlanV1 {
  readonly version: 1;
  readonly admission: "inactive_unverified";
  readonly operationId: string;
  readonly initialMessageId: string;
  readonly serverGeneration: string;
  readonly exactEffectiveOptions: readonly NativeSpawnOption[];
  readonly executionEvidenceSha256: string;
  readonly descriptor: NativeSpawnDescriptorV1;
  readonly descriptorSha256: string;
}

/** Opaque correlation only; MCP is unsupported for admission in this slice. */
export function inspectNativeSpawnOperationId(operationId: string): "uuid" | "future-mcp-opaque" {
  if (typeof operationId !== "string" || operationId.length > 256)
    reject("Invalid native child operation ID.");
  if (UUID.test(operationId)) return "uuid";
  const parts = operationId.split(":");
  if (
    parts.length === 5 &&
    parts[0] === "thread" &&
    parts[1] === "mcp" &&
    canonicalMcpSegment(parts[2] ?? "") &&
    canonicalMcpSegment(parts[3] ?? "") &&
    BATCH_INDEX.test(parts[4] ?? "")
  ) {
    return "future-mcp-opaque";
  }
  return reject("Unknown, malformed or unsupported native child operation ID.");
}

/** Validate byte-identical T3-generated opaque IDs without normalization. */
export function inspectNativeSpawnOpaquePair(threadId: string, messageId: string): void {
  if (inspectNativeSpawnOperationId(threadId) !== "future-mcp-opaque")
    reject("Not a native MCP child ID.");
  if (messageId !== `message:${threadId.slice("thread:".length)}`) {
    reject("MCP first-message ID is not the exact preallocated pair.");
  }
}

async function canonicalContent(
  items: readonly NativeSpawnContent[],
  field: string,
): Promise<string> {
  if (!Array.isArray(items)) reject(`Missing complete ${field} manifest.`);
  let previous = "";
  for (const entry of items) {
    required(entry?.id, `${field} identity`);
    if (entry.id <= previous || !SHA256.test(entry.sha256)) {
      reject(`Unsorted, duplicated or unhashed ${field} manifest.`);
    }
    previous = entry.id;
  }
  return nativeSpawnSha256(canonicalNativeSpawnJson(items));
}

function validateOptions(options: readonly NativeSpawnOption[]): void {
  if (!Array.isArray(options)) reject("Final effective adapter options are missing.");
  let previous = "";
  for (const option of options) {
    required(option?.id, "option ID");
    if (
      option.id <= previous ||
      (typeof option.value !== "string" && typeof option.value !== "boolean") ||
      (typeof option.value === "string" && option.value.length === 0)
    ) {
      reject("Missing, duplicated, unsorted or unrepresentable effective option.");
    }
    previous = option.id;
  }
}

/**
 * This pure structural compilation never invents a verifier, enrollment,
 * canonical human approval, or a positive native-create admission.
 * A future enrolled attestor must re-derive the plan and independently
 * convert its unresolved descriptor to verified under a separate grant.
 */
export async function compileNativeSpawnExecutionPlanV1(
  evidence: NativeSpawnExecutionEvidenceV1,
): Promise<NativeSpawnExecutionPlanV1> {
  if (
    evidence.operationKind !== "create-and-start" ||
    evidence.origin !== "desktop-managed-local" ||
    evidence.importedOrReused !== false ||
    evidence.sourceThreadId !== null ||
    evidence.sourceRunId !== null ||
    evidence.sourceProviderSessionId !== null
  ) {
    reject("Only an unparented local Desktop create-and-start is representable.");
  }
  if (
    inspectNativeSpawnOperationId(evidence.threadId) !== "uuid" ||
    !UUID.test(evidence.initialMessageId)
  ) {
    reject(
      "First slice requires actual T3 UUID child and first-message IDs, not prefixed allocator IDs.",
    );
  }
  for (const [name, value] of Object.entries({
    environmentId: evidence.environmentId,
    serverGeneration: evidence.serverGeneration,
    projectId: evidence.projectId,
    providerInstanceId: evidence.providerInstanceId,
    driver: evidence.driver,
    modelSlug: evidence.modelSlug,
    title: evidence.title,
    runtimeMode: evidence.runtimeMode,
    interactionMode: evidence.interactionMode,
    workspaceRoot: evidence.workspace.root,
    resolvedExecutionPath: evidence.workspace.executionPath,
    workspaceStrategy: evidence.workspace.strategy,
  })) {
    required(value, name);
  }
  if (
    evidence.driver !== "codex" &&
    evidence.driver !== "claudeAgent" &&
    !evidence.driver.match(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
  )
    reject("Invalid provider driver identity.");
  const state = evidence.providerState;
  if (
    !state ||
    !state.installed ||
    !state.authenticated ||
    !state.ready ||
    !state.available ||
    !state.adapterRegistered ||
    !state.projectEnabled ||
    !state.catalogModels.includes(evidence.modelSlug)
  ) {
    reject("Provider project, adapter, catalog or authentication is not authoritatively ready.");
  }
  if (!evidence.optionsCompiledFromFinalAdapterSettings) {
    reject("Final effective provider defaults are unresolved.");
  }
  validateOptions(evidence.effectiveOptions);
  if (evidence.reasoningEffort !== null) required(evidence.reasoningEffort, "reasoningEffort");
  const workspace = evidence.workspace;
  if (
    !workspace.fullyResolvedWithoutEffects ||
    (workspace.branch !== null && !workspace.branch) ||
    (workspace.baseRef !== null && !workspace.baseRef)
  ) {
    reject("Workspace/path/base/branch cannot be resolved without effects.");
  }
  // A stronger side-effect-free adapter compiler will eventually prove that
  // composedProviderPrompt is the *actual* complete first payload.
  if (
    !evidence.initialMessageText ||
    evidence.initialMessageText.trim().length === 0 ||
    Buffer.byteLength(evidence.initialMessageText, "utf8") > 120_000 ||
    evidence.initialMessageText !== evidence.composedProviderPrompt
  ) {
    reject("The exact composed first-message payload is unknown or mismatched.");
  }
  const attachmentsSha256 = await canonicalContent(evidence.attachments, "attachments");
  const contextSha256 = await canonicalContent(evidence.context, "context");
  const options = evidence.effectiveOptions.map((item) => ({ id: item.id, value: item.value }));
  const promptSha256 = await nativeSpawnSha256(evidence.composedProviderPrompt);
  const descriptor: NativeSpawnDescriptorV1 = {
    kind: "provider-native",
    origin: "t3-native-ipc",
    environmentId: evidence.environmentId,
    providerInstanceId: evidence.providerInstanceId,
    driver: evidence.driver,
    modelSlug: evidence.modelSlug,
    modelOptions: Object.fromEntries(options.map((item) => [item.id, item.value])),
    reasoningEffort: evidence.reasoningEffort,
    runtimeMode: evidence.runtimeMode,
    workspaceRoot: workspace.root,
    projectId: evidence.projectId,
    targetSeatId: null,
    verifiedCallerSeatId: null,
    verifiedSourceThreadId: null,
    callerProvenance: "unverified",
    parentSeatId: null,
    parentThreadId: null,
    title: evidence.title,
    initialPromptSha256: promptSha256,
    initialMessageId: evidence.initialMessageId,
    executionBinding: {
      verificationState: "unresolved",
      operationKind: "create-and-start",
      effectiveModelOptions: null,
      roleComposedPromptSha256: promptSha256,
      attachmentsSha256,
      contextSha256,
      interactionMode: evidence.interactionMode,
      workspaceStrategy: canonicalNativeSpawnJson({
        strategy: workspace.strategy,
        baseRef: workspace.baseRef,
      }),
      resolvedExecutionPath: workspace.executionPath,
      resolvedBranch: workspace.branch,
    },
  };
  const canonical = canonicalNativeSpawnJson(descriptor);
  if (Buffer.byteLength(canonical, "utf8") > MAX_DESCRIPTOR_BYTES) {
    reject("Spawn descriptor exceeds OpenRig's 16KiB schema limit.");
  }
  return deepFreezePlan({
    version: 1,
    admission: "inactive_unverified",
    operationId: evidence.threadId,
    initialMessageId: evidence.initialMessageId,
    serverGeneration: evidence.serverGeneration,
    exactEffectiveOptions: options,
    executionEvidenceSha256: await nativeSpawnSha256(canonicalNativeSpawnJson(evidence)),
    descriptor,
    descriptorSha256: await nativeSpawnSha256(
      canonicalNativeSpawnJson({
        requestVersion: 1,
        operationId: evidence.threadId,
        descriptor,
      }),
    ),
  });
}

/**
 * Canonical-A V2 alignment. THIS IS NOT AN ADMISSION PATH.
 *
 * The OpenRig Stage-A SpawnDescriptorV2 has verificationState="verified" and
 * callerProvenance="trusted-transport". A pure T3 structural compiler cannot
 * assert either. Thus its output is a distinct V2 *candidate*, with no
 * descriptorSha256 for submission, even when source-looking fields are present.
 * The separate hash function below is only a canonical-byte primitive.
 */
const SOURCE_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const A_V2_PROJECT_THREAD =
  /^thread:project:((?:[A-Za-z0-9_.!~*'()-]|%[0-9A-F]{2}){1,112}):([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
const A_V2_UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;

/** Current Stage-A ledger accepts these two ID forms ONLY. Not MCP opaque. */
export function inspectCanonicalV2NativeChildId(
  operationId: string,
  actualProjectId: string,
): "actual-uuid" | "allocator-project-thread" {
  required(actualProjectId, "actual T3 projectId");
  if (typeof operationId !== "string" || operationId.length > 256) {
    reject("Canonical A V2 child ID exceeds its bound.");
  }
  if (A_V2_UUID.test(operationId)) return "actual-uuid";
  const match = A_V2_PROJECT_THREAD.exec(operationId);
  if (!match || !SOURCE_UUID_V4.test(match[2] ?? "")) {
    reject("Not a source-proven T3 default project-thread ID.");
  }
  const encoded = match[1]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return reject("Malformed UTF-8 project ID segment.");
  }
  if (
    decoded.includes("..") ||
    [...decoded].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    encodeURIComponent(decoded) !== encoded ||
    decoded !== actualProjectId
  ) {
    reject("T3 allocated project identity disagrees with canonical project binding.");
  }
  return "allocator-project-thread";
}

/** A V2 ledger validates message:thread:E(child):ordinal:1:UUID for a project child.
 * For an actual UUID child it additionally accepts an actual standalone UUID.
 * Matching syntax NEVER demonstrates that T3 really preallocated/persisted it.
 */
export function assertCanonicalV2RealFirstMessageId(
  childThreadId: string,
  actualProjectId: string,
  actualInitialMessageId: string,
): void {
  const kind = inspectCanonicalV2NativeChildId(childThreadId, actualProjectId);
  if (kind === "actual-uuid" && A_V2_UUID.test(actualInitialMessageId)) return;
  const exactPrefix = `message:thread:${encodeURIComponent(childThreadId)}:ordinal:1:`;
  if (
    !actualInitialMessageId.startsWith(exactPrefix) ||
    !A_V2_UUID.test(actualInitialMessageId.slice(exactPrefix.length))
  ) {
    reject("V2 first message is not the actual source allocator ID for the child.");
  }
}

export interface CanonicalV2EnrollmentCandidate {
  readonly serverInstanceId: string;
  readonly serverGenerationId: string;
  readonly enrollmentLeaseId: string;
  readonly backendProcessId: number;
  readonly backendStartedAtEpochMs: number;
  readonly leaseExpiresAtEpochMs: number;
}

export interface CanonicalV2SourceRunCandidate {
  readonly callerKind: "native-provider-run";
  readonly sourceThreadId: string;
  readonly sourceRunId: string;
  readonly sourceProviderSessionId: string;
  readonly commandId: string;
}

export interface NativeSpawnMaterialV2 {
  readonly attachments: readonly Readonly<{
    id: string;
    contentSha256: string;
    sizeBytes: number;
    materializedVersion: string;
  }>[];
  readonly context: readonly Readonly<{
    id: string;
    contentSha256: string;
    materializedVersion: string;
  }>[];
  readonly roleInstructionsSha256: string;
  readonly composedProviderPromptSha256: string;
  readonly adapterSettingsVersion: string;
  readonly providerSettingsVersion: string;
  readonly inheritedDefaultsSha256: string;
  readonly toolProfileSha256: string;
  readonly runtimePermissionProfileSha256: string;
  readonly projectSettingsVersion: string;
  readonly workspaceSettingsVersion: string;
}

/** Structured CANDIDATE fields, not attested. Stage A binds only manifest hash;
 * exact manifest serialization needs a separately agreed producer/witness. */
export interface NativeSpawnExecutionEvidenceV2 {
  readonly operationKind: "create-and-start";
  readonly operationId: string;
  readonly firstMessageId: string;
  readonly actualProjectId: string;
  readonly environmentId: string;
  readonly enrollment: CanonicalV2EnrollmentCandidate;
  readonly sourceRun: CanonicalV2SourceRunCandidate;
  readonly providerInstanceId: string;
  readonly driver: string;
  readonly modelSlug: string;
  readonly selectedFromEnrolledCatalog: boolean;
  readonly providerInstalledAuthenticatedReadyEnabled: boolean;
  readonly finalEffectiveOptions: readonly NativeSpawnOption[];
  readonly modelOptionsCompiledFromFinalAdapter: boolean;
  readonly promptText: string;
  readonly material: NativeSpawnMaterialV2;
  readonly workspace: Readonly<{
    root: string;
    strategy: "root" | "existing_worktree" | "worktree";
    executionPath: string;
    branch: string | null;
    /** Known-null means a genuinely base-free existing root only. */
    baseRef: string | null;
    frozenBeforeEffects: boolean;
  }>;
  readonly alreadyPersistedOrLaunched: false;
}

export type NativeSpawnExecutionPlanV2Candidate = Readonly<{
  version: 2;
  admission: "inactive_unverified";
  descriptorVersion: 2;
  operationId: string;
  initialMessageId: string;
  /** This is not an A-valid SpawnDescriptorV2. */
  descriptorSha256: null;
  verificationState: "unresolved";
  callerProvenance: "unverified";
  enrollmentCandidate: CanonicalV2EnrollmentCandidate;
  sourceRunCandidate: CanonicalV2SourceRunCandidate;
  actualProjectId: string;
  providerInstanceId: string;
  driver: string;
  modelSlug: string;
  effectiveOptions: readonly NativeSpawnOption[];
  workspace: NativeSpawnExecutionEvidenceV2["workspace"];
  /** Deterministic candidate fingerprints, NOT an authoritative approved digest. */
  attachmentsSha256: string;
  contextSha256: string;
  immutableMaterialManifestSha256: string;
  composedProviderPromptSha256: string;
  candidateEvidenceSha256: string;
}>;

function v2Sha(value: unknown, name: string): void {
  if (typeof value !== "string" || !SHA256.test(value)) {
    reject(`Missing or invalid V2 ${name} digest.`);
  }
}
function validateMaterialList(
  items: readonly Record<string, unknown>[],
  field: string,
  withSize: boolean,
): void {
  if (!Array.isArray(items)) reject(`Unresolved V2 ${field} manifest.`);
  let last = "";
  for (const item of items) {
    required(item?.id, `${field} item ID`);
    required(item?.materializedVersion, `${field} materializedVersion`);
    v2Sha(item?.contentSha256, `${field} content`);
    if (
      item.id <= last ||
      (withSize && (!Number.isSafeInteger(item.sizeBytes) || (item.sizeBytes as number) < 0))
    ) {
      reject(`V2 ${field} entries must be strictly sorted with real sizes/versions.`);
    }
    last = item.id;
  }
}

/**
 * This function makes a structurally bounded **unverified** V2 candidate.
 * Source/host claims here still need independent runtime/authority observation,
 * so the function intentionally has no method to mint a verified descriptor.
 */
export async function compileNativeSpawnExecutionPlanV2Candidate(
  evidence: NativeSpawnExecutionEvidenceV2,
): Promise<NativeSpawnExecutionPlanV2Candidate> {
  if (
    !evidence ||
    evidence.operationKind !== "create-and-start" ||
    evidence.alreadyPersistedOrLaunched !== false
  ) {
    reject("V2 requires a fresh pre-effect create-and-start candidate.");
  }
  assertCanonicalV2RealFirstMessageId(
    evidence.operationId,
    evidence.actualProjectId,
    evidence.firstMessageId,
  );
  for (const [name, value] of Object.entries({
    environmentId: evidence.environmentId,
    providerInstanceId: evidence.providerInstanceId,
    driver: evidence.driver,
    modelSlug: evidence.modelSlug,
    sourceThreadId: evidence.sourceRun?.sourceThreadId,
    sourceRunId: evidence.sourceRun?.sourceRunId,
    sourceProviderSessionId: evidence.sourceRun?.sourceProviderSessionId,
    commandId: evidence.sourceRun?.commandId,
    serverInstanceId: evidence.enrollment?.serverInstanceId,
    serverGenerationId: evidence.enrollment?.serverGenerationId,
    enrollmentLeaseId: evidence.enrollment?.enrollmentLeaseId,
    root: evidence.workspace?.root,
    executionPath: evidence.workspace?.executionPath,
    strategy: evidence.workspace?.strategy,
  }))
    required(value, name);
  if (
    evidence.sourceRun.callerKind !== "native-provider-run" ||
    !evidence.selectedFromEnrolledCatalog ||
    !evidence.providerInstalledAuthenticatedReadyEnabled ||
    !evidence.modelOptionsCompiledFromFinalAdapter
  ) {
    reject("V2 has no real native-source run or final ready provider compiler.");
  }
  const lease = evidence.enrollment;
  if (
    !Number.isSafeInteger(lease.backendProcessId) ||
    lease.backendProcessId <= 0 ||
    !Number.isSafeInteger(lease.backendStartedAtEpochMs) ||
    lease.backendStartedAtEpochMs <= 0 ||
    !Number.isSafeInteger(lease.leaseExpiresAtEpochMs) ||
    lease.leaseExpiresAtEpochMs <= lease.backendStartedAtEpochMs
  ) {
    reject("Unrepresentable enrollment process/lease generation.");
  }
  const ws = evidence.workspace;
  if (
    !ws.frozenBeforeEffects ||
    (ws.strategy === "worktree" && ws.baseRef === null) ||
    (ws.strategy === "root" && ws.baseRef !== null) ||
    (ws.branch !== null && ws.branch.length === 0)
  ) {
    reject("Unknown/unfrozen V2 workspace or worktree base reference.");
  }
  validateOptions(evidence.finalEffectiveOptions);
  const material = evidence.material;
  if (!material) reject("No immutable material manifest.");
  validateMaterialList(
    material.attachments as readonly Record<string, unknown>[],
    "attachments",
    true,
  );
  validateMaterialList(material.context as readonly Record<string, unknown>[], "context", false);
  for (const name of [
    "roleInstructionsSha256",
    "composedProviderPromptSha256",
    "inheritedDefaultsSha256",
    "toolProfileSha256",
    "runtimePermissionProfileSha256",
  ] as const)
    v2Sha(material[name], name);
  for (const name of [
    "adapterSettingsVersion",
    "providerSettingsVersion",
    "projectSettingsVersion",
    "workspaceSettingsVersion",
  ] as const)
    required(material[name], name);
  if (
    !evidence.promptText?.trim() ||
    (await nativeSpawnSha256(evidence.promptText)) !== material.composedProviderPromptSha256
  ) {
    reject("V2 full actual composed prompt bytes/material hash mismatched.");
  }
  const attachmentsSha256 = await nativeSpawnSha256(canonicalNativeSpawnJson(material.attachments));
  const contextSha256 = await nativeSpawnSha256(canonicalNativeSpawnJson(material.context));
  const immutableMaterialManifestSha256 = await nativeSpawnSha256(
    canonicalNativeSpawnJson({
      manifestVersion: 2,
      ...material,
      effectiveOptions: evidence.finalEffectiveOptions,
      workspace: evidence.workspace,
    }),
  );
  return deepFreezePlan({
    version: 2,
    admission: "inactive_unverified",
    descriptorVersion: 2,
    operationId: evidence.operationId,
    initialMessageId: evidence.firstMessageId,
    descriptorSha256: null,
    verificationState: "unresolved",
    callerProvenance: "unverified",
    enrollmentCandidate: { ...lease },
    sourceRunCandidate: { ...evidence.sourceRun },
    actualProjectId: evidence.actualProjectId,
    providerInstanceId: evidence.providerInstanceId,
    driver: evidence.driver,
    modelSlug: evidence.modelSlug,
    effectiveOptions: evidence.finalEffectiveOptions.map((o) => ({ ...o })),
    workspace: { ...ws },
    attachmentsSha256,
    contextSha256,
    immutableMaterialManifestSha256,
    composedProviderPromptSha256: material.composedProviderPromptSha256,
    candidateEvidenceSha256: await nativeSpawnSha256(canonicalNativeSpawnJson(evidence)),
  });
}

/**
 * Byte-compatible with OpenRig Stage-A descriptorDigestV2's hash envelope.
 * Pure formatting ONLY: it does not validate a process lease, any descriptor,
 * A's requestV2(), or a client entitlement. Never feed a candidate through
 * this helper as an API authorization or call it a verified digest.
 */
export async function canonicalNativeSpawnV2DigestBytes(
  operationId: string,
  descriptorBytesShape: unknown,
): Promise<string> {
  if (
    typeof operationId !== "string" ||
    !operationId ||
    descriptorBytesShape === null ||
    typeof descriptorBytesShape !== "object"
  ) {
    reject("V2 hash requires a real operation key and a structured descriptor.");
  }
  const payload = canonicalNativeSpawnJson({
    requestVersion: 2,
    operationId,
    descriptor: descriptorBytesShape,
  });
  if (Buffer.byteLength(payload, "utf8") > MAX_DESCRIPTOR_BYTES) {
    reject("Canonical A V2 request exceeds 16KiB.");
  }
  return nativeSpawnSha256(payload);
}
