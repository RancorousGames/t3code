/**
 * Typed, INACTIVE provider-only attestation client.
 *
 * No runtime registration, sidecar, IPC handle, HTTP request, bearer,
 * Windows Hello or creator permission is provided by this module.
 * Only an explicitly injected isolated harness can exercise the protocol
 * state machine. Its permits are NOT accepted by T3's Orchestrator.
 */
import {
  canonicalNativeSpawnJson,
  inspectNativeSpawnOperationId,
  inspectCanonicalV2NativeChildId,
  nativeSpawnSha256,
  type NativeSpawnExecutionPlanV2Candidate,
  type NativeSpawnExecutionPlanV1,
} from "./NativeSpawnExecutionPlan.ts";

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const SHA256 = /^[a-f\d]{64}$/;
const MAX_ENVELOPE_BYTES = 16_384;

export class T3OpenRigApprovalUnavailableError extends Error {
  readonly code = "native_spawn_attestor_unavailable" as const;
  constructor(message = "Enrolled T3 provider-spawn authority is unavailable (hard deny).") {
    super(message);
    this.name = "T3OpenRigApprovalUnavailableError";
  }
}

function deny(message: string): never {
  throw new T3OpenRigApprovalUnavailableError(message);
}

export type T3ProviderRequestFrameV1 = Readonly<{
  protocolVersion: 1;
  requestId: string;
  method: "provider.request";
  operationId: string;
  descriptorSha256: string;
}>;
export type T3ProviderReserveFrameV1 = Readonly<{
  protocolVersion: 1;
  requestId: string;
  method: "provider.reserve";
  operationId: string;
  expectedVersion: number;
  descriptorSha256: string;
}>;
export type T3ProviderOutcomeFrameV1 = Readonly<{
  protocolVersion: 1;
  requestId: string;
  method: "provider.outcome";
  operationId: string;
  reservationId: string;
}>;

export type T3ProviderFrameV1 =
  | T3ProviderRequestFrameV1
  | T3ProviderReserveFrameV1
  | T3ProviderOutcomeFrameV1;

export type NativeSpawnOutcomeV1 =
  | Readonly<{
      kind: "launched";
      threadId: string;
      providerInstanceId: string;
      driver: string;
      modelSlug: string;
      initialMessageId: string;
      persistenceReceiptId: string;
    }>
  | Readonly<{
      kind: "indeterminate";
      reason:
        | "missing-receipt"
        | "ambiguous-provider-effect"
        | "process-crashed"
        | "unverified-persistence";
      diagnosticSha256?: string;
    }>;

export type T3ProviderFrameReplyV1 =
  | Readonly<{
      method: "provider.request";
      requestId: string;
      operationId: string;
      descriptorSha256: string;
      status: "pending_approval";
      stateVersion: number;
    }>
  | Readonly<{
      method: "provider.reserve";
      requestId: string;
      operationId: string;
      descriptorSha256: string;
      status: "reserved_for_execution";
      reservationId: string;
      stateVersion: number;
      createPermittedOnce: true;
    }>
  | Readonly<{
      method: "provider.outcome";
      requestId: string;
      operationId: string;
      reservationId: string;
      status: "launched" | "indeterminate";
    }>;

function validRequestId(id: string): boolean {
  return typeof id === "string" && UUID.test(id);
}
function validCorrelation(id: string): boolean {
  try {
    inspectNativeSpawnOperationId(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strict plain-JSON frame shape. The envelope is a correlation key only;
 * validation cannot attest a T3 process, human, parent or permission.
 */
export function assertT3ProviderFrameV1(frame: unknown): asserts frame is T3ProviderFrameV1 {
  if (
    !frame ||
    typeof frame !== "object" ||
    Array.isArray(frame) ||
    Object.getPrototypeOf(frame) !== Object.prototype
  ) {
    deny("Provider IPC correlation must be a plain object.");
  }
  const record = frame as Record<string, unknown>;
  if (
    record.protocolVersion !== 1 ||
    !validRequestId(record.requestId as string) ||
    !validCorrelation(record.operationId as string)
  ) {
    deny("Invalid provider-only protocol, request or operation identity.");
  }
  const required =
    record.method === "provider.request"
      ? ["protocolVersion", "requestId", "method", "operationId", "descriptorSha256"]
      : record.method === "provider.reserve"
        ? [
            "protocolVersion",
            "requestId",
            "method",
            "operationId",
            "expectedVersion",
            "descriptorSha256",
          ]
        : record.method === "provider.outcome"
          ? ["protocolVersion", "requestId", "method", "operationId", "reservationId"]
          : deny("Unrecognized provider-only method.");
  if (
    Object.keys(record).length !== required.length ||
    Object.keys(record).some((key) => !required.includes(key))
  ) {
    deny("Provider-only envelope contains unauthorized or missing fields.");
  }
  if (
    record.method !== "provider.outcome" &&
    (typeof record.descriptorSha256 !== "string" || !SHA256.test(record.descriptorSha256))
  ) {
    deny("Missing canonical descriptor digest.");
  }
  if (
    record.method === "provider.reserve" &&
    (!Number.isSafeInteger(record.expectedVersion) || (record.expectedVersion as number) < 1)
  ) {
    deny("Expected version is required for single-use reservation.");
  }
  if (
    record.method === "provider.outcome" &&
    (typeof record.reservationId !== "string" || !UUID.test(record.reservationId))
  ) {
    deny("Outcome requires exact reservation identity.");
  }
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_ENVELOPE_BYTES) {
    deny("Private correlation envelope exceeds 16KiB.");
  }
}

export type NativeSpawnAttemptBindingV1 = Readonly<{
  operationId: string;
  descriptorSha256: string;
  reservationId: string;
  childThreadId: string;
  initialMessageId: string;
  commandId: string;
  expectedEffects: readonly ["thread.create", "message.dispatch", "provider.start"];
}>;

/**
 * Private closure-backed object, no public JSON representation. This is a
 * MODEL of the future internal permit, not an Orchestrator-admitted permit.
 * No production service consumes this class.
 */
const ISOLATED_ISSUANCE = Symbol("isolated-provider-reservation-only");

export class IsolatedNativeSpawnAttemptPermit {
  #binding: NativeSpawnAttemptBindingV1;
  #claimed = false;
  private constructor(binding: NativeSpawnAttemptBindingV1) {
    this.#binding = binding;
  }
  static issueFromIsolatedReservation(
    binding: NativeSpawnAttemptBindingV1,
    privateTicket: symbol,
  ): IsolatedNativeSpawnAttemptPermit {
    if (privateTicket !== ISOLATED_ISSUANCE) {
      deny("No internal positive isolated-reservation issuance ticket.");
    }
    return new IsolatedNativeSpawnAttemptPermit(binding);
  }
  claimOnce(expected: NativeSpawnAttemptBindingV1): void {
    if (this.#claimed) deny("Native attempt already spent or interrupted.");
    // Burn before checking to prevent trying multiple different bindings.
    this.#claimed = true;
    if (
      expected.operationId !== this.#binding.operationId ||
      expected.descriptorSha256 !== this.#binding.descriptorSha256 ||
      expected.reservationId !== this.#binding.reservationId ||
      expected.childThreadId !== this.#binding.childThreadId ||
      expected.initialMessageId !== this.#binding.initialMessageId ||
      expected.commandId !== this.#binding.commandId ||
      JSON.stringify(expected.expectedEffects) !== JSON.stringify(this.#binding.expectedEffects)
    ) {
      deny("Internal attempt binding changed; native create held.");
    }
  }
  toJSON(): never {
    return deny("An internal native-attempt permit cannot be serialized.");
  }
}

export interface T3OpenRigApprovalClient {
  request(plan: NativeSpawnExecutionPlanV1): Promise<{
    operationId: string;
    descriptorSha256: string;
    expectedVersion: number;
  }>;
  reserve(
    plan: NativeSpawnExecutionPlanV1,
    commandId: string,
  ): Promise<{
    binding: NativeSpawnAttemptBindingV1;
    permit: IsolatedNativeSpawnAttemptPermit;
  }>;
  outcome(
    plan: NativeSpawnExecutionPlanV1,
    evidence: NativeSpawnOutcomeV1,
  ): Promise<"launched" | "indeterminate">;
}

export function createT3OpenRigApprovalClient(): T3OpenRigApprovalClient {
  return {
    request: async () => deny("T3 Desktop backend enrollment is not implemented; request denied."),
    reserve: async () => deny("T3 provider authority is not enrolled; reserve denied."),
    outcome: async () => deny("T3 native outcome verifier is not enrolled; outcome denied."),
  };
}

/** No default instance, no transport connector; test double supplied by caller. */
export interface IsolatedT3ApprovalHarnessV1 {
  readonly getCurrentPlan: (operationId: string) => Promise<NativeSpawnExecutionPlanV1>;
  readonly sendFrame: (frame: T3ProviderFrameV1) => Promise<T3ProviderFrameReplyV1>;
  readonly nextRequestId: () => string;
  /** Only fake persisted records are used by isolated tests. Not caller claims. */
  readonly observePersistedOutcome: (operationId: string) => Promise<NativeSpawnOutcomeV1>;
}

type Stage =
  | { status: "requested"; planHash: string; descriptorSha256: string; version: number }
  | { status: "spent"; planHash: string; descriptorSha256: string; reservationId: string | null }
  | { status: "finished" }
  | { status: "blocked" };

async function ensurePlan(plan: NativeSpawnExecutionPlanV1): Promise<void> {
  if (
    plan.admission !== "inactive_unverified" ||
    plan.descriptor.callerProvenance !== "unverified" ||
    plan.version !== 1 ||
    !UUID.test(plan.operationId) ||
    plan.initialMessageId !== plan.descriptor.initialMessageId ||
    plan.descriptor.executionBinding.verificationState !== "unresolved" ||
    !SHA256.test(plan.descriptorSha256) ||
    !SHA256.test(plan.executionEvidenceSha256) ||
    plan.operationId === plan.initialMessageId
  ) {
    deny("Plan identity, exact initial message or structural admission marker mismatched.");
  }
  const actual = await nativeSpawnSha256(
    canonicalNativeSpawnJson({
      requestVersion: 1,
      operationId: plan.operationId,
      descriptor: plan.descriptor,
    }),
  );
  if (actual !== plan.descriptorSha256)
    deny("Descriptor was altered after immutable plan compilation.");
}

async function ensureSamePlan(
  original: NativeSpawnExecutionPlanV1,
  refreshed: NativeSpawnExecutionPlanV1,
): Promise<void> {
  await ensurePlan(refreshed);
  if (
    refreshed.operationId !== original.operationId ||
    refreshed.descriptorSha256 !== original.descriptorSha256 ||
    refreshed.executionEvidenceSha256 !== original.executionEvidenceSha256 ||
    refreshed.initialMessageId !== original.initialMessageId ||
    refreshed.serverGeneration !== original.serverGeneration
  ) {
    deny("Current enrolled-server plan drift; new reviewed intent required.");
  }
}

function assertReply(reply: T3ProviderFrameReplyV1, frame: T3ProviderFrameV1): void {
  if (
    !reply ||
    reply.method !== frame.method ||
    reply.requestId !== frame.requestId ||
    reply.operationId !== frame.operationId
  ) {
    deny("Authority reply is missing or correlated to another operation.");
  }
}

/**
 * Protocol simulator for isolated injected tests ONLY. It cannot verify host
 * enrollment or a human decision, cannot call a real provider transport, and
 * cannot release T3's unconditional native guards. A mock positive reserve
 * proves state handling only, never authorization.
 */
export function createIsolatedT3OpenRigApprovalProtocol(
  harness: IsolatedT3ApprovalHarnessV1,
): T3OpenRigApprovalClient {
  const operations = new Map<string, Stage>();
  const issuedRequestIds = new Set<string>();

  const send = async (frame: T3ProviderFrameV1): Promise<T3ProviderFrameReplyV1> => {
    assertT3ProviderFrameV1(frame);
    // Never retry an uncertain frame. It is the harness's job to simulate
    // one individual response; real enrollment and networking are absent.
    return harness.sendFrame(frame);
  };
  const requestId = (): string => {
    const id = harness.nextRequestId();
    if (!validRequestId(id) || issuedRequestIds.has(id)) {
      deny("Authority request ID is malformed or replayed.");
    }
    issuedRequestIds.add(id);
    return id;
  };
  return {
    request: async (plan) => {
      await ensurePlan(plan);
      if (operations.has(plan.operationId))
        deny("Duplicate request or uncertain previous request.");
      operations.set(plan.operationId, { status: "blocked" });
      const latest = await harness.getCurrentPlan(plan.operationId);
      await ensureSamePlan(plan, latest);
      const frame: T3ProviderRequestFrameV1 = {
        protocolVersion: 1,
        requestId: requestId(),
        method: "provider.request",
        operationId: plan.operationId,
        descriptorSha256: plan.descriptorSha256,
      };
      const response = await send(frame);
      assertReply(response, frame);
      if (
        response.method !== "provider.request" ||
        response.descriptorSha256 !== plan.descriptorSha256 ||
        response.status !== "pending_approval" ||
        !Number.isSafeInteger(response.stateVersion) ||
        response.stateVersion < 1
      ) {
        deny("Pending approval reply missing exact digest or state version.");
      }
      operations.set(plan.operationId, {
        status: "requested",
        planHash: plan.executionEvidenceSha256,
        descriptorSha256: plan.descriptorSha256,
        version: response.stateVersion,
      });
      return {
        operationId: plan.operationId,
        descriptorSha256: plan.descriptorSha256,
        expectedVersion: response.stateVersion,
      };
    },
    reserve: async (plan, commandId) => {
      await ensurePlan(plan);
      const state = operations.get(plan.operationId);
      if (
        state?.status !== "requested" ||
        state.planHash !== plan.executionEvidenceSha256 ||
        state.descriptorSha256 !== plan.descriptorSha256
      ) {
        deny("No unspent, matching request before reserve.");
      }
      if (typeof commandId !== "string" || commandId.length === 0 || commandId.length > 256) {
        deny("Exact preallocated T3 create command ID required.");
      }
      // Consume locally before any call. Lost response or a rejected CAS may
      // have consumed approval remotely; never re-reserve this operation.
      operations.set(plan.operationId, {
        status: "spent",
        planHash: state.planHash,
        descriptorSha256: state.descriptorSha256,
        reservationId: null,
      });
      const latest = await harness.getCurrentPlan(plan.operationId);
      await ensureSamePlan(plan, latest);
      const frame: T3ProviderReserveFrameV1 = {
        protocolVersion: 1,
        requestId: requestId(),
        method: "provider.reserve",
        operationId: plan.operationId,
        expectedVersion: state.version,
        descriptorSha256: plan.descriptorSha256,
      };
      const response = await send(frame);
      assertReply(response, frame);
      if (
        response.method !== "provider.reserve" ||
        response.descriptorSha256 !== plan.descriptorSha256 ||
        response.status !== "reserved_for_execution" ||
        response.createPermittedOnce !== true ||
        !UUID.test(response.reservationId) ||
        !Number.isSafeInteger(response.stateVersion) ||
        response.stateVersion <= state.version
      ) {
        deny("No positive single-use CAS reservation acknowledgement.");
      }
      const binding: NativeSpawnAttemptBindingV1 = {
        operationId: plan.operationId,
        descriptorSha256: plan.descriptorSha256,
        reservationId: response.reservationId,
        childThreadId: plan.operationId,
        initialMessageId: plan.initialMessageId,
        commandId,
        expectedEffects: ["thread.create", "message.dispatch", "provider.start"],
      };
      operations.set(plan.operationId, {
        status: "spent",
        planHash: state.planHash,
        descriptorSha256: state.descriptorSha256,
        reservationId: response.reservationId,
      });
      return {
        binding,
        permit: IsolatedNativeSpawnAttemptPermit.issueFromIsolatedReservation(
          binding,
          ISOLATED_ISSUANCE,
        ),
      };
    },
    outcome: async (plan, evidence) => {
      await ensurePlan(plan);
      const state = operations.get(plan.operationId);
      if (
        state?.status !== "spent" ||
        state.reservationId === null ||
        state.descriptorSha256 !== plan.descriptorSha256
      ) {
        deny("Outcome without exact consumed reservation or duplicate report.");
      }
      // Terminal from the first attempt: burn before any callback/response.
      operations.set(plan.operationId, { status: "finished" });
      const actual = await harness.observePersistedOutcome(plan.operationId);
      if (canonicalNativeSpawnJson(actual) !== canonicalNativeSpawnJson(evidence)) {
        deny("Outcome was not observed in T3 persisted receipts.");
      }
      if (
        actual.kind === "launched" &&
        (actual.threadId !== plan.operationId ||
          actual.initialMessageId !== plan.initialMessageId ||
          actual.providerInstanceId !== plan.descriptor.providerInstanceId ||
          actual.driver !== plan.descriptor.driver ||
          actual.modelSlug !== plan.descriptor.modelSlug ||
          !/^[A-Za-z0-9_:.-]{1,256}$/.test(actual.persistenceReceiptId))
      ) {
        deny("Persisted launched receipt mismatches immutable first attempt.");
      }
      if (
        actual.kind === "indeterminate" &&
        actual.diagnosticSha256 !== undefined &&
        !SHA256.test(actual.diagnosticSha256)
      ) {
        deny("Indeterminate diagnosis digest is invalid.");
      }
      const frame: T3ProviderOutcomeFrameV1 = {
        protocolVersion: 1,
        requestId: requestId(),
        method: "provider.outcome",
        operationId: plan.operationId,
        reservationId: state.reservationId,
      };
      const response = await send(frame);
      assertReply(response, frame);
      if (
        response.method !== "provider.outcome" ||
        response.reservationId !== state.reservationId ||
        response.status !== actual.kind
      ) {
        deny("Terminal outcome reply mismatches persisted record.");
      }
      return response.status;
    },
  };
}

/**
 * Canonical A V2 client contract (INACTIVE): pure correlation/response types.
 * The public factory cannot convert V2 candidates into verified descriptors,
 * invoke OpenRig's canonical requestV2, or issue a native attempt permit.
 */
export type T3CanonicalV2AdmissionTrack = "human" | "exact_luna_policy";
export type T3CanonicalV2Correlation =
  | Readonly<{
      protocolVersion: 1;
      requestId: string;
      method: "provider.request";
      operationId: string;
      descriptorSha256: string;
    }>
  | Readonly<{
      protocolVersion: 1;
      requestId: string;
      method: "provider.admitExactLuna";
      operationId: string;
      expectedVersion: number;
      descriptorSha256: string;
    }>
  | Readonly<{
      protocolVersion: 1;
      requestId: string;
      method: "provider.reserve";
      operationId: string;
      expectedVersion: number;
      descriptorSha256: string;
    }>
  | Readonly<{
      protocolVersion: 1;
      requestId: string;
      method: "provider.outcome";
      operationId: string;
      reservationId: string;
    }>;

export type T3CanonicalV2AuthorityObservation = Readonly<{
  requestVersion: 2;
  operationId: string;
  descriptorSha256: string;
  admissionTrack: T3CanonicalV2AdmissionTrack;
  stateVersion: number;
  status:
    | "pending_approval"
    | "approved"
    | "pending_policy_admission"
    | "exempt_admitted"
    | "reserved_for_execution"
    | "launched"
    | "indeterminate";
  /** Policy rows must never assert a human decision/destination. */
  humanDestination: string | null;
  decidedBy: string | null;
  policyId: "exact-codex-gpt-6-luna-v1" | null;
  policyEvidenceSha256: string | null;
}>;

export function assertT3CanonicalV2AuthorityObservation(
  value: unknown,
  expected: Readonly<{ operationId: string; descriptorSha256: string }>,
): asserts value is T3CanonicalV2AuthorityObservation {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    deny("No canonical v2 authority record.");
  }
  const row = value as Record<string, unknown>;
  const keys = [
    "requestVersion",
    "operationId",
    "descriptorSha256",
    "admissionTrack",
    "stateVersion",
    "status",
    "humanDestination",
    "decidedBy",
    "policyId",
    "policyEvidenceSha256",
  ];
  if (
    Object.keys(row).length !== keys.length ||
    Object.keys(row).some((key) => !keys.includes(key)) ||
    row.requestVersion !== 2 ||
    row.operationId !== expected.operationId ||
    row.descriptorSha256 !== expected.descriptorSha256 ||
    !SHA256.test(row.descriptorSha256 as string) ||
    !Number.isSafeInteger(row.stateVersion) ||
    (row.stateVersion as number) < 1
  ) {
    deny("V2 authority version, identity, digest or state is inconsistent.");
  }
  if (row.admissionTrack === "human") {
    if (
      ![
        "pending_approval",
        "approved",
        "reserved_for_execution",
        "launched",
        "indeterminate",
      ].includes(row.status as string) ||
      row.policyId !== null ||
      row.policyEvidenceSha256 !== null ||
      row.humanDestination !== "human@kernel"
    ) {
      deny("Canonical human track cannot masquerade as policy admission.");
    }
    if (
      (row.status === "approved" ||
        row.status === "reserved_for_execution" ||
        row.status === "launched") &&
      row.decidedBy !== "human@kernel"
    ) {
      deny("Human approval requires actual operator decision provenance.");
    }
    // This structural check is not proof that the claimed human acted.
  } else if (row.admissionTrack === "exact_luna_policy") {
    if (
      ![
        "pending_policy_admission",
        "exempt_admitted",
        "reserved_for_execution",
        "launched",
        "indeterminate",
      ].includes(row.status as string) ||
      row.decidedBy !== null ||
      row.humanDestination !== null ||
      (row.status === "pending_policy_admission"
        ? row.policyId !== null || row.policyEvidenceSha256 !== null
        : row.policyId !== "exact-codex-gpt-6-luna-v1" ||
          typeof row.policyEvidenceSha256 !== "string" ||
          !SHA256.test(row.policyEvidenceSha256))
    ) {
      deny("Luna policy track must never contain forged human approval.");
    }
  } else {
    deny("Unknown canonical admission track.");
  }
}

export function assertT3CanonicalV2Correlation(
  raw: unknown,
  projectId: string,
): asserts raw is T3CanonicalV2Correlation {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.getPrototypeOf(raw) !== Object.prototype
  ) {
    deny("Malformed V2 provider-only correlation.");
  }
  const r = raw as Record<string, unknown>;
  const fields =
    r.method === "provider.request"
      ? ["protocolVersion", "requestId", "method", "operationId", "descriptorSha256"]
      : r.method === "provider.reserve" || r.method === "provider.admitExactLuna"
        ? [
            "protocolVersion",
            "requestId",
            "method",
            "operationId",
            "expectedVersion",
            "descriptorSha256",
          ]
        : r.method === "provider.outcome"
          ? ["protocolVersion", "requestId", "method", "operationId", "reservationId"]
          : deny("Operator, public client, or unsupported policy method denied.");
  if (
    Object.keys(r).length !== fields.length ||
    Object.keys(r).some((key) => !fields.includes(key)) ||
    r.protocolVersion !== 1 ||
    !validRequestId(r.requestId as string) ||
    typeof r.operationId !== "string"
  ) {
    deny("Invalid V2 provider-only transport envelope.");
  }
  // Only Stage-A's default allocator project thread or *actual* UUID; never
  // MCP create/read-send aliases, delegated IDs or client-selected new IDs.
  try {
    inspectCanonicalV2NativeChildId(r.operationId, projectId);
  } catch {
    deny("Operation ID is not admitted by canonical A V2 grammar.");
  }
  if (r.method === "provider.outcome") {
    if (typeof r.reservationId !== "string" || !UUID.test(r.reservationId)) {
      deny("Missing actual one-use reservation correlation.");
    }
  } else {
    if (typeof r.descriptorSha256 !== "string" || !SHA256.test(r.descriptorSha256)) {
      deny("Missing exact canonical V2 digest.");
    }
    if (
      r.method !== "provider.request" &&
      (!Number.isSafeInteger(r.expectedVersion) || (r.expectedVersion as number) < 1)
    ) {
      deny("Single-use canonical CAS expectedVersion required.");
    }
  }
  if (Buffer.byteLength(JSON.stringify(r), "utf8") > 4096) {
    deny("Provider correlation exceeds f8a's 4096-byte private frame bound.");
  }
}

export interface T3OpenRigApprovalClientV2 {
  request(candidate: NativeSpawnExecutionPlanV2Candidate): Promise<never>;
  admitExactLuna(candidate: NativeSpawnExecutionPlanV2Candidate): Promise<never>;
  reserve(candidate: NativeSpawnExecutionPlanV2Candidate): Promise<never>;
  outcome(candidate: NativeSpawnExecutionPlanV2Candidate): Promise<never>;
}

/** Source-only V2 alignment: NO trusted enrollment, no IPC process and NO permit. */
export function createT3OpenRigApprovalClientV2(): T3OpenRigApprovalClientV2 {
  return {
    request: async () => deny("Canonical V2 has no enrolled source-run/material verifier."),
    admitExactLuna: async () =>
      deny("Exact-Luna policy admission requires a separate trusted authority."),
    reserve: async () => deny("Canonical V2 cannot reserve before enrolled one-use admission."),
    outcome: async () => deny("Canonical V2 has no authenticated persisted outcome reader."),
  };
}
