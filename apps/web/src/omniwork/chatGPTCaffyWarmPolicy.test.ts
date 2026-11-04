import { describe, expect, it } from "vite-plus/test";
import { imminentCaffySessionIds, isCaffyWakeImminent } from "./chatGPTCaffyWarmPolicy";
import { nextWarmChatGPTSession, type WarmCandidate } from "./chatGPTWarmSessionPolicy";
import type { T3CaffyEntry, T3CaffyOverview } from "../hooks/useT3CaffyOverview";

const now = Date.parse("2026-11-04T15:00:00+01:00");
const minute = 60_000;
const entry = (changes: Partial<T3CaffyEntry> = {}): T3CaffyEntry => ({
  sessionId: "browser", publicSessionId: "public", mode: "queued",
  paused: false, onceOnly: false, expiresAt: null, intervalMinutes: 20,
  pendingWake: true, ...changes,
});
const overview = (monitors: T3CaffyEntry[], keepT3Busy = true): T3CaffyOverview => ({
  entries: monitors, keepT3Busy, maxWorking: 3, shutdownWhenIdle: false,
});

describe("Caffy-aware keep-warm / unload protection", () => {
  it("prewarms at 30 minutes, but never earlier even with a queued pending wake", () => {
    expect(isCaffyWakeImminent(entry({ beginAt: now + 31 * minute }), true, now)).toBe(false);
    expect(isCaffyWakeImminent(entry({ beginAt: now + 30 * minute }), true, now)).toBe(true);
    expect(isCaffyWakeImminent(entry({ beginAt: now + 2 * minute }), true, now)).toBe(true);
  });

  it("respects pause, expired schedules and queued Keep T3 Busy", () => {
    expect(isCaffyWakeImminent(entry({ paused: true }), true, now)).toBe(false);
    expect(isCaffyWakeImminent(entry({ expiresAt: now - 1 }), true, now)).toBe(false);
    expect(isCaffyWakeImminent(entry(), false, now)).toBe(false);
    expect(isCaffyWakeImminent(entry({ mode: "periodic", pendingWake: false, nextDueAt: now + 29 * minute }), false, now)).toBe(true);
  });

  it("resolves public and browser aliases and does not warm hidden or snoozed sessions", () => {
    const sessions = [
      { id: "public" }, { id: "browser", hidden: true },
      { id: "other", snoozedUntil: now + minute },
    ];
    expect([...imminentCaffySessionIds(sessions, overview([entry()]), now)])
      .toEqual(["public"]);
  });

  it("preempts ordinary warm candidates, even when the soft warm limit is reached", () => {
    const defaults = {
      manager: false, highlighted: false, selected: false,
      activeBeforeFailure: false, recentlyClicked: -1,
      lastActiveAt: 0, lastActivityAt: 0, createdAt: 0,
    };
    const candidates: WarmCandidate[] = [
      { ...defaults, id: "old", recentlyClicked: 0 },
      { ...defaults, id: "caffy", caffyDueSoon: true, exceedTarget: true },
    ];
    expect(nextWarmChatGPTSession({
      candidates, loadedIds: new Set(["already-loaded"]), targetCount: 1, now,
    })).toBe("caffy");
    expect(nextWarmChatGPTSession({
      candidates, loadedIds: new Set(["native-resident"]), targetCount: 0, now,
    })).toBe("caffy");
  });
});
