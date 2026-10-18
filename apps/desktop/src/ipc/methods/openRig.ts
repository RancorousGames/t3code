import {
  DesktopOpenRigAgentSchema,
  DesktopOpenRigSessionSchema,
  DesktopOpenRigBindInputSchema,
  DesktopOpenRigSendInputSchema,
  type DesktopOpenRigAgent,
  type DesktopOpenRigSession,
  type DesktopOpenRigSessionTarget,
  type DesktopOpenRigBindInput,
  type DesktopOpenRigSendInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

// The renderer never connects to localhost directly. It cannot choose the host,
// path or HTTP method, even when a remote T3 environment is selected.
const OPENRIG_BASE_URL = "http://127.0.0.1:7433/api/integrations/t3";
const LIST_TIMEOUT_MS = 12_000;
// T3 browser composer dispatch can take up to 95 seconds. A shorter timeout
// would report failure after T3 already delivered the message, inviting duplicates.
const SEND_TIMEOUT_MS = 110_000;

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
  options: { method: "GET" | "POST" | "DELETE"; payload?: Record<string, unknown> },
  fetchImpl: typeof fetch,
): Promise<Response> {
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
        : path.endsWith("/send")
          ? SEND_TIMEOUT_MS
          : LIST_TIMEOUT_MS,
    ),
  });
  if (!response.ok) throw new Error(`OpenRig bridge returned HTTP ${response.status}.`);
  return response;
}

export async function fetchOpenRigAgents(fetchImpl: typeof fetch = fetch) {
  const response = await bridgeRequest("/agents", { method: "GET" }, fetchImpl);
  return decodeOpenRigAgents((await response.json()) as unknown);
}

export async function sendOpenRigMessage(
  { id, message }: DesktopOpenRigSendInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  // IDs are opaque. Encode them as a single segment, never interpolate raw path data.
  if (!id.trim() || id.length > 512 || !message.trim() || message.length > 8_000) {
    throw new Error("Invalid OpenRig message.");
  }
  await bridgeRequest(
    `/agents/${encodeURIComponent(id)}/send`,
    { method: "POST", payload: { message } },
    fetchImpl,
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
    await bridgeRequest(
      `/agents/${encodeURIComponent(input.id)}/binding`,
      { method: "POST", payload: { target: normalized } },
      fetchImpl,
    );
    return;
  }
  if (!input.sessionId?.trim()) throw new Error("Browser session ID required.");
  await bridgeRequest(
    `/agents/${encodeURIComponent(input.id)}/bind`,
    { method: "POST", payload: { sessionId: input.sessionId } },
    fetchImpl,
  );
}

export async function unbindOpenRigSeat(id: string, fetchImpl: typeof fetch = fetch) {
  if (!id.trim()) throw new Error("Seat ID required.");
  await bridgeRequest(`/agents/${encodeURIComponent(id)}/bind`, { method: "DELETE" }, fetchImpl);
}

export const listOpenRigSessions = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPENRIG_LIST_SESSIONS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopOpenRigSessionSchema),
  handler: () => Effect.tryPromise(() => fetchOpenRigSessions()),
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
