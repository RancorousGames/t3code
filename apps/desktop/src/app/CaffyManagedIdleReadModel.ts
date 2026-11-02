// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off -- Desktop-only fixed-origin OpenRig integration.
import * as NodeProcess from "node:process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  CaffyManagedIdleSubscriptionSchema,
  type CaffyManagedIdleReadResult,
  type CaffyManagedIdleCancelResult,
} from "@t3tools/contracts";

const URL = "http://127.0.0.1:7433/api/integrations/managed-idle-resume";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const decode = Schema.decodeUnknownSync(CaffyManagedIdleSubscriptionSchema);

function bearer() {
  const configured = NodeProcess.env.OPENRIG_TERMINAL_BEARER_TOKEN?.trim() ||
    NodeProcess.env.OPENRIG_AUTH_BEARER_TOKEN?.trim() || null;
  if (configured) return configured;
  try {
    const saved = NodeFS.readFileSync(
      NodePath.join(NodeProcess.env.USERPROFILE || NodeOS.homedir(), ".openrig", "terminal-token"),
      "utf8",
    ).trim();
    return saved.length >= 24 ? saved : null;
  } catch { return null; }
}

async function request(path: string, method: "GET" | "POST") {
  const token = bearer();
  const response = await fetch(URL + path, {
    method,
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(6_000),
  });
  if (!response.ok) throw new Error(`OpenRig HTTP ${response.status}`);
  const length = response.headers.get("content-length");
  if (length && Number(length) > 2_000_000) throw new Error("Caffy response too large");
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Malformed Caffy response");
  }
  return payload as Record<string, unknown>;
}

/** Only read an authenticated OpenRig projection. Errors are surfaced as
 * unavailable, NOT as an empty active-subscription set. */
export async function readCaffyManagedIdle(): Promise<CaffyManagedIdleReadResult> {
  const observedAtMs = Date.now();
  try {
    const payload = await request("", "GET");
    if (payload.system !== "caffy" || payload.mode !== "resume_on_idle" ||
        !Array.isArray(payload.subscriptions) || payload.subscriptions.length > 500)
      throw new Error("Unexpected managed idle response");
    return {
      availability: "ok", observedAtMs,
      eventDeliveryEnabled: payload.eventDeliveryEnabled === true,
      subscriptions: payload.subscriptions.map(entry => decode(entry)),
    };
  } catch (error) {
    return {
      availability: "unavailable", observedAtMs, eventDeliveryEnabled: false, subscriptions: [],
      error: error instanceof Error ? error.message : "Unable to read OpenRig Caffy subscriptions",
    };
  }
}

/** Cancellation is a single POST only. UNKNOWN is never retried; a later
 * read-only status fetch must reconcile the original ID. */
export async function cancelCaffyManagedIdle(id: string): Promise<CaffyManagedIdleCancelResult> {
  if (!UUID.test(id)) return { ok: false, status: "unavailable", detail: "Invalid exact subscription ID" };
  try {
    const payload = await request(`/${id}/cancel`, "POST");
    if (payload.system !== "caffy" || payload.mode !== "resume_on_idle" ||
        payload.status !== "cancelled")
      throw new Error("Unverified cancellation receipt");
    return { ok: true, status: "cancelled", detail: "OpenRig confirmed cancellation." };
  } catch (error) {
    return {
      ok: false, status: "uncertain",
      detail: `Cancellation outcome unknown; refresh original status before retrying. ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
