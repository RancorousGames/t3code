import type { EnvironmentId } from "@t3tools/contracts";
import { randomUUID } from "./lib/utils";
import { readChatGPTBrowserSessions } from "./chatGPTBrowserSessions";
import { rebootChatGPTDesktop } from "./chatGPTSameBrowserRebootDesktop";
import type { RebootReceipt } from "./chatGPTSameBrowserReboot";

const active = new Set<string>();
const keyFor = (environmentId: EnvironmentId, sessionId: string) =>
  `${environmentId}:${sessionId}`;

/** The existing T3 reboot journal is authoritative across renderer restarts. */
export function pendingSidebarReboot(
  environmentId: EnvironmentId,
  sessionId: string,
): RebootReceipt | null {
  const raw = window.localStorage.getItem(
    `t3code:chatgpt-browser:refresh:v1:${environmentId}`,
  );
  if (!raw) return null;
  const records: unknown = JSON.parse(raw);
  if (!Array.isArray(records) || records.some((r) =>
    !r || typeof r !== "object" || typeof r.sessionId !== "string" ||
    typeof r.operationId !== "string" || typeof r.status !== "string"))
    throw new Error("T3 reboot journal cannot be read; do not initiate another reboot.");
  const pending = (records as RebootReceipt[]).filter((r) =>
    r.sessionId === sessionId && (r.status === "unknown" || r.status === "submitted"));
  if (pending.length > 1)
    throw new Error("Conflicting Agent Reboot requests. Preserve both receipts for reconciliation.");
  return pending[0] ?? null;
}

/** Exact T3 browser UUID only; never infer from the selected browser or OpenRig title.
 * Reboot owns the browser replacement, draft snapshot and UNKNOWN-send journal. */
export async function beginSidebarReboot(input: {
  environmentId: EnvironmentId;
  sessionId: string;
  prompt: string;
}): Promise<RebootReceipt> {
  const key = keyFor(input.environmentId, input.sessionId);
  if (active.has(key)) throw new Error("Agent Reboot already executing for this session.");
  active.add(key);
  try {
    if (!readChatGPTBrowserSessions(input.environmentId).some((s) => s.id === input.sessionId))
      throw new Error("The exact T3 session is no longer present.");
    if (pendingSidebarReboot(input.environmentId, input.sessionId))
      throw new Error("An earlier reboot may have been submitted. Check its existing receipt instead.");
    if (!input.prompt.trim()) throw new Error("A continuation handoff is required.");
    return await rebootChatGPTDesktop({
      ...input,
      operationId: randomUUID(),
      prompt: input.prompt.trim(),
      phase: "begin",
    });
  } finally {
    active.delete(key);
  }
}

/** This must never send, navigate, or allocate another request ID. */
export async function reconcileSidebarReboot(
  environmentId: EnvironmentId,
  sessionId: string,
): Promise<RebootReceipt> {
  const key = keyFor(environmentId, sessionId);
  if (active.has(key)) throw new Error("Agent Reboot already executing for this session.");
  active.add(key);
  try {
    const existing = pendingSidebarReboot(environmentId, sessionId);
    if (!existing) throw new Error("No unresolved Agent Reboot receipt for this T3 session.");
    const receipt = await rebootChatGPTDesktop({
      environmentId, sessionId, operationId: existing.operationId, phase: "status",
    });
    if (receipt.status !== "submitted") return receipt;
    try {
      return await rebootChatGPTDesktop({
        environmentId, sessionId, operationId: existing.operationId, phase: "finalize",
      });
    } catch (error) {
      if (error instanceof Error && error.message === "First assistant response is not verified.")
        return receipt;
      throw error;
    }
  } finally {
    active.delete(key);
  }
}
