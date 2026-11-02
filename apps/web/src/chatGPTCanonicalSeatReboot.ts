import type { DesktopOpenRigSeatRebootReceipt } from "@t3tools/contracts";

/** A durable exact request fence: a lost IPC reply never issues another begin. */
export async function canonicalSeatReboot(input: {
  seatId: string;
  sessionId: string;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  invoke: NonNullable<NonNullable<Window["desktopBridge"]>["runOpenRigSeatReboot"]>;
  createId?: () => string;
}): Promise<DesktopOpenRigSeatRebootReceipt> {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.seatId) ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.sessionId))
    throw new Error("Verified seat and browser session UUIDs required");
  const key = `t3code:openrig-seat-reboot:${input.sessionId}`;
  const previous = input.storage.getItem(key);
  let operation: { seatId: string; requestId: string } | null = null;
  try { operation = previous ? JSON.parse(previous) as { seatId: string; requestId: string } : null; }
  catch { throw new Error("Reboot journal is unreadable; manual recovery required"); }
  if (operation && operation.seatId !== input.seatId)
    throw new Error("Canonical seat changed; reconcile the recorded operation before reboot");
  if (operation && !/^[a-f0-9-]{36}$/i.test(operation.requestId))
    throw new Error("Reboot journal contains an invalid request; do not overwrite it");
  const requestId = operation?.requestId ?? (input.createId ?? crypto.randomUUID)();
  if (!operation) input.storage.setItem(key, JSON.stringify({ seatId: input.seatId, requestId }));
  const base = { seatId: input.seatId, sessionId: input.sessionId, requestId };
  // First click commits one begin; all further clicks reconcile the SAME operation.
  if (!operation) {
    try { return await input.invoke({ ...base, phase: "begin" }); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("pre-dispatch authorization rejected") ||
          message.includes("operator authority unavailable; no reboot attempted"))
        input.storage.removeItem(key);
      // Every other error may represent an already dispatched UNKNOWN send.
      throw error;
    }
  }
  const state = await input.invoke({ ...base, phase: "status" });
  const settled = ["reserved", "submitted", "unknown"].includes(state.status)
    ? await input.invoke({ ...base, phase: "reconcile" }) : state;
  if (settled.status === "committed" || settled.status === "restored")
    input.storage.removeItem(key);
  return settled;
}
