import { describe, expect, it } from "vitest";

import {
  formatKeepAwakeInterval,
  formatKeepAwakeRawValue,
  groupKeepAwakeMonitors,
  keepAwakeHasIssue,
  keepAwakeStatusPresentation,
  type OmniHubKeepAwakeMonitor,
} from "./omniHubKeepAwake.logic";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");

/** Shaped exactly like a desktop IPC projection monitor. */
function monitor(overrides: Partial<OmniHubKeepAwakeMonitor>): OmniHubKeepAwakeMonitor {
  return {
    source: "omnihub-temporary-keep-awake",
    id: "m",
    mandateId: "mandate-1",
    target: {
      id: "f1e7a46e-e467-489d-ba96-9b44bac54e56",
      kind: "t3/chatgpt_browser",
      title: "f1e7a46e-e467-489d-ba96-9b44bac54e56",
      url: null,
      visibility: "visible",
    },
    status: "active",
    activeOrPending: true,
    finalWakePending: false,
    oneShot: false,
    intervalMinutes: 20,
    createdAtMs: null,
    endAtMs: null,
    nextAttemptAtMs: null,
    lastSchedulerTickAtMs: null,
    lastWakeUserTurnAtMs: null,
    lastAssistantAckAtMs: null,
    finalDeliveredAtMs: null,
    wakeAttempts: 0,
    lastDelivery: null,
    lastOutcome: null,
    explanation: "Monitor remains scheduled in OmniHub.",
    ...overrides,
  };
}

describe("groupKeepAwakeMonitors", () => {
  it("files by activeOrPending only, so unknown or final states never read as done", () => {
    const { active, history } = groupKeepAwakeMonitors([
      monitor({ id: "final", status: "final_retrying", finalWakePending: true }),
      monitor({ id: "unknown", status: "unknown" }),
      monitor({ id: "done", status: "completed", activeOrPending: false }),
      monitor({ id: "gone", status: "cancelled", activeOrPending: false }),
    ]);
    expect(active.map((m) => m.id)).toEqual(["final", "unknown"]);
    expect(history.map((m) => m.id)).toEqual(["done", "gone"]);
  });
});

describe("keepAwakeStatusPresentation", () => {
  it("flags final_pending/final_retrying as overdue only after endAtMs", () => {
    const pending = monitor({ status: "final_pending", endAtMs: NOW + 60_000 });
    const overdue = monitor({ status: "final_retrying", finalWakePending: true, endAtMs: NOW - 1 });
    expect(keepAwakeStatusPresentation(pending, NOW).label).toBe("Final wake pending");
    expect(keepAwakeStatusPresentation(overdue, NOW)).toEqual({
      label: "Final wake overdue · retrying",
      tone: "error",
    });
    expect(keepAwakeHasIssue(overdue, NOW)).toBe(true);
  });
});

describe("keepAwakeHasIssue", () => {
  it("flags missing/hidden targets and blocked raw outcomes, not a healthy monitor", () => {
    expect(keepAwakeHasIssue(monitor({}), NOW)).toBe(false);
    expect(
      keepAwakeHasIssue(monitor({ target: { ...monitor({}).target, visibility: "missing" } }), NOW),
    ).toBe(true);
    expect(keepAwakeHasIssue(monitor({ lastDelivery: "blocked_unknown_send" }), NOW)).toBe(true);
  });
});

describe("formatters", () => {
  it("humanizes raw values and minute intervals", () => {
    expect(formatKeepAwakeRawValue("user_turn_observed")).toBe("User turn observed");
    expect(formatKeepAwakeInterval(20)).toBe("20m");
    expect(formatKeepAwakeInterval(90)).toBe("1h 30m");
    expect(formatKeepAwakeInterval(null)).toBe("Not set");
  });
});
