// @effect-diagnostics nodeBuiltinImport:off -- The desktop-only Windows AISpeak process is a bounded OS adapter (no shell).
import {
  DesktopOpenRigAgentSchema,
  DesktopOpenRigNativeApprovalSchema,
  DesktopOpenRigNativeApprovalPageSchema,
  DesktopOpenRigNativeReviewResultSchema,
  DesktopOpenRigInboxSchema,
  DesktopOpenRigHumanResponseInputSchema,
  DesktopOpenRigHumanResponseResultSchema,
  DesktopOpenRigOperatorReplyInputSchema,
  DesktopOpenRigOperatorReplyResultSchema,
  type DesktopOpenRigOperatorReplyInput,
  type DesktopOpenRigOperatorReplyResult,
  type DesktopOpenRigHumanResponseInput,
  type DesktopOpenRigHumanResponseResult,
  DesktopOpenRigSessionSchema,
  DesktopOpenRigSeatSessionsSchema,
  DesktopOpenRigSeatTopologySchema,
  DesktopOpenRigSeatReportsSchema,
  DesktopOpenRigAgentTasksSchema,
  DesktopOpenRigPolicyPageSchema,
  DesktopOpenRigPolicyIntakeInputSchema,
  DesktopOpenRigPolicyIntakeResultSchema,
  type DesktopOpenRigPolicyIntakeInput,
  type DesktopOpenRigPolicyIntakeResult,
  type DesktopOpenRigPolicyItem,
  type DesktopOpenRigAgentTasks,
  type DesktopOpenRigSeatTopology,
  type DesktopOpenRigSeatReports,
  DesktopOpenRigExecutionProfileSchema,
  DesktopOpenRigConfigureExecutionProfileInputSchema,
  type DesktopOpenRigExecutionProfile,
  type DesktopOpenRigConfigureExecutionProfileInput,
  DesktopOpenRigPrimaryInputSchema,
  DesktopOpenRigLaunchInputSchema,
  DesktopOpenRigAdoptInputSchema,
  DesktopOpenRigSessionActionInputSchema,
  DesktopOpenRigManagedBrowserLifecycleInputSchema,
  DesktopOpenRigManagedBrowserLifecycleResultSchema,
  type DesktopOpenRigAdoptInput,
  type DesktopOpenRigSessionActionInput,
  type DesktopOpenRigManagedBrowserLifecycleInput,
  type DesktopOpenRigManagedBrowserLifecycleResult,
  type DesktopOpenRigLaunchInput,
  type DesktopOpenRigSeatSessions,
  type DesktopOpenRigPrimaryInput,
  DesktopOpenRigBindInputSchema,
  DesktopOpenRigSendInputSchema,
  type DesktopOpenRigAgent,
  type DesktopOpenRigInbox,
  type DesktopOpenRigSession,
  type DesktopOpenRigSessionTarget,
  type DesktopOpenRigBindInput,
  type DesktopOpenRigSendInput,
  decodeOpenRigReviewGate,
  safeOpenRigReviewUrl,
  DesktopOpenRigReviewGateSelectionSchema,
  DesktopOpenRigReviewGateResolveInputSchema,
  DesktopOpenRigReviewGateResolveResultSchema,
  OPENRIG_REVIEW_GATE_VERDICTS,
  type OpenRigReviewGate,
  type DesktopOpenRigInboxItem,
  type DesktopOpenRigReviewGateSelection,
  type DesktopOpenRigReviewGateResolveInput,
  type DesktopOpenRigReviewGateResolveResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import { createHash } from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import * as NodeProcess from "node:process";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../channels.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import {
  getNativeSpawnApproval,
  listPendingNativeSpawnApprovals,
  reviewNativeSpawnOperation,
} from "../../app/DesktopOpenRigApprovalHost.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { ensureLocalOpenRigBridge } from "./OpenRigBridgeLifecycle.ts";

// The renderer never connects to localhost directly. It cannot choose the host,
// path or HTTP method, even when a remote T3 environment is selected.
const OPENRIG_BASE_URL = "http://127.0.0.1:7433/api/integrations/t3";
const LIST_TIMEOUT_MS = 12_000;
// T3 browser composer dispatch can take up to 95 seconds. A shorter timeout
// would report failure after T3 already delivered the message, inviting duplicates.
const SEND_TIMEOUT_MS = 110_000;
const decodeOpenRigInbox = Schema.decodeUnknownSync(DesktopOpenRigInboxSchema);
const decodeHumanResponse = Schema.decodeUnknownSync(DesktopOpenRigHumanResponseResultSchema);
const decodeCanonicalAgentTasks = Schema.decodeUnknownSync(DesktopOpenRigAgentTasksSchema);
const decodeOpenRigPolicyPage = Schema.decodeUnknownSync(DesktopOpenRigPolicyPageSchema);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Invalid OpenRig agent response.");
  }
  return value;
}

/** Accepts an array or { agents: [] }; only expose fields needed by the sidebar. */
export function decodeOpenRigAgents(payload: unknown): DesktopOpenRigAgent[] {
  const entries = Array.isArray(payload) ? payload : record(payload)?.agents;
  if (!Array.isArray(entries) || entries.length > 500) {
    throw new Error("Invalid OpenRig agents response.");
  }
  return entries.map((entry: unknown) => {
    const agent = record(entry);
    if (!agent) throw new Error("Invalid OpenRig agent response.");
    const task = agent.task ?? agent.currentTask ?? agent.current_task;
    return {
      id: requiredString(agent.id),
      name: requiredString(agent.name),
      status: typeof agent.status === "string" ? agent.status : "unknown",
      role: typeof agent.role === "string" ? agent.role : null,
      task: typeof task === "string" ? task : null,
      bound: record(agent.binding) !== null,
      bindingKind:
        typeof record(record(agent.binding)?.target)?.kind === "string"
          ? (record(record(agent.binding)?.target)!.kind as string)
          : record(agent.binding)
            ? "legacy-browser"
            : null,
      sessionId:
        typeof record(agent.binding)?.sessionId === "string"
          ? (record(agent.binding)!.sessionId as string)
          : null,
      sessionTitle:
        typeof record(agent.session)?.title === "string"
          ? (record(agent.session)!.title as string)
          : null,
    };
  });
}

async function bridgeRequest(
  path: string,
  options: { method: "GET" | "POST" | "PUT" | "DELETE"; payload?: Record<string, unknown> },
  fetchImpl: typeof fetch,
  allowUnavailable = false,
  acceptedErrorStatuses: readonly number[] = [],
): Promise<Response> {
  // Renderer IPC is the only consumer. On this user's Windows installation
  // adopt an existing OpenRig listener or start the local Phase-1 bridge.
  // Injected test fetchers never create external processes.
  if (fetchImpl === fetch) await ensureLocalOpenRigBridge();
  const response = await fetchImpl(`${OPENRIG_BASE_URL}${path}`, {
    method: options.method,
    headers:
      options.payload === undefined
        ? { Accept: "application/json" }
        : { Accept: "application/json", "Content-Type": "application/json" },
    ...(options.payload === undefined ? {} : { body: JSON.stringify(options.payload) }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(
      options.method === "GET"
        ? LIST_TIMEOUT_MS
        : path.endsWith("/send") || path.endsWith("/sessions")
          ? SEND_TIMEOUT_MS
          : LIST_TIMEOUT_MS,
    ),
  });
  if (
    !response.ok &&
    !(allowUnavailable && response.status === 503) &&
    !acceptedErrorStatuses.includes(response.status)
  ) {
    // Surface the backend's actionable reason (missing seat, stale thread,
    // duplicate binding) instead of presenting every failure as a generic 503.
    const errorBody = (await response
      .clone()
      .json()
      .catch(() => null)) as unknown;
    const detail = record(errorBody)?.error;
    throw new Error(
      `OpenRig bridge HTTP ${response.status}${typeof detail === "string" ? ": " + detail.slice(0, 300) : ""}.`,
    );
  }
  return response;
}

export async function fetchOpenRigAgents(fetchImpl: typeof fetch = fetch) {
  const response = await bridgeRequest("/agents", { method: "GET" }, fetchImpl);
  return decodeOpenRigAgents((await response.json()) as unknown);
}

/** HTTP 2xx alone does not establish that T3 accepted the message. */
export function assertOpenRigSendAcknowledged(value: unknown): void {
  const receipt = record(value);
  const target = record(receipt?.target);
  const result = record(receipt?.result);
  if (target?.kind === "t3-thread") {
    if (
      result?.messageSent === true &&
      typeof result.messageId === "string" &&
      result.messageId.length > 0 &&
      result.threadId === target.threadId &&
      result.environmentId === target.environmentId
    )
      return;
  } else if (target?.kind === "chatgpt-conversation") {
    if (
      result?.messageSent === true &&
      result.conversationGuardValidated === true &&
      result.verifiedConversationId === target.conversationId
    )
      return;
  }
  // Managed delivery never falls back to a legacy browser UUID, even if an
  // older bridge returns HTTP 200 and claims it dispatched a message.
  throw new Error(
    "OpenRig did not return a matching T3 delivery acknowledgement; outcome unknown. Do not retry blindly.",
  );
}

export async function sendOpenRigMessage(
  { id, message }: DesktopOpenRigSendInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!id.trim() || id.length > 512 || !message.trim() || message.length > 8_000) {
    throw new Error("OpenRig message not sent: invalid seat or message.");
  }
  // Older OpenRig versions still have a legacy /binding fallback when no
  // managed primary exists. Refuse to make any POST in that state, even if a
  // renderer mistakenly exposes a send action for a legacy-bound seat.
  let ledger: DesktopOpenRigSeatSessions;
  try {
    ledger = await fetchOpenRigManagedSessions(id, fetchImpl);
  } catch (error) {
    // This read precedes the POST. An unavailable/malformed ledger is a
    // definite no-send, unlike a failed or timed-out POST.
    throw new Error(
      "OpenRig message not sent: could not verify managed primary: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  const primary = ledger.sessions.find((session) => session.id === ledger.primarySessionId);
  const expected = primary?.status === "active" ? primary.target : null;
  if (!expected || expected.kind === "legacy-browser")
    throw new Error("OpenRig message not sent: seat has no routable active managed primary.");
  const response = await bridgeRequest(
    `/agents/${encodeURIComponent(id)}/send`,
    { method: "POST", payload: { message } },
    fetchImpl,
  );
  const acknowledgement = (await response.json()) as unknown;
  assertOpenRigSendAcknowledged(acknowledgement);
  const actual = record(record(acknowledgement)?.target);
  if (
    !actual ||
    actual.kind !== expected.kind ||
    (expected.kind === "t3-thread" &&
      (actual.environmentId !== expected.environmentId || actual.threadId !== expected.threadId)) ||
    (expected.kind === "chatgpt-conversation" && actual.conversationId !== expected.conversationId)
  )
    throw new Error(
      "OpenRig delivery target diverged from the managed primary; outcome unknown. Do not retry blindly.",
    );
}

function decodeSessionTarget(value: unknown): DesktopOpenRigSessionTarget {
  const target = record(value);
  if (!target) throw new Error("Missing OpenRig conversation target.");
  if (
    target.kind === "t3-thread" &&
    typeof target.environmentId === "string" &&
    typeof target.threadId === "string"
  ) {
    return { kind: "t3-thread", environmentId: target.environmentId, threadId: target.threadId };
  }
  if (target.kind === "chatgpt-conversation" && typeof target.conversationId === "string") {
    return {
      kind: "chatgpt-conversation",
      conversationId: target.conversationId,
      ...(typeof target.preferredBrowserSessionId === "string"
        ? { preferredBrowserSessionId: target.preferredBrowserSessionId }
        : {}),
    };
  }
  if (target.kind === "legacy-browser" && typeof target.sessionId === "string")
    return { kind: "legacy-browser", sessionId: target.sessionId };
  throw new Error("Unsupported OpenRig conversation target.");
}

export function decodeOpenRigSessions(payload: unknown): DesktopOpenRigSession[] {
  const sessions = record(payload)?.conversations;
  if (!Array.isArray(sessions) || sessions.length > 6_000) {
    throw new Error("Invalid OpenRig/T3 conversation list.");
  }
  return sessions.map((entry: unknown) => {
    const session = record(entry);
    if (!session) throw new Error("Invalid OpenRig conversation.");
    const target = decodeSessionTarget(session.target);
    return {
      id: requiredString(session.id),
      title: typeof session.title === "string" ? session.title : "Untitled conversation",
      project: typeof session.project === "string" ? session.project : null,
      status: typeof session.status === "string" ? session.status : "unknown",
      kind: target.kind,
      target,
      provider: typeof session.provider === "string" ? session.provider : null,
    };
  });
}

export async function fetchOpenRigSessions(fetchImpl: typeof fetch = fetch) {
  const response = await bridgeRequest("/conversations", { method: "GET" }, fetchImpl);
  return decodeOpenRigSessions((await response.json()) as unknown);
}

/** Read OpenRig's ledger as-is, without inferring ownership from T3 tabs or title matches. */
export function decodeOpenRigManagedSessions(
  payload: unknown,
  seatId: string,
): DesktopOpenRigSeatSessions {
  const value = record(payload);
  if (value?.seatId !== seatId || !Array.isArray(value.sessions) || value.sessions.length > 1_000)
    throw new Error("Invalid OpenRig managed session ledger or seat mismatch.");
  const decoded = Schema.decodeUnknownSync(DesktopOpenRigSeatSessionsSchema)(payload);
  const ids = new Set<string>();
  for (const session of decoded.sessions) {
    if (session.seatId !== seatId || ids.has(session.id))
      throw new Error("OpenRig returned duplicate or foreign owned sessions.");
    ids.add(session.id);
  }
  if (decoded.primarySessionId !== null && !ids.has(decoded.primarySessionId))
    throw new Error("OpenRig primary session does not belong to this seat.");
  for (const session of decoded.sessions) {
    if (session.primary !== (decoded.primarySessionId === session.id))
      throw new Error("OpenRig primary session flags contradict the ledger.");
  }
  return decoded;
}

function assertSeatId(seatId: string): string {
  if (!seatId.trim() || seatId.length > 512) throw new Error("Invalid OpenRig seat ID.");
  return encodeURIComponent(seatId);
}

const stringArray = (value: unknown): string[] | null =>
  Array.isArray(value) && value.length <= 500 && value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : null;

/** RigSpec seat edges only. Malformed seats fail the whole read; nothing is guessed. */
export function decodeOpenRigSeatTopology(payload: unknown): DesktopOpenRigSeatTopology {
  const body = record(payload);
  // The full daemon includes its managed ledger in RigSpec discovery provenance.
  // Both published source labels still carry exactly the same authoritative seat shape.
  if (
    (body?.source !== "openrig-rigspec" && body?.source !== "openrig-rigspec-and-managed-ledger") ||
    !Array.isArray(body.seats) ||
    body.seats.length > 1_000
  )
    throw new Error("Invalid OpenRig seat topology response.");
  return {
    source: body.source as DesktopOpenRigSeatTopology["source"],
    seats: body.seats.map((entry: unknown) => {
      const seat = record(entry);
      const parentIds = stringArray(seat?.parentIds);
      const childIds = stringArray(seat?.childIds);
      if (!seat || !parentIds || !childIds)
        throw new Error("Invalid OpenRig seat topology response.");
      return {
        id: requiredString(seat.id),
        rigId: requiredString(seat.rigId),
        rigName: typeof seat.rigName === "string" ? seat.rigName : "",
        name: requiredString(seat.name),
        logicalId: typeof seat.logicalId === "string" ? seat.logicalId : "",
        role: typeof seat.role === "string" ? seat.role : null,
        parentIds,
        childIds,
      };
    }),
  };
}

const REPORT_STATUSES = new Set(["working", "blocked", "completed", "failed"]);
/** Seat reports are author-unverified; any other claim is rejected. */
export function decodeOpenRigSeatReports(
  payload: unknown,
  seatId: string,
): DesktopOpenRigSeatReports {
  const body = record(payload);
  if (body?.seatId !== seatId || !Array.isArray(body.reports) || body.reports.length > 100)
    throw new Error("Invalid OpenRig seat reports response.");
  return {
    seatId,
    reports: body.reports.map((entry: unknown) => {
      const report = record(entry);
      const blockedOn = stringArray(report?.blockedOn ?? []);
      if (
        !report ||
        typeof report.status !== "string" ||
        !REPORT_STATUSES.has(report.status) ||
        typeof report.summary !== "string" ||
        typeof report.timestamp !== "string" ||
        typeof report.eventSeq !== "number" ||
        report.authorVerified !== false ||
        !blockedOn ||
        (report.progress !== null &&
          report.progress !== undefined &&
          typeof report.progress !== "number")
      )
        throw new Error("Invalid OpenRig seat report.");
      return {
        reportId: requiredString(report.reportId),
        status: report.status as DesktopOpenRigSeatReports["reports"][number]["status"],
        summary: report.summary,
        progress: typeof report.progress === "number" ? report.progress : null,
        blockedOn,
        timestamp: report.timestamp,
        eventSeq: report.eventSeq,
        authorVerified: false as const,
      };
    }),
  };
}

export async function fetchOpenRigSeatTopology(
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopOpenRigSeatTopology> {
  const response = await bridgeRequest("/coordination/discover", { method: "GET" }, fetchImpl);
  return decodeOpenRigSeatTopology((await response.json()) as unknown);
}

export async function fetchOpenRigSeatReports(
  seatId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopOpenRigSeatReports> {
  const id = assertSeatId(seatId);
  const response = await bridgeRequest(
    `/coordination/reports/${id}?limit=20`,
    { method: "GET" },
    fetchImpl,
  );
  return decodeOpenRigSeatReports((await response.json()) as unknown, seatId);
}

/** Read exactly one RigSpec node's canonical queue projection through desktop MAIN. */
export async function fetchOpenRigAgentTasks(
  agentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopOpenRigAgentTasks> {
  if (
    !agentId ||
    agentId !== agentId.trim() ||
    agentId.length > 512 ||
    /[\\?#%\s]/.test(agentId) ||
    agentId.split("/").some((segment) => segment === "." || segment === "..") ||
    [...agentId].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new Error("Invalid OpenRig agent node ID.");
  }
  const response = await bridgeRequest(
    `/agents/${encodeURIComponent(agentId)}/tasks?limit=25`,
    { method: "GET" },
    fetchImpl,
    false,
    [400, 404, 409, 503],
  );
  const payload = (await response.json()) as unknown;
  let decoded: DesktopOpenRigAgentTasks;
  try {
    decoded = decodeCanonicalAgentTasks(payload);
  } catch {
    throw new Error("Invalid OpenRig canonical task projection response.");
  }
  if (response.ok) {
    if (
      !decoded.available ||
      decoded.agent.agentId !== agentId ||
      decoded.limit !== 25 ||
      decoded.tasks.length > 25 ||
      decoded.tasks.some((task) => task.destinationSession !== decoded.agent.canonicalSession)
    ) {
      throw new Error("OpenRig canonical task projection identity or payload mismatch.");
    }
  } else {
    const expectedError: Record<number, string> = {
      400: "limit_must_be_1_to_100",
      404: "agent_not_found",
      409: "ambiguous_canonical_seat",
      503: "canonical_task_read_model_unavailable",
    };
    if (decoded.available || decoded.error !== expectedError[response.status]) {
      throw new Error("OpenRig canonical task projection error mismatch.");
    }
  }
  return decoded;
}

/** Optional C05 intake on ONE pre-existing, guarded browser send. Deliberately bypasses
 * bridgeRequest: that routine auto-starts Phase1, forbidden for optional policy. */
export async function readOpenRigPolicyForBrowserSend(
  input: DesktopOpenRigPolicyIntakeInput,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopOpenRigPolicyIntakeResult> {
  const deferred = (reason: string): DesktopOpenRigPolicyIntakeResult => ({
    schema: "t3-c05-browser-optional/v1",
    status: "deferred",
    reason,
  });
  if (
    !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(input.browserSessionId) ||
    !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(input.conversationId)
  )
    return deferred("invalid_exact_browser_identity");

  const noStartGet = async (path: string): Promise<unknown> => {
    const token = NodeProcess.env.OPENRIG_AUTH_BEARER_TOKEN?.trim();
    const response = await fetchImpl(`${OPENRIG_BASE_URL}${path}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error(`policy_http_${response.status}`);
    const raw = await response.text();
    if (raw.length > 150_000) throw new Error("policy_page_oversized");
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error("policy_malformed_json");
    }
  };
  try {
    const topology = decodeOpenRigSeatTopology(await noStartGet("/coordination/discover"));
    if (topology.source !== "openrig-rigspec-and-managed-ledger")
      return deferred("full_daemon_topology_unavailable");
    const managers = topology.seats.filter(
      (seat) =>
        (seat.role === "global-manager" || seat.role === "project-manager") && seat.logicalId,
    );
    if (managers.length === 0 || managers.length > 100)
      return deferred("manager_topology_unavailable");
    // Parallel bounded reads: optional intake must not delay a legitimate send
    // by serially waiting on unrelated manager seats.
    const ledgers = await Promise.all(
      managers.map(async (seat) => ({
        seat,
        ledger: decodeOpenRigManagedSessions(
          await noStartGet(`/agents/${assertSeatId(seat.id)}/sessions`),
          seat.id,
        ),
      })),
    );
    const matches: Array<{
      seat: (typeof managers)[number];
      primary: DesktopOpenRigSeatSessions["sessions"][number];
    }> = [];
    for (const { seat, ledger } of ledgers) {
      const primary = ledger.sessions.find((item) => item.id === ledger.primarySessionId);
      if (
        primary?.primary &&
        primary.status === "active" &&
        (primary.mode === "chatgpt" || primary.mode === "adopt") &&
        primary.attachedTabUuid === input.browserSessionId &&
        primary.conversationId === input.conversationId &&
        primary.target?.kind === "chatgpt-conversation" &&
        primary.target.conversationId === input.conversationId &&
        (!primary.target.preferredBrowserSessionId ||
          primary.target.preferredBrowserSessionId === input.browserSessionId)
      )
        matches.push({ seat, primary });
    }
    if (matches.length !== 1) return deferred("managed_primary_not_unique_or_not_active");
    const { seat, primary } = matches[0]!;
    const member =
      seat.logicalId.includes(".") && seat.logicalId.indexOf(".") < seat.logicalId.length - 1
        ? seat.logicalId.replace(".", "-")
        : seat.logicalId;
    const canonicalSession = `${member}@${seat.rigName}`;
    const all: DesktopOpenRigPolicyItem[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    let contextBytes = 0;
    do {
      if (++pages > 12) return deferred("policy_too_many_pages");
      const page = decodeOpenRigPolicyPage(
        await noStartGet(
          `/agents/${assertSeatId(seat.id)}/tasks?view=policy&limit=25` +
            (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
        ),
      );
      if (
        page.agent.agentId !== seat.id ||
        page.agent.rigId !== seat.rigId ||
        page.agent.rigName !== seat.rigName ||
        page.agent.canonicalSession !== canonicalSession ||
        page.policies.length > 25 ||
        page.policies.some(
          (policy) =>
            !policy.qitemId ||
            policy.destinationSession !== canonicalSession ||
            policy.tags.indexOf("coordination:policy") === -1 ||
            policy.body.length === 0 ||
            policy.body.length > 100_000,
        )
      )
        return deferred("policy_page_identity_or_content_mismatch");
      for (const policy of page.policies) {
        if (!seen.has(policy.qitemId)) {
          seen.add(policy.qitemId);
          all.push(policy);
          contextBytes += JSON.stringify(policy).length;
          if (contextBytes > 96_000) return deferred("policy_context_oversized");
        }
      }
      if (
        page.hasMore !== (page.nextCursor !== null) ||
        (page.hasMore &&
          (page.policies.length === 0 || !page.nextCursor || cursors.has(page.nextCursor)))
      )
        return deferred("policy_partial_or_cursor_loop");
      cursor = page.nextCursor;
      if (cursor) cursors.add(cursor);
    } while (cursor);
    // A page fetch is not an atomic snapshot of the ledger. Recheck the
    // authoritative primary before returning any optional context.
    const afterTopology = decodeOpenRigSeatTopology(await noStartGet("/coordination/discover"));
    const currentSeat = afterTopology.seats.filter((item) => item.id === seat.id);
    const after = decodeOpenRigManagedSessions(
      await noStartGet(`/agents/${assertSeatId(seat.id)}/sessions`),
      seat.id,
    );
    const currentPrimary = after.sessions.find((item) => item.id === after.primarySessionId);
    if (
      afterTopology.source !== topology.source ||
      currentSeat.length !== 1 ||
      JSON.stringify(currentSeat[0]) !== JSON.stringify(seat) ||
      !currentPrimary ||
      currentPrimary.id !== primary.id ||
      JSON.stringify(currentPrimary) !== JSON.stringify(primary)
    )
      return deferred("managed_primary_changed_during_policy_read");
    return {
      schema: "t3-c05-browser-optional/v1",
      status: "ready",
      agentId: seat.id,
      managedSessionId: primary.id,
      browserSessionId: input.browserSessionId,
      conversationId: input.conversationId,
      canonicalSession,
      policies: all,
    };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return deferred(
      /^policy_http_\d+$|^policy_(?:page_oversized|malformed_json)$/.test(detail)
        ? detail
        : "policy_offline_or_invalid_response",
    );
  }
}

export const readOpenRigPolicyForBrowserSendIpc = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_POLICY_BROWSER_SEND_CHANNEL,
  payload: DesktopOpenRigPolicyIntakeInputSchema,
  result: DesktopOpenRigPolicyIntakeResultSchema,
  handler: (input) => Effect.tryPromise(() => readOpenRigPolicyForBrowserSend(input)),
});

export async function fetchOpenRigManagedSessions(
  seatId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopOpenRigSeatSessions> {
  const id = assertSeatId(seatId);
  const response = await bridgeRequest(`/agents/${id}/sessions`, { method: "GET" }, fetchImpl);
  return decodeOpenRigManagedSessions((await response.json()) as unknown, seatId);
}

const decodeExecutionProfile = Schema.decodeUnknownSync(DesktopOpenRigExecutionProfileSchema);

/** Read authoritative RigSpec vs explicit saved execution profile without inferring defaults. */
export async function fetchOpenRigExecutionProfile(
  seatId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopOpenRigExecutionProfile> {
  const id = assertSeatId(seatId);
  const response = await bridgeRequest(
    `/agents/${id}/execution-profile`,
    { method: "GET" },
    fetchImpl,
  );
  const result = decodeExecutionProfile((await response.json()) as unknown);
  if (result.seatId !== seatId || (result.profile !== null && result.profile.seatId !== seatId))
    throw new Error("OpenRig returned an execution profile for the wrong seat.");
  return result;
}

/** Persist ONLY explicitly operator-entered, catalog-validated native execution settings. */
export async function configureOpenRigSeatExecutionProfile(
  {
    seatId,
    workspaceRoot,
    providerInstanceId,
    model,
    runtimeMode,
    environmentId,
  }: DesktopOpenRigConfigureExecutionProfileInput,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopOpenRigExecutionProfile> {
  const id = assertSeatId(seatId);
  const root = workspaceRoot.trim();
  const instance = providerInstanceId.trim();
  const slug = model.trim();
  const environment = environmentId?.trim();
  if (!/^[A-Za-z]:\\/u.test(root) || root.length > 1024 || /[\r\n\0]/u.test(root))
    throw new Error(
      "Workspace root must be an existing absolute Windows drive path, e.g. D:\\Project.",
    );
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(instance))
    throw new Error(
      "Choose an exact T3 provider instance ID from the live catalog (not the driver name).",
    );
  if (!slug || slug.length > 256 || model !== slug)
    throw new Error(
      "Enter the exact nonempty T3 provider catalog model slug (max 256 characters).",
    );
  if (!["approval-required", "auto-accept-edits", "auto", "full-access"].includes(runtimeMode))
    throw new Error("Select an explicit T3 runtime approval mode.");
  if (environmentId !== undefined && (!environment || environment.length > 256))
    throw new Error("Environment ID, if supplied, must be an exact nonempty T3 environment ID.");
  const payload = {
    workspaceRoot: root,
    providerInstanceId: instance,
    model: slug,
    runtimeMode,
    ...(environment ? { environmentId: environment } : {}),
  };
  const response = await bridgeRequest(
    `/agents/${id}/execution-profile`,
    { method: "PUT", payload },
    fetchImpl,
  );
  const receipt = record((await response.json()) as unknown);
  const saved = record(receipt?.profile);
  if (
    receipt?.version !== 1 ||
    receipt.seatId !== seatId ||
    receipt.overwriteRigSpec !== false ||
    receipt.legacySessionsAutoAdopted !== false ||
    saved?.seatId !== seatId ||
    saved.workspaceRoot !== root ||
    saved.providerInstanceId !== instance ||
    saved.model !== slug ||
    saved.runtimeMode !== runtimeMode ||
    saved.provenance !== "operator-explicit-t3-provider-catalog" ||
    typeof saved.environmentId !== "string" ||
    !saved.environmentId ||
    (environment !== undefined && saved.environmentId !== environment)
  )
    throw new Error(
      "OpenRig did not confirm the exact provider-catalog execution profile; inspect GET before resubmitting.",
    );
  const profile = await fetchOpenRigExecutionProfile(seatId, fetchImpl);
  if (
    !profile.profile ||
    JSON.stringify({
      workspaceRoot: profile.profile.workspaceRoot,
      providerInstanceId: profile.profile.providerInstanceId,
      model: profile.profile.model,
      runtimeMode: profile.profile.runtimeMode,
      environmentId: profile.profile.environmentId,
    }) !== JSON.stringify({ ...payload, environmentId: saved.environmentId })
  )
    throw new Error(
      "OpenRig did not confirm persisted execution settings on GET; inspect before editing again.",
    );
  return profile;
}

/**
 * The operation UUID comes from the operator request and is NEVER regenerated/retried here.
 * A 503/timeout may mean the provider launched; inspect the ledger before any new operation.
 */
export async function startOpenRigSeatSession(
  {
    seatId,
    operationId,
    kind,
    workspaceRoot,
    title,
    initialPrompt,
    parentSeatId,
    parentManagedSessionId,
  }: DesktopOpenRigLaunchInput,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopOpenRigSeatSessions> {
  const id = assertSeatId(seatId);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(operationId)
  )
    throw new Error("Managed-session launch requires an operation UUID.");
  if (kind && kind !== "native" && kind !== "chatgpt") throw new Error("Invalid seat runtime.");
  if (
    (title !== undefined && title.length > 160) ||
    (initialPrompt !== undefined && initialPrompt.length > 28_000) ||
    (workspaceRoot !== undefined && workspaceRoot.length > 1_024) ||
    (parentSeatId !== undefined && parentSeatId.length > 512) ||
    (parentManagedSessionId !== undefined && parentManagedSessionId.length > 512)
  )
    throw new Error("Managed-session launch options exceed limits.");
  if (parentManagedSessionId?.trim() && !parentSeatId?.trim())
    throw new Error("A parent managed session requires its exact parent OpenRig seat ID.");
  const payload = {
    operationId,
    ...(kind ? { kind } : {}),
    ...(workspaceRoot?.trim() ? { workspaceRoot: workspaceRoot.trim() } : {}),
    ...(title?.trim() ? { title: title.trim() } : {}),
    ...(initialPrompt?.trim() ? { initialPrompt: initialPrompt.trim() } : {}),
    ...(parentSeatId?.trim() ? { parentSeatId: parentSeatId.trim() } : {}),
    ...(parentManagedSessionId?.trim()
      ? { parentManagedSessionId: parentManagedSessionId.trim() }
      : {}),
  };
  // OpenRig alone validates exact RigSpec provider, catalog model, environment,
  // workspace and parent relation. T3 must never open an unpersisted draft.
  const response = await bridgeRequest(
    `/agents/${id}/sessions`,
    { method: "POST", payload },
    fetchImpl,
  );
  const receipt = record((await response.json()) as unknown);
  const launched = record(receipt?.session);
  const dispatch = record(receipt?.initialDispatch);
  const launchMode = launched?.mode;
  const nativeIntent = record(launched?.intent);
  const nativeReceiptVerified =
    launchMode !== "native" ||
    (launched?.threadId === operationId &&
      typeof launched.projectId === "string" &&
      launched.projectId.length > 0 &&
      typeof dispatch?.messageId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        dispatch.messageId,
      ) &&
      dispatch.messageId === nativeIntent?.initialMessageId &&
      typeof nativeIntent?.providerInstanceId === "string" &&
      typeof nativeIntent?.environmentId === "string" &&
      typeof nativeIntent?.runtimeMode === "string");
  if (
    response.status !== 201 ||
    receipt?.version !== 1 ||
    receipt.seatId !== seatId ||
    launched?.operationId !== operationId ||
    launched?.seatId !== seatId ||
    (launchMode !== "native" && launchMode !== "chatgpt") ||
    (kind !== undefined && launchMode !== kind) ||
    (launched?.status !== "active" && launched?.status !== "pending") ||
    receipt.retrySafe !== false ||
    dispatch?.state !== "transport_accepted" ||
    dispatch.modelCompletionVerified !== false ||
    !nativeReceiptVerified
  ) {
    throw new Error(
      "OpenRig did not prove exact persisted launch and bootstrap transport acceptance; inspect the ledger before retrying.",
    );
  }
  const after = await fetchOpenRigManagedSessions(seatId, fetchImpl);
  if (
    !after.sessions.some(
      (session) =>
        session.operationId === operationId && session.id === record(receipt.session)?.id,
    )
  ) {
    throw new Error(
      "OpenRig did not confirm a matching managed launch; inspect the ledger before retrying.",
    );
  }
  return after;
}

function assertOperationId(operationId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(operationId)
  )
    throw new Error("Managed session action requires an operation UUID.");
  return operationId;
}

/** Explicitly adopt a verified provider conversation through OpenRig's managed ledger. */
export async function adoptOpenRigSeatSession(
  { seatId, operationId, target }: DesktopOpenRigAdoptInput,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopOpenRigSeatSessions> {
  const id = assertSeatId(seatId);
  assertOperationId(operationId);
  const normalized = decodeSessionTarget(target);
  if (normalized.kind === "legacy-browser")
    throw new Error(
      "A browser tab ID alone is not a durable conversation; choose a verified provider conversation.",
    );
  const response = await bridgeRequest(
    `/agents/${id}/sessions/adopt`,
    { method: "POST", payload: { operationId, target: normalized } },
    fetchImpl,
  );
  const receipt = record((await response.json()) as unknown);
  if (
    receipt?.version !== 1 ||
    receipt.seatId !== seatId ||
    record(receipt.session)?.operationId !== operationId ||
    record(receipt.session)?.seatId !== seatId ||
    record(receipt.session)?.mode !== "adopt"
  )
    throw new Error("OpenRig did not confirm adoption; inspect the ledger before retrying.");
  const after = await fetchOpenRigManagedSessions(seatId, fetchImpl);
  if (
    !after.sessions.some(
      (s) => s.id === record(receipt.session)?.id && s.operationId === operationId,
    )
  )
    throw new Error("OpenRig managed adoption is not in its ledger; inspect before retrying.");
  return after;
}

export async function reconcileOpenRigChatGPTSeatSession(
  { seatId, sessionId }: DesktopOpenRigSessionActionInput,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopOpenRigSeatSessions> {
  const id = assertSeatId(seatId);
  if (!sessionId.trim() || sessionId.length > 512) throw new Error("Invalid managed session ID.");
  const before = await fetchOpenRigManagedSessions(seatId, fetchImpl);
  if (
    !before.sessions.some(
      (s) => s.id === sessionId && s.mode === "chatgpt" && s.status === "pending",
    )
  )
    throw new Error("No pending owned ChatGPT conversation to reconcile.");
  const response = await bridgeRequest(
    `/agents/${id}/sessions/${encodeURIComponent(sessionId)}/reconcile-chatgpt`,
    { method: "POST", payload: {} },
    fetchImpl,
  );
  const receipt = record((await response.json()) as unknown);
  if (
    receipt?.version !== 1 ||
    receipt.seatId !== seatId ||
    record(receipt.session)?.id !== sessionId
  )
    throw new Error("OpenRig did not acknowledge ChatGPT reconciliation.");
  const after = await fetchOpenRigManagedSessions(seatId, fetchImpl);
  if (
    !after.sessions.some(
      (s) =>
        s.id === sessionId && s.status === "active" && s.target?.kind === "chatgpt-conversation",
    )
  )
    throw new Error("ChatGPT conversation URL still unverified; do not relaunch.");
  return after;
}

export async function detachOpenRigSeatSession(
  { seatId, sessionId }: DesktopOpenRigSessionActionInput,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopOpenRigSeatSessions> {
  const id = assertSeatId(seatId);
  if (!sessionId.trim() || sessionId.length > 512) throw new Error("Invalid managed session ID.");
  const before = await fetchOpenRigManagedSessions(seatId, fetchImpl);
  if (!before.sessions.some((s) => s.id === sessionId && s.status !== "detached"))
    throw new Error("No attached session owned by this OpenRig seat.");
  const response = await bridgeRequest(
    `/agents/${id}/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
    fetchImpl,
  );
  const receipt = record((await response.json()) as unknown);
  if (
    receipt?.version !== 1 ||
    receipt.seatId !== seatId ||
    record(receipt.session)?.id !== sessionId ||
    record(receipt.session)?.status !== "detached"
  )
    throw new Error("OpenRig did not confirm detachment.");
  const after = await fetchOpenRigManagedSessions(seatId, fetchImpl);
  if (!after.sessions.some((s) => s.id === sessionId && s.status === "detached"))
    throw new Error("OpenRig did not persist the detached session history.");
  return after;
}

/** One fixed MAIN-only lifecycle POST. Never infer success from HTTP 200 or retry an uncertain action. */
const lifecycleEffects = {
  suspend: "t3_archived_local_browser_unmounted_no_model_completion_claim",
  resume: "t3_archive_restored_reattachment_on_render",
  stop: "local_t3_session_closed_not_chatgpt_cloud_deleted",
  recover: "safe_saved_conversation_navigation_requested_not_verified_loaded",
} as const;
const decodeManagedBrowserLifecycle = Schema.decodeUnknownSync(
  DesktopOpenRigManagedBrowserLifecycleResultSchema,
);

export async function runOpenRigSeatBrowserLifecycle(
  input: DesktopOpenRigManagedBrowserLifecycleInput,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopOpenRigManagedBrowserLifecycleResult> {
  const fields = record(input);
  if (
    !fields ||
    Object.keys(fields).some(
      (key) => !["seatId", "sessionId", "action", "confirm"].includes(key),
    ) ||
    typeof fields.seatId !== "string" ||
    typeof fields.sessionId !== "string" ||
    !Object.hasOwn(lifecycleEffects, String(fields.action)) ||
    (fields.action === "stop"
      ? fields.confirm !== "close-local-t3-session"
      : Object.hasOwn(fields, "confirm"))
  )
    throw new Error("Invalid managed browser lifecycle action or stop-only confirmation.");
  const { seatId, sessionId, action } = input;
  const id = assertSeatId(seatId);
  if (sessionId !== sessionId.trim() || !sessionId || sessionId.length > 512)
    throw new Error("Invalid managed session ID.");
  const before = await fetchOpenRigManagedSessions(seatId, fetchImpl);
  const matches = before.sessions.filter((session) => session.id === sessionId);
  const current = matches[0];
  if (
    matches.length !== 1 ||
    before.primarySessionId !== sessionId ||
    !current ||
    current.seatId !== seatId ||
    !current.primary ||
    (current.mode !== "chatgpt" && current.mode !== "adopt") ||
    current.status !== "active" ||
    current.target?.kind !== "chatgpt-conversation" ||
    !current.attachedTabUuid ||
    current.conversationId !== current.target.conversationId
  )
    throw new Error("Lifecycle requires the exact active primary managed ChatGPT conversation.");
  const browserId = current.attachedTabUuid;
  const conversationId = current.target.conversationId;
  const expectedUrl = new RegExp("^https://chatgpt\\.com/c/" + conversationId + "(?:[/?#]|$)", "i");
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(conversationId))
    throw new Error("Managed ChatGPT conversation identity is not canonical.");
  // No raw renderer URL, user-controlled header, browser token, or actor claim.
  const payload = action === "stop" ? { action, confirm: "close-local-t3-session" } : { action };
  const response = await bridgeRequest(
    `/agents/${id}/sessions/${encodeURIComponent(sessionId)}/lifecycle`,
    { method: "POST", payload },
    fetchImpl,
  );
  let result: DesktopOpenRigManagedBrowserLifecycleResult;
  try {
    result = decodeManagedBrowserLifecycle((await response.json()) as unknown);
  } catch {
    throw new Error(
      "OpenRig lifecycle receipt malformed; outcome unconfirmed. Inspect the exact browser and ledger; do not retry.",
    );
  }
  const receipt = record(result.receipt);
  const closing = action === "stop";
  const validControl = closing
    ? receipt?.action === "change_state" &&
      receipt.state === "closed" &&
      receipt.persisted === true &&
      receipt.acknowledged === true &&
      receipt.closed === true &&
      receipt.scope === "local-t3-session"
    : action === "recover"
      ? receipt?.requestedNavigation === true &&
        expectedUrl.test(String(receipt.recoveredUrl ?? ""))
      : receipt?.action === (action === "suspend" ? "archive" : "restore") &&
        receipt.acknowledged === true &&
        receipt.persisted === true &&
        (action === "suspend"
          ? expectedUrl.test(String(record(receipt.archive)?.conversationUrl ?? ""))
          : receipt.restored === true && expectedUrl.test(String(receipt.conversationUrl ?? "")));
  if (
    result.seatId !== seatId ||
    result.managedSessionId !== sessionId ||
    result.browserSessionId !== browserId ||
    result.conversationId !== conversationId ||
    result.action !== action ||
    result.effect !== lifecycleEffects[action] ||
    !receipt ||
    receipt.sessionId !== browserId ||
    !validControl ||
    (closing
      ? result.primarySessionId !== null ||
        result.managedStatus !== "detached" ||
        result.managedPrimaryUnchanged !== false
      : result.primarySessionId !== sessionId ||
        result.managedStatus !== "active" ||
        result.managedPrimaryUnchanged !== true)
  )
    throw new Error(
      "OpenRig lifecycle receipt mismatches selected session or T3 control; outcome unconfirmed. Inspect before retrying.",
    );
  // Read after positive provider receipt. A failed readback cannot turn it into an
  // optimistic success, particularly after a locally closed browser but failed detach.
  const after = await fetchOpenRigManagedSessions(seatId, fetchImpl);
  const persisted = after.sessions.find((s) => s.id === sessionId);
  if (
    closing
      ? after.primarySessionId === sessionId || persisted?.status !== "detached"
      : after.primarySessionId !== sessionId ||
        persisted?.status !== "active" ||
        persisted.attachedTabUuid !== browserId ||
        persisted.target?.kind !== "chatgpt-conversation" ||
        persisted.target.conversationId !== conversationId
  )
    throw new Error(
      "OpenRig ledger has not confirmed lifecycle state; inspect browser and ledger, do not retry.",
    );
  return result;
}

export async function selectOpenRigSeatPrimary(
  { seatId, sessionId }: DesktopOpenRigPrimaryInput,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopOpenRigSeatSessions> {
  const id = assertSeatId(seatId);
  if (!sessionId.trim() || sessionId.length > 512) throw new Error("Invalid managed session ID.");
  const before = await fetchOpenRigManagedSessions(seatId, fetchImpl);
  if (!before.sessions.some((s) => s.id === sessionId && s.status === "active" && s.target))
    throw new Error("Only an active session owned by this OpenRig seat can become primary.");
  const response = await bridgeRequest(
    `/agents/${id}/sessions/${encodeURIComponent(sessionId)}/primary`,
    { method: "POST", payload: {} },
    fetchImpl,
  );
  const receipt = record((await response.json()) as unknown);
  if (
    receipt?.version !== 1 ||
    receipt.seatId !== seatId ||
    receipt.primarySessionId !== sessionId ||
    record(receipt.session)?.id !== sessionId ||
    record(receipt.session)?.seatId !== seatId
  )
    throw new Error("OpenRig did not acknowledge the requested primary.");
  const after = await fetchOpenRigManagedSessions(seatId, fetchImpl);
  if (after.primarySessionId !== sessionId)
    throw new Error("OpenRig did not confirm the requested primary session.");
  return after;
}

export async function bindOpenRigSeat(
  input: DesktopOpenRigBindInput,
  fetchImpl: typeof fetch = fetch,
) {
  if (!input.id.trim() || (input.sessionId === undefined) === (input.target === undefined))
    throw new Error("Seat ID and exactly one conversation target required.");
  const target = input.target;
  if (target) {
    // Only the target from OpenRig's typed picker may cross this fixed proxy.
    const normalized = decodeSessionTarget(target);
    const response = await bridgeRequest(
      `/agents/${encodeURIComponent(input.id)}/binding`,
      { method: "POST", payload: { target: normalized } },
      fetchImpl,
    );
    const receipt = record((await response.json()) as unknown);
    const binding = record(receipt?.binding);
    const assignedTarget = record(binding?.target);
    // A successful HTTP response with no persisted target is not a binding.
    if (
      binding?.nodeId !== input.id ||
      JSON.stringify(assignedTarget) !== JSON.stringify(normalized)
    ) {
      throw new Error("OpenRig did not confirm the requested seat-to-conversation binding.");
    }
    return;
  }
  if (!input.sessionId?.trim()) throw new Error("Browser session ID required.");
  const response = await bridgeRequest(
    `/agents/${encodeURIComponent(input.id)}/bind`,
    { method: "POST", payload: { sessionId: input.sessionId } },
    fetchImpl,
  );
  const receipt = record((await response.json()) as unknown);
  const binding = record(receipt?.binding);
  if (binding?.nodeId !== input.id || binding.sessionId !== input.sessionId) {
    throw new Error("OpenRig did not confirm the requested browser binding.");
  }
}

export async function unbindOpenRigSeat(id: string, fetchImpl: typeof fetch = fetch) {
  if (!id.trim()) throw new Error("Seat ID required.");
  const response = await bridgeRequest(
    `/agents/${encodeURIComponent(id)}/bind`,
    { method: "DELETE" },
    fetchImpl,
  );
  const receipt = record((await response.json()) as unknown);
  if (typeof receipt?.unbound !== "boolean") {
    throw new Error("OpenRig did not confirm the seat was detached.");
  }
}

/** Only known operator/registry-selected human addresses may be read. */
export async function fetchOpenRigOperatorInbox(
  address: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopOpenRigInbox> {
  if (!/^(?:human(?:-[A-Za-z0-9._-]+)?@(kernel|host)|[A-Za-z0-9._:-]+@external)$/.test(address)) {
    throw new Error("Invalid OpenRig human address.");
  }
  const response = await bridgeRequest(
    `/human-inbox?destination=${encodeURIComponent(address)}&limit=50&includeAll=1`,
    { method: "GET" },
    fetchImpl,
    true,
  );
  if (!response.ok && response.status !== 503)
    throw new Error(`OpenRig operator inbox HTTP ${response.status}.`);
  const payload = decodeOpenRigInbox((await response.json()) as unknown);
  // A 503 is authoritative unavailability, never the proof of an empty inbox.
  if (
    response.status === 503 &&
    (payload.available || payload.items.length > 0 || payload.pendingCount !== null)
  ) {
    throw new Error("Contradictory OpenRig inbox availability.");
  }
  if (payload.address !== address) throw new Error("OpenRig inbox destination mismatch.");
  return payload;
}

// AISpeak is the shared local Windows script, not a third-party speech service.
// It enforces a hard 20-word limit itself. Keep both the word and length cap
// here, and never pass user-supplied text to a command shell.
const AISPEAK_SCRIPT = "B:\\GDrive\\Tools\\13AITools\\AISpeak\\aispeak.py";
const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);
export function trimOpenRigSpeech(text: string): string {
  return text.trim().split(/\s+/u).filter(Boolean).slice(0, 20).join(" ").slice(0, 160).trim();
}

export async function invokeOpenRigSpeech(
  text: string,
  runner: typeof execFileAsync = execFileAsync,
  assertScript: (path: string) => Promise<void> = NodeFSP.access,
): Promise<void> {
  const spoken = trimOpenRigSpeech(text);
  if (!spoken) throw new Error("Nothing to read aloud.");
  await assertScript(AISPEAK_SCRIPT);
  // aispeak.py's launcher returns immediately after it starts the worker.
  await runner("python", [AISPEAK_SCRIPT, "--silent", spoken], {
    windowsHide: true,
    timeout: 6_000,
    maxBuffer: 32_768,
  });
}

export const speakOpenRigPreview = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_SPEAK_PREVIEW_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: (text) => Effect.tryPromise(() => invokeOpenRigSpeech(text)),
});

/**
 * This route is deliberately separate from /agents/:id/send: selecting an answer
 * is NOT a general agent command. The OpenRig backend must atomically validate
 * the source decision and confirm durable acceptance; 404/503 leave the draft.
 */
export async function fetchOpenRigHumanResponse(
  input: DesktopOpenRigHumanResponseInput,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopOpenRigHumanResponseResult> {
  if (
    input.version !== 2 ||
    input.destination !== "human@kernel" ||
    !/^qitem-[A-Za-z0-9_-]{1,100}$/u.test(input.qitemId)
  ) {
    throw new Error("Invalid OpenRig human response target.");
  }
  if (
    input.answers.length < 1 ||
    input.answers.length > 8 ||
    new Set(input.answers.map((a) => a.questionId)).size !== input.answers.length ||
    input.answers.some(
      ({ questionId, value }) =>
        !/^[A-Za-z0-9_-]{1,40}$/u.test(questionId) ||
        !(
          (typeof value === "string" && value.length <= 120) ||
          (typeof value === "number" && Number.isFinite(value)) ||
          (Array.isArray(value) &&
            value.length <= 12 &&
            value.every((v) => typeof v === "string" && v.length <= 120))
        ),
    ) ||
    JSON.stringify(input).length > 8_000
  ) {
    throw new Error("Invalid OpenRig human response answers.");
  }
  // Only the desktop main process can access this secret. The renderer cannot
  // set or read this header; missing configuration fails closed before POST.
  const answerToken = NodeProcess.env.OPENRIG_T3_HUMAN_ANSWER_TOKEN;
  if (!answerToken || answerToken.length < 24) {
    throw new Error("Interactive OpenRig replies are not configured on this desktop yet.");
  }
  const response = await fetchImpl(
    `${OPENRIG_BASE_URL}/human-inbox/${encodeURIComponent(input.qitemId)}/answer`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-openrig-human-answer-token": answerToken,
        "x-openrig-human-intent": "t3-desktop-ipc",
        ...(NodeProcess.env.OPENRIG_AUTH_BEARER_TOKEN?.trim()
          ? { Authorization: `Bearer ${NodeProcess.env.OPENRIG_AUTH_BEARER_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({ version: 2, destination: input.destination, answers: input.answers }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    },
  );
  if (!response.ok)
    throw new Error(`OpenRig human answer endpoint returned HTTP ${response.status}.`);
  const accepted = decodeHumanResponse(await response.json());
  if (
    !accepted.acceptedIntoQueue ||
    accepted.qitemId !== input.qitemId ||
    accepted.actor !== input.destination ||
    accepted.deliveredToAgent
  ) {
    throw new Error("OpenRig did not confirm a matching durable human response.");
  }
  return accepted;
}
export const submitOpenRigHumanResponse = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_HUMAN_RESPONSE_CHANNEL,
  payload: DesktopOpenRigHumanResponseInputSchema,
  result: DesktopOpenRigHumanResponseResultSchema,
  handler: (input) => Effect.tryPromise(() => fetchOpenRigHumanResponse(input)),
});

/** Ordinary replies must use the original durable OpenRig queue; never /agents/:id/send. */
function operatorReplyValid(input: DesktopOpenRigOperatorReplyInput): boolean {
  return (
    input.sourceType === "queue" &&
    input.destination === "human@kernel" &&
    /^qitem-[A-Za-z0-9_-]{1,100}$/u.test(input.qitemId) &&
    /^[A-Za-z0-9_-]{8,128}$/u.test(input.requestId) &&
    input.message.length <= 4000 &&
    !!input.message.trim() &&
    !!input.expectedRecipient &&
    input.expectedRecipient !== "human@kernel" &&
    input.expectedRecipient !== "daemon@kernel" &&
    JSON.stringify(input).length < 16_000
  );
}

/**
 * This private credential belongs to the desktop MAIN process, not its
 * renderer. The custom T3 executable is also launched from a startup shortcut
 * that bypasses compile_and_launch_t3.py, so the launcher environment cannot
 * be the sole source of the existing locally provisioned token.
 *
 * An explicitly present (even blank) environment value suppresses fallback:
 * tests and deployments can deliberately fail closed.
 */
function privateOperatorAnswerToken(): string | null {
  const environmentToken = NodeProcess.env.OPENRIG_T3_HUMAN_ANSWER_TOKEN;
  if (environmentToken !== undefined) {
    const token = environmentToken.trim();
    return token.length >= 24 ? token : null;
  }
  try {
    const file = joinPath(homedir(), ".openrig", "operator-tokens", "t3-human-answer-token.txt");
    const token = readFileSync(file, "utf8").trim();
    return token.length >= 24 ? token : null;
  } catch {
    return null;
  }
}

function operatorReplyHeaders(): Record<string, string> | null {
  const token = privateOperatorAnswerToken();
  if (!token) return null;
  const bearer = NodeProcess.env.OPENRIG_AUTH_BEARER_TOKEN?.trim();
  // OpenRig permits bearer-free loopback calls when its daemon is configured
  // without a bearer. The fixed endpoint is ALWAYS 127.0.0.1:7433 and the
  // independent private human-answer token is still mandatory for writes.
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    "x-openrig-human-answer-token": token,
    "x-openrig-human-intent": "t3-desktop-ipc",
  };
}

function operatorReplyAccepted(
  payload: unknown,
  input: DesktopOpenRigOperatorReplyInput,
): DesktopOpenRigOperatorReplyResult | null {
  const value = record(payload);
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const expectedId =
    "qitem-t3-operator-reply-" +
    hash(JSON.stringify([input.qitemId, input.requestId])).slice(0, 40);
  if (
    value?.outcome !== "accepted" ||
    value.version !== 1 ||
    value.qitemId !== input.qitemId ||
    value.replyQitemId !== expectedId ||
    value.recipient !== input.expectedRecipient ||
    value.source !== "human@kernel" ||
    value.messageSha256 !== hash(input.message) ||
    value.acceptedIntoQueue !== true ||
    value.deliveredToAgent !== false ||
    !["recorded", "idempotent"].includes(String(value.status)) ||
    !["queued", "verified", "indeterminate", "failed"].includes(String(value.delivery))
  )
    return null;
  return {
    outcome: "accepted",
    requestId: input.requestId,
    qitemId: input.qitemId,
    replyQitemId: expectedId,
    recipient: input.expectedRecipient,
    source: "human@kernel",
    messageSha256: hash(input.message),
    acceptedIntoQueue: true,
    deliveredToAgent: false,
    status: value.status as "recorded" | "idempotent",
    delivery: value.delivery as "queued" | "verified" | "indeterminate" | "failed",
  };
}

const operatorReplyPath = (input: DesktopOpenRigOperatorReplyInput) =>
  `${OPENRIG_BASE_URL}/human-inbox/${encodeURIComponent(input.qitemId)}`;

export async function lookupOpenRigOperatorReply(
  input: DesktopOpenRigOperatorReplyInput,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopOpenRigOperatorReplyResult> {
  if (!operatorReplyValid(input))
    return { outcome: "not_sent", reason: "Invalid original queue item or reply identity." };
  const headers = operatorReplyHeaders();
  if (!headers)
    return {
      outcome: "unknown",
      reason: "MAIN writer credentials unavailable for reconciliation.",
    };
  try {
    const response = await fetchImpl(
      `${operatorReplyPath(input)}/replies/${encodeURIComponent(input.requestId)}`,
      {
        method: "GET",
        headers,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      },
    );
    const body = (await response.json()) as unknown;
    if (response.status === 404 && record(body)?.outcome === "unconfirmed")
      return {
        outcome: "unconfirmed",
        reason: "No confirmed receipt yet. A write may still be in flight.",
      };
    const accepted = response.ok ? operatorReplyAccepted(body, input) : null;
    return accepted ?? { outcome: "unknown", reason: "OpenRig receipt lookup was not conclusive." };
  } catch {
    return { outcome: "unknown", reason: "OpenRig receipt lookup unavailable." };
  }
}

export async function postOpenRigOperatorReply(
  input: DesktopOpenRigOperatorReplyInput,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopOpenRigOperatorReplyResult> {
  if (!operatorReplyValid(input))
    return { outcome: "not_sent", reason: "Invalid original queue item or reply identity." };
  const headers = operatorReplyHeaders();
  if (!headers)
    return {
      outcome: "not_sent",
      reason: "OpenRig operator reply token is not available in desktop MAIN.",
    };
  // Pre-POST authoritative read, not renderer metadata: original must still be
  // a replyable direct queue message addressed to the operator.
  try {
    const inbox = await fetchOpenRigOperatorInbox(input.destination, fetchImpl);
    const original = inbox.items.find(
      (item) =>
        item.id === input.qitemId &&
        item.sourceType === "queue" &&
        item.recipient === input.destination,
    );
    if (
      !inbox.available ||
      inbox.replyWriteAvailable !== true ||
      original?.replyEligible !== true ||
      original.sender !== input.expectedRecipient
    )
      return {
        outcome: "not_sent",
        reason: "Original item or live reply capability not confirmed.",
      };
  } catch {
    return {
      outcome: "not_sent",
      reason: "Could not verify original OpenRig queue item before POST.",
    };
  }
  // After fetch begins, an error/timeout/invalid response is indeterminate.
  // Preserve requestId, NEVER retry POST. Only a read-only GET may resolve it.
  let uncertain = false;
  try {
    const response = await fetchImpl(`${operatorReplyPath(input)}/reply`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        version: 1,
        destination: input.destination,
        requestId: input.requestId,
        message: input.message,
      }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    const body = (await response.json()) as unknown;
    if (
      !response.ok &&
      record(body)?.outcome === "not_sent" &&
      record(body)?.acceptedIntoQueue === false
    )
      return {
        outcome: "not_sent",
        reason: String(record(body)?.error ?? "OpenRig declined this reply."),
      };
    const accepted = response.ok ? operatorReplyAccepted(body, input) : null;
    if (accepted) return accepted;
    uncertain = true;
  } catch {
    uncertain = true;
  }
  if (uncertain) {
    const reconciled = await lookupOpenRigOperatorReply(input, fetchImpl);
    return reconciled.outcome === "accepted"
      ? reconciled
      : {
          outcome: "unknown",
          reason: "POST result unconfirmed. No duplicate send; use read-only reconciliation.",
        };
  }
  return { outcome: "unknown", reason: "OpenRig did not confirm the exact durable reply." };
}

export const sendOpenRigOperatorReply = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_OPERATOR_REPLY_CHANNEL,
  payload: DesktopOpenRigOperatorReplyInputSchema,
  result: DesktopOpenRigOperatorReplyResultSchema,
  handler: (input) => Effect.tryPromise(() => postOpenRigOperatorReply(input)),
});
export const reconcileOpenRigOperatorReply = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_OPERATOR_REPLY_LOOKUP_CHANNEL,
  payload: DesktopOpenRigOperatorReplyInputSchema,
  result: DesktopOpenRigOperatorReplyResultSchema,
  handler: (input) => Effect.tryPromise(() => lookupOpenRigOperatorReply(input)),
});

// TaskBoard review gates. A gate release is a separate human decision route,
// never an ordinary queue reply. The renderer only names the selected inbox
// item; MAIN re-reads the item and the OpenRig link, then asks natively.
const REVIEW_GATES_BASE_URL = "http://127.0.0.1:7433/api/integrations/taskboard-review-gates";
const REVIEW_GATE_WAKES = ["verified", "queued", "indeterminate", "failed"];

function reviewGateSelectionValid(input: DesktopOpenRigReviewGateSelection): boolean {
  return (
    input.destination === "human@kernel" &&
    /^qitem-[A-Za-z0-9_-]{1,100}$/u.test(input.qitemId) &&
    /^qitem-[A-Za-z0-9_-]{1,100}$/u.test(input.gateQitemId)
  );
}

function reviewGateResolveValid(input: DesktopOpenRigReviewGateResolveInput): boolean {
  return (
    reviewGateSelectionValid(input) &&
    /^[A-Za-z0-9._:-]{1,128}$/u.test(input.reviewId) &&
    /^[A-Za-z0-9._:-]{1,128}$/u.test(input.reviewRevision) &&
    OPENRIG_REVIEW_GATE_VERDICTS.includes(input.verdict) &&
    /^[A-Za-z0-9_-]{8,128}$/u.test(input.requestId) &&
    (input.note === undefined || input.note.length <= 2_000)
  );
}

/** The exact current inbox item and its decoded gate, from MAIN's own read. */
async function readSelectedReviewGate(
  selection: DesktopOpenRigReviewGateSelection,
  fetchImpl: typeof fetch,
): Promise<{ item: DesktopOpenRigInboxItem; gate: OpenRigReviewGate } | null> {
  const inbox = await fetchOpenRigOperatorInbox(selection.destination, fetchImpl);
  if (!inbox.available) return null;
  const matches = inbox.items.filter(
    (item) => item.id === selection.qitemId && item.recipient === selection.destination,
  );
  const gate = matches.length === 1 ? decodeOpenRigReviewGate(matches[0]!.reviewGate) : null;
  return gate && gate.gateQitemId === selection.gateQitemId ? { item: matches[0]!, gate } : null;
}

/** OpenRig bearer-protected single gate status must match this current open review binding. */
async function reviewGateLinkConfirmed(
  gate: OpenRigReviewGate,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const bearer = NodeProcess.env.OPENRIG_AUTH_BEARER_TOKEN?.trim();
  const response = await fetchImpl(
    `${REVIEW_GATES_BASE_URL}/${encodeURIComponent(gate.gateQitemId)}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    },
  );
  if (!response.ok) return false;
  const body = (await response.json()) as unknown;
  const status = record(body);
  const link = record(status?.link);
  return status?.available === true && status?.gateQitemId === gate.gateQitemId &&
    status.gateState === "blocked" && status.resolved === false &&
    link?.gateQitemId === gate.gateQitemId && link.reviewId === gate.reviewId &&
    link.reviewRevision === gate.reviewRevision && link.authorityVerified === false;
}

function reviewGateReleased(
  payload: unknown,
  input: DesktopOpenRigReviewGateResolveInput,
): DesktopOpenRigReviewGateResolveResult | null {
  const value = record(payload);
  if (
    value?.version !== 1 ||
    value.requestId !== input.requestId ||
    value.gateQitemId !== input.gateQitemId ||
    value.reviewId !== input.reviewId ||
    value.reviewRevision !== input.reviewRevision ||
    value.verdict !== input.verdict ||
    value.gateReleased !== true ||
    !["recorded", "idempotent"].includes(String(value.status)) ||
    value.wakeIntentDurable !== true ||
    !REVIEW_GATE_WAKES.includes(String(value.delivery))
  )
    return null;
  return {
    outcome: "released",
    requestId: input.requestId,
    gateQitemId: input.gateQitemId,
    reviewId: input.reviewId,
    reviewRevision: input.reviewRevision,
    verdict: input.verdict,
    status: value.status as "recorded" | "idempotent",
    gateReleased: true,
    delivery: value.delivery as "verified" | "queued" | "indeterminate" | "failed",
    wakeIntentDurable: true,
  };
}

export async function lookupOpenRigReviewGateReceipt(
  input: DesktopOpenRigReviewGateResolveInput,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopOpenRigReviewGateResolveResult> {
  if (!reviewGateResolveValid(input))
    return { outcome: "not_sent", reason: "Invalid review gate or request identity." };
  const headers = operatorReplyHeaders();
  if (!headers)
    return { outcome: "unknown", reason: "MAIN human-answer token unavailable for reconciliation." };
  try {
    const response = await fetchImpl(
      `${REVIEW_GATES_BASE_URL}/${encodeURIComponent(input.gateQitemId)}/receipts/${encodeURIComponent(input.requestId)}`,
      {
        method: "GET",
        headers,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      },
    );
    const body = (await response.json()) as unknown;
    if (response.status === 404 && record(body)?.outcome === "unconfirmed")
      return {
        outcome: "unconfirmed",
        reason: "No confirmed gate receipt yet. A release may still be in flight.",
      };
    const released = response.ok ? reviewGateReleased(body, input) : null;
    return released ?? { outcome: "unknown", reason: "OpenRig gate receipt was not conclusive." };
  } catch {
    return { outcome: "unknown", reason: "OpenRig gate receipt lookup unavailable." };
  }
}

export type ReviewGateConfirm = (
  gate: OpenRigReviewGate,
  input: DesktopOpenRigReviewGateResolveInput,
) => Promise<boolean>;

export async function postOpenRigReviewGateResolve(
  input: DesktopOpenRigReviewGateResolveInput,
  confirm: ReviewGateConfirm,
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopOpenRigReviewGateResolveResult> {
  if (!reviewGateResolveValid(input))
    return { outcome: "not_sent", reason: "Invalid review gate or request identity." };
  const headers = operatorReplyHeaders();
  if (!headers)
    return {
      outcome: "not_sent",
      reason: "OpenRig human-answer token is not available in desktop MAIN.",
    };
  let gate: OpenRigReviewGate;
  try {
    const selected = await readSelectedReviewGate(input, fetchImpl);
    if (
      !selected ||
      selected.item.sourceType !== "human_gate" ||
      selected.item.state !== "blocked" ||
      selected.gate.reviewId !== input.reviewId ||
      selected.gate.reviewRevision !== input.reviewRevision
    )
      return {
        outcome: "not_sent",
        reason: "Selected review gate is not the current pending gate for this review revision.",
      };
    gate = selected.gate;
    if (!(await reviewGateLinkConfirmed(gate, fetchImpl)))
      return { outcome: "not_sent", reason: "OpenRig did not confirm the review gate link." };
  } catch {
    return { outcome: "not_sent", reason: "Could not verify the review gate before release." };
  }
  // Renderer invocation is not human intent. Only the native MAIN dialog is.
  const confirmed = await confirm(gate, input).catch(() => false);
  if (!confirmed)
    return { outcome: "cancelled", reason: "Gate release cancelled. Nothing was sent." };
  // After fetch begins an error is indeterminate: keep requestId, NEVER re-POST.
  try {
    const response = await fetchImpl(
      `${REVIEW_GATES_BASE_URL}/${encodeURIComponent(input.gateQitemId)}/resolve`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          version: 1,
          requestId: input.requestId,
          reviewId: input.reviewId,
          reviewRevision: input.reviewRevision,
          verdict: input.verdict,
          ...(input.note?.trim() ? { note: input.note.trim() } : {}),
        }),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
      },
    );
    const body = (await response.json()) as unknown;
    if (!response.ok && record(body)?.outcome === "not_sent")
      return {
        outcome: "not_sent",
        reason: String(record(body)?.error ?? "OpenRig declined this gate release."),
      };
    const released = response.ok ? reviewGateReleased(body, input) : null;
    if (released) return released;
  } catch {
    /* fall through to read-only reconciliation */
  }
  const reconciled = await lookupOpenRigReviewGateReceipt(input, fetchImpl);
  return reconciled.outcome === "released"
    ? reconciled
    : {
        outcome: "unknown",
        reason: "Gate release unconfirmed. Nothing will be resent; check status to reconcile.",
      };
}

/** Opens only the review URL MAIN itself re-read for the selected gate. */
export async function openOpenRigReviewGateUrl(
  selection: DesktopOpenRigReviewGateSelection,
  open: (url: string) => Promise<boolean>,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!reviewGateSelectionValid(selection)) return false;
  const selected = await readSelectedReviewGate(selection, fetchImpl);
  const url = safeOpenRigReviewUrl(selected?.gate.reviewUrl);
  return url ? open(url) : false;
}

const verdictLabels = {
  approved: "Approved",
  changes_requested: "Changes requested",
  rejected: "Rejected",
} as const;

export const resolveOpenRigReviewGate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_REVIEW_GATE_RESOLVE_CHANNEL,
  payload: DesktopOpenRigReviewGateResolveInputSchema,
  result: DesktopOpenRigReviewGateResolveResultSchema,
  handler: (input) =>
    Effect.gen(function* () {
      const dialog = yield* ElectronDialog.ElectronDialog;
      const runPromise = Effect.runPromiseWith(
        yield* Effect.context<ElectronDialog.ElectronDialog>(),
      );
      return yield* Effect.tryPromise(() =>
        postOpenRigReviewGateResolve(input, async (gate, request) => {
          const choice = await runPromise(
            dialog.showMessageBox({
              type: "question",
              noLink: true,
              title: "Release TaskBoard review gate",
              message: `Release the review gate as "${verdictLabels[request.verdict]}"?`,
              detail: [
                gate.title ?? `Review ${gate.reviewId}`,
                `Review ${gate.reviewId} · revision ${gate.reviewRevision}`,
                `Gate ${gate.gateQitemId}`,
                request.note?.trim() ? `Note: ${request.note.trim().slice(0, 300)}` : "",
              ]
                .filter(Boolean)
                .join("\n"),
              buttons: ["Cancel", "Release gate"],
              defaultId: 0,
              cancelId: 0,
            }),
          );
          return choice.response === 1;
        }),
      );
    }),
});

export const reconcileOpenRigReviewGate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_REVIEW_GATE_RECEIPT_CHANNEL,
  payload: DesktopOpenRigReviewGateResolveInputSchema,
  result: DesktopOpenRigReviewGateResolveResultSchema,
  handler: (input) => Effect.tryPromise(() => lookupOpenRigReviewGateReceipt(input)),
});

export const openOpenRigReviewGate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_REVIEW_GATE_OPEN_CHANNEL,
  payload: DesktopOpenRigReviewGateSelectionSchema,
  result: Schema.Boolean,
  handler: (selection) =>
    Effect.gen(function* () {
      const shell = yield* ElectronShell.ElectronShell;
      return yield* Effect.tryPromise(() =>
        openOpenRigReviewGateUrl(selection, (url) => Effect.runPromise(shell.openExternal(url))),
      );
    }),
});

export const readOpenRigOperatorInbox = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_OPERATOR_INBOX_CHANNEL,
  payload: Schema.String,
  result: DesktopOpenRigInboxSchema,
  handler: (address) => Effect.tryPromise(() => fetchOpenRigOperatorInbox(address)),
});

export const listOpenRigSessions = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_LIST_SESSIONS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopOpenRigSessionSchema),
  handler: () => Effect.tryPromise(() => fetchOpenRigSessions()),
});

export const listOpenRigManagedSessions = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_MANAGED_SESSIONS_CHANNEL,
  payload: Schema.String,
  result: DesktopOpenRigSeatSessionsSchema,
  handler: (id) => Effect.tryPromise(() => fetchOpenRigManagedSessions(id)),
});

export const discoverOpenRigSeats = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_DISCOVER_SEATS_CHANNEL,
  payload: Schema.Void,
  result: DesktopOpenRigSeatTopologySchema,
  handler: () => Effect.tryPromise(() => fetchOpenRigSeatTopology()),
});

export const readOpenRigSeatReports = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_SEAT_REPORTS_CHANNEL,
  payload: Schema.String,
  result: DesktopOpenRigSeatReportsSchema,
  handler: (id) => Effect.tryPromise(() => fetchOpenRigSeatReports(id)),
});

export const readOpenRigAgentTasks = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_AGENT_TASKS_CHANNEL,
  payload: Schema.String,
  result: DesktopOpenRigAgentTasksSchema,
  handler: (id) => Effect.tryPromise(() => fetchOpenRigAgentTasks(id)),
});

export const readOpenRigExecutionProfile = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_READ_EXECUTION_PROFILE_CHANNEL,
  payload: Schema.String,
  result: DesktopOpenRigExecutionProfileSchema,
  handler: (id) => Effect.tryPromise(() => fetchOpenRigExecutionProfile(id)),
});

export const configureOpenRigExecutionProfile = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_CONFIGURE_EXECUTION_PROFILE_CHANNEL,
  payload: DesktopOpenRigConfigureExecutionProfileInputSchema,
  result: DesktopOpenRigExecutionProfileSchema,
  handler: (input) => Effect.tryPromise(() => configureOpenRigSeatExecutionProfile(input)),
});

export const startOpenRigManagedSession = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_START_MANAGED_SESSION_CHANNEL,
  payload: DesktopOpenRigLaunchInputSchema,
  result: DesktopOpenRigSeatSessionsSchema,
  handler: (input) => Effect.tryPromise(() => startOpenRigSeatSession(input)),
});

export const selectOpenRigPrimarySession = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_SELECT_PRIMARY_CHANNEL,
  payload: DesktopOpenRigPrimaryInputSchema,
  result: DesktopOpenRigSeatSessionsSchema,
  handler: (input) => Effect.tryPromise(() => selectOpenRigSeatPrimary(input)),
});

export const adoptOpenRigManagedSession = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_ADOPT_MANAGED_CHANNEL,
  payload: DesktopOpenRigAdoptInputSchema,
  result: DesktopOpenRigSeatSessionsSchema,
  handler: (input) => Effect.tryPromise(() => adoptOpenRigSeatSession(input)),
});

export const reconcileOpenRigChatGPTManagedSession = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_RECONCILE_MANAGED_CHANNEL,
  payload: DesktopOpenRigSessionActionInputSchema,
  result: DesktopOpenRigSeatSessionsSchema,
  handler: (input) => Effect.tryPromise(() => reconcileOpenRigChatGPTSeatSession(input)),
});

export const detachOpenRigManagedSession = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_DETACH_MANAGED_CHANNEL,
  payload: DesktopOpenRigSessionActionInputSchema,
  result: DesktopOpenRigSeatSessionsSchema,
  handler: (input) => Effect.tryPromise(() => detachOpenRigSeatSession(input)),
});

export const runOpenRigManagedBrowserLifecycle = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_MANAGED_BROWSER_LIFECYCLE_CHANNEL,
  payload: DesktopOpenRigManagedBrowserLifecycleInputSchema,
  result: DesktopOpenRigManagedBrowserLifecycleResultSchema,
  handler: (input) => Effect.tryPromise(() => runOpenRigSeatBrowserLifecycle(input)),
});

export const bindOpenRigAgent = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_BIND_AGENT_CHANNEL,
  payload: DesktopOpenRigBindInputSchema,
  result: Schema.Void,
  handler: (input) => Effect.tryPromise(() => bindOpenRigSeat(input)),
});

export const unbindOpenRigAgent = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_UNBIND_AGENT_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: (id) => Effect.tryPromise(() => unbindOpenRigSeat(id)),
});

/** Read-only canonical approval projection over the MAIN-only anonymous child.
 * Neither this bridge nor renderer input confers human authorization. */
export const listPendingOpenRigNativeApprovals = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_NATIVE_APPROVAL_PENDING_CHANNEL,
  payload: Schema.Void,
  result: DesktopOpenRigNativeApprovalPageSchema,
  handler: () =>
    Effect.tryPromise(() => listPendingNativeSpawnApprovals()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(DesktopOpenRigNativeApprovalPageSchema)),
    ),
});

export const getOpenRigNativeApproval = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_NATIVE_APPROVAL_GET_CHANNEL,
  payload: Schema.String,
  result: DesktopOpenRigNativeApprovalSchema,
  handler: (operationId) =>
    Effect.tryPromise(() => getNativeSpawnApproval(operationId)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(DesktopOpenRigNativeApprovalSchema)),
    ),
});

/** The only renderer-controlled field is the opaque lookup key. MAIN presents
 * a native dialog and the authority requires Windows Hello, verifying the
 * immutable operation ID, digest, version and choice before a one-use write.
 * An IPC invocation NEVER equals human approval. */
const decodeNativeReview = Schema.decodeUnknownEffect(DesktopOpenRigNativeReviewResultSchema);
export const requestOpenRigNativeReview = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_NATIVE_APPROVAL_REVIEW_CHANNEL,
  payload: Schema.String,
  result: DesktopOpenRigNativeReviewResultSchema,
  handler: (operationId) =>
    Effect.gen(function* () {
      const dialog = yield* ElectronDialog.ElectronDialog;
      const context = yield* Effect.context<ElectronDialog.ElectronDialog>();
      const runPromise = Effect.runPromiseWith(context);
      const result = yield* Effect.tryPromise(() =>
        reviewNativeSpawnOperation(operationId, (options) =>
          runPromise(dialog.showMessageBox({ ...options, type: "question", noLink: true })),
        ),
      );
      return yield* decodeNativeReview(result);
    }),
});

export const listOpenRigAgents = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_LIST_AGENTS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopOpenRigAgentSchema),
  handler: () => Effect.tryPromise(() => fetchOpenRigAgents()),
});

export const sendOpenRigAgentMessage = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_SEND_AGENT_MESSAGE_CHANNEL,
  payload: DesktopOpenRigSendInputSchema,
  result: Schema.Void,
  handler: (input) => Effect.tryPromise(() => sendOpenRigMessage(input)),
});
