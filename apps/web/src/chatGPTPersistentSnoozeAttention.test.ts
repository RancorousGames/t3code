import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  activateAgentAttention,
  loadAgentAttention,
  markAgentAttentionNotified,
  requestAgentAttention,
} from "./chatGPTAgentAttention";
import { getChatGPTSessionPersistedStore } from "./chatGPTSessionPersistedStore";
import {
  persistentAttentionSnoozeDue,
  watchPersistentChatGPTSessionSnoozes,
} from "./chatGPTPersistentSnoozeAttention";

const NOW = 1_800_000_000_000;
const storage = new Map<string, string>();
const cleanups: Array<() => void> = [];
let sequence = 0;

beforeEach(() => {
  sequence++;
  storage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const events = new EventTarget();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
  };
  vi.stubGlobal("window", {
    localStorage,
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  });
  vi.stubGlobal("localStorage", localStorage);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(marker: "armed" | "ready" | undefined, flags = {}) {
  const env = `attention-snooze-expiry-${sequence}`;
  const id = "worker";
  const until = NOW + 5_000;
  const store = getChatGPTSessionPersistedStore(env);
  store.setState({
    sessions: [{
      id, title: "Real T3 session title", ...(marker ? { returnMarker: marker } : {}),
      snoozedAt: NOW, snoozedUntil: until, ...flags,
    }],
  });
  const stop = watchPersistentChatGPTSessionSnoozes(env);
  cleanups.push(stop);
  return { env, id, until, store };
}

describe("persistent Ctrl+D attention when a session snooze expires", () => {
  it("activates previously armed attention and turns the session yellow at expiry", () => {
    requestAgentAttention("manual-1", "worker", "Old title", "manual");
    const { store } = setup("armed");
    vi.advanceTimersByTime(4_999);
    expect(store.getState().sessions[0]?.returnMarker).toBe("armed");
    expect(loadAgentAttention().find((item) => item.id === "manual-1")?.status).toBe("waiting");
    vi.advanceTimersByTime(1);
    expect(store.getState().sessions[0]).toMatchObject({
      returnMarker: "ready", title: "Real T3 session title",
    });
    expect(store.getState().sessions[0]?.snoozedUntil).toBeUndefined();
    expect(loadAgentAttention().find((item) => item.id === "manual-1"))
      .toMatchObject({ status: "pending", message: "Real T3 session title", nextAt: NOW + 5_000 });
    vi.advanceTimersByTime(20_000);
    expect(loadAgentAttention().filter((item) => item.status === "pending")).toHaveLength(1);
  });

  it("silences a pending Ctrl+D alert while snoozed and reannounces it on wake", () => {
    requestAgentAttention("manual-2", "worker", "Old title", "manual");
    activateAgentAttention(["worker"]);
    markAgentAttentionNotified("manual-2");
    const { store } = setup("ready");
    expect(loadAgentAttention().find((item) => item.id === "manual-2"))
      .toMatchObject({ status: "snoozed", nextAt: NOW + 5_000 });
    vi.advanceTimersByTime(5_000);
    expect(store.getState().sessions[0]?.returnMarker).toBe("ready");
    const item = loadAgentAttention().find((entry) => entry.id === "manual-2");
    expect(item).toMatchObject({ status: "pending", activatedAt: NOW + 5_000 });
    expect(item?.notifiedAt).toBeUndefined();
    expect(loadAgentAttention().filter((entry) => entry.id === "manual-2")).toHaveLength(1);
  });

  it("keeps a response that finishes during snooze hidden until the session wakes", () => {
    requestAgentAttention("manual-while-asleep", "worker", "Old title", "manual");
    const { store } = setup("working");
    activateAgentAttention(["worker"]);
    expect(loadAgentAttention().find((item) => item.id === "manual-while-asleep"))
      .toMatchObject({ status: "snoozed", nextAt: NOW + 5_000 });
    vi.advanceTimersByTime(5_000);
    expect(store.getState().sessions[0]?.returnMarker).toBe("ready");
    expect(loadAgentAttention().find((item) => item.id === "manual-while-asleep"))
      .toMatchObject({ status: "pending", activatedAt: NOW + 5_000 });
  });

  it("reactivates once after restarting the snooze watcher past the deadline", () => {
    requestAgentAttention("manual-restart", "worker", "Old title", "manual");
    const { env, store } = setup("armed");
    cleanups.pop()?.();
    vi.advanceTimersByTime(5_000);
    expect(store.getState().sessions[0]?.returnMarker).toBe("armed");
    const stop = watchPersistentChatGPTSessionSnoozes(env);
    cleanups.push(stop);
    expect(store.getState().sessions[0]?.returnMarker).toBe("ready");
    expect(loadAgentAttention().filter((item) => item.status === "pending")).toHaveLength(1);
    stop();
    cleanups.pop();
    cleanups.push(watchPersistentChatGPTSessionSnoozes(env));
    expect(loadAgentAttention().filter((item) => item.status === "pending")).toHaveLength(1);
  });

  it("does not reactivate disabled markers or verification snoozes", () => {
    requestAgentAttention("manual-3", "worker", "Old title", "manual");
    const { store } = setup(undefined);
    vi.advanceTimersByTime(5_000);
    expect(loadAgentAttention().find((item) => item.id === "manual-3")?.status).toBe("waiting");
    expect(store.getState().sessions[0]?.returnMarker).toBeUndefined();
    expect(persistentAttentionSnoozeDue({
      id: "skip", title: "Skip", returnMarker: "armed",
      snoozedAt: NOW, snoozedUntil: NOW + 1,
      verificationPending: true,
    }, NOW + 1)).toBe(false);
  });

  it("does not re-alert on an explicit early unsnooze", () => {
    requestAgentAttention("manual-4", "worker", "Old title", "manual");
    const { store } = setup("armed");
    store.setState({ sessions: store.getState().sessions.map((session) =>
      ({ ...session, snoozedAt: undefined, snoozedUntil: undefined })) });
    vi.advanceTimersByTime(5_000);
    expect(store.getState().sessions[0]?.returnMarker).toBe("armed");
    expect(loadAgentAttention().find((item) => item.id === "manual-4")?.status).toBe("waiting");
  });
});
