import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  archiveLegacyUnknownChatGPTSend,
  hasDurableUnknownChatGPTSend,
  readDurableUnknownChatGPTSend,
  reserveDurableUnknownChatGPTSend,
} from "./chatGPTUncertainSendFence";

const environment = "test-delivery" as never;
const session = "test-worker";
const url = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";

function storage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    keys: () => [...map.keys()],
  };
}

let store: ReturnType<typeof storage>;
beforeEach(() => {
  store = storage();
  vi.stubGlobal("window", { localStorage: store });
});
afterEach(() => vi.unstubAllGlobals());

describe("durable legacy UNKNOWN quarantine", () => {
  it("retains original v1 evidence and unblocks only the exact old conversation after a minimum age", () => {
    const now = Date.now();
    vi.setSystemTime(now - 120_000);
    reserveDurableUnknownChatGPTSend(environment, session, url, false);
    vi.useRealTimers();
    expect(archiveLegacyUnknownChatGPTSend(environment, session, url + "-other", now)).toBe(false);
    expect(archiveLegacyUnknownChatGPTSend(environment, session, url, now)).toBe(true);
    expect(hasDurableUnknownChatGPTSend(environment, session)).toBe(false);
    const archives = store.keys().filter(k => k.includes("legacy-unknown-archive"));
    expect(archives).toHaveLength(1);
    expect(store.getItem(archives[0]!)).toContain("original_delivery_unresolved");
    // A fresh distinct operation can obtain a new fence without losing the old evidence.
    reserveDurableUnknownChatGPTSend(environment, session, url, false);
    expect(readDurableUnknownChatGPTSend(environment, session)?.conversationUrl).toBe(url);
  });
  it("will not archive a modern v2 receipt with exact original message evidence", () => {
    const attempt = {
      original: "Exact message", text: "Exact message", url,
      before: { totalTurns: 2, lastUserTurnKey: "turn-2" },
      policyEnrichment: { schema: "t3-c05-browser-optional/v1" as const, status: "not_eligible" as const },
    };
    reserveDurableUnknownChatGPTSend(environment, session, url, false, attempt);
    expect(archiveLegacyUnknownChatGPTSend(environment, session, url, Date.now() + 120_000)).toBe(false);
    expect(hasDurableUnknownChatGPTSend(environment, session)).toBe(true);
  });
});
