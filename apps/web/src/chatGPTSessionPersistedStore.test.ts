import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getChatGPTSessionPersistedStore,
  readLegacyChatGPTSessionData,
} from "./chatGPTSessionPersistedStore";
import { recordChatGPTSessionRefreshedAt } from "./chatGPTSessionTimestamps";

function storage(entries: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(entries));
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("T3-0102 non-destructive legacy migration", () => {
  it("copies sessions, queued recovery, orphan timestamps and journal indexes without touching evidence", () => {
    const env = "test-env";
    const unknownKey = `t3code:chatgpt-unknown-send-fence:v1:${env}:session-a`;
    const unknownReceipt = JSON.stringify({
      version: 2, conversationUrl: "https://chatgpt.com/c/example", reservedAt: 111,
      attempt: { original: "message not yet confirmed" },
    });
    const local = storage({
      [`t3code:chatgpt-browser:sessions:${env}`]: JSON.stringify([
        { id: "session-a", title: "Manager", completion: { declaredAt: "2026-10-25", observedTurns: 12, observedUrl: null } },
        { id: "session-b", title: "Hidden", hidden: true },
      ]),
      [`t3code:chatgpt-browser:last-active:${env}:session-a`]: "123",
      [`t3code:chatgpt-browser:last-reboot:${env}:orphan-session`]: "456",
      [`t3code:chatgpt-browser:recovery:${env}`]: '{"lastAttemptAt":789,"bySession":{"session-a":789}}',
      [`t3code:chatgpt-browser:recovery-log:${env}`]: '[{"at":77,"sessionId":"session-a","event":"recovery"}]',
      [unknownKey]: unknownReceipt,
      [`t3code:chatgpt-confirmed-delivery:v1:${env}:session-b`]: '[{"messageId":"abc"}]',
      ["t3code:chatgpt-unknown-send-fence:v1:other-env:session-x"]: "other",
    });
    const session = storage({
      [`t3code:chatgpt-browser:recovery-queue:${env}`]: JSON.stringify({
        targets: ["session-a"], failures: { "session-a": { attempts: 6 } },
        history: [{ kind: "attempt", at: 789 }], lastScanAt: 789,
      }),
    });

    const beforeLocal = [...Array(local.length)].map((_, i) => [local.key(i), local.getItem(local.key(i)!)]);
    const beforeSession = session.getItem(`t3code:chatgpt-browser:recovery-queue:${env}`);
    const first = readLegacyChatGPTSessionData(env, local, session);
    expect(first.sessions).toHaveLength(2);
    expect(first.sessions[0]?.completion?.observedTurns).toBe(12);
    expect(first.recovery.queue?.failures["session-a"]?.attempts).toBe(6);
    expect(first.recovery.history).toEqual({ lastAttemptAt: 789, bySession: { "session-a": 789 } });
    expect(first.timeline["orphan-session"]?.reboot).toBe(456);
    expect(first.sendJournal.unknownKeys).toEqual([unknownKey]);
    expect(first.sendJournal.confirmedKeys).toHaveLength(1);
    expect(first.snapshots).toEqual({});
    expect(readLegacyChatGPTSessionData(env, local, session)).toEqual(first);
    expect([...Array(local.length)].map((_, i) => [local.key(i), local.getItem(local.key(i)!)]))
      .toEqual(beforeLocal);
    expect(session.getItem(`t3code:chatgpt-browser:recovery-queue:${env}`)).toBe(beforeSession);
    expect(local.getItem(unknownKey)).toBe(unknownReceipt);
  });

  it("upgrades a stale v1 mirror from the authoritative legacy sessions without losing UNKNOWN evidence or snapshots", () => {
    const env = "v1-session-cutover";
    const unknownKey = `t3code:chatgpt-unknown-send-fence:v1:${env}:worker`;
    const unknownPayload = '{"attempt":"unresolved"}';
    const legacySessions = [
      { id: "manager", title: "Manager", parentSessionId: null },
      { id: "worker", title: "Worker", parentSessionId: "manager", hidden: true,
        completion: { declaredAt: "2026-10-27", observedTurns: 3, observedUrl: null } },
    ];
    const stale = {
      state: {
        schemaVersion: 1,
        sessions: legacySessions.slice(0, 1),
        recovery: { queue: null, history: null, bounded: null, diagnostics: [] },
        timeline: {},
        sendJournal: { unknownKeys: [], confirmedKeys: [], archivedKeys: [] },
        snapshots: { manager: { observedAt: 123 } },
      },
      version: 1,
    };
    const local = storage({
      [`t3code:chatgpt-browser:sessions:${env}`]: JSON.stringify(legacySessions),
      [`t3code:chatgpt-browser:session-store:v1:${env}`]: JSON.stringify(stale),
      [unknownKey]: unknownPayload,
    });
    vi.stubGlobal("window", { localStorage: local, sessionStorage: storage() });
    const current = getChatGPTSessionPersistedStore(env).getState();
    expect(current.sessions).toEqual(legacySessions);
    expect(current.snapshots).toEqual(stale.state.snapshots);
    expect(current.sendJournal.unknownKeys).toContain(unknownKey);
    expect(local.getItem(unknownKey)).toBe(unknownPayload);
    const persisted = JSON.parse(local.getItem(`t3code:chatgpt-browser:session-store:v1:${env}`)!);
    expect(persisted.version).toBe(2);
    expect(persisted.state.sessions).toEqual(legacySessions);
  });

  it("dual-writes an actual refresh observation without changing its legacy key", () => {
    const env = "timeline-dual-write";
    const local = storage();
    vi.stubGlobal("window", { localStorage: local, sessionStorage: storage() });
    const at = Date.now() - 1000;
    recordChatGPTSessionRefreshedAt(env, "session-a", at);
    expect(local.getItem(`t3code:chatgpt-browser:last-refresh:${env}:session-a`)).toBe(JSON.stringify(at));
    expect(getChatGPTSessionPersistedStore(env).getState().timeline["session-a"]?.refresh).toBe(at);
  });

  it("keeps a previously persisted environment snapshot on restart while leaving UNKNOWN keys intact", () => {
    const env = "persistent-reopen";
    const unknown = `t3code:chatgpt-unknown-send-fence:v1:${env}:old`;
    const local = storage({
      [unknown]: '{"version":1,"conversationUrl":"https://chatgpt.com/c/old","reservedAt":100}',
      [`t3code:chatgpt-browser:sessions:${env}`]: '[{"id":"old","title":"legacy"}]',
    });
    const session = storage();
    vi.stubGlobal("window", { localStorage: local, sessionStorage: session });
    const first = getChatGPTSessionPersistedStore(env);
    expect(first.getState().sessions[0]?.id).toBe("old");
    const saved = { ...first.getState(), sessions: [{ id: "new", title: "store" }] };
    first.setState(saved);
    expect(local.getItem(`t3code:chatgpt-browser:session-store:v1:${env}`)).not.toBeNull();
    expect(getChatGPTSessionPersistedStore(env)).toBe(first);
    expect(first.getState().sessions[0]?.id).toBe("new");
    expect(local.getItem(unknown)).toContain('"version":1');
    // Legacy keys remain for the compatibility release and are not overwritten.
    expect(local.getItem(`t3code:chatgpt-browser:sessions:${env}`)).toBe('[{"id":"old","title":"legacy"}]');
  });
});
