import { assert, describe, it } from "@effect/vitest";
import {
  makeInactiveBoundedObservationGate,
  inactiveFixedIncarnationExpiry,
  makeInactivePrivateServerChannel,
  type PrivateReply,
} from "./ProviderMainPrivateChannel.ts";

const ids = {
  mainRunId: "real-run-1",
  serverGenerationId: "server-generation-1",
  serverChannelIncarnationId: "server-channel-1",
};
const nonce = "X".repeat(43);
const encode = (v: unknown) => Buffer.from(JSON.stringify(v) + "\n", "utf8");
const challenge = (v: Record<string, unknown> = {}) => ({
  type: "challenge",
  version: 1,
  ...ids,
  challengeId: "challenge-1",
  nonce,
  ...v,
});
const request = (v: Record<string, unknown> = {}) => ({
  type: "read_only",
  version: 1,
  ...ids,
  requestId: "req-1",
  operationId: "thread:project:fixture:1",
  ...v,
});

function channel() {
  const sent: PrivateReply[] = [];
  const revoked: string[] = [];
  let clock = 0;
  const instance = makeInactivePrivateServerChannel({
    ...ids,
    openedAtMs: 0,
    now: () => clock,
    output: (reply) => {
      sent.push(reply);
    },
    onRevoke: (reason) => {
      revoked.push(reason);
    },
  });
  return {
    instance,
    sent,
    revoked,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("W2-A synthetic inactive server channel (never native admission)", () => {
  it("one use challenge, bounded fragmented frames, and read-only unavailability", () => {
    const x = channel();
    const bytes = encode(challenge());
    x.instance.ingest(bytes.subarray(0, 9));
    assert.isFalse(x.instance.challengeAcknowledged);
    x.instance.ingest(bytes.subarray(9));
    assert.isTrue(x.instance.challengeAcknowledged);
    assert.deepEqual(x.sent, [
      {
        type: "challenge_ack",
        version: 1,
        ...ids,
        challengeId: "challenge-1",
        nonce,
      },
    ]);
    x.instance.ingest(encode(request()));
    assert.deepEqual(x.sent[1], {
      type: "unavailable",
      version: 1,
      requestId: "req-1",
      operationId: "thread:project:fixture:1",
      reason: "source_not_enrolled",
    });
    x.instance.ingest(encode(challenge()));
    assert.equal(x.instance.failure, "duplicate_challenge");
    assert.isTrue(x.instance.revoked);
    assert.equal(x.sent.length, 2);
  });
  it("rejects wrong generation, nonce, extra fields, and pre-challenge traffic", () => {
    for (const candidate of [
      challenge({ serverGenerationId: "other" }),
      challenge({ nonce: "weak" }),
      challenge({ bonus: "untrusted" }),
      request(),
    ]) {
      const x = channel();
      x.instance.ingest(encode(candidate));
      assert.isTrue(x.instance.revoked);
      assert.equal(x.sent.length, 0);
    }
  });
  it("rejects malformed inner correlation as terminal; never reuses channel", () => {
    for (const wrong of [
      request({ requestId: 0 }),
      request({ operationId: "" }),
      request({ serverChannelIncarnationId: "stale" }),
      request({ extra: true }),
      { ...request(), type: "provider.reserve" },
      null,
    ]) {
      const x = channel();
      x.instance.ingest(encode(challenge()));
      x.instance.ingest(encode(wrong));
      assert.isTrue(x.instance.revoked);
      assert.equal(x.sent.length, 1);
      x.instance.ingest(encode(request()));
      assert.equal(x.sent.length, 1);
    }
  });
  it("rejects replayed read correlation and noncanonical/duplicate-key control JSON", () => {
    const a = channel();
    a.instance.ingest(encode(challenge()));
    a.instance.ingest(encode(request()));
    assert.equal(a.sent.length, 2);
    a.instance.ingest(encode(request()));
    assert.isTrue(a.instance.revoked);
    assert.equal(a.sent.length, 2);
    const b = channel();
    b.instance.ingest(Buffer.from('{"type":"challenge","type":"challenge"}\n'));
    assert.equal(b.instance.failure, "malformed");
    const c = channel();
    c.instance.ingest(Buffer.from(JSON.stringify(challenge()) + " \n"));
    assert.equal(c.instance.failure, "malformed");
  });
  it("pins advisory cancel correlation with not_pending ACK, never claims remote cancellation", () => {
    const x = channel();
    x.instance.ingest(encode(challenge()));
    x.instance.ingest(encode(request()));
    x.instance.ingest(
      encode({
        type: "cancel",
        version: 1,
        ...ids,
        requestId: "cancel-1",
        targetRequestId: "req-1",
        operationId: "thread:project:fixture:1",
      }),
    );
    assert.deepEqual(x.sent[2], {
      type: "cancel_ack",
      version: 1,
      requestId: "cancel-1",
      targetRequestId: "req-1",
      operationId: "thread:project:fixture:1",
      status: "not_pending",
    });
    x.instance.ingest(
      encode({
        type: "cancel",
        version: 1,
        ...ids,
        requestId: "cancel-2",
        targetRequestId: "req-1",
        operationId: "wrong-operation",
      }),
    );
    assert.isTrue(x.instance.revoked);
    assert.equal(x.sent.length, 3);
  });
  it("final accepted control #512 replies then permanently drains/closes without reset", () => {
    const x = channel();
    x.instance.ingest(encode(challenge()));
    for (let n = 0; n < 512; n++) {
      x.instance.ingest(encode(request({ requestId: `req-${n}` })));
      if (n < 511) assert.isFalse(x.instance.revoked);
    }
    assert.equal(x.sent.length, 513);
    assert.equal(x.instance.failure, "exhausted");
    x.instance.ingest(encode(request({ requestId: "req-512" })));
    assert.equal(x.sent.length, 513);
  });
  it("pins no-sliding negative-only maximum 300000ms and earlier cutoff", () => {
    assert.equal(inactiveFixedIncarnationExpiry(1000000), 1300000);
    assert.equal(inactiveFixedIncarnationExpiry(1000000, 1200000), 1200000);
    assert.equal(inactiveFixedIncarnationExpiry(1000000, 1000000), null);
    assert.equal(inactiveFixedIncarnationExpiry(Number.MAX_SAFE_INTEGER), null);
    assert.equal(inactiveFixedIncarnationExpiry(1000000, 1300001), 1300000);
  });
  it("fails closed on invalid utf8, oversize fragments, CR and multiple frames", () => {
    const malformed = [
      new Uint8Array([0xff, 0x0a]),
      Buffer.alloc(4097, 0x61),
      Buffer.from('{"type":"challenge"}\r\n'),
      Buffer.from("not-json\n"),
    ];
    for (const bytes of malformed) {
      const x = channel();
      x.instance.ingest(bytes);
      assert.isTrue(x.instance.revoked);
      assert.equal(x.sent.length, 0);
    }
    const x = channel();
    x.instance.ingest(Buffer.concat([encode(challenge()), encode(request())]));
    assert.equal(x.sent.length, 2);
  });
  it("readiness deadline, EOF and partial frame fail closed; late input does nothing", () => {
    const x = channel();
    x.instance.ingest(Buffer.from('{"partial":'));
    x.advance(5000);
    x.instance.expire();
    assert.equal(x.instance.failure, "deadline");
    x.instance.ingest(encode(challenge()));
    assert.equal(x.sent.length, 0);
    const y = channel();
    y.instance.close();
    assert.equal(y.instance.failure, "closed");
    assert.isTrue(y.instance.revoked);
  });
});

describe("bounded read-only observation with advisory abort and late fencing", () => {
  it("enforces eight slots before any callback dispatch", async () => {
    const gate = makeInactiveBoundedObservationGate(8, 5000);
    const completions: Array<(v: number) => void> = [];
    const ongoing = Array.from({ length: 8 }, (_, i) =>
      gate
        .read(
          () =>
            new Promise<number>((resolve) => {
              completions.push(resolve);
            }),
        )
        .then((result) => ({ i, result })),
    );
    await Promise.resolve();
    assert.equal(gate.pending, 8);
    let extraRan = false;
    assert.deepEqual(
      await gate.read(async () => {
        extraRan = true;
        return 11;
      }),
      { kind: "unavailable", reason: "busy" },
    );
    assert.isFalse(extraRan);
    completions.forEach((fn, i) => fn(i));
    const values = await Promise.all(ongoing);
    assert.equal(values.length, 8);
    assert.equal(gate.pending, 0);
    assert.deepEqual(values[7]?.result, { kind: "value", value: 7 });
  });
  it("advisory abort and late response fencing; no retries; closed gate denies", async () => {
    const gate = makeInactiveBoundedObservationGate(2, 10);
    let resolveLate: ((n: number) => void) | undefined;
    let signal: AbortSignal | undefined;
    let calls = 0;
    const attempt = gate.read((abort) => {
      calls++;
      signal = abort;
      return new Promise<number>((resolve) => {
        resolveLate = resolve;
      });
    });
    const first = await attempt;
    assert.deepEqual(first, { kind: "unavailable", reason: "timeout" });
    assert.isTrue(signal?.aborted);
    resolveLate?.(123);
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(gate.pending, 0);
    gate.close();
    assert.deepEqual(await gate.read(async () => 987), { kind: "unavailable", reason: "closed" });
  });
});
