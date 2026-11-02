import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "./persistence/Sqlite.ts";
import * as Registry from "./chatGPTSessionRegistry.ts";

const testLayer = Registry.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

describe("ChatGPTSessionRegistry", () => {
  it.effect("keeps migrated sessions readable after the driver disconnects, without dispatching actions offline", () =>
    Effect.gen(function* () {
      const registry = yield* Registry.ChatGPTSessionRegistry;
      const environmentId = "env-1";
      const sessionId = "00000000-0000-4000-8000-000000000010";
      yield* registry.registerDriver(environmentId, "driver-1");
      assert.isTrue((yield* registry.driver(environmentId)).online);
      assert.isTrue(yield* registry.heartbeat(environmentId, "driver-1"));

      const change: Registry.RegistryChange = {
        environmentId, sessionId,
        record: { id: sessionId, title: "Working", parentSessionId: "parent-123", snoozedUntil: 100 },
        snapshot: { contentHash: "abc", observedAt: 101, lastAssistantText: "Current work" },
        timeline: { active: 1000, refresh: 1200, reboot: 1500 },
      };
      yield* registry.sync("driver-1", [change], true);
      // First-upload migration is idempotent and cannot overwrite newer edits.
      yield* registry.sync("driver-1", [{ ...change, record: { id: sessionId, title: "Old" } }], true);
      assert.strictEqual((yield* registry.get(environmentId, sessionId))?.record.title, "Working");
      assert.strictEqual((yield* registry.list(environmentId)).length, 1);
      yield* registry.sync("driver-1", [{ ...change,
        snapshot: { contentHash: "older", observedAt: 99, lastAssistantText: "Outdated" },
        timeline: { active: 10, refresh: 11 },
      }], false);
      assert.strictEqual((yield* registry.get(environmentId, sessionId))?.snapshot?.lastAssistantText, "Current work");
      assert.deepStrictEqual((yield* registry.get(environmentId, sessionId))?.timeline,
        { active: 1000, refresh: 1200, reboot: 1500 });

      yield* registry.disconnectDriver(environmentId, "driver-1");
      assert.isFalse((yield* registry.driver(environmentId)).online);
      const offline = yield* Effect.exit(registry.requestAction({
        requestId: "00000000-0000-4000-8000-000000000001", environmentId, sessionId, actionId: "reload", args: {},
      }));
      assert.isTrue(Exit.isFailure(offline));
      assert.strictEqual((yield* registry.getAction("00000000-0000-4000-8000-000000000001")), null);
      assert.strictEqual((yield* registry.get(environmentId, sessionId))?.snapshot?.lastAssistantText, "Current work");
      assert.deepStrictEqual((yield* registry.get(environmentId, sessionId))?.timeline, { active: 1000, refresh: 1200, reboot: 1500 });
      const beforePatch = (yield* registry.get(environmentId, sessionId))!;
      const patched = yield* registry.patchMetadata(environmentId, sessionId, beforePatch.updatedAt,
        { title: "New remote title", snoozedUntil: 8000, project: "T3 Code" });
      assert.strictEqual(patched.record.title, "New remote title");
      assert.strictEqual(patched.metadataRevision, 1);
      assert.deepStrictEqual(patched.metadataPatch, {
        title: "New remote title", titleSource: "user", snoozedUntil: 8000, project: "T3 Code",
      });
      assert.isTrue(Exit.isFailure(yield* Effect.exit(registry.patchMetadata(
        environmentId, sessionId, beforePatch.updatedAt, { title: "Stale" }))));
      yield* registry.registerDriver(environmentId, "driver-2");
      // A reconnecting desktop with an old local catalog may not erase a
      // server-side rename, even with a normal (non-initial) sync.
      yield* registry.sync("driver-2", [change], false);
      assert.strictEqual((yield* registry.get(environmentId, sessionId))?.record.title, "New remote title");
      assert.strictEqual((yield* registry.get(environmentId, sessionId))?.metadataRevision, 1);
      const acked = {
        ...change,
        record: { ...change.record, title: "New remote title", titleSource: "user",
          snoozedUntil: 8000, project: "T3 Code" },
        appliedMetadataRevision: 1,
      };
      yield* registry.sync("driver-2", [acked], false);
      assert.deepStrictEqual((yield* registry.get(environmentId, sessionId))?.metadataPatch, {});
      yield* registry.sync("driver-2", [{
        ...acked, record: { ...acked.record, title: "Edited on desktop" },
      }], false);
      assert.strictEqual((yield* registry.get(environmentId, sessionId))?.record.title, "Edited on desktop");
      // A second server change racing with the desktop cannot be lost to a
      // previously acknowledged revision.
      const beforeSecondPatch = (yield* registry.get(environmentId, sessionId))!;
      const secondPatch = yield* registry.patchMetadata(environmentId, sessionId,
        beforeSecondPatch.updatedAt, { title: "Remote again" });
      assert.strictEqual(secondPatch.metadataRevision, 2);
      yield* registry.sync("driver-2", [acked], false);
      assert.strictEqual((yield* registry.get(environmentId, sessionId))?.record.title, "Remote again");
      yield* registry.sync("driver-2", [{
        ...acked, appliedMetadataRevision: 2,
        record: { ...acked.record, title: "Remote again" },
      }], false);
      assert.deepStrictEqual((yield* registry.get(environmentId, sessionId))?.metadataPatch, {});
      const pendingRequestId = "00000000-0000-4000-8000-000000000012";
      yield* registry.requestAction({
        requestId: pendingRequestId, environmentId, sessionId, actionId: "reload", args: {},
      });
      assert.strictEqual(yield* registry.closeFromReceipts(environmentId, "driver-2", [
        { sessionId, removedAt: "1970-01-01T00:00:00.001Z" },
      ]), 1);
      assert.strictEqual(yield* registry.closeFromReceipts(environmentId, "driver-2", [
        { sessionId, removedAt: "1970-01-01T00:00:00.001Z" },
      ]), 0);
      assert.isNotNull((yield* registry.get(environmentId, sessionId))?.closedAt);
      assert.deepStrictEqual((yield* registry.getAction(pendingRequestId))?.result,
        { ok: false, status: "session_closed_before_dispatch" });
      assert.strictEqual((yield* registry.takeActions(environmentId, "driver-2")).length, 0);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(registry.requestAction({
        requestId: "00000000-0000-4000-8000-000000000011",
        environmentId, sessionId, actionId: "reload", args: {},
      }))));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("queues an unregistered T3 ID and releases it only after unique Bootstrap registration", () =>
    Effect.gen(function* () {
      const registry = yield* Registry.ChatGPTSessionRegistry;
      const env = "pending-new-id";
      const publicId = "00000000-0000-4000-8000-000000000080";
      const privateId = "00000000-0000-4000-8000-000000000081";
      const conversationId = "00000000-0000-4000-8000-000000000082";
      const requestId = "00000000-0000-4000-8000-000000000083";
      yield* registry.registerDriver(env, "driver-pending");
      const original = yield* registry.requestAction({ requestId, environmentId: env,
        sessionId: publicId, actionId: "send", args: { message: "pending" } });
      assert.strictEqual(original.sessionId, publicId);
      assert.strictEqual((yield* registry.takeActions(env, "driver-pending")).length, 0);
      yield* registry.sync("driver-pending", [{ environmentId: env, sessionId: privateId,
        record: { id: privateId, title: "New worker", creationOrigin: "manual",
          bootstrapIdentity: { state: "registered", publicId, conversationId } },
      }]);
      const pending = yield* registry.getAction(requestId);
      assert.strictEqual(pending?.sessionId, privateId);
      assert.strictEqual(pending?.args.expectedConversationId, conversationId);
      const taken = yield* registry.takeActions(env, "driver-pending");
      assert.strictEqual(taken.length, 1);
      assert.strictEqual(taken[0]?.requestId, requestId);
      assert.strictEqual((yield* registry.takeActions(env, "driver-pending")).length, 0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("dispatches each action once and binds the receipt to its original driver", () =>
    Effect.gen(function* () {
      const registry = yield* Registry.ChatGPTSessionRegistry;
      yield* registry.registerDriver("env-2", "driver-a");
      yield* registry.sync("driver-a", [{
        environmentId: "env-2", sessionId: "session-1",
        record: { id: "session-1", title: "Testing" },
      }]);
      const privateId = "00000000-0000-4000-8000-000000000020";
      const publicId = "00000000-0000-4000-8000-000000000021";
      yield* registry.sync("driver-a", [{
        environmentId: "env-2", sessionId: privateId,
        record: { id: privateId, title: "Registered manual ChatGPT", creationOrigin: "manual",
          bootstrapIdentity: { state: "registered", publicId, conversationId: "00000000-0000-4000-8000-000000000099" } },
      }]);
      assert.strictEqual((yield* registry.get("env-2", privateId))?.publicSessionId, publicId);
      assert.strictEqual((yield* registry.get("env-2", publicId))?.sessionId, privateId);
      const mismatchId = "00000000-0000-4000-8000-000000000033";
      yield* registry.sync("driver-a", [{
        environmentId: "env-2", sessionId: mismatchId,
        record: { id: mismatchId, title: "Mismatched", creationOrigin: "backend", spawnRequestId: "request-1",
          bootstrapIdentity: { publicId: mismatchId, state: "mismatch", reportedId: publicId } },
      }]);
      assert.isNull((yield* registry.get("env-2", mismatchId))?.publicSessionId ?? null);
      const publicAction = yield* registry.requestAction({
        requestId: "00000000-0000-4000-8000-000000000022", environmentId: "env-2",
        sessionId: publicId, actionId: "reload", args: {},
      });
      assert.strictEqual(publicAction.sessionId, privateId);
      assert.strictEqual((yield* registry.takeActions("env-2", "driver-a")).length, 1);
      const req = { requestId: "00000000-0000-4000-8000-000000000002", environmentId: "env-2",
        sessionId: "session-1", actionId: "reload", args: {} };
      yield* registry.requestAction(req);
      yield* registry.requestAction(req);
      const collision = yield* Effect.exit(registry.requestAction({ ...req, actionId: "send", args: { message: "wrong", expectedConversationId: "x" } }));
      assert.isTrue(Exit.isFailure(collision));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(registry.requestAction({
        ...req, requestId: "00000000-0000-4000-8000-000000000013", actionId: "hide",
      }))));
      assert.strictEqual((yield* registry.takeActions("env-2", "driver-a")).length, 1);
      assert.strictEqual((yield* registry.takeActions("env-2", "driver-a")).length, 0);
      assert.isFalse(yield* registry.finishAction("00000000-0000-4000-8000-000000000002", "another-driver", { ok: true }));
      assert.isTrue(yield* registry.finishAction("00000000-0000-4000-8000-000000000002", "driver-a", { ok: true }));
      assert.isFalse(yield* registry.finishAction("00000000-0000-4000-8000-000000000002", "driver-a", { ok: false }));
      const receipt = yield* registry.getAction("00000000-0000-4000-8000-000000000002");
      assert.deepStrictEqual(receipt?.result, { ok: true });
      assert.isNotNull(receipt?.dispatchedAt);

      const strandedId = "00000000-0000-4000-8000-000000000004";
      yield* registry.requestAction({ ...req, requestId: strandedId });
      // A desktop can reconnect with the SAME driver ID after a dropped
      // socket. Its prior lease has expired and pending work must not replay.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE chatgpt_registry_drivers SET last_seen_at = -100000000000 WHERE environment_id = ${"env-2"}`;
      assert.deepStrictEqual((yield* registry.getAction(strandedId))?.result,
        { ok: false, status: "desktop_disconnected_before_dispatch" });
      yield* registry.registerDriver("env-2", "driver-a");
      yield* registry.disconnectDriver("env-2", "driver-a");
      assert.deepStrictEqual((yield* registry.getAction(strandedId))?.result,
        { ok: false, status: "desktop_disconnected_before_dispatch" });
      // The first public action was taken before disconnect, so its delivery
      // remains UNKNOWN rather than being falsely declared unsent.
      assert.isNull((yield* registry.getAction("00000000-0000-4000-8000-000000000022"))?.result ?? null);
      yield* registry.registerDriver("env-2", "driver-b");
      const other = yield* registry.requestAction({
        ...req, requestId: "00000000-0000-4000-8000-000000000003", actionId: "reload",
      });
      assert.strictEqual(other.driverId, "driver-b");
      assert.strictEqual((yield* registry.takeActions("env-2", "driver-a").pipe(Effect.exit))._tag, "Failure");
      assert.strictEqual((yield* registry.takeActions("env-2", "driver-b")).length, 1);
      const suspendedId = "00000000-0000-4000-8000-000000000005";
      yield* registry.requestAction({ ...req, requestId: suspendedId });
      yield* sql`UPDATE chatgpt_registry_drivers SET last_seen_at = -100000000000 WHERE environment_id = ${"env-2"}`;
      assert.isTrue(yield* registry.heartbeat("env-2", "driver-b"));
      assert.deepStrictEqual((yield* registry.getAction(suspendedId))?.result,
        { ok: false, status: "desktop_disconnected_before_dispatch" });
      assert.strictEqual((yield* registry.takeActions("env-2", "driver-b")).length, 0);
    }).pipe(Effect.provide(testLayer)),
  );
});
