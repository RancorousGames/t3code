import type {
  AgentProviderV1Capability,
  AgentProviderV1NativeCaffyBadge,
  AgentProviderV1Session,
} from "@t3tools/contracts";

/** Browser catalogs may claim only capabilities implemented by the desktop bridge. */
export function permittedDesktopBrowserCapability(capability: AgentProviderV1Capability): boolean {
  return capability === "ReadHistory" || capability === "Submit" || capability === "RemoteControl";
}
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
  nativeCaffy: ReadonlyArray<AgentProviderV1NativeCaffyBadge>;
};
export type BrowserWork = {
  jobId: string;
  environmentId: string;
  browserSessionId?: string;
  expectedConversationId?: string;
  action: "history" | "submit" | "create" | "visibility" | "load" | "control" | "native_caffy";
  /** Raw native T3 thread id, for action "native_caffy". */
  nativeThreadId?: string;
  command?: string;
  options?: unknown;
  visibility?: { hidden?: boolean; snoozedUntil?: number | null };
  text?: string;
  delivery?: "WhenIdle" | "WaitForSlot" | "Steer";
  maxActiveWorkers?: number;
  clientRequestId?: string;
  title?: string;
  prompt?: string;
  project?: string;
  parentSessionId?: string;
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
  nativeCaffy: ReadonlyArray<AgentProviderV1NativeCaffyBadge> = [],
): void {
  catalogs.set(connectionId, { environmentId, updatedAt: clockNow(), sessions, nativeCaffy });
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

/** Compact Caffy status is owned by the one live desktop, not the native thread store. */
export function readNativeCaffyBadges(
  environmentId: string,
): ReadonlyMap<string, AgentProviderV1NativeCaffyBadge> {
  const now = clockNow();
  const live = [...catalogs.values()].filter(
    (catalog) => catalog.environmentId === environmentId && now - catalog.updatedAt <= LEASE_MS,
  );
  if (live.length !== 1) return new Map();
  const prefix = `t3:${environmentId}:`;
  return new Map<string, AgentProviderV1NativeCaffyBadge>(
    live[0]!.nativeCaffy
      .filter((item) => item.sessionId.startsWith(prefix))
      .map((item) => [item.sessionId.slice(prefix.length), item]),
  );
}

/** Single-shot desktop handoff. A claimed job is NEVER redelivered on poll retry. */
export function dispatchBrowserWork(
  environmentId: string,
  browserSessionId: string,
  expectedConversationId: string | null,
  action: "history" | "submit" | "visibility" | "load" | "control",
  text?: string,
  options?: {
    delivery?: "WhenIdle" | "WaitForSlot" | "Steer";
    clientRequestId?: string;
    maxActiveWorkers?: number;
    visibility?: { hidden?: boolean; snoozedUntil?: number | null };
    command?: string;
    controlOptions?: unknown;
  },
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
    (action !== "visibility" &&
      action !== "load" &&
      action !== "control" &&
      session.source.conversationId !== expectedConversationId &&
      // A cold guest has no observed conversation; queued delivery will
      // verify the exact requested conversation before touching its composer.
      !(
        action === "submit" &&
        options?.delivery === "WhenIdle" &&
        session.source.conversationId === null
      )) ||
    (action !== "visibility" &&
      action !== "load" &&
      action !== "control" &&
      !session.capabilities.includes(action === "history" ? "ReadHistory" : "Submit")) ||
    (action === "load" &&
      expectedConversationId !== null &&
      session.source.conversationId !== null &&
      session.source.conversationId !== expectedConversationId) ||
    (action === "submit" && !session.deliveryModes.includes(options?.delivery ?? "WhenIdle"))
  )
    return Promise.resolve({
      ok: false,
      code: "ConversationChanged",
      message: "Published browser session or conversation is not eligible.",
    });
  // Closing a session must not be refused because a status/history read is
  // still in flight. The desktop processes the close as the next work item.
  const isClose = action === "control" && options?.command === "close";
  if (
    !isClose &&
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
    ...(expectedConversationId === null ? {} : { expectedConversationId }),
    action,
    ...(text === undefined ? {} : { text }),
    ...(options?.delivery ? { delivery: options.delivery } : {}),
    ...(options?.clientRequestId ? { clientRequestId: options.clientRequestId } : {}),
    ...(options?.maxActiveWorkers ? { maxActiveWorkers: options.maxActiveWorkers } : {}),
    ...(options?.visibility ? { visibility: options.visibility } : {}),
    ...(options?.command ? { command: options.command } : {}),
    ...(options?.controlOptions !== undefined ? { options: options.controlOptions } : {}),
  };
  return new Promise((resolve) => {
    jobs.set(work.jobId, { owner, work, claimed: false, resolve });
    // Never replay after timeout: the desktop might already have pressed Enter.
    Effect.runFork(
      Effect.sleep(
        action === "submit"
          ? SUBMIT_TIMEOUT_MS
          : action === "load"
            ? 35_000
            : action === "control"
              ? 48_000
              : READ_TIMEOUT_MS,
      ).pipe(
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
  const pending = [...jobs.values()].filter(
    (job) => job.owner === connectionId && job.work.environmentId === environmentId && !job.claimed,
  );
  // A requested close takes precedence over unclaimed status/history polls.
  const available =
    pending.find((job) => job.work.action === "control" && job.work.command === "close") ??
    pending[0];
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

/**
 * Creation is bound to exactly one authenticated T3 desktop publisher, not
 * the most recently active browser tab. A claimed job is never redelivered.
 */
export function hasUniqueDesktopCreator(environmentId: string): boolean {
  const now = clockNow();
  return (
    [...catalogs.values()].filter(
      (catalog) => catalog.environmentId === environmentId && now - catalog.updatedAt <= LEASE_MS,
    ).length === 1
  );
}
export function dispatchBrowserCreate(
  environmentId: string,
  input: {
    clientRequestId: string;
    title: string;
    prompt?: string;
    project?: string;
    parentSessionId?: string;
  },
): Promise<BrowserWorkReply | null> {
  const now = clockNow();
  const owners = [...catalogs.entries()].filter(
    ([, catalog]) => catalog.environmentId === environmentId && now - catalog.updatedAt <= LEASE_MS,
  );
  if (owners.length !== 1)
    return Promise.resolve({
      ok: false,
      code: "Unavailable",
      message: "Exactly one authenticated T3 desktop publisher is required for ChatGPT creation.",
    });
  const owner = owners[0]![0];
  const work: BrowserWork = {
    jobId: newId(),
    environmentId,
    action: "create",
    ...input,
  };
  return new Promise((resolve) => {
    jobs.set(work.jobId, { owner, work, claimed: false, resolve });
    Effect.runFork(
      Effect.sleep(105_000).pipe(
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
      jobs.get(work.jobId)!.claimed = true;
      waiter.resolve(work);
    }
  });
}

/**
 * Native T3 thread Caffy (status / caffy_* commands) from a remote client. Caffy is
 * owned by the Electron desktop, so this goes to the single live desktop publisher.
 */
export function dispatchNativeThreadCaffy(
  environmentId: string,
  nativeThreadId: string,
  command: string,
  options: Record<string, unknown>,
): Promise<BrowserWorkReply | null> {
  const now = clockNow();
  const owners = [...catalogs.entries()].filter(
    ([, catalog]) => catalog.environmentId === environmentId && now - catalog.updatedAt <= LEASE_MS,
  );
  if (owners.length !== 1)
    return Promise.resolve({
      ok: false,
      code: "Unavailable",
      message: "Exactly one connected T3 desktop is required for Caffy.",
    });
  const owner = owners[0]![0];
  const work: BrowserWork = {
    jobId: newId(),
    environmentId,
    action: "native_caffy",
    nativeThreadId,
    command,
    options,
  };
  return new Promise((resolve) => {
    jobs.set(work.jobId, { owner, work, claimed: false, resolve });
    Effect.runFork(
      Effect.sleep(command === "status" ? READ_TIMEOUT_MS : 48_000).pipe(
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
      jobs.get(work.jobId)!.claimed = true;
      waiter.resolve(work);
    }
  });
}
