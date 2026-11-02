/** MAIN-only transport for an existing canonical OpenRig seat's T3 same-tab reboot.
 * The renderer can request begin/status/reconcile, never supply authority or a prompt.
 * A failed POST is UNKNOWN; only GET/status or reconcile may follow that requestId. */
/** Definitively rejected by the middleware before any reboot mutation. */
export class OpenRigRebootNotDispatched extends Error {
  constructor(status: number) {
    super(`OpenRig reboot pre-dispatch authorization rejected (HTTP ${status}); no operation was sent`);
    this.name = "OpenRigRebootNotDispatched";
  }
}
export type SeatRebootReceipt = {
  version: 1;
  operation: "reboot_agent";
  requestId: string;
  seatId: string;
  sessionId: string;
  managedSessionId: string;
  rebootGeneration: number | null;
  status: "reserved" | "unknown" | "submitted" | "committed" | "restored";
  reason: string | null;
  retrySafe: false;
};
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export async function requestCanonicalSeatReboot(
  input: { seatId: string; sessionId: string; requestId: string; phase: "begin" | "status" | "reconcile" },
  opts: { bearer: string | null; operatorToken: string | null; fetchImpl?: typeof fetch },
): Promise<SeatRebootReceipt> {
  if (!UUID.test(input.seatId) || !UUID.test(input.sessionId) ||
      !UUID.test(input.requestId))
    throw new Error("Canonical seat reboot requires exact UUID identities");
  if (!opts.bearer || !opts.operatorToken || opts.operatorToken.length < 24)
    throw new Error("OpenRig operator authority unavailable; no reboot attempted");
  const requestId = input.requestId;
  const root = `http://127.0.0.1:7433/api/integrations/t3/agents/${input.seatId}/reboots`;
  const url = input.phase === "begin" ? root
    : `${root}/${requestId}${input.phase === "reconcile" ? "/reconcile" : ""}`;
  const method = input.phase === "status" ? "GET" : "POST";
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, {
    method,
    headers: { Accept: "application/json", Authorization: `Bearer ${opts.bearer}`,
      "x-openrig-rollover-operator-token": opts.operatorToken,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
    ...(input.phase === "begin" ? { body: JSON.stringify({ requestId, sessionId: input.sessionId }) } : {}),
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new Error(`OpenRig reboot ${input.phase} UNKNOWN for exact request ${requestId}; reconcile without repeating begin`);
  }
  if (res.status === 401 || res.status === 403) throw new OpenRigRebootNotDispatched(res.status);
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || !body || typeof body !== "object")
    throw new Error(`OpenRig reboot ${input.phase} returned HTTP ${res.status}; original request ${requestId} must be reconciled`);
  const value = body as Partial<SeatRebootReceipt>;
  if (value.requestId !== requestId || value.seatId !== input.seatId ||
      value.sessionId !== input.sessionId || value.operation !== "reboot_agent" ||
      !["reserved", "unknown", "submitted", "committed", "restored"].includes(value.status ?? ""))
    throw new Error(`Unverified OpenRig reboot receipt for ${requestId}; do not retry begin`);
  return value as SeatRebootReceipt;
}
