// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off -- Trusted Electron-main compatibility boundary to the existing OmniHub MCP HTTP service.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Operator controls for the already-running OmniHub Tools temporary scheduler.
 * The store is read solely to obtain the monitor owner's secret control token.
 * Only the real Tools MCP endpoint executes mutations; never write its store,
 * wake T3 guests directly, expose tokens to the renderer, or retry UNKNOWN calls.
 */
export type KeepAwakeControlAction = "wake_in_one_minute" | "cancel";
export type KeepAwakeControlRequest = {
  monitorId: string;
  action: KeepAwakeControlAction;
  clientRequestId: string;
  /** UI supplies the ID shown in its explicit cancellation confirmation. */
  confirmedTargetId?: string;
};
export type KeepAwakeControlReceipt = {
  ok: boolean;
  monitorId: string;
  action: KeepAwakeControlAction;
  clientRequestId: string;
  code: "applied" | "unavailable" | "denied" | "conflict" | "unknown";
  detail: string;
  state?: string;
  nextDueMs?: number;
  /** Cancel can stop future polls but cannot revoke an already in-flight send. */
  sendMayAlreadyBeInFlight?: boolean;
};
type RecordValue = Record<string, unknown>;
const asRecord = (v: unknown): RecordValue | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as RecordValue) : null;
const uuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const sourcePath = () => {
  const appData = process.env.LOCALAPPDATA;
  if (!appData) throw new Error("LOCALAPPDATA is unavailable");
  return join(appData, "OmniHub", "temporary-keep-awake-v1.json");
};
const ONLY_SCHEDULER_ENDPOINT = "http://127.0.0.1:8773/mcp";
const response = (request: KeepAwakeControlRequest, code: KeepAwakeControlReceipt["code"], detail: string): KeepAwakeControlReceipt => ({
  ok: code === "applied", monitorId: request.monitorId,
  action: request.action, clientRequestId: request.clientRequestId,
  code, detail,
});

/** Current T3 manager scheduler: never offer an ordinary cancel for this monitor. */
export function isProtectedT3KeepAwake(monitor: RecordValue): boolean {
  const mandate = typeof monitor.mandateId === "string" ? monitor.mandateId : "";
  const caller = typeof monitor.callerIdentity === "string" ? monitor.callerIdentity : "";
  return /^t3[-_ ]manager[-_ ]/i.test(mandate)
    || /^T3 Code Manager\b/i.test(caller);
}

type Invocation = (args: RecordValue) => Promise<unknown>;
async function invokeScheduler(args: RecordValue): Promise<unknown> {
  const rpcId = args.clientRequestId;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(ONLY_SCHEDULER_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method: "tools/call", params: { name: "keep_awake", arguments: args } }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OmniHub Tools HTTP ${response.status}`);
    const json = asRecord(await response.json());
    if (!json || json.error) throw new Error("OmniHub Tools returned a JSON-RPC error");
    const rpcResult = asRecord(json.result);
    if (!rpcResult || rpcResult.isError === true) throw new Error("OmniHub Tools failed the operation");
    const entries = rpcResult.content;
    const item = Array.isArray(entries) ? asRecord(entries[0]) : null;
    if (!item || typeof item.text !== "string") throw new Error("OmniHub Tools returned no operation receipt");
    return JSON.parse(item.text) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The operator receives only an allowlisted receipt; private control tokens
 * remain in Electron main. Pass an injected invocation/store only for focused tests.
 */
export async function controlOmniHubKeepAwake(
  request: KeepAwakeControlRequest,
  dependencies: {
    readStore?: () => Promise<unknown>;
    invoke?: Invocation;
  } = {},
): Promise<KeepAwakeControlReceipt> {
  if (!uuid(request.monitorId) || !uuid(request.clientRequestId))
    return response(request, "denied", "An exact monitor ID and idempotency UUID are required.");
  if (request.action !== "cancel" && request.action !== "wake_in_one_minute")
    return response(request, "denied", "Unsupported scheduler operation.");
  let store: RecordValue | null;
  try {
    const raw = dependencies.readStore
      ? await dependencies.readStore()
      : JSON.parse(await readFile(sourcePath(), "utf8")) as unknown;
    store = asRecord(raw);
  } catch {
    return response(request, "unavailable", "Cannot read OmniHub's owner store. No action attempted.");
  }
  if (store?.version !== 1)
    return response(request, "unavailable", "Unsupported OmniHub keep-awake store version.");
  const monitor = asRecord(asRecord(store.monitors)?.[request.monitorId]);
  if (!monitor || monitor.id !== request.monitorId)
    return response(request, "unavailable", "Exact monitor not found in owner store.");
  const token = monitor.token;
  if (!uuid(token))
    return response(request, "denied", "Monitor owner control token unavailable.");
  if (monitor.state !== "active")
    return response(request, "conflict", "Monitor is not active. Refresh and inspect its current status.");
  if (monitor.inFlight === true)
    return response(request, "conflict", "Delivery is in-flight. Refresh first; never replay a pending send.");
  if (request.action === "cancel") {
    if (isProtectedT3KeepAwake(monitor))
      return response(request, "denied", "This T3 manager keep-awake is protected from accidental cancellation.");
    const exactTargetId = asRecord(monitor.target)?.sessionId;
    if (typeof exactTargetId !== "string" || exactTargetId !== request.confirmedTargetId)
      return response(request, "denied", "Confirm the exact target session ID before cancelling.");
  }
  const args: RecordValue = request.action === "cancel"
    ? { apiVersion: "1", action: "cancel", monitorId: request.monitorId, controlToken: token, clientRequestId: request.clientRequestId }
    : { apiVersion: "1", action: "set_next", monitorId: request.monitorId, controlToken: token, clientRequestId: request.clientRequestId, nextInMinutes: 1 };
  let rawResult: unknown;
  try {
    rawResult = await (dependencies.invoke ?? invokeScheduler)(args);
  } catch {
    // A timeout could occur after OmniHub committed. Do NOT generate a second call.
    return response(request, "unknown", "OmniHub Tools outcome is unknown. Refresh/reconcile; do not repeat this action.");
  }
  const result = asRecord(rawResult);
  if (!result) return response(request, "unknown", "Scheduler returned no recognizable receipt. Refresh before retrying.");
  if (result.ok === false || typeof result.code === "string" && result.code !== "OK") {
    const message = typeof result.message === "string" ? result.message : "Scheduler refused the operation.";
    return response(request, result.code === "CONFLICT" ? "conflict" : "denied", message.slice(0, 300));
  }
  if (result.monitorId !== request.monitorId)
    return response(request, "unknown", "Scheduler receipt monitor ID did not match. Do not retry.");
  const state = typeof result.state === "string" ? result.state : undefined;
  const nextDueMs = typeof result.nextDueMs === "number" ? result.nextDueMs : undefined;
  const sendMayAlreadyBeInFlight = typeof result.lastOutcome === "string" && result.lastOutcome.includes("send_may_already_be_in_flight");
  return {
    ...response(request, "applied", request.action === "cancel"
      ? "Scheduler confirmed cancellation. Earlier sends cannot be recalled."
      : "Scheduler confirmed the next wake for approximately one minute from now."),
    ...(state === undefined ? {} : { state }),
    ...(nextDueMs === undefined ? {} : { nextDueMs }),
    ...(sendMayAlreadyBeInFlight ? { sendMayAlreadyBeInFlight } : {}),
  };
}
