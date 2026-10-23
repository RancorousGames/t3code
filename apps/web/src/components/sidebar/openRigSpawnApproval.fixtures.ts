import type { SpawnApprovalFeed, SpawnApprovalRequestView } from "./OpenRigSpawnApproval";

/**
 * MOCK DATA ONLY, for tests and design review of OpenRigSpawnApproval. Never
 * import from a live surface: these are not OpenRig records.
 */
const base: SpawnApprovalRequestView = {
  id: "mock-request-pending",
  operationId: "00000000-0000-4000-8000-00000000a001",
  status: "pending_approval",
  requestedBy: { kind: "verified-seat", seatId: "mock-seat/manager" },
  sourceThread: { environmentId: "mock-env", threadId: "mock-thread-manager" },
  destinationSeatId: "mock-seat/worker",
  target: {
    environmentId: "mock-env",
    providerInstanceId: "mockCodex",
    model: "gpt-6-astra",
    effort: "high",
    runtime: "codex",
    runtimeMode: "approval-required",
  },
  exemption: "not-exempt",
  workspaceRoot: "D:\\MockProject",
  projectId: null,
  taskPreview: "Mock task preview: refactor the parser module.",
  requestedAt: "2026-10-19T10:00:00.000Z",
  expiresAt: "2026-10-19T10:30:00.000Z",
  decision: null,
};

export const MOCK_SPAWN_APPROVAL_NOW = Date.parse("2026-10-19T10:05:00.000Z");

export const MOCK_SPAWN_APPROVALS = {
  pending: base,
  unknownCaller: {
    ...base, id: "mock-request-unknown", operationId: "00000000-0000-4000-8000-00000000a002",
    requestedBy: { kind: "unknown" }, sourceThread: null, exemption: "unknown",
  },
  approved: {
    ...base, id: "mock-request-approved", operationId: "00000000-0000-4000-8000-00000000a003",
    status: "approved", decision: { outcome: "approved", actor: "human@kernel", at: "2026-10-19T10:02:00.000Z" },
  },
  denied: {
    ...base, id: "mock-request-denied", operationId: "00000000-0000-4000-8000-00000000a004",
    status: "denied", decision: { outcome: "denied", actor: "human@kernel", at: "2026-10-19T10:03:00.000Z" },
  },
  expired: {
    ...base, id: "mock-request-expired", operationId: "00000000-0000-4000-8000-00000000a005",
    status: "expired", expiresAt: "2026-10-19T09:30:00.000Z", requestedAt: "2026-10-19T09:00:00.000Z",
  },
  /** Still pending server-side, but past its deadline at MOCK_SPAWN_APPROVAL_NOW: no controls. */
  pendingPastDeadline: {
    ...base, id: "mock-request-stale", operationId: "00000000-0000-4000-8000-00000000a006",
    expiresAt: "2026-10-19T10:01:00.000Z",
  },
  indeterminate: {
    ...base, id: "mock-request-indeterminate", operationId: "00000000-0000-4000-8000-00000000a007",
    status: "indeterminate", decision: { outcome: "approved", actor: "human@kernel", at: "2026-10-19T10:02:00.000Z" },
  },
} satisfies Record<string, SpawnApprovalRequestView>;

export const MOCK_SPAWN_APPROVAL_FEEDS = {
  empty: { kind: "ready", requests: [] },
  loading: { kind: "loading" },
  error: { kind: "error", message: "Mock: OpenRig bridge HTTP 503." },
  mixed: { kind: "ready", requests: Object.values(MOCK_SPAWN_APPROVALS) },
} satisfies Record<string, SpawnApprovalFeed>;
