import { describe, expect, it } from "vite-plus/test";
import { caffyDiagnosticLines } from "./CaffyHoverDetails";
import type { T3CaffyEntry } from "../../hooks/useT3CaffyOverview";

const NOW = Date.parse("2026-11-14T05:00:00Z");
const monitor = (overrides: Partial<T3CaffyEntry> = {}): T3CaffyEntry => ({
  sessionId: "f1a453af-fdc4-46ff-8a16-cae8cbe636ae",
  mode: "idle", paused: false, onceOnly: false, expiresAt: null,
  intervalMinutes: 20, createdAt: NOW - 30_000,
  lastCheckedAt: NOW - 10_000,
  lastWakeAt: NOW - 90_000,
  lastCheckResult: "Waiting for assistant response; page may appear idle before a reply is complete.",
  ...overrides,
});

describe("Caffy hover diagnostics", () => {
  it("does not promise a time-based wake for event-driven idle mode", () => {
    const lines = caffyDiagnosticLines(monitor(), NOW).join("\n");
    expect(lines).toContain("Event-driven: after the next verified assistant reply");
    expect(lines).toContain("Last scheduler check:");
    expect(lines).toContain("Next scheduler check:");
    expect(lines).toContain("Last wake sent:");
    expect(lines).toContain("Waiting for assistant response");
  });

  it("prioritizes paused, pending deliveries and delayed starts", () => {
    expect(caffyDiagnosticLines(monitor({ paused: true }), NOW)[0]).toBe("Next wake: Paused");
    expect(caffyDiagnosticLines(monitor({ pendingMessageId: "pending" }), NOW)[0])
      .toBe("Next wake: Delivery pending");
    expect(caffyDiagnosticLines(monitor({ beginAt: NOW + 60_000 }), NOW)[0])
      .toContain("delayed start");
  });

  it("shows concrete periodic next due time and actionable failure text", () => {
    const lines = caffyDiagnosticLines(monitor({
      mode: "periodic", nextDueAt: NOW + 30_000, lastError: "No exact binding",
    }), NOW).join("\n");
    expect(lines).toContain("Next wake: At ");
    expect(lines).toContain("Error: No exact binding");
  });
});
