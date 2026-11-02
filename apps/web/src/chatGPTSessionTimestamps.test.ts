import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { chatGPTBrowserLastWorkingKey } from "./chatGPTBrowserSessions";
import {
  formatChatGPTSessionDateTime,
  readChatGPTSessionTimeline,
  recordChatGPTSessionActiveAt,
  recordChatGPTSessionRefreshedAt,
  recordChatGPTSessionRebootedAt,
} from "./chatGPTSessionTimestamps";

const records = new Map<string, string>();

beforeEach(() => {
  records.clear();
  const localStorage = {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => records.set(key, value),
  };
  vi.stubGlobal("window", { localStorage });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T04:40:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("per-ChatGPT session timestamp provenance", () => {
  it("does not invent creation, activity or refresh dates for legacy sessions", () => {
    const legacy = { id: "old", title: "Legacy" };
    expect(readChatGPTSessionTimeline("env", legacy)).toEqual({
      createdAt: null,
      lastActiveAt: null,
      lastRefreshAt: null,
      lastRebootAt: null,
    });
    expect(formatChatGPTSessionDateTime(null)).toBe("Unknown (not recorded)");
    expect(readChatGPTSessionTimeline("env", { ...legacy, createdAt: Date.now() }).createdAt).toBe(
      Date.now(),
    );
    // An exact durable worker-spawn receipt can recover creation for an older
    // session; its timestamp never replaces an explicitly recorded creation.
    expect(
      readChatGPTSessionTimeline("env", legacy, undefined, Date.now() - 50_000).createdAt,
    ).toBe(Date.now() - 50_000);
    expect(
      readChatGPTSessionTimeline(
        "env",
        { ...legacy, createdAt: Date.now() - 100_000 },
        undefined,
        Date.now() - 50_000,
      ).createdAt,
    ).toBe(Date.now() - 100_000);
  });

  it("combines existing observed worker history with deliberate user activation", () => {
    const session = { id: "s", title: "Worker", createdAt: Date.now() - 100_000 };
    const earlier = Date.now() - 60_000;
    records.set(
      chatGPTBrowserLastWorkingKey(EnvironmentId.make("env"), "s"),
      JSON.stringify(earlier),
    );
    expect(readChatGPTSessionTimeline("env", session).lastActiveAt).toBe(earlier);
    recordChatGPTSessionActiveAt("env", "s", Date.now() - 20_000);
    expect(readChatGPTSessionTimeline("env", session).lastActiveAt).toBe(Date.now() - 20_000);
    // A delayed older observation can never regress newer activity.
    recordChatGPTSessionActiveAt("env", "s", earlier);
    expect(readChatGPTSessionTimeline("env", session).lastActiveAt).toBe(Date.now() - 20_000);
    expect(readChatGPTSessionTimeline("other-env", session).lastActiveAt).toBeNull();
    expect(
      readChatGPTSessionTimeline("env", { id: "other", title: "Other" }).lastActiveAt,
    ).toBeNull();
  });

  it("keeps Agent Reboots separate from ordinary page reload timestamps", () => {
    const entry = { id: "s", title: "Manager" };
    recordChatGPTSessionRefreshedAt("env", "s", Date.now() - 10_000);
    recordChatGPTSessionRebootedAt("env", "s", Date.now() - 1_000);
    expect(readChatGPTSessionTimeline("env", entry)).toMatchObject({
      lastRefreshAt: Date.now() - 10_000,
      lastRebootAt: Date.now() - 1_000,
    });
    expect(readChatGPTSessionTimeline("env", { ...entry, id: "other" }).lastRebootAt).toBeNull();
  });

  it("survives independent reads, rejects future timestamps, and isolates browser reloads", () => {
    const entry = { id: "s", title: "Session" };
    const first = Date.now() - 45_000;
    recordChatGPTSessionRefreshedAt("env", "s", first);
    recordChatGPTSessionRefreshedAt("env", "s", first - 1_000);
    recordChatGPTSessionRefreshedAt("env", "s", Date.now() + 100_000);
    expect(readChatGPTSessionTimeline("env", entry).lastRefreshAt).toBe(first);
    expect(readChatGPTSessionTimeline("env", { ...entry, id: "other" }).lastRefreshAt).toBeNull();
    expect(readChatGPTSessionTimeline("other-env", entry).lastRefreshAt).toBeNull();
    records.set("t3code:chatgpt-browser:last-refresh:env:s", "{garbage");
    expect(readChatGPTSessionTimeline("env", entry).lastRefreshAt).toBeNull();
  });
});
