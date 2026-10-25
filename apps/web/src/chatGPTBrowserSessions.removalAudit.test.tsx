// @vitest-environment node
import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CHATGPT_HIDDEN_EXPIRY_MS,
  chatGPTBrowserLastUrlKey,
  chatGPTBrowserRemovalAuditKey,
  chatGPTBrowserSessionsKey,
  mergeChatGPTSessionRemovalReceipts,
  readChatGPTBrowserSessions,
  useChatGPTBrowserSessions,
  type ChatGPTSessionRemovalReceipt,
} from "./chatGPTBrowserSessions";

const env = EnvironmentId.make("local-removal-audit-test");
const key = chatGPTBrowserRemovalAuditKey(env);
const canonicalId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
let harness: ReturnType<typeof useChatGPTBrowserSessions>;
let renderer: ReactTestRenderer | undefined;

function Harness() {
  harness = useChatGPTBrowserSessions(env);
  return null;
}
async function mount() {
  await act(async () => {
    renderer = create(<Harness />);
  });
}
async function unmount() {
  await act(async () => renderer?.unmount());
  renderer = undefined;
}
function audit(): ChatGPTSessionRemovalReceipt[] {
  return JSON.parse(window.localStorage.getItem(key) ?? "[]") as ChatGPTSessionRemovalReceipt[];
}
async function add(title: string, metadata?: { parentSessionId?: string }) {
  let id = "";
  await act(async () => {
    id = harness.createSession(title, metadata);
  });
  return id;
}
async function remove(id: string, source: Parameters<typeof harness.removeSession>[1]) {
  await act(async () => {
    harness.removeSession(id, source);
  });
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const storage = new Map<string, string>();
  const events = new EventTarget();
  const localStorage = {
    getItem: (name: string) => storage.get(name) ?? null,
    setItem: (name: string, value: string) => {
      storage.set(name, value);
    },
    removeItem: (name: string) => {
      storage.delete(name);
    },
    clear: () => {
      storage.clear();
    },
  };
  vi.stubGlobal("window", {
    localStorage,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  });
  vi.stubGlobal(
    "CustomEvent",
    class extends Event {
      detail: unknown;
      constructor(name: string, options: { detail: unknown }) {
        super(name);
        this.detail = options.detail;
      }
    },
  );
  await mount();
});
afterEach(async () => {
  await unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("durable T3 ChatGPT local browser removal audit", () => {
  it("keeps auto-close exemption after unsnooze and clearing a highlighted border", async () => {
    const worker = await add("Worker");
    await act(async () => harness.setSessionSnooze([worker], Date.now() + 3600_000));
    await act(async () => harness.setSessionSnooze([worker], null));
    expect(readChatGPTBrowserSessions(env).find((s) => s.id === worker)?.autoCloseExempt).toBe(
      true,
    );

    const highlighted = await add("Highlighted");
    await act(async () => harness.setSessionBorderColor(highlighted, "blue"));
    await act(async () => harness.setSessionBorderColor(highlighted, null));
    expect(readChatGPTBrowserSessions(env).find((s) => s.id === highlighted)?.autoCloseExempt).toBe(
      true,
    );
  });
  it("records only verified index removal after a sidebar close, with original metadata and cached URL ID", async () => {
    const parent = await add("Manager");
    const child = await add("Child title", { parentSessionId: parent });
    window.localStorage.setItem(
      chatGPTBrowserLastUrlKey(env, child),
      JSON.stringify(`https://chatgpt.com/c/${canonicalId}?token=private-do-not-log`),
    );
    window.localStorage.setItem("unrelated-draft", "DO-NOT-LOG-DRAFT-OR-MESSAGE");
    await remove(child, "sidebar-user-action");
    const record = audit()[0]!;
    expect(record).toEqual({
      version: 1,
      sessionId: child,
      removedAt: expect.any(String),
      title: "Child title",
      parentSessionId: parent,
      conversationId: canonicalId,
      source: "sidebar-user-action",
      authenticatedCaller: "UNKNOWN",
      draftSafetyVerified: false,
      completionVerified: false,
      persistence: "local-session-list-verified",
    });
    expect(Number.isFinite(Date.parse(record.removedAt))).toBe(true);
    expect(readChatGPTBrowserSessions(env).some((s) => s.id === child)).toBe(false);
    expect(JSON.stringify(audit())).not.toContain("token");
    expect(JSON.stringify(audit())).not.toContain("DO-NOT-LOG");
    await unmount();
    await mount();
    expect(audit()).toEqual([record]);
  });

  it("persists a distinct unused-empty-manual cleanup reason without claiming server conversation deletion", async () => {
    const id = await add("ChatGPT 2");
    await remove(id, "unused-empty-manual");
    expect(audit()).toEqual([
      expect.objectContaining({
        sessionId: id,
        source: "unused-empty-manual",
        conversationId: null,
        persistence: "local-session-list-verified",
        draftSafetyVerified: false,
      }),
    ]);
    await unmount();
    await mount();
    expect(audit()[0]?.source).toBe("unused-empty-manual");
  });

  it("distinguishes desktop menu close from IPC request without claiming authenticated human identity", async () => {
    const menu = await add("Menu");
    const ipc = await add("Remote close");
    await remove(menu, "desktop-menu-action");
    await remove(ipc, "desktop-IPC-request");
    expect(audit().map((r) => r.source)).toEqual(["desktop-menu-action", "desktop-IPC-request"]);
    expect(audit().map((r) => r.authenticatedCaller)).toEqual(["UNKNOWN", "UNKNOWN"]);
    expect(audit().map((r) => r.completionVerified)).toEqual([false, false]);
    expect(audit().map((r) => r.draftSafetyVerified)).toEqual([false, false]);
  });

  it("uses UNKNOWN for an unclassified caller and never invents an URL or parent", async () => {
    const id = await add("No identity");
    await act(async () => harness.removeSession(id));
    expect(audit()[0]).toMatchObject({
      sessionId: id,
      source: "unknown",
      parentSessionId: "UNKNOWN",
      conversationId: null,
      authenticatedCaller: "UNKNOWN",
    });
  });

  it("audits actual hidden expiration but never treats ordinary hide, archived hide or a live session as deletion", async () => {
    const now = Date.now();
    await unmount();
    window.localStorage.setItem(
      chatGPTBrowserSessionsKey(env),
      JSON.stringify([
        {
          id: "expired",
          title: "Stale hidden",
          hidden: true,
          hiddenAt: now - CHATGPT_HIDDEN_EXPIRY_MS - 1,
        },
        { id: "child", title: "Child", parentSessionId: "expired" },
        { id: "recent", title: "Recent", hidden: true, hiddenAt: now },
        {
          id: "archived",
          title: "Archived",
          hidden: true,
          hiddenAt: now - CHATGPT_HIDDEN_EXPIRY_MS * 5,
          archive: {
            archivedAt: new Date(now).toISOString(),
            conversationUrl: "https://chatgpt.com/c/saved",
            basis: "completion",
          },
        },
      ]),
    );
    await mount();
    let removed: string[] = [];
    await act(async () => {
      removed = harness.pruneExpiredHidden(now);
    });
    expect(removed).toEqual(["expired"]);
    expect(audit().map((r) => [r.sessionId, r.source])).toEqual([["expired", "expiration"]]);
    expect(audit()[0]?.parentSessionId).toBe("UNKNOWN");
    expect(
      readChatGPTBrowserSessions(env).find((session) => session.id === "child")?.parentSessionId,
    ).toBeNull();
    expect(readChatGPTBrowserSessions(env).some((session) => session.id === "archived")).toBe(true);
    await act(async () => harness.pruneExpiredHidden(now));
    expect(audit()).toHaveLength(1);
  });

  it("does not log a missing removal or record a second receipt for a repeated close", async () => {
    const id = await add("Once");
    await remove("unknown-id", "desktop-IPC-request");
    expect(audit()).toHaveLength(0);
    await remove(id, "sidebar-user-action");
    const first = audit()[0]!;
    await remove(id, "desktop-IPC-request");
    expect(audit()).toEqual([first]);
  });

  it("never turns audit write failure into a deletion failure or logs draft content", async () => {
    const id = await add("Audit failure");
    const original = window.localStorage.setItem.bind(window.localStorage);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(window.localStorage, "setItem").mockImplementation((name, value) => {
      if (name === key) throw new Error("Quota exceeded");
      original(name, value);
    });
    await remove(id, "sidebar-user-action");
    expect(readChatGPTBrowserSessions(env).some((s) => s.id === id)).toBe(false);
    expect(audit()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "[ChatGPT removal audit] Could not persist local removal provenance.",
    );
  });

  it("does not claim persisted deletion when the session index write itself fails", async () => {
    const id = await add("Must survive failed save");
    const original = window.localStorage.setItem.bind(window.localStorage);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(window.localStorage, "setItem").mockImplementation((name, value) => {
      if (name === chatGPTBrowserSessionsKey(env)) throw new Error("session storage unavailable");
      original(name, value);
    });
    await remove(id, "sidebar-user-action");
    expect(readChatGPTBrowserSessions(env).some((entry) => entry.id === id)).toBe(true);
    expect(audit()).toEqual([]);
    expect(error).toHaveBeenCalled();
  });

  it("preserves a corrupted journal rather than copying injected draft contents or inventing audit proof", async () => {
    const id = await add("Corrupt journal");
    const before = JSON.stringify([{ sessionId: "old", draft: "PRIVATE-DRAFT-NOT-A-RECEIPT" }]);
    window.localStorage.setItem(key, before);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await remove(id, "sidebar-user-action");
    expect(readChatGPTBrowserSessions(env).some((s) => s.id === id)).toBe(false);
    expect(window.localStorage.getItem(key)).toBe(before);
    expect(warn).toHaveBeenCalled();
  });

  it("merges a bounded journal without overwriting first provenance or adding duplicate receipts", async () => {
    const original = {
      version: 1 as const,
      sessionId: "original",
      removedAt: "2026-10-23T18:00:00.000Z",
      title: "Earlier",
      parentSessionId: null,
      conversationId: null,
      source: "sidebar-user-action" as const,
      authenticatedCaller: "UNKNOWN" as const,
      draftSafetyVerified: false as const,
      completionVerified: false as const,
      persistence: "local-session-list-verified" as const,
    };
    expect(
      mergeChatGPTSessionRemovalReceipts([original], { ...original, source: "unknown" }),
    ).toEqual([original]);
    let receipts: ChatGPTSessionRemovalReceipt[] = [];
    for (let i = 0; i < 140; i++)
      receipts = mergeChatGPTSessionRemovalReceipts(receipts, {
        ...original,
        sessionId: `session-${i}`,
      });
    expect(receipts).toHaveLength(128);
    expect(receipts[0]?.sessionId).toBe("session-12");
    expect(receipts.at(-1)?.sessionId).toBe("session-139");
  });
});
