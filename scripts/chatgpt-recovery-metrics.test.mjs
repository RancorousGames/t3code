import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeRecoveryAggregate } from "./chatgpt-recovery-metrics.mjs";
import { controlSessions } from "./chatgpt-sessions.mjs";

const dist = { n: 0, mean: null, p50: null, p90: null };
const summary = {
  observed: 0,
  partial: 0,
  censored: 0,
  active: 0,
  unknown: 0,
  recovered: 0,
  failed: 0,
  closedKnown: 0,
  successRate: null,
  recoveredDurationMs: dist,
  recoveredAttempts: dist,
  actions: { reload: 0, stop: 0, continue: 0 },
  observedAttempts: dist,
  activeAgeMs: dist,
};
function payload() {
  return {
    availability: "missing",
    observationStartedAt: null,
    retainedStartedAt: null,
    retainedUpdatedAt: null,
    dropped: 0,
    droppedActive: 0,
    observationCoverage: "untracked",
    unobservedPeriods: null,
    censoredByGap: null,
    eligibleEpisodes: 0,
    ...summary,
    byCategory: { red: summary, orange: summary },
    byCause: {
      "load-failure": summary,
      interrupted: summary,
      stalled: summary,
      unknown: summary,
    },
    bySource: {
      automatic: summary,
      manual: summary,
      "lost-route": summary,
      unspecified: summary,
    },
  };
}
test("telemetry-only CLI requests no session, never reads a guest and strips unknown content", async () => {
  const sent = [];
  const raw = {
    ...payload(),
    extra: "PRIVATE CONTENT",
    bySource: {
      ...payload().bySource,
      manual: { ...summary, privateText: "PRIVATE DRAFT" },
    },
  };
  const result = await controlSessions(
    { action: "recovery_metrics" },
    {
      home: ".t3",
      exchange: async (_address, request) => {
        sent.push(request);
        return {
          ok: true,
          data: { action: "recovery_metrics", metrics: raw, messages: "PRIVATE TRANSCRIPT" },
        };
      },
    },
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, "recovery_metrics");
  assert.equal(Object.hasOwn(sent[0], "sessionId"), false);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.deepEqual(result.metrics.bySource.manual, summary);
});
test("telemetry fails closed on older runtimes, wrong responses, unknown schemas and guest-bearing arguments", async () => {
  let contacted = 0;
  const exchange = async () => {
    contacted++;
    return { ok: true, data: { action: "read", messages: [] } };
  };
  await assert.rejects(
    controlSessions({ action: "recovery_metrics", sessionId: "guest" }, { home: ".t3", exchange }),
    /environment-level/,
  );
  await assert.rejects(
    controlSessions({ action: "recovery_metrics", message: "private" }, { home: ".t3", exchange }),
    /environment-level/,
  );
  assert.equal(contacted, 0);
  await assert.rejects(
    controlSessions({ action: "recovery_metrics" }, { home: ".t3", exchange }),
    /telemetry-only/,
  );
  await assert.rejects(
    controlSessions(
      { action: "recovery_metrics" },
      {
        home: ".t3",
        exchange: async () => ({
          ok: true,
          data: { action: "recovery_metrics", metrics: { availability: "available" } },
        }),
      },
    ),
    /telemetry schema/,
  );
  assert.throws(
    () =>
      sanitizeRecoveryAggregate({
        ...payload(),
        bySource: {
          ...payload().bySource,
          automatic: {
            ...summary,
            actions: { reload: 0, stop: 0, continue: "private" },
          },
        },
      }),
    /number/,
  );
});
