import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  enqueueExternalBootstrapRequest,
  isExactExternalChatGPTUrl,
  readExternalBootstrapRequests,
} from "./chatGPTExternalBootstrapDiscovery";

const ID = "12345678-abcd-4abc-8abc-123456789abc";
const FIRST = "https://chatgpt.com/c/11111111-2222-4333-8444-555555555555";
const SECOND = "https://chatgpt.com/c/66666666-7777-4888-8999-aaaaaaaaaaaa";

describe("external ChatGPT registration queue", () => {
  const data = new Map<string, string>();
  beforeEach(() => {
    data.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("upgrades a pending Bootstrap discovery to exact-URL verification once, preserving identity", () => {
    enqueueExternalBootstrapRequest("env", ID, "External agent");
    const original = readExternalBootstrapRequests("env")[0]!;
    expect(original.conversationUrl).toBeUndefined();

    enqueueExternalBootstrapRequest("env", ID, "Changed title", FIRST);
    const upgraded = readExternalBootstrapRequests("env");
    expect(upgraded).toHaveLength(1);
    expect(upgraded[0]).toMatchObject({
      id: ID, title: "External agent", conversationUrl: FIRST, attempts: 0,
    });
    expect(upgraded[0]!.nextAttemptAt).toBeLessThanOrEqual(original.nextAttemptAt);

    enqueueExternalBootstrapRequest("env", ID, "Another title", FIRST);
    expect(readExternalBootstrapRequests("env")).toEqual(upgraded);
    expect(() => enqueueExternalBootstrapRequest("env", ID, undefined, SECOND)).toThrow(/different pending conversation/);
  });

  it("rejects lookalike hosts, malformed URLs and invalid IDs", () => {
    expect(isExactExternalChatGPTUrl(FIRST)).toBe(true);
    for (const url of [
      FIRST.replace("chatgpt.com", "chatgpt.com.evil.test"),
      FIRST + "/other",
      FIRST.replace("https:", "http:"),
      "https://chatgpt.com/c/not-a-uuid",
    ]) {
      expect(isExactExternalChatGPTUrl(url)).toBe(false);
      expect(() => enqueueExternalBootstrapRequest("env", ID, undefined, url)).toThrow(/exact/);
    }
    expect(() => enqueueExternalBootstrapRequest("env", "not-a-uuid")).toThrow(/UUID/);
    expect(readExternalBootstrapRequests("env")).toEqual([]);
  });
});
