import type { AgentProviderV1Session } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

const clockNow = () => Effect.runSync(Clock.currentTimeMillis);
export const agentProviderEpoch = `ws-${process.pid}-${clockNow()}-${performance.timeOrigin}`;
let jobCounter = 0;
const newId = () => `browser-work:${agentProviderEpoch}:${++jobCounter}`;

type DesktopCatalog = {
  environmentId: string;
  updatedAt: number;
  sessions: ReadonlyArray<AgentProviderV1Session>;
};
export type BrowserWork = {
  jobId: string;
  environmentId: string;
  browserSessionId: string;
  expectedConversationId: string;
  action: "history" | "submit";
  text?: string;
};
export type BrowserWorkReply =
  | { ok: true; data: unknown }
  | {
      ok: false;
      code: "Busy" | "ConversationChanged" | "Unavailable" | "InvalidInput";
      message: string;
    };

const LEASE_MS = 75_000;
const READ_TIMEOUT_MS = 16_000;
const SUBMIT_TIMEOUT_MS = 38_000;
const catalogs = new Map<string, DesktopCatalog>();
const jobs = new Map<
  string,
  {
    owner: string;
    work: BrowserWork;
    claimed: boolean;
    resolve: (value: BrowserWorkReply | null) => void;
  }
>();
const waiters = new Map<
  string,
  {
    resolve: (work: BrowserWork | null) => void;
  }
>();

const liveOwners = (environmentId: string, sessionId: string) => {
  const now = clockNow();
  const found: Array<{ owner: string; session: AgentProviderV1Session }> = [];
  for (const [owner, catalog] of catalogs) {
    if (now - catalog.updatedAt > LEASE_MS) {
      catalogs.delete(owner);
      continue;
    }
    if (catalog.environmentId !== environmentId) continue;
    const entry = catalog.sessions.find((session) => session.ref.id === sessionId);
    if (entry) found.push({ owner, session: entry });
  }
  return found;
};

export function publishDesktopCatalog(
  connectionId: string,
  environmentId: string,
  sessions: ReadonlyArray<AgentProviderV1Session>,
): void {
  catalogs.set(connectionId, { environmentId, updatedAt: clockNow(), sessions });
}

export function disconnectDesktopCatalog(connectionId: string): void {
  catalogs.delete(connectionId);
  const waiter = waiters.get(connectionId);
  if (waiter) {
    waiters.delete(connectionId);
    waiter.resolve(null);
  }
  for (const [id, job] of jobs) {
    if (job.owner !== connectionId) continue;
    jobs.delete(id);
    job.resolve(null);
  }
}

export function readDesktopCatalog(environmentId: string): ReadonlyArray<AgentProviderV1Session> {
  const now = clockNow();
  const merged = new Map<string, AgentProviderV1Session>();
  for (const [owner, catalog] of catalogs) {
    if (now - catalog.updatedAt > LEASE_MS) {
      catalogs.delete(owner);
      continue;
    }
    if (catalog.environmentId !== environmentId) continue;
    for (const session of catalog.sessions) {
      // Collision or desktop handoff is not evidence of a unique live recipient.
      if (liveOwners(environmentId, session.ref.id).length === 1)
        merged.set(session.ref.id, session);
    }
  }
  return [...merged.values()];
}

/** Single-shot desktop handoff. A claimed job is NEVER redelivered on poll retry. */
export function dispatchBrowserWork(
  environmentId: string,
  browserSessionId: string,
  expectedConversationId: string,
  action: BrowserWork["action"],
  text?: string,
): Promise<BrowserWorkReply | null> {
  const owners = liveOwners(environmentId, browserSessionId);
  if (owners.length !== 1)
    return Promise.resolve({
      ok: false,
      code: "Unavailable",
      message: "No unique current desktop publisher owns this exact browser session.",
    });
  const { owner, session } = owners[0]!;
  if (
    session.kind !== "t3/chatgpt" ||
    session.source.browserSessionId !== browserSessionId ||
    session.source.conversationId !== expectedConversationId ||
    !session.capabilities.includes(action === "history" ? "ReadHistory" : "Submit") ||
    (action === "submit" && !session.deliveryModes.includes("WhenIdle"))
  )
    return Promise.resolve({
      ok: false,
      code: "ConversationChanged",
      message: "Published browser session or conversation is not eligible.",
    });
  if (
    [...jobs.values()].some(
      (job) =>
        job.work.browserSessionId === browserSessionId && job.work.environmentId === environmentId,
    )
  )
    return Promise.resolve({
      ok: false,
      code: "Busy",
      message: "Another browser operation is in flight for this exact session.",
    });
  const work: BrowserWork = {
    jobId: newId(),
    environmentId,
    browserSessionId,
    expectedConversationId,
    action,
    ...(text === undefined ? {} : { text }),
  };
  return new Promise((resolve) => {
    jobs.set(work.jobId, { owner, work, claimed: false, resolve });
    // Never replay after timeout: the desktop might already have pressed Enter.
    Effect.runFork(
      Effect.sleep(action === "submit" ? SUBMIT_TIMEOUT_MS : READ_TIMEOUT_MS).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (!jobs.has(work.jobId)) return;
            jobs.delete(work.jobId);
            resolve(null);
          }),
        ),
      ),
    );
    const waiter = waiters.get(owner);
    if (waiter) {
      waiters.delete(owner);
      const job = jobs.get(work.jobId);
      if (job) job.claimed = true;
      waiter.resolve(work);
    }
  });
}

export function takeDesktopWork(
  connectionId: string,
  environmentId: string,
): Promise<BrowserWork | null> {
  const catalog = catalogs.get(connectionId);
  if (
    !catalog ||
    catalog.environmentId !== environmentId ||
    clockNow() - catalog.updatedAt > LEASE_MS
  )
    return Promise.resolve(null);
  const available = [...jobs.values()].find(
    (job) => job.owner === connectionId && job.work.environmentId === environmentId && !job.claimed,
  );
  if (available) {
    available.claimed = true;
    return Promise.resolve(available.work);
  }
  if (waiters.has(connectionId)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const waiter = { resolve };
    waiters.set(connectionId, waiter);
    Effect.runFork(
      Effect.sleep(10_000).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (waiters.get(connectionId) !== waiter) return;
            waiters.delete(connectionId);
            resolve(null);
          }),
        ),
      ),
    );
  });
}

export function finishDesktopWork(
  connectionId: string,
  environmentId: string,
  jobId: string,
  result: BrowserWorkReply,
): boolean {
  const job = jobs.get(jobId);
  if (
    !job ||
    !job.claimed ||
    job.owner !== connectionId ||
    job.work.environmentId !== environmentId
  )
    return false;
  jobs.delete(jobId);
  job.resolve(result);
  return true;
}
