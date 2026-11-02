// @effect-diagnostics globalDate:off preferSchemaOverJson:off tryCatchInEffectGen:off
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import type {
  ChatGPTRegistryAction,
  ChatGPTRegistryDriver,
  ChatGPTRegistryRecord,
  ChatGPTRegistrySession,
  ChatGPTRegistrySnapshot,
  ChatGPTRegistryTimeline,
  ChatGPTRegistryMetadataPatch,
} from "@t3tools/contracts";

const DRIVER_LEASE_MS = 15_000;
const MAX_SNAPSHOT_TEXT = 2_000;
const MAX_RECORD_BYTES = 48_000;
const MAX_ACTION_BYTES = 16_000;
const DRIVER_ACTIONS = new Set(["read", "send", "when_idle", "answer", "reload", "retry_recovery", "complete", "snooze", "unsnooze"]);

export class ChatGPTDriverUnavailable extends Data.TaggedError("ChatGPTDriverUnavailable")<{
  readonly message: string;
}> {
  constructor(message = "The desktop ChatGPT driver is offline; the action was not queued.") {
    super({ message });
  }
}

export interface RegistryChange {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly record: ChatGPTRegistryRecord;
  readonly snapshot?: ChatGPTRegistrySnapshot | null | undefined;
  readonly timeline?: ChatGPTRegistryTimeline | null | undefined;
  readonly appliedMetadataRevision?: number | undefined;
}

export interface RegistryActionRequest {
  readonly requestId: string;
  readonly environmentId: string;
  readonly sessionId: string;
  readonly actionId: string;
  readonly args: Record<string, unknown>;
}

type RegistryError = SqlError.SqlError | ChatGPTDriverUnavailable;
type RegistryEffect<A> = Effect.Effect<A, RegistryError>;

type SessionRow = {
  environment_id: string; session_id: string; record_json: string;
  snapshot_json: string | null; timeline_json: string | null; metadata_revision: number;
  metadata_patch_json: string; closed_at: number | null; updated_at: number;
};
type DriverRow = { driver_id: string; last_seen_at: number };
type ActionRow = {
  request_id: string; environment_id: string; session_id: string; driver_id: string;
  action_id: string; args_json: string; requested_at: number; dispatched_at: number | null;
  result_json: string | null; resolved_at: number | null;
};

function deriveBootstrapPublicId(record: ChatGPTRegistryRecord): string | null {
  const bootstrap = record.bootstrapIdentity;
  if (!bootstrap || typeof bootstrap !== "object" || Array.isArray(bootstrap)) return null;
  const identity = bootstrap as Record<string, unknown>;
  const publicId = identity.publicId;
  if (identity.state === "mismatch") return null; // Never route a proven wrong-session marker.
  // Preassigned worker IDs are public immediately. Manual/legacy IDs require
  // explicit first-marker registration. The server never invents an alias.
  if (typeof publicId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(publicId)) return null;
  if (identity.state === "registered" ||
      (record.creationOrigin === "backend" && typeof record.spawnRequestId === "string")) {
    return publicId.toLowerCase();
  }
  return null;
}

function fromSession(row: SessionRow): ChatGPTRegistrySession {
  const record = JSON.parse(row.record_json) as ChatGPTRegistryRecord;
  return {
    environmentId: row.environment_id,
    sessionId: row.session_id,
    publicSessionId: deriveBootstrapPublicId(record),
    record,
    snapshot: row.snapshot_json ? JSON.parse(row.snapshot_json) as ChatGPTRegistrySnapshot : null,
    timeline: row.timeline_json ? JSON.parse(row.timeline_json) as ChatGPTRegistryTimeline : null,
    metadataRevision: row.metadata_revision,
    metadataPatch: JSON.parse(row.metadata_patch_json) as ChatGPTRegistryMetadataPatch,
    closedAt: row.closed_at,
    updatedAt: row.updated_at,
  };
}

function fromAction(row: ActionRow): ChatGPTRegistryAction {
  return {
    requestId: row.request_id,
    environmentId: row.environment_id,
    sessionId: row.session_id,
    driverId: row.driver_id,
    actionId: row.action_id,
    args: JSON.parse(row.args_json) as Record<string, unknown>,
    requestedAt: row.requested_at,
    dispatchedAt: row.dispatched_at,
    result: row.result_json ? JSON.parse(row.result_json) as Record<string, unknown> : null,
    resolvedAt: row.resolved_at,
  };
}

/** Renderer-independent persistence. Reads never start guests; actions are one-use
 * receipts bound to the current driver and cannot replay after a crash or reconnect. */
export class ChatGPTSessionRegistry extends Context.Service<
  ChatGPTSessionRegistry,
  {
    readonly list: (environmentId: string) => RegistryEffect<readonly ChatGPTRegistrySession[]>;
    readonly get: (environmentId: string, sessionId: string) => RegistryEffect<ChatGPTRegistrySession | null>;
    readonly patchMetadata: (environmentId: string, sessionId: string, expectedUpdatedAt: number, patch: ChatGPTRegistryMetadataPatch) => RegistryEffect<ChatGPTRegistrySession>;
    readonly driver: (environmentId: string) => RegistryEffect<ChatGPTRegistryDriver>;
    readonly registerDriver: (environmentId: string, driverId: string) => RegistryEffect<void>;
    readonly heartbeat: (environmentId: string, driverId: string) => RegistryEffect<boolean>;
    readonly disconnectDriver: (environmentId: string, driverId: string) => RegistryEffect<void>;
    readonly sync: (driverId: string, changes: readonly RegistryChange[], initial?: boolean) => RegistryEffect<number>;
    readonly closeFromReceipts: (environmentId: string, driverId: string, receipts: readonly { sessionId: string; removedAt: string }[]) => RegistryEffect<number>;
    readonly requestAction: (request: RegistryActionRequest) => RegistryEffect<ChatGPTRegistryAction>;
    readonly takeActions: (environmentId: string, driverId: string, limit?: number) => RegistryEffect<readonly ChatGPTRegistryAction[]>;
    readonly finishAction: (requestId: string, driverId: string, result: Record<string, unknown>) => RegistryEffect<boolean>;
    readonly getAction: (requestId: string) => RegistryEffect<ChatGPTRegistryAction | null>;
  }
>()("t3/chatGPTSessionRegistry") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findDriver = (environmentId: string) =>
    sql<DriverRow>`SELECT driver_id, last_seen_at FROM chatgpt_registry_drivers WHERE environment_id = ${environmentId}`
      .pipe(Effect.map((rows) => rows[0] ?? null));

  const liveDriver = Effect.fn("ChatGPTSessionRegistry.liveDriver")(function* (environmentId: string) {
    const driver = yield* findDriver(environmentId);
    const now = yield* Clock.currentTimeMillis;
    if (!driver || now - driver.last_seen_at >= DRIVER_LEASE_MS) {
      return yield* Effect.fail(new ChatGPTDriverUnavailable());
    }
    return driver.driver_id;
  });

  const retireUndispatched = (environmentId: string, driverId: string, at: number) =>
    sql`
      UPDATE chatgpt_registry_actions
      SET result_json = ${JSON.stringify({ ok: false, status: "desktop_disconnected_before_dispatch" })},
          resolved_at = ${at}
      WHERE environment_id = ${environmentId} AND driver_id = ${driverId}
        AND dispatched_at IS NULL AND resolved_at IS NULL
    `.pipe(Effect.asVoid);

  const getAction = (requestId: string) =>
    Effect.gen(function* () {
      const [row] = yield* sql<ActionRow>`
        SELECT * FROM chatgpt_registry_actions WHERE request_id = ${requestId}
      `;
      if (!row) return null;
      if (row.dispatched_at !== null || row.resolved_at !== null) return fromAction(row);
      const driver = yield* findDriver(row.environment_id);
      const now = yield* Clock.currentTimeMillis;
      if (!driver || driver.driver_id !== row.driver_id ||
          now - driver.last_seen_at >= DRIVER_LEASE_MS) {
        // No desktop ever took this action, and its assigned driver is dead.
        // Resolve the receipt as NOT SENT. A dispatched action stays UNKNOWN.
        yield* retireUndispatched(row.environment_id, row.driver_id, now);
        const [resolved] = yield* sql<ActionRow>`
          SELECT * FROM chatgpt_registry_actions WHERE request_id = ${requestId}
        `;
        return resolved ? fromAction(resolved) : null;
      }
      return fromAction(row);
    });

  const get = (environmentId: string, sessionId: string) =>
    Effect.gen(function* () {
      const exact = yield* sql<SessionRow>`
        SELECT * FROM chatgpt_session_registry
        WHERE environment_id = ${environmentId} AND session_id = ${sessionId}
      `;
      // Read-only external routes accept the canonical Bootstrap ID. The
      // private browser key remains the SQLite primary key because preview
      // hosts and recovery receipts are tied to it.
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) {
        return exact[0] ? fromSession(exact[0]) : null;
      }
      const rows = yield* sql<SessionRow>`
        SELECT * FROM chatgpt_session_registry WHERE environment_id = ${environmentId}
      `;
      const matches = rows.filter((row) =>
        deriveBootstrapPublicId(JSON.parse(row.record_json) as ChatGPTRegistryRecord) === sessionId.toLowerCase());
      // Prefer exact public identities, but refuse ambiguous collisions with
      // an independently existing private browser ID instead of guessing.
      if (matches.length > 1 ||
          (exact[0] && matches.length === 1 && exact[0].session_id !== matches[0]!.session_id)) {
        return null;
      }
      return matches[0] ? fromSession(matches[0]) : exact[0] ? fromSession(exact[0]) : null;
    });

  const patchMetadata = Effect.fn("ChatGPTSessionRegistry.patchMetadata")(function* (environmentId: string, sessionId: string, expectedUpdatedAt: number, requested: ChatGPTRegistryMetadataPatch) {
    const update: Record<string, unknown> = {};
    if (requested.title !== undefined) {
      const title = requested.title.trim().replace(/\s+/gu, " ");
      if (title.length < 3 || title.length > 80) return yield* Effect.fail(new ChatGPTDriverUnavailable("Title must contain 3-80 characters."));
      update.title = title;
      update.titleSource = "user";
    }
    if (requested.project !== undefined) {
      if (requested.project !== null && (requested.project.length > 120 || !requested.project.trim()))
        return yield* Effect.fail(new ChatGPTDriverUnavailable("Invalid project name."));
      update.project = requested.project;
    }
    if (requested.snoozedUntil !== undefined) {
      if (requested.snoozedUntil !== null &&
          (!Number.isFinite(requested.snoozedUntil) || requested.snoozedUntil < 0))
        return yield* Effect.fail(new ChatGPTDriverUnavailable("Invalid snooze end."));
      update.snoozedUntil = requested.snoozedUntil;
    }
    if (Object.keys(update).length === 0)
      return yield* Effect.fail(new ChatGPTDriverUnavailable("No supported metadata changes."));
    return yield* sql.withTransaction(Effect.gen(function* () {
      const [row] = yield* sql<SessionRow>`
        SELECT * FROM chatgpt_session_registry
        WHERE environment_id = ${environmentId} AND session_id = ${sessionId}
      `;
      if (!row || row.closed_at !== null || row.updated_at !== expectedUpdatedAt)
        return yield* Effect.fail(new ChatGPTDriverUnavailable("Session metadata changed. Refresh and retry."));
      const record = JSON.parse(row.record_json) as Record<string, unknown>;
      const cumulative = JSON.parse(row.metadata_patch_json) as Record<string, unknown>;
      for (const [key, value] of Object.entries(update)) {
        if (value === null) delete record[key];
        else record[key] = value;
        cumulative[key] = value;
      }
      const now = Math.max((yield* Clock.currentTimeMillis), row.updated_at + 1);
      yield* sql`
        UPDATE chatgpt_session_registry
        SET record_json = ${JSON.stringify(record)},
            metadata_patch_json = ${JSON.stringify(cumulative)},
            metadata_revision = metadata_revision + 1,
            updated_at = ${now}
        WHERE environment_id = ${environmentId} AND session_id = ${sessionId}
      `;
      return (yield* get(environmentId, sessionId))!;
    }));
  });

  return ChatGPTSessionRegistry.of({
    list: (environmentId) =>
      sql<SessionRow>`SELECT * FROM chatgpt_session_registry WHERE environment_id = ${environmentId} ORDER BY updated_at DESC, session_id`
        .pipe(Effect.map((rows) => rows.map(fromSession))),
    get,
    patchMetadata,
    driver: (environmentId) => Effect.gen(function* () {
      const row = yield* findDriver(environmentId);
      const now = yield* Clock.currentTimeMillis;
      return {
        environmentId, driverId: row?.driver_id ?? null,
        online: !!row && now - row.last_seen_at < DRIVER_LEASE_MS,
        lastSeenAt: row?.last_seen_at ?? null,
      };
    }),
    registerDriver: (environmentId, driverId) =>
      sql.withTransaction(Effect.gen(function* () {
        const previous = yield* findDriver(environmentId);
        const now = yield* Clock.currentTimeMillis;
        if (previous && previous.driver_id !== driverId &&
            now - previous.last_seen_at < DRIVER_LEASE_MS) {
          return yield* Effect.fail(new ChatGPTDriverUnavailable("Another desktop currently owns the ChatGPT guest driver."));
        }
        if (previous && now - previous.last_seen_at >= DRIVER_LEASE_MS) {
          // Even a reconnecting renderer that retains the same driver UUID
          // must not pick up pre-crash unsubmitted messages after lease expiry.
          yield* retireUndispatched(environmentId, previous.driver_id, now);
        }
        yield* sql`
          INSERT INTO chatgpt_registry_drivers (environment_id, driver_id, last_seen_at)
          VALUES (${environmentId}, ${driverId}, ${now})
          ON CONFLICT(environment_id) DO UPDATE
          SET driver_id = excluded.driver_id, last_seen_at = excluded.last_seen_at
        `;
      })),
    heartbeat: (environmentId, driverId) =>
      sql.withTransaction(Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const row = yield* findDriver(environmentId);
        if (!row || row.driver_id !== driverId) return false;
        if (now - row.last_seen_at >= DRIVER_LEASE_MS) {
          // A suspended renderer can resume with its old driver UUID without
          // re-registering. Retire stale NOT-TAKEN requests before renewing.
          yield* retireUndispatched(environmentId, driverId, now);
        }
        const rows = yield* sql`UPDATE chatgpt_registry_drivers SET last_seen_at = ${now}
          WHERE environment_id = ${environmentId} AND driver_id = ${driverId}
          RETURNING environment_id`;
        return rows.length > 0;
      })),
    disconnectDriver: (environmentId, driverId) =>
      sql.withTransaction(Effect.gen(function* () {
        const deleted = yield* sql`DELETE FROM chatgpt_registry_drivers
          WHERE environment_id = ${environmentId} AND driver_id = ${driverId}
          RETURNING environment_id`;
        if (deleted.length) yield* retireUndispatched(environmentId, driverId, yield* Clock.currentTimeMillis);
      })),
    sync: (driverId, changes, initial = false) =>
      sql.withTransaction(Effect.gen(function* () {
        let written = 0;
        for (const change of changes) {
          const owner = yield* liveDriver(change.environmentId);
          if (owner !== driverId) return yield* Effect.fail(new ChatGPTDriverUnavailable("This desktop does not own the ChatGPT driver."));
          if (change.record.id !== change.sessionId || JSON.stringify(change.record).length > MAX_RECORD_BYTES) {
            return yield* Effect.fail(new ChatGPTDriverUnavailable("Invalid ChatGPT session record; no changes saved."));
          }
          const [prior] = yield* sql<SessionRow>`
            SELECT * FROM chatgpt_session_registry
            WHERE environment_id = ${change.environmentId} AND session_id = ${change.sessionId}
          `;
          if (prior?.closed_at !== null && prior !== undefined) continue;
          const serverRevision = prior?.metadata_revision ?? 0;
          const pendingRemotePatch = serverRevision > (change.appliedMetadataRevision ?? 0);
          const acknowledgedPatch = serverRevision > 0 && !pendingRemotePatch;
          // Remote edits win until the desktop confirms it has incorporated the
          // matching revision. A concurrent patch cannot be erased by an older
          // local catalog upload, and an acknowledged patch does not override
          // subsequent genuine desktop edits forever.
          const record: Record<string, unknown> = { ...change.record };
          if (prior && pendingRemotePatch) {
            const overlay = JSON.parse(prior.metadata_patch_json) as Record<string, unknown>;
            for (const [key, value] of Object.entries(overlay)) {
              if (value === null) delete record[key];
              else record[key] = value;
            }
          }
          const now = yield* Clock.currentTimeMillis;
          const json = JSON.stringify(record);
          const cleanSnapshot = change.snapshot ? {
            ...change.snapshot,
            lastUserText: change.snapshot.lastUserText?.slice(0, MAX_SNAPSHOT_TEXT),
            lastAssistantText: change.snapshot.lastAssistantText?.slice(0, MAX_SNAPSHOT_TEXT),
          } : change.snapshot;
          const snapshot = cleanSnapshot === undefined ? null : JSON.stringify(cleanSnapshot);
          // Timeline markers are monotonic evidence, not replaceable local
          // preferences. A dormant desktop profile cannot roll them backward.
          const currentTimeline: Record<string, number> = prior?.timeline_json
            ? JSON.parse(prior.timeline_json) as Record<string, number> : {};
          for (const key of ["active", "refresh", "reboot"] as const) {
            const latest = change.timeline?.[key];
            if (typeof latest === "number" && Number.isFinite(latest) && latest > 0 &&
                latest > (currentTimeline[key] ?? 0)) currentTimeline[key] = latest;
          }
          const timeline = Object.keys(currentTimeline).length ? JSON.stringify(currentTimeline) : null;
          if (initial) {
            yield* sql`
              INSERT OR IGNORE INTO chatgpt_session_registry
              (environment_id, session_id, record_json, snapshot_json, timeline_json, updated_at)
              VALUES (${change.environmentId}, ${change.sessionId}, ${json}, ${snapshot}, ${timeline}, ${now})
            `;
          } else {
            yield* sql`
              INSERT INTO chatgpt_session_registry
              (environment_id, session_id, record_json, snapshot_json, timeline_json, updated_at)
              VALUES (${change.environmentId}, ${change.sessionId}, ${json}, ${snapshot}, ${timeline}, ${now})
              ON CONFLICT(environment_id, session_id) DO UPDATE SET
                record_json = excluded.record_json,
                snapshot_json = CASE
                  WHEN excluded.snapshot_json IS NULL THEN chatgpt_session_registry.snapshot_json
                  WHEN chatgpt_session_registry.snapshot_json IS NULL THEN excluded.snapshot_json
                  WHEN CAST(json_extract(excluded.snapshot_json, '$.observedAt') AS REAL)
                    >= CAST(json_extract(chatgpt_session_registry.snapshot_json, '$.observedAt') AS REAL)
                    THEN excluded.snapshot_json
                  ELSE chatgpt_session_registry.snapshot_json
                END,
                timeline_json = COALESCE(excluded.timeline_json, chatgpt_session_registry.timeline_json),
                metadata_patch_json = CASE WHEN ${acknowledgedPatch ? 1 : 0} = 1
                  THEN '{}' ELSE chatgpt_session_registry.metadata_patch_json END,
                updated_at = MAX(excluded.updated_at, chatgpt_session_registry.updated_at + 1)
            `;
          }
          // Resolve pre-registration messages only when the server has a unique
          // owner for this public ID. Preserve the request ID and FIFO timestamp.
          const registeredPublicId = deriveBootstrapPublicId(record as ChatGPTRegistryRecord);
          if (registeredPublicId) {
            const collisions = yield* sql<SessionRow>`SELECT * FROM chatgpt_session_registry
              WHERE environment_id = ${change.environmentId}`;
            const owners = collisions.filter((candidate) => deriveBootstrapPublicId(
              JSON.parse(candidate.record_json) as ChatGPTRegistryRecord) === registeredPublicId);
            if (owners.length === 1 && owners[0]!.session_id === change.sessionId) {
              const pending = yield* sql<ActionRow>`SELECT * FROM chatgpt_registry_actions
                WHERE environment_id = ${change.environmentId} AND session_id = ${registeredPublicId}
                  AND action_id = 'send' AND dispatched_at IS NULL AND resolved_at IS NULL`;
              for (const action of pending) {
                const args = JSON.parse(action.args_json) as Record<string, unknown>;
                const binding = (record.bootstrapIdentity as { conversationId?: string } | undefined)?.conversationId;
                if (typeof binding !== "string" || !/^[a-f0-9-]{36}$/i.test(binding)) continue;
                if (args.expectedConversationId !== undefined && args.expectedConversationId !== binding) continue;
                args.expectedConversationId = binding;
                yield* sql`UPDATE chatgpt_registry_actions SET session_id = ${change.sessionId},
                  args_json = ${JSON.stringify(args)} WHERE request_id = ${action.request_id}
                    AND dispatched_at IS NULL AND resolved_at IS NULL`;
              }
            }
          }
          written++;
        }
        return written;
      })),
    closeFromReceipts: (environmentId, driverId, receipts) =>
      sql.withTransaction(Effect.gen(function* () {
        if ((yield* liveDriver(environmentId)) !== driverId) {
          return yield* Effect.fail(new ChatGPTDriverUnavailable("The desktop is not the owner of these removals."));
        }
        let closed = 0;
        for (const receipt of receipts.slice(0, 128)) {
          if (!/^[a-f0-9-]{36}$/i.test(receipt.sessionId)) continue;
          const removedAt = Date.parse(receipt.removedAt);
          if (!Number.isFinite(removedAt) || removedAt <= 0 ||
              removedAt > (yield* Clock.currentTimeMillis) + 60_000) continue;
          const rows = yield* sql`
            UPDATE chatgpt_session_registry SET
              closed_at = ${removedAt},
              updated_at = MAX(updated_at + 1, ${removedAt})
            WHERE environment_id = ${environmentId}
              AND session_id = ${receipt.sessionId} AND closed_at IS NULL
            RETURNING session_id
          `;
          closed += rows.length;
          if (rows.length) {
            // A close may race with a queued remote send. Retire only actions
            // that have NOT been taken by the desktop yet; dispatched actions
            // remain UNKNOWN because they might already have produced a turn.
            const resolvedAt = yield* Clock.currentTimeMillis;
            yield* sql`
              UPDATE chatgpt_registry_actions
              SET result_json = ${JSON.stringify({ ok: false, status: "session_closed_before_dispatch" })},
                  resolved_at = ${resolvedAt}
              WHERE environment_id = ${environmentId}
                AND session_id = ${receipt.sessionId}
                AND dispatched_at IS NULL AND resolved_at IS NULL
            `;
          }
        }
        return closed;
      })),
    requestAction: (request) =>
      sql.withTransaction(Effect.gen(function* () {
        if (!/^[a-f0-9-]{36}$/i.test(request.requestId) ||
            !DRIVER_ACTIONS.has(request.actionId) ||
            JSON.stringify(request.args).length > MAX_ACTION_BYTES) {
          return yield* Effect.fail(new ChatGPTDriverUnavailable("Invalid or oversized ChatGPT action; no request queued."));
        }
        // Duplicate request IDs retain their original receipt and are never redispatched.
        const previous = yield* getAction(request.requestId);
        if (previous) {
          const previousTarget = yield* get(previous.environmentId, previous.sessionId);
          const sameTarget = previous.sessionId === request.sessionId ||
            previousTarget?.publicSessionId === request.sessionId.toLowerCase();
          if (previous.environmentId !== request.environmentId ||
              !sameTarget ||
              previous.actionId !== request.actionId ||
              JSON.stringify(previous.args) !== JSON.stringify(request.args)) {
            return yield* Effect.fail(new ChatGPTDriverUnavailable(
              "This request ID belongs to another ChatGPT action; no action queued."));
          }
          return previous;
        }
        const owner = yield* liveDriver(request.environmentId);
        const candidates = yield* sql<SessionRow>`
          SELECT * FROM chatgpt_session_registry WHERE environment_id = ${request.environmentId}
        `;
        // A public Bootstrap UUID is externally routable while the private
        // browser ID still owns the existing webview and recovery fences.
        const publicMatches = candidates.filter((candidate) =>
          deriveBootstrapPublicId(JSON.parse(candidate.record_json) as ChatGPTRegistryRecord) === request.sessionId.toLowerCase());
        if (publicMatches.length > 1) return yield* Effect.fail(new ChatGPTDriverUnavailable(
          "Duplicate Bootstrap public identity. No action queued."));
        const row = publicMatches[0] ? fromSession(publicMatches[0]) :
          yield* get(request.environmentId, request.sessionId);
        if (row && row.closedAt !== null) return yield* Effect.fail(new ChatGPTDriverUnavailable("ChatGPT session is closed; no action queued."));
        // An unknown public T3 ID is a durable reservation, not a send attempt.
        // It cannot be taken until a verified Bootstrap identity arrives in sync.
        if (!row && !["send", "when_idle"].includes(request.actionId)) return yield* Effect.fail(new ChatGPTDriverUnavailable("ChatGPT session is unknown; no action queued."));
        const now = yield* Clock.currentTimeMillis;
        yield* sql`
          INSERT INTO chatgpt_registry_actions
            (request_id, environment_id, session_id, driver_id, action_id, args_json, requested_at)
          VALUES (${request.requestId}, ${request.environmentId}, ${row?.sessionId ?? request.sessionId},
            ${owner}, ${request.actionId}, ${JSON.stringify(request.args)}, ${now})
        `;
        return (yield* getAction(request.requestId))!;
      })),
    takeActions: (environmentId, driverId, limit = 20) =>
      sql.withTransaction(Effect.gen(function* () {
        if ((yield* liveDriver(environmentId)) !== driverId) {
          return yield* Effect.fail(new ChatGPTDriverUnavailable("Wrong or disconnected ChatGPT driver."));
        }
        const now = yield* Clock.currentTimeMillis;
        const rows = yield* sql<ActionRow>`
          SELECT a.* FROM chatgpt_registry_actions a
          INNER JOIN chatgpt_session_registry s
            ON s.environment_id = a.environment_id AND s.session_id = a.session_id
          WHERE a.environment_id = ${environmentId} AND a.driver_id = ${driverId}
            AND a.dispatched_at IS NULL AND a.resolved_at IS NULL AND s.closed_at IS NULL
          ORDER BY requested_at, request_id LIMIT ${Math.min(50, Math.max(1, limit))}
        `;
        for (const row of rows) {
          yield* sql`UPDATE chatgpt_registry_actions SET dispatched_at = ${now}
            WHERE request_id = ${row.request_id} AND dispatched_at IS NULL`;
        }
        return rows.map((row) => fromAction({ ...row, dispatched_at: now }));
      })),
    finishAction: (requestId, driverId, result) =>
      sql.withTransaction(Effect.gen(function* () {
        const action = yield* getAction(requestId);
        if (!action || action.driverId !== driverId || action.resolvedAt !== null || action.dispatchedAt === null) {
          return false;
        }
        yield* sql`UPDATE chatgpt_registry_actions
          SET result_json = ${JSON.stringify(result)}, resolved_at = ${yield* Clock.currentTimeMillis}
          WHERE request_id = ${requestId} AND driver_id = ${driverId} AND resolved_at IS NULL`;
        return true;
      })),
    getAction,
  });
});

export const layer = Layer.effect(ChatGPTSessionRegistry, make);
