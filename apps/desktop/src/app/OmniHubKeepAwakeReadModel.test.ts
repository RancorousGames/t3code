import { describe, expect, it, vi } from "vite-plus/test";
import {
  projectOmniHubKeepAwakeSnapshot,
  readLocalOmniHubKeepAwake,
} from "./OmniHubKeepAwakeReadModel.ts";

const now = Date.parse("2026-10-26T04:00:00+01:00");
const sid = "75a6ef99-1f30-4ac3-afe2-4ced0ad7a849";
const id = "bdbfebdc-6b8b-45c8-8d64-956d5acf2d26";
const monitor = (overrides: Record<string, unknown> = {}) => ({
  id,
  token: "PRIVATE_CONTROL_TOKEN_NOT_FOR_UI",
  ackToken: "PRIVATE_ACK_TOKEN_NOT_FOR_UI",
  mandateId: "omniwork-autowork-4h-20261026-0153",
  target: { kind: "t3/chatgpt_browser", sessionId: sid, expectedConversationId: "abcdef" },
  state: "active",
  intervalMinutes: 20,
  createdAtMs: now - 2_000_000,
  expiresAtMs: now + 1_000_000,
  nextDueMs: now + 60_000,
  wakeAttempts: 3,
  lastOutcome: "registered_no_initial_send",
  lastDelivery: null,
  lastObservation: { status: "confirmed_idle", atMs: now - 10_000 },
  schedulerTickCount: 3,
  lastSchedulerTickAtMs: now - 10_000,
  ...overrides,
});
const snapshot = (...items: ReturnType<typeof monitor>[]) => ({
  version: 1,
  receipts: { "hidden-key": { controlToken: "PRIVATE_RECEIPT" } },
  events: [{ controlToken: "PRIVATE_EVENT" }],
  monitors: Object.fromEntries(items.map((item) => [item.id, item])),
});
const sessions = [
  {
    id: sid,
    kind: "t3/chatgpt_browser" as const,
    title: "Omni Coordinator",
    url: "https://chatgpt.com/c/6adeb35c-2c48-83ed-a173-fdaf93cb9f14",
  },
];

describe("OmniHub temporary keep-awake read-only projection", () => {
  it("uses the OmniHub source and exact registered T3 session title/link", () => {
    const result = projectOmniHubKeepAwakeSnapshot(snapshot(monitor()), now, sessions);
    expect(result.availability).toBe("ok");
    const row = result.monitors[0]!;
    expect(row).toMatchObject({
      source: "omnihub-temporary-keep-awake",
      id,
      status: "active",
      activeOrPending: true,
      finalWakePending: false,
      intervalMinutes: 20,
      nextAttemptAtMs: now + 60_000,
      lastSchedulerTickAtMs: now - 10_000,
      target: { id: sid, title: "Omni Coordinator", url: sessions[0]!.url, visibility: "visible" },
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|controlToken|ackToken|receipts|events/i);
  });

  it("keeps overdue final wake active, even after delivery or with exhausted legacy attempts", () => {
    const old = monitor({
      expiresAtMs: now - 600_000,
      finalStartedAtMs: now - 500_000,
      finalDeliveredAtMs: now - 200_000,
      maxWakeAttempts: 1,
      wakeAttempts: 15,
      lastOutcome: "not_ready_retry_scheduled: UNKNOWN send blocked",
      lastDelivery: "unknown_after_send_transport",
      lastObservation: { status: "unavailable", reason: "Unrelated UNKNOWN send" },
    });
    const result = projectOmniHubKeepAwakeSnapshot(snapshot(old), now, sessions);
    const row = result.monitors[0]!;
    expect(row.status).toBe("final_retrying");
    expect(row.finalWakePending).toBe(true);
    expect(row.activeOrPending).toBe(true);
    expect(row.nextAttemptAtMs).toBe(now + 60_000);
    expect(row.explanation).toContain("UNKNOWN");
    expect(row.finalDeliveredAtMs).toBe(now - 200_000);
  });

  it("keeps final wake pending when expiry elapsed but scheduler has not ticked", () => {
    const row = projectOmniHubKeepAwakeSnapshot(
      snapshot(
        monitor({
          expiresAtMs: now - 1000,
          finalStartedAtMs: null,
          lastOutcome: "registered_no_initial_send",
        }),
      ),
      now,
      sessions,
    ).monitors[0]!;
    expect(row.status).toBe("final_pending");
    expect(row.activeOrPending).toBe(true);
  });

  it("classifies retrying, indeterminate, canceled and completed independently", () => {
    const monitors = [
      monitor({ id: "retry", lastOutcome: "not_ready_retry_scheduled: busy" }),
      monitor({ id: "indeterminate", state: "paused_indeterminate", expiresAtMs: now - 100 }),
      monitor({ id: "canceled", state: "cancelled", expiresAtMs: now - 100 }),
      monitor({ id: "done", state: "completed", expiresAtMs: now - 100 }),
      monitor({ id: "unknown", state: "mystery", expiresAtMs: now - 100 }),
    ];
    const rows = projectOmniHubKeepAwakeSnapshot(snapshot(...monitors), now, sessions).monitors;
    const find = (key: string) => rows.find((item) => item.id === key)!;
    expect(find("retry").status).toBe("retrying");
    expect(find("indeterminate")).toMatchObject({
      status: "needs_attention",
      activeOrPending: true,
      finalWakePending: true,
      nextAttemptAtMs: null,
    });
    expect(find("canceled")).toMatchObject({
      status: "cancelled",
      activeOrPending: false,
      finalWakePending: false,
    });
    expect(find("done")).toMatchObject({ status: "completed", activeOrPending: false });
    expect(find("unknown")).toMatchObject({ status: "unknown", activeOrPending: true });
    expect(rows[0]!.activeOrPending).toBe(true);
  });

  it("distinguishes hidden and missing exact targets, without inventing URLs", () => {
    const hidden = projectOmniHubKeepAwakeSnapshot(snapshot(monitor()), now, [
      { ...sessions[0]!, hidden: true },
    ]).monitors[0]!;
    expect(hidden.target.visibility).toBe("hidden");
    expect(hidden.explanation).toContain("hidden/unloaded");

    const missing = projectOmniHubKeepAwakeSnapshot(snapshot(monitor()), now, []).monitors[0]!;
    expect(missing.target).toMatchObject({ title: sid, url: null, visibility: "missing" });
    expect(missing.explanation).toContain("absent");

    const unchecked = projectOmniHubKeepAwakeSnapshot(snapshot(monitor()), now).monitors[0]!;
    expect(unchecked.target.visibility).toBe("unchecked");
    expect(unchecked.explanation).not.toContain("absent");

    const badUrl = projectOmniHubKeepAwakeSnapshot(snapshot(monitor()), now, [
      { ...sessions[0]!, url: "https://evil.example/c/abc" },
    ]).monitors[0]!;
    expect(badUrl.target.url).toBeNull();
  });

  it("only marks absent targets missing when their kind was enumerated", () => {
    const native = monitor({ target: { kind: "t3/native_thread", sessionId: sid } });
    const browserOnly = projectOmniHubKeepAwakeSnapshot(
      snapshot(native),
      now,
      sessions,
      ["t3/chatgpt_browser"],
    ).monitors[0]!;
    expect(browserOnly.target.visibility).toBe("unchecked");
    expect(browserOnly.explanation).not.toContain("absent");
    const nativeChecked = projectOmniHubKeepAwakeSnapshot(
      snapshot(native),
      now,
      sessions,
      ["t3/chatgpt_browser", "t3/native_thread"],
    ).monitors[0]!;
    expect(nativeChecked.target.visibility).toBe("missing");
  });

  it("fails closed on invalid store or invalid monitor instead of reporting zero active", () => {
    expect(projectOmniHubKeepAwakeSnapshot({ version: 2, monitors: {} }, now).availability).toBe(
      "unavailable",
    );
    expect(
      projectOmniHubKeepAwakeSnapshot({ version: 1, monitors: { fake: { state: "active" } } }, now)
        .availability,
    ).toBe("unavailable");
  });

  it("reads the owner file only and returns a redacted projection without mutations", async () => {
    const readText = vi.fn(async () => JSON.stringify(snapshot(monitor())));
    const result = await readLocalOmniHubKeepAwake({
      localAppData: "C:/Local",
      nowMs: now,
      readText,
      sessions,
    });
    expect(readText).toHaveBeenCalledWith(
      expect.stringMatching(/OmniHub[\\/]temporary-keep-awake-v1\.json$/),
    );
    expect(result.availability).toBe("ok");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CONTROL_TOKEN");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_ACK_TOKEN");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_RECEIPT");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_EVENT");
  });

  it("shows an unavailable state on read failure instead of falsely declaring completion", async () => {
    const result = await readLocalOmniHubKeepAwake({
      localAppData: "C:/not-found",
      nowMs: now,
      readText: async () => {
        throw new Error("ACCESS DENIED");
      },
    });
    expect(result).toMatchObject({ availability: "unavailable", monitors: [] });
    expect("error" in result && result.error).toContain("Unable to read");
  });
});
