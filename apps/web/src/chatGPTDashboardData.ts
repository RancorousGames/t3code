import type { BrowserSession } from "./chatGPTBrowserSessions";
import type { ChatGPTPageSnapshot } from "./chatGPTPageSnapshotInspection";
import { validChatGPTCompletion } from "./chatGPTSessionCompletion";
import {
  deriveChatGPTSession,
  type ChatGPTSessionModel,
  type RawChatGPTSessionSignals,
} from "./chatGPTSessionModel";

export type ChatGPTDashboardSession = {
  session: BrowserSession;
  model: ChatGPTSessionModel;
  snapshot: ChatGPTPageSnapshot | null;
  updatedAt: number;
};

export function isChatGPTDashboardSnapshot(value: unknown): value is ChatGPTPageSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<ChatGPTPageSnapshot>;
  return typeof snapshot.url === "string" &&
    typeof snapshot.conversationId === "string" &&
    typeof snapshot.observedAt === "number" &&
    Number.isFinite(snapshot.observedAt) &&
    typeof snapshot.turnCount === "number" &&
    ["working", "idle", "interrupted", "failed", "unknown"].includes(snapshot.activity ?? "");
}

/**
 * A read-only projection of persisted data; never mounts or wakes any guest.
 * Stale snapshots remain visible with their own observed time, not as live truth.
 */
export function projectChatGPTDashboardSession(input: {
  session: BrowserSession;
  snapshot: unknown;
  now: number;
  uncertainSend?: boolean;
  recovery?: RawChatGPTSessionSignals["recovery"];
  lastWorkingAt?: number;
}): ChatGPTDashboardSession {
  const { session, now } = input;
  const snapshot = isChatGPTDashboardSnapshot(input.snapshot) ? input.snapshot : null;
  // Persisted pages are historical evidence, never proof a guest is still working.
  const fresh = !!snapshot && now >= snapshot.observedAt && now - snapshot.observedAt <= 2 * 60_000;
  const age = fresh && snapshot?.activity === "working" ? "working" as const
    : fresh && snapshot?.activity === "idle" ? "inactive" as const
    : fresh && snapshot?.activity === "interrupted" ? "interrupted" as const
    : fresh && snapshot?.activity === "failed" ? "invalid" as const
    : "unknown" as const;
  const signals: RawChatGPTSessionSignals = {
    age,
    ...(session.hidden !== undefined ? { hidden: session.hidden } : {}),
    ...(session.snoozedUntil !== undefined ? { snoozedUntil: session.snoozedUntil } : {}),
    ...(input.recovery ? { recovery: input.recovery } : {}),
    uncertainSend: input.uncertainSend === true,
    completionValid: !!validChatGPTCompletion(
      session.completion,
      snapshot?.url ?? null,
      snapshot?.turnCount ?? 0,
      snapshot?.activity === "idle",
    ),
    lastWorkingAt: input.lastWorkingAt ?? (
      fresh && snapshot?.activity === "idle" ? snapshot.observedAt : 0
    ),
    ...(snapshot?.signals.signInOrCaptcha ? { browserUnavailable: true } : {}),
    ...(fresh && snapshot?.activity === "idle" && snapshot.lastAssistant?.endsWithQuestion
      ? { status: "waiting_for_input" } : {}),
  };
  const model = deriveChatGPTSession(signals, now);
  return {
    session,
    model,
    snapshot,
    updatedAt: snapshot?.observedAt ?? session.lastDirectInteractionAt ?? session.createdAt ?? 0,
  };
}

export const CHATGPT_DASHBOARD_BUCKETS = [
  ["needs_you", "Needs you"],
  ["working", "Working"],
  ["recently_stopped", "Recently stopped"],
  ["idle", "Idle"],
  ["snoozed", "Snoozed"],
  ["completed", "Completed today"],
] as const;

export function groupChatGPTDashboardSessions(
  sessions: readonly ChatGPTDashboardSession[],
  now: number,
): Record<(typeof CHATGPT_DASHBOARD_BUCKETS)[number][0], ChatGPTDashboardSession[]> {
  const groups: Record<(typeof CHATGPT_DASHBOARD_BUCKETS)[number][0], ChatGPTDashboardSession[]> = {
    needs_you: [], working: [], recently_stopped: [], idle: [], snoozed: [], completed: [],
  };
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  for (const row of sessions) {
    const bucket = row.model.bucket;
    if (!bucket) continue;
    if (bucket === "completed") {
      const declaredAt = Date.parse(row.session.completion?.declaredAt ?? "");
      if (!Number.isFinite(declaredAt) || declaredAt < today.getTime() || declaredAt > now)
        continue;
    }
    groups[bucket].push(row);
  }
  for (const rows of Object.values(groups)) rows.sort((a, b) =>
    b.updatedAt - a.updatedAt || a.session.title.localeCompare(b.session.title));
  return groups;
}
