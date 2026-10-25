import { decodeOpenRigReviewGate, safeOpenRigReviewUrl } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  lookupOpenRigReviewGateReceipt,
  openOpenRigReviewGateUrl,
  postOpenRigReviewGateResolve,
} from "./openRig.ts";

const gate = {
  gateQitemId: "qitem-gate-42",
  reviewId: "review-7",
  reviewRevision: "abc123manifestsha",
  authorityVerified: false,
  title: "Hero art pass",
  reviewUrl: "http://localhost:3333/taskboard/review/review-7",
  thumbnailUrl: "http://127.0.0.1:3333/taskboard/thumb/review-7.png",
};
const item = {
  id: "qitem-inbox-1",
  sender: "worker@omni",
  recipient: "human@kernel",
  subject: "Review ready",
  body: "Please review",
  createdAt: "2026-10-24T10:00:00Z",
  state: "blocked",
  requiresAction: true,
  sourceType: "human_gate",
  reviewGate: gate,
};
const inbox = (items: unknown[] = [item]) => ({
  available: true,
  address: "human@kernel",
  addresses: [{ address: "human@kernel", label: "Local operator" }],
  count: items.length,
  truncated: false,
  pendingCount: 0,
  items,
});
const input = {
  destination: "human@kernel" as const,
  qitemId: item.id,
  gateQitemId: gate.gateQitemId,
  reviewId: gate.reviewId,
  reviewRevision: gate.reviewRevision,
  verdict: "approved" as const,
  requestId: "22222222-2222-4222-9222-222222222222",
};
const receipt = {
  version: 1,
  requestId: input.requestId,
  gateQitemId: input.gateQitemId,
  reviewId: input.reviewId,
  reviewRevision: input.reviewRevision,
  verdict: input.verdict,
  status: "recorded",
  gateReleased: true,
  delivery: "queued",
  wakeIntentDurable: true,
};
const links = { available: true, gateQitemId: gate.gateQitemId, gateState: "blocked", resolved: false, link: gate };

/** Routes the fixed MAIN endpoints; counts writes so no test can hide a duplicate POST. */
function daemon(overrides: {
  inbox?: unknown;
  links?: unknown;
  post?: (body: Record<string, unknown>, headers: Record<string, string>) => Response;
  receipt?: () => Response;
}) {
  const calls = { posts: 0, receipts: 0 };
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes("/human-inbox?")) return Response.json(overrides.inbox ?? inbox());
    if (url.endsWith("/taskboard-review-gates/qitem-gate-42") && init.method === "GET")
      return Response.json(overrides.links ?? links);
    if (url.endsWith("/qitem-gate-42/resolve") && init.method === "POST") {
      calls.posts++;
      const handler = overrides.post ?? (() => Response.json(receipt));
      return handler(
        JSON.parse(String(init.body)) as Record<string, unknown>,
        init.headers as Record<string, string>,
      );
    }
    if (url.endsWith(`/qitem-gate-42/receipts/${input.requestId}`)) {
      calls.receipts++;
      return (overrides.receipt ?? (() => Response.json(receipt)))();
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const confirmYes = vi.fn(async () => true);

beforeEach(() => {
  vi.stubEnv("OPENRIG_T3_HUMAN_ANSWER_TOKEN", "test-token-with-at-least-24-characters");
  vi.stubEnv("OPENRIG_AUTH_BEARER_TOKEN", "test-bearer");
  confirmYes.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("review gate decoding", () => {
  it("rejects javascript, off-host and credentialed review URLs", () => {
    expect(safeOpenRigReviewUrl("javascript:alert(1)")).toBeNull();
    expect(safeOpenRigReviewUrl("https://evil.example/review")).toBeNull();
    expect(safeOpenRigReviewUrl("http://user:pw@localhost:3333/x")).toBeNull();
    expect(safeOpenRigReviewUrl("file:///C:/x")).toBeNull();
    expect(safeOpenRigReviewUrl("http://localhost:3333/taskboard")).toBe(
      "http://localhost:3333/taskboard",
    );
    expect(decodeOpenRigReviewGate({ ...gate, reviewUrl: "https://evil.example" })?.reviewUrl).toBeNull();
  });

  it("treats malformed gate bindings as no gate", () => {
    expect(decodeOpenRigReviewGate({ ...gate, gateQitemId: "../admin" })).toBeNull();
    expect(decodeOpenRigReviewGate({ ...gate, reviewRevision: 0 })).toBeNull();
    expect(decodeOpenRigReviewGate({ ...gate, authorityVerified: true })).toBeNull();
    expect(decodeOpenRigReviewGate({ ...gate, reviewRevision: "../bad" })).toBeNull();
  });
});

describe("MAIN review gate release", () => {
  it("missing private token fails closed before any network call", async () => {
    vi.stubEnv("OPENRIG_T3_HUMAN_ANSWER_TOKEN", "");
    const { fetchImpl } = daemon({});
    expect(await postOpenRigReviewGateResolve(input, confirmYes, fetchImpl)).toMatchObject({
      outcome: "not_sent",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(confirmYes).not.toHaveBeenCalled();
  });

  it("refuses forged selections that do not match the current gate, link or recorded verdict", async () => {
    const forged = [
      { ...input, gateQitemId: "qitem-other" },
      { ...input, reviewRevision: "another-revision" },
      { ...input, qitemId: "qitem-not-in-inbox" },
    ];
    for (const attempt of forged) {
      const { fetchImpl, calls } = daemon({});
      expect(await postOpenRigReviewGateResolve(attempt, confirmYes, fetchImpl)).toMatchObject({
        outcome: "not_sent",
      });
      expect(calls.posts).toBe(0);
    }
    const released = daemon({ inbox: inbox([{ ...item, state: "in-progress" }]) });
    expect(await postOpenRigReviewGateResolve(input, confirmYes, released.fetchImpl)).toMatchObject({
      outcome: "not_sent",
    });
    const recorded = daemon({
      inbox: inbox([{ ...item, reviewGate: { ...gate, reviewRevision: "different" } }]),
    });
    expect(await postOpenRigReviewGateResolve(input, confirmYes, recorded.fetchImpl)).toMatchObject({
      outcome: "not_sent",
    });
    const foreignRecipient = daemon({ inbox: inbox([{ ...item, recipient: "human-two@kernel" }]) });
    expect(
      await postOpenRigReviewGateResolve(input, confirmYes, foreignRecipient.fetchImpl),
    ).toMatchObject({ outcome: "not_sent" });
    const unlinked = daemon({ links: { ...links, link: { ...gate, reviewRevision: "wrong-link" } } });
    expect(await postOpenRigReviewGateResolve(input, confirmYes, unlinked.fetchImpl)).toMatchObject({
      outcome: "not_sent",
    });
    for (const run of [released, recorded, foreignRecipient, unlinked]) expect(run.calls.posts).toBe(0);
    expect(confirmYes).not.toHaveBeenCalled();
  });

  it("native cancel sends nothing", async () => {
    const { fetchImpl, calls } = daemon({});
    expect(await postOpenRigReviewGateResolve(input, async () => false, fetchImpl)).toMatchObject({
      outcome: "cancelled",
    });
    expect(calls.posts).toBe(0);
  });

  it("POSTs the exact contract with private headers only after confirmation", async () => {
    const { fetchImpl, calls } = daemon({
      post: (body, headers) => {
        expect(body).toEqual({
          version: 1,
          requestId: input.requestId,
          reviewId: "review-7",
          reviewRevision: gate.reviewRevision,
          verdict: "approved",
        });
        expect(headers["x-openrig-human-answer-token"]).toBe("test-token-with-at-least-24-characters");
        expect(headers["x-openrig-human-intent"]).toBe("t3-desktop-ipc");
        expect(headers.Authorization).toBe("Bearer test-bearer");
        expect(headers.Origin).toBeUndefined();
        expect(headers["X-Forwarded-For"]).toBeUndefined();
        return Response.json(receipt);
      },
    });
    expect(await postOpenRigReviewGateResolve(input, confirmYes, fetchImpl)).toEqual({
      outcome: "released",
      requestId: input.requestId,
      gateQitemId: input.gateQitemId,
      reviewId: input.reviewId,
      reviewRevision: gate.reviewRevision,
      verdict: "approved",
      status: "recorded",
      gateReleased: true,
      delivery: "queued",
  wakeIntentDurable: true,
    });
    expect(confirmYes).toHaveBeenCalledTimes(1);
    expect(calls.posts).toBe(1);
  });

  it("lost or spoofed acknowledgement never re-POSTs; read-only GET reconciles idempotently", async () => {
    const lost = daemon({
      post: () => {
        throw new Error("socket closed after commit");
      },
      receipt: () => Response.json({ ...receipt, status: "idempotent" }),
    });
    expect(await postOpenRigReviewGateResolve(input, confirmYes, lost.fetchImpl)).toMatchObject({
      outcome: "released",
      status: "idempotent",
    });
    expect(lost.calls).toEqual({ posts: 1, receipts: 1 });

    const spoofed = daemon({
      post: () => Response.json({ ...receipt, gateReleased: false }),
      receipt: () => Response.json({ outcome: "unconfirmed" }, { status: 404 }),
    });
    expect(await postOpenRigReviewGateResolve(input, confirmYes, spoofed.fetchImpl)).toMatchObject({
      outcome: "unknown",
    });
    expect(spoofed.calls).toEqual({ posts: 1, receipts: 1 });

    // Repeated reconciliation is read-only and stable.
    const again = daemon({});
    expect(await lookupOpenRigReviewGateReceipt(input, again.fetchImpl)).toMatchObject({
      outcome: "released",
    });
    expect(await lookupOpenRigReviewGateReceipt(input, again.fetchImpl)).toMatchObject({
      outcome: "released",
    });
    expect(again.calls).toEqual({ posts: 0, receipts: 2 });
    const mismatch = daemon({ receipt: () => Response.json({ ...receipt, verdict: "rejected" }) });
    expect(await lookupOpenRigReviewGateReceipt(input, mismatch.fetchImpl)).toMatchObject({
      outcome: "unknown",
    });
  });
});

describe("MAIN review link routing", () => {
  it("opens only the URL MAIN re-read for the selected item", async () => {
    const open = vi.fn(async () => true);
    const { fetchImpl } = daemon({});
    expect(
      await openOpenRigReviewGateUrl(
        { destination: "human@kernel", qitemId: item.id, gateQitemId: gate.gateQitemId },
        open,
        fetchImpl,
      ),
    ).toBe(true);
    expect(open).toHaveBeenCalledWith("http://localhost:3333/taskboard/review/review-7");

    const hostile = daemon({
      inbox: inbox([{ ...item, reviewGate: { ...gate, reviewUrl: "javascript:alert(1)" } }]),
    });
    open.mockClear();
    expect(
      await openOpenRigReviewGateUrl(
        { destination: "human@kernel", qitemId: item.id, gateQitemId: gate.gateQitemId },
        open,
        hostile.fetchImpl,
      ),
    ).toBe(false);
    expect(
      await openOpenRigReviewGateUrl(
        { destination: "human@kernel", qitemId: item.id, gateQitemId: "qitem-forged" },
        open,
        fetchImpl,
      ),
    ).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
