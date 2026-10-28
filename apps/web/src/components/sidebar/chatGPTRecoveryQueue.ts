import { getChatGPTSessionPersistedStore } from "../../chatGPTSessionPersistedStore";
import { readChatGPTRecoverySettings } from "../../chatGPTRecoverySettings";
/**
 * Desktop-only recovery scheduling. Session storage deliberately survives React
 * remounts but starts a new diagnostic/retry episode with the next T3 app launch.
 * No message content, drafts or authentication state enters this journal.
 */
export const MAX_RECOVERY_TARGETS = 3;
/** Historical diagnostic marker, NOT a recovery limit. Retries never terminate at this count. */
export const MAX_RECOVERY_ATTEMPTS = 50;

export interface RecoveryQueueEntry {
  id: string;
  reason: string;
  manager: boolean;
  firstSeenAt: number;
  attempts: number;
  lastAttemptAt: number;
  lastOutcome: string;
  /** Legacy persisted marker. Ignored and cleared after upgrade; never blocks retries. */
  exhausted: boolean;
  /** Explicit user-requested queue rearm, not merely the selected tab. */
  manualPriority?: boolean;
  /** Current failing selection outranks all other recovery tiers. */
  selected?: boolean;
  /** Derived only from independently observed interrupted/delivery-timeout work. */
  interrupted?: boolean;
  /** A verified recent interaction; independent of title or collapsed project. */
  recentlyClicked?: boolean;
}

export interface RecoveryQueueEvent {
  at: number;
  id: string;
  kind: "attempt" | "outcome" | "recovered" | "queued" | "preempted" | "exhausted" | "manual-retry";
  detail: string;
  targets: string[];
  queued: string[];
}

export interface RecoveryQueueState {
  targets: string[];
  failures: Record<string, RecoveryQueueEntry>;
  history: RecoveryQueueEvent[];
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
}

const queueKey = (environment: string) => "t3code:chatgpt-browser:recovery-queue:" + environment;
const empty = (): RecoveryQueueState => ({ targets: [], failures: {}, history: [] });

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
/** Five fixed tiers; oldest actual attempt wins within each tier. */
function tier(entry: RecoveryQueueEntry): number {
  if (entry.selected) return -1;
  if (entry.manualPriority) return 0;
  if (entry.manager) return 1;
  if (entry.interrupted) return 2;
  if (entry.recentlyClicked) return 3;
  return 4;
}

function byPriority(a: RecoveryQueueEntry, b: RecoveryQueueEntry): number {
  return (
    tier(a) - tier(b) ||
    a.lastAttemptAt - b.lastAttemptAt ||
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
    .sort(byPriority)
    .map((entry) => entry.id);
}

function fillTargets(state: RecoveryQueueState): void {
  // A target is a scheduling opportunity, not an ownership lock: after an
  // attempt, an older unattempted peer in the same tier must get its turn.
  // The coordinator serializes actual mutations and retains global cooldowns.
  const next = recoveryPriorityOrder(state).slice(0, readChatGPTRecoverySettings().targetCount);
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
  fillTargets(state);
  if (changed || before !== state.targets.join("|")) save(environment, state);
  return state;
}

export function noteRecoveryFailure(
  environment: string,
  id: string,
  reason: string,
  context: RecoveryQueueContext,
): void {
  const state = readRecoveryQueue(environment);
  if (!context.eligibleIds.includes(id) || state.failures[id]) return;
  state.failures[id] = {
    id,
    reason: priorityReason(id, context),
    manager: context.managerIds?.includes(id) ?? false,
    selected: id === context.selectedId,
    firstSeenAt: Date.now(),
    attempts: 0,
    lastAttemptAt: 0,
    lastOutcome: "awaiting verification (" + reason + ")",
    exhausted: false,
    interrupted: context.interruptedIds?.includes(id) ?? false,
    recentlyClicked: id === context.selectedId || (context.recentClicks?.includes(id) ?? false),
  };
  fillTargets(state);
  append(state, id, "queued", reason);
  save(environment, state);
}

export function noteRecoveryVerified(environment: string, id: string): void {
  const state = readRecoveryQueue(environment);
  const entry = state.failures[id];
  if (!entry) return;
  delete state.failures[id];
  state.targets = state.targets.filter((target) => target !== id);
  append(state, id, "recovered", "Health verified after " + entry.attempts + " attempt(s)");
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
  if (!entry || !state.targets.includes(id)) return null;
  // Avoid numeric overflow without ever terminating retries.
  entry.attempts = Math.min(
    Number.MAX_SAFE_INTEGER,
    (Number.isSafeInteger(entry.attempts) ? entry.attempts : 0) + 1,
  );
  entry.manualPriority = false;
  entry.lastAttemptAt = Date.now();
  entry.lastOutcome = "dispatched " + action;
  append(state, id, "attempt", action + " #" + entry.attempts + " | priority: " + entry.reason);
  save(environment, state);
  return entry.attempts;
}

export function finishRecoveryAttempt(environment: string, id: string, outcome: string): void {
  const state = readRecoveryQueue(environment);
  if (!state.failures[id]) return;
  state.failures[id]!.lastOutcome = outcome;
  append(state, id, "outcome", outcome);
  save(environment, state);
}

export function manuallyRetryRecovery(environment: string, id: string): void {
  const state = readRecoveryQueue(environment);
  const entry = state.failures[id];
  if (!entry) return;
  entry.exhausted = false;
  // Manual priority must not erase real attempt history or existing cooldowns.
  entry.manualPriority = true;
  entry.lastOutcome = "manual retry requested";
  state.targets = state.targets.filter((target) => target !== id);
  if (state.targets.length >= readChatGPTRecoverySettings().targetCount) state.targets.pop();
  state.targets.unshift(id);
  entry.reason = "manual recovery requested";
  append(state, id, "manual-retry", "Manual retry rearmed and promoted this episode");
  save(environment, state);
}
