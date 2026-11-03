import { getChatGPTSessionPersistedStore } from "../../chatGPTSessionPersistedStore";
import { isPersistentChatGPTSessionOptedIn } from "../../browser/persistentChatGPTSessionMode";
import { readChatGPTRecoverySettings } from "../../chatGPTRecoverySettings";
import { recordChatGPTRecoveryAttemptLog } from "../../chatGPTRecoveryAttemptLog";
import {
  logChatGPTRecoveryPriority,
  logChatGPTRecoveryTimeline,
} from "../../chatGPTRecoveryTimeline";
/**
 * Desktop-only recovery scheduling. Session storage deliberately survives React
 * remounts but starts a new diagnostic/retry episode with the next T3 app launch.
 * No message content, drafts or authentication state enters this journal.
 */
export const MAX_RECOVERY_TARGETS = 3;
const FAILURE_BURST_LIMIT = 20;
const FAILURE_BURST_PAUSE_MS = 10 * 60_000;
const backendFor = (id: string) => isPersistentChatGPTSessionOptedIn(id) ? "native" : "webview";

export interface RecoveryQueueEntry {
  id: string;
  reason: string;
  manager: boolean;
  /** Red browser/load failure is always scheduled before orange stalls. */
  red?: boolean;
  firstSeenAt: number;
  attempts: number;
  lastAttemptAt: number;
  lastOutcome: string;
  /** Set after a browser mutation settles; cleared by the next verified health check. */
  awaitingHealthCheck?: boolean;
  /** Legacy persisted marker. Ignored and cleared after upgrade; never blocks retries. */
  exhausted: boolean;
  /** Explicit user-requested queue rearm, not merely the selected tab. */
  manualPriority?: boolean;
  /** Current failing selection wins ties, but cannot starve older failures. */
  selected?: boolean;
  /** Derived only from independently observed interrupted/delivery-timeout work. */
  interrupted?: boolean;
  /** A verified recent interaction; independent of title or collapsed project. */
  recentlyClicked?: boolean;
}

export interface RecoveryQueueEvent {
  at: number;
  id: string;
  kind:
    | "attempt"
    | "outcome"
    | "failed"
    | "backoff"
    | "recovered"
    | "queued"
    | "preempted"
    | "exhausted"
    | "manual-retry";
  detail: string;
  targets: string[];
  queued: string[];
}

export interface RecoveryQueueState {
  targets: string[];
  /** Sticky red target: never displaced by age, attempts, a new selection, or a cooldown. */
  activeRedId: string | null;
  failures: Record<string, RecoveryQueueEntry>;
  history: RecoveryQueueEvent[];
  /** Summary counters retained for dashboards and legacy queue compatibility. */
  failureStreak: number;
  backoffUntil: number;
  /** Lane-specific failure bursts and cooldowns: orange never blocks red. */
  redFailureStreak: number;
  orangeFailureStreak: number;
  redBackoffUntil: number;
  orangeBackoffUntil: number;
  lastScanAt?: number | undefined;
}

export interface RecoveryQueueContext {
  eligibleIds: readonly string[];
  failingIds: readonly string[];
  selectedId?: string | null;
  managerIds?: readonly string[];
  recentClicks?: readonly string[];
  /** IDs from observed interrupted/delivery-timeout statuses, not guessed from titles. */
  interruptedIds?: readonly string[];
  lastActive?: Readonly<Record<string, number>>;
  /** Guests whose previous host mutation has not settled; retain their errors, but free their slots. */
  suspendedIds?: readonly string[];
}

const queueKey = (environment: string) => "t3code:chatgpt-browser:recovery-queue:" + environment;
const empty = (): RecoveryQueueState => ({
  targets: [],
  activeRedId: null,
  failures: {},
  history: [],
  failureStreak: 0,
  backoffUntil: 0,
  redFailureStreak: 0,
  orangeFailureStreak: 0,
  redBackoffUntil: 0,
  orangeBackoffUntil: 0,
});

export function readRecoveryQueue(environment: string): RecoveryQueueState {
  try {
    // A recovery episode ends when window sessionStorage resets. Never resurrect
    // a prior launch's persisted queue.
    const raw = window.sessionStorage.getItem(queueKey(environment));
    const decoded: unknown = raw === null ? null : JSON.parse(raw);
    const store = getChatGPTSessionPersistedStore(environment);
    if (JSON.stringify(store.getState().recovery.queue) !== JSON.stringify(decoded)) {
      store.setState((previous) => ({
        recovery: { ...previous.recovery, queue: decoded as RecoveryQueueState | null },
      }));
    }
    const value: unknown = store.getState().recovery.queue;
    if (!value || typeof value !== "object") return empty();
    const data = value as Partial<RecoveryQueueState>;
    return {
      targets: Array.isArray(data.targets)
        ? data.targets.filter((id): id is string => typeof id === "string")
        : [],
      activeRedId: typeof data.activeRedId === "string" ? data.activeRedId : null,
      // Old 50-attempt episodes must resume automatically after upgrading.
      failures:
        data.failures && typeof data.failures === "object"
          ? (Object.fromEntries(
              Object.entries(data.failures).map(([id, value]) => [
                id,
                { ...value, exhausted: false },
              ]),
            ) as RecoveryQueueState["failures"])
          : {},
      history: Array.isArray(data.history) ? data.history : [],
      failureStreak:
        Number.isSafeInteger(data.failureStreak) && data.failureStreak! >= 0
          ? data.failureStreak!
          : 0,
      backoffUntil:
        typeof data.backoffUntil === "number" && Number.isFinite(data.backoffUntil)
          ? data.backoffUntil
          : 0,
      redFailureStreak:
        Number.isSafeInteger(data.redFailureStreak) && data.redFailureStreak! >= 0
          ? data.redFailureStreak!
          : (data.failureStreak ?? 0),
      orangeFailureStreak:
        Number.isSafeInteger(data.orangeFailureStreak) && data.orangeFailureStreak! >= 0
          ? data.orangeFailureStreak!
          : (data.failureStreak ?? 0),
      redBackoffUntil: Number.isFinite(data.redBackoffUntil)
        ? data.redBackoffUntil!
        : Number.isFinite(data.backoffUntil)
          ? data.backoffUntil!
          : 0,
      orangeBackoffUntil: Number.isFinite(data.orangeBackoffUntil)
        ? data.orangeBackoffUntil!
        : Number.isFinite(data.backoffUntil)
          ? data.backoffUntil!
          : 0,
      lastScanAt: typeof data.lastScanAt === "number" ? data.lastScanAt : undefined,
    };
  } catch {
    return empty();
  }
}
function save(environment: string, state: RecoveryQueueState): void {
  try {
    window.sessionStorage.setItem(queueKey(environment), JSON.stringify(state));
    const store = getChatGPTSessionPersistedStore(environment);
    store.setState((previous) => ({
      recovery: { ...previous.recovery, queue: structuredClone(state) },
    }));
    window.dispatchEvent(new CustomEvent("chatgpt-recovery-queue-updated"));
  } catch {
    // A lost journal must never cause an unsafe recovery mutation.
  }
}
const pending = (state: RecoveryQueueState) =>
  Object.keys(state.failures).filter((id) => !state.targets.includes(id));
function append(
  state: RecoveryQueueState,
  id: string,
  kind: RecoveryQueueEvent["kind"],
  detail: string,
) {
  state.history.push({
    at: Date.now(),
    id,
    kind,
    detail,
    targets: [...state.targets],
    queued: pending(state),
  });
  if (state.history.length > 500) state.history.splice(0, state.history.length - 500);
}
/** Red priority is stable between attempts. Orange retains oldest-attempt rotation. */
function tier(entry: RecoveryQueueEntry): number {
  // Mere selection is a recent click, not an explicit recovery request.
  // Only manuallyRetryRecovery may promote a guest above trusted managers.
  if (entry.manualPriority) return 0;
  if (entry.manager) return 1;
  if (entry.interrupted) return 2;
  if (entry.recentlyClicked) return 3;
  return 4;
}

function byPriority(a: RecoveryQueueEntry, b: RecoveryQueueEntry): number {
  return (
    Number(!!b.red) - Number(!!a.red) ||
    Number(!!b.manualPriority) - Number(!!a.manualPriority) ||
    // For orange, class priority wins before fairness. A low-priority guest
    // cannot leapfrog a verified manager solely by having fewer attempts.
    tier(a) - tier(b) ||
    // Within a priority tier, the least recently attempted orange guest wins.
    (a.red && b.red ? 0 : a.lastAttemptAt - b.lastAttemptAt) ||
    a.firstSeenAt - b.firstSeenAt ||
    a.id.localeCompare(b.id)
  );
}

function priorityReason(id: string, context: RecoveryQueueContext): string {
  if (context.managerIds?.includes(id)) return "trusted manager";
  if (context.interruptedIds?.includes(id)) return "confirmed interrupted work";
  if (id === context.selectedId || context.recentClicks?.includes(id))
    return "recently user-interacted";
  if ((context.lastActive?.[id] ?? 0) > 0) return "last-active session";
  return "errored session";
}
/** Public read-only full ordering, including queued candidates outside the active N slots. */
export function recoveryPriorityOrder(state: RecoveryQueueState): string[] {
  return Object.values(state.failures)
    .sort((a, b) =>
      a.id === state.activeRedId && a.red
        ? -1
        : b.id === state.activeRedId && b.red
          ? 1
          : byPriority(a, b),
    )
    .map((entry) => entry.id);
}

function fillTargets(state: RecoveryQueueState, suspendedIds: readonly string[] = []): void {
  // Pin exactly one red failure until verified healthy, removed, or manually
  // overridden. Other red sessions wait; only orange gets round-robin slots.
  // A suspended/uncertain red guest keeps its pin but does not consume a slot.
  if (!state.activeRedId || !state.failures[state.activeRedId]?.red) {
    state.activeRedId =
      Object.values(state.failures)
        .filter((entry) => entry.red)
        .sort(byPriority)[0]?.id ?? null;
  }
  const suspended = new Set(suspendedIds);
  const next = [
    ...(state.activeRedId && !suspended.has(state.activeRedId) ? [state.activeRedId] : []),
    ...recoveryPriorityOrder(state).filter((id) => !state.failures[id]?.red && !suspended.has(id)),
  ].slice(0, readChatGPTRecoverySettings().targetCount);
  for (const id of state.targets) {
    if (!next.includes(id)) append(state, id, "preempted", "Queued for a fairer recovery turn");
  }
  for (const id of next) {
    if (!state.targets.includes(id))
      append(state, id, "queued", "Scheduled: " + state.failures[id]!.reason);
  }
  state.targets = next;
}

export function recordRecoveryScan(environment: string): void {
  const state = readRecoveryQueue(environment);
  state.lastScanAt = Date.now();
  save(environment, state);
}

export function reconcileRecoveryQueue(
  environment: string,
  context: RecoveryQueueContext,
): RecoveryQueueState {
  const state = readRecoveryQueue(environment);
  const eligible = new Set(context.eligibleIds);
  let changed = false;
  for (const id of Object.keys(state.failures)) {
    if (eligible.has(id)) continue;
    delete state.failures[id];
    changed = true;
  }
  const retained = state.targets
    .filter((id) => id in state.failures)
    .slice(0, readChatGPTRecoverySettings().targetCount);
  if (retained.join("|") !== state.targets.join("|")) changed = true;
  state.targets = retained;
  for (const id of context.failingIds) {
    if (!eligible.has(id)) continue;
    if (!state.failures[id]) {
      state.failures[id] = {
        id,
        reason: priorityReason(id, context),
        manager: context.managerIds?.includes(id) ?? false,
        red: true,
        selected: id === context.selectedId,
        firstSeenAt: Date.now(),
        attempts: 0,
        lastAttemptAt: 0,
        lastOutcome: "awaiting verification",
        exhausted: false,
        interrupted: context.interruptedIds?.includes(id) ?? false,
        recentlyClicked: id === context.selectedId || (context.recentClicks?.includes(id) ?? false),
      };
      changed = true;
    }
  }
  for (const entry of Object.values(state.failures)) {
    const reason = priorityReason(entry.id, context);
    if (entry.reason !== reason) {
      entry.reason = reason;
      changed = true;
    }
    // A missing sidebar red signal is not a verified recovery. Once classified
    // red, retain it until noteRecoveryVerified confirms health or eligibility ends.
    const red = entry.red === true || context.failingIds.includes(entry.id);
    if (entry.red !== red) {
      entry.red = red;
      changed = true;
    }
    const selected = entry.id === context.selectedId;
    if (entry.selected !== selected) {
      entry.selected = selected;
      changed = true;
    }
    const manager = context.managerIds?.includes(entry.id) ?? false;
    if (entry.manager !== manager) {
      entry.manager = manager;
      changed = true;
    }
    const interrupted = context.interruptedIds?.includes(entry.id) ?? false;
    if (entry.interrupted !== interrupted) {
      entry.interrupted = interrupted;
      changed = true;
    }
    const clicked =
      entry.id === context.selectedId || (context.recentClicks?.includes(entry.id) ?? false);
    if (entry.recentlyClicked !== clicked) {
      entry.recentlyClicked = clicked;
      changed = true;
    }
    // Re-arm a legacy exhausted record; no new 50-attempt cutoff exists.
    if (entry.exhausted) {
      entry.exhausted = false;
      changed = true;
    }
  }
  const before = state.targets.join("|");
  fillTargets(state, context.suspendedIds);
  if (changed || before !== state.targets.join("|")) save(environment, state);
  logChatGPTRecoveryPriority(
    environment,
    "all",
    recoveryPriorityOrder(state).map((id) => ({
      id,
      reason: `recovery: ${state.failures[id]?.reason ?? "unknown"}`,
    })),
    state.targets,
    "Verified-failure recovery queue (red pinned, orange ranked by priority).",
    "recovery",
  );
  return state;
}

export function noteRecoveryFailure(
  environment: string,
  id: string,
  reason: string,
  context: RecoveryQueueContext,
): void {
  const state = readRecoveryQueue(environment);
  if (!context.eligibleIds.includes(id)) return;
  const existing = state.failures[id];
  if (existing) {
    if (!existing.awaitingHealthCheck) return;
    // Only an independently observed failure AFTER a settled attempt counts.
    // A completed reload/route navigation is not itself proof of recovery.
    existing.awaitingHealthCheck = false;
    const lane = existing.red ? "red" : "orange";
    const streakKey = lane === "red" ? "redFailureStreak" : "orangeFailureStreak";
    const backoffKey = lane === "red" ? "redBackoffUntil" : "orangeBackoffUntil";
    state[streakKey] += 1;
    existing.lastOutcome = `still failing after attempt #${existing.attempts} (${reason})`;
    append(
      state,
      id,
      "failed",
      `${existing.lastOutcome}; ${lane} streak ${state[streakKey]}/${FAILURE_BURST_LIMIT}`,
    );
    logChatGPTRecoveryTimeline(
      environment,
      backendFor(id),
      "outcome",
      `Page still unhealthy after attempt #${existing.attempts}: ${reason}.`,
      { sessionId: id, attempt: existing.attempts },
    );
    if (state[streakKey] >= FAILURE_BURST_LIMIT) {
      state[backoffKey] = Date.now() + FAILURE_BURST_PAUSE_MS;
      state[streakKey] = 0;
      append(
        state,
        id,
        "backoff",
        `20 consecutive ${lane} failures: ${lane} recovery pauses until ${new Date(state[backoffKey]).toLocaleTimeString()}`,
      );
      logChatGPTRecoveryTimeline(
        environment,
        backendFor(id),
        "backoff",
        `20 consecutive ${lane} failures; recovery pauses for 10 minutes.`,
        { sessionId: id, nextAt: state[backoffKey] },
      );
      recordChatGPTRecoveryAttemptLog(environment, {
        at: Date.now(),
        kind: "backoff",
        sessionId: id,
        attemptNumber: existing.attempts,
        detail: `20 consecutive ${lane} failures: ${lane} recovery paused for 10 minutes`,
        pauseUntil: state[backoffKey],
      });
    }
    state.failureStreak = Math.max(state.redFailureStreak, state.orangeFailureStreak);
    state.backoffUntil = Math.max(state.redBackoffUntil, state.orangeBackoffUntil);
    save(environment, state);
    return;
  }
  state.failures[id] = {
    id,
    reason: priorityReason(id, context),
    manager: context.managerIds?.includes(id) ?? false,
    red: reason === "load-failure" || reason === "browser-unresponsive",
    selected: id === context.selectedId,
    firstSeenAt: Date.now(),
    attempts: 0,
    lastAttemptAt: 0,
    lastOutcome: "awaiting verification (" + reason + ")",
    exhausted: false,
    interrupted: context.interruptedIds?.includes(id) ?? false,
    recentlyClicked: id === context.selectedId || (context.recentClicks?.includes(id) ?? false),
  };
  fillTargets(state, context.suspendedIds);
  append(state, id, "queued", reason);
  save(environment, state);
}

export function noteRecoveryVerified(environment: string, id: string): void {
  const state = readRecoveryQueue(environment);
  const entry = state.failures[id];
  if (!entry) return;
  delete state.failures[id];
  if (state.activeRedId === id) state.activeRedId = null;
  // A verified recovery clears only its own lane. A healthy orange session must
  // not extend or cancel the independent red backoff (and vice versa).
  if (entry.red) {
    state.redFailureStreak = 0;
    state.redBackoffUntil = 0;
  } else {
    state.orangeFailureStreak = 0;
    state.orangeBackoffUntil = 0;
  }
  state.failureStreak = Math.max(state.redFailureStreak, state.orangeFailureStreak);
  state.backoffUntil = Math.max(state.redBackoffUntil, state.orangeBackoffUntil);
  state.targets = state.targets.filter((target) => target !== id);
  append(state, id, "recovered", "Health verified after " + entry.attempts + " attempt(s)");
  logChatGPTRecoveryTimeline(
    environment,
    backendFor(id),
    "health",
    `Independent health check passed; recovery resolved after ${entry.attempts} attempt(s).`,
    { sessionId: id },
  );
  save(environment, state);
}

export function recoveryTargetOrder(
  state: RecoveryQueueState,
  _selectedId?: string | null,
): string[] {
  return [...state.targets].sort((a, b) => byPriority(state.failures[a]!, state.failures[b]!));
}

export function beginRecoveryAttempt(
  environment: string,
  id: string,
  action: string,
): number | null {
  const state = readRecoveryQueue(environment);
  const entry = state.failures[id];
  if (
    !entry ||
    !state.targets.includes(id) ||
    (entry.red && id !== state.activeRedId) ||
    Date.now() < (entry.red ? state.redBackoffUntil : state.orangeBackoffUntil)
  )
    return null;
  // Avoid numeric overflow without ever terminating retries.
  entry.attempts = Math.min(
    Number.MAX_SAFE_INTEGER,
    (Number.isSafeInteger(entry.attempts) ? entry.attempts : 0) + 1,
  );
  entry.manualPriority = false;
  entry.awaitingHealthCheck = false;
  entry.lastAttemptAt = Date.now();
  entry.lastOutcome = "dispatched " + action;
  append(state, id, "attempt", action + " #" + entry.attempts + " | priority: " + entry.reason);
  recordChatGPTRecoveryAttemptLog(environment, {
    at: entry.lastAttemptAt,
    kind: "attempt",
    sessionId: id,
    attemptNumber: entry.attempts,
    detail: action,
  });
  logChatGPTRecoveryTimeline(
    environment,
    backendFor(id),
    "attempt",
    `Automatic recovery action dispatched: ${action}; priority ${entry.reason}.`,
    { sessionId: id, attempt: entry.attempts },
  );
  save(environment, state);
  return entry.attempts;
}

export function finishRecoveryAttempt(environment: string, id: string, outcome: string): void {
  const state = readRecoveryQueue(environment);
  if (!state.failures[id]) return;
  state.failures[id]!.awaitingHealthCheck = true;
  state.failures[id]!.lastOutcome = outcome;
  append(state, id, "outcome", outcome);
  recordChatGPTRecoveryAttemptLog(environment, {
    at: Date.now(), kind: "outcome", sessionId: id,
    attemptNumber: state.failures[id]!.attempts, detail: outcome,
  });
  logChatGPTRecoveryTimeline(
    environment,
    backendFor(id),
    "outcome",
    `Browser action settled: ${outcome}. This is not proof ChatGPT recovered.`,
    { sessionId: id, attempt: state.failures[id]!.attempts },
  );
  save(environment, state);
}

export function manuallyRetryRecovery(environment: string, id: string): void {
  const state = readRecoveryQueue(environment);
  const entry = state.failures[id];
  if (!entry) return;
  entry.exhausted = false;
  // Manual priority must not erase real attempt history or existing cooldowns.
  entry.manualPriority = true;
  // Explicit manual retry is the only way to replace a still-failing red pin.
  if (entry.red) state.activeRedId = id;
  entry.lastOutcome = "manual retry requested";
  state.targets = state.targets.filter((target) => target !== id);
  if (state.targets.length >= readChatGPTRecoverySettings().targetCount) state.targets.pop();
  state.targets.unshift(id);
  entry.reason = "manual recovery requested";
  append(state, id, "manual-retry", "Manual retry rearmed and promoted this episode");
  logChatGPTRecoveryTimeline(
    environment,
    backendFor(id),
    "click",
    "User explicitly requested recovery retry; moved to the front of the eligible recovery queue.",
    { sessionId: id },
  );
  save(environment, state);
}
