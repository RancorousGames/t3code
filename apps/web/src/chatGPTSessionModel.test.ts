import { describe, expect, it } from "vitest";
import {
  deriveChatGPTSession,
  matchesChatGPTSessionWhich,
  type RawChatGPTSessionSignals,
} from "./chatGPTSessionModel";

const NOW = 100 * 60_000;
const derive = (signals: RawChatGPTSessionSignals) => deriveChatGPTSession(signals, NOW);

describe("ChatGPT session model", () => {
  it.each([
    ["working", "working", "none", "working"],
    ["recent", "idle", "none", "recently_stopped"],
    ["inactive", "idle", "none", "idle"],
    ["interrupted", "interrupted", "none", "needs_you"],
    ["invalid", "failed", "error", "needs_you"],
    ["unknown", "unknown", "none", "idle"],
  ] as const)("maps %s age to the independent axes", (age, activity, attention, bucket) => {
    const model = derive({ age, lastWorkingAt: age === "recent" ? NOW - 30_000 : 0 });
    expect([model.activity, model.attention, model.bucket]).toEqual([activity, attention, bucket]);
  });

  it("uses actual guest presence for stale idle states while retaining work and errors", () => {
    for (const age of ["recent", "inactive", "unknown"] as const) {
      expect(derive({ age, attached: false }).residency).toBe("unloaded");
      expect(derive({ age, attached: true }).residency).toBe("loaded");
    }
    expect(derive({ age: "working", attached: false }).compatibilityAge).toBe("working");
    expect(derive({ age: "invalid", attached: false }).attention).toBe("error");
    expect(derive({ age: "unknown", status: "working", attached: false }).activity).toBe("working");
    expect(derive({ age: "unknown", status: "unavailable", attached: false }).attention).toBe("error");
  });

  it("treats an attached guest as loaded despite stale lifecycle signals", () => {
    for (const signals of [
      { hibernated: true }, { status: "hibernated" }, { unloaded: true },
      { status: "unloaded" }, { loading: true }, { warm: true },
    ]) {
      expect(derive({ ...signals, attached: true }).residency).toBe("loaded");
    }
    const stale = derive({ attached: true, age: "unloaded", label: "ChatGPT browser unloaded" });
    expect([stale.residency, stale.compatibilityAge, stale.statusLine]).toEqual(
      ["loaded", "unknown", "ChatGPT status unknown"],
    );
    expect(derive({ attached: false, age: "inactive" }).residency).toBe("unloaded");
    expect(derive({ attached: true, hidden: true }).residency).toBe("hidden");
    expect(derive({ attached: true, snoozedUntil: NOW + 1 }).residency).toBe("snoozed");
    expect(derive({ attached: true, hibernated: true, age: "working" }).activity).toBe("working");
    expect(derive({ attached: true, unloaded: true, age: "invalid" }).attention).toBe("error");
    expect(derive({ attached: true, age: "unloaded", status: "unavailable" }).attention).toBe("error");
  });

  it("maps transcript status, uncertain send and browser needs without losing priority", () => {
    expect(derive({ status: "waiting_for_input" }).attention).toBe("question");
    expect(derive({ status: "conversation_full" }).attention).toBe("conversation_full");
    expect(derive({ browserUnavailable: true }).attention).toBe("needs_browser");
    expect(derive({
      status: "unavailable", uncertainSend: true, age: "delivery-timeout",
    }).attention).toBe("unconfirmed_send");
    expect(derive({
      recovery: { stoppedReason: "exhausted" },
    }).attention).toBe("recovery_stopped");
  });

  it("preserves the saved interruption stage for sidebar recovery diagnostics", () => {
    expect(derive({ age: "interrupted", recovery: { orangeStage: "observe_only" } })
      .recovery.orangeStage).toBe("observe_only");
    expect(derive({ age: "interrupted" }).recovery.orangeStage).toBeNull();
  });

  it("applies the exact hidden, completion, attention, snooze, work, recent, idle order", () => {
    expect(derive({ hidden: true, uncertainSend: true, completionValid: true }).bucket).toBeNull();
    expect(derive({ completionValid: true, uncertainSend: true }).bucket).toBe("completed");
    expect(derive({ snoozedUntil: NOW + 1, age: "interrupted" }).bucket).toBe("needs_you");
    expect(derive({ snoozedUntil: NOW + 1 }).bucket).toBe("snoozed");
    expect(derive({ age: "working" }).bucket).toBe("working");
    expect(derive({ age: "inactive", lastWorkingAt: NOW - 15 * 60_000 }).bucket).toBe("idle");
    expect(derive({ age: "recent", lastWorkingAt: NOW + 1 }).bucket).toBe("idle");
  });

  it("retains the original MCP which-filter membership, including hidden exclusion", () => {
    const ages = ["working", "recent", "inactive", "invalid", "interrupted", "delivery-timeout"] as const;
    const matches = (which: "recent" | "working" | "blocked") => ages.filter(
      (age) => matchesChatGPTSessionWhich(which, derive({ age })),
    );
    expect(matches("recent")).toEqual(["recent"]);
    expect(matches("working")).toEqual(["working"]);
    expect(matches("blocked")).toEqual(["invalid", "interrupted"]);
    expect(matchesChatGPTSessionWhich("all", derive({ hidden: true, age: "working" }))).toBe(false);
  });
});
