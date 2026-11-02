import { describe, expect, it } from "vite-plus/test";
import {
  resolveExistingChatGPTSessionAddress,
  resolveExplicitChatGPTConversationAddress,
} from "./chatGPTConversationRouting";
import type { BrowserSession } from "./chatGPTBrowserSessions";

const CONVERSATION = "6ada88be-7e48-83eb-a735-75dbd1161d46";
const TAB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sessions: BrowserSession[] = [{ id: TAB, title: "Worker" }];

describe("persistent T3 session addressing", () => {
  it("accepts only the exact existing T3 browser UUID, retaining the independent conversation guard", () => {
    expect(resolveExistingChatGPTSessionAddress(TAB, sessions, CONVERSATION)).toEqual({
      sessionId: TAB,
      conversationId: CONVERSATION,
      create: false,
    });
    expect(resolveExistingChatGPTSessionAddress(TAB, sessions)).toEqual({
      sessionId: TAB,
      conversationId: null,
      create: false,
    });
  });

  it("never interprets a missing T3 UUID, even with an equal guard, as creation permission", () => {
    const missingTab = "8844dff8-f152-4f3c-8d4f-f0d6c6997c9a";
    for (const expected of [undefined, missingTab, CONVERSATION])
      expect(() => resolveExistingChatGPTSessionAddress(missingTab, sessions, expected)).toThrow(
        /T3 browser session is missing/,
      );
    expect(() => resolveExistingChatGPTSessionAddress(CONVERSATION, sessions)).toThrow(
      /T3 browser session is missing/,
    );
  });

  it("refuses hidden or archived owners instead of recovering them with a read/send", () => {
    expect(() =>
      resolveExistingChatGPTSessionAddress(TAB, [{ ...sessions[0]!, hidden: true }]),
    ).toThrow(/T3 browser session is missing/);
  });
});

describe("explicit ChatGPT conversation opening", () => {
  const lookup = (id: string) => (id === TAB ? `https://chatgpt.com/c/${CONVERSATION}` : null);

  it("reuses a unique visible owner by its observed or saved URL", () => {
    expect(resolveExplicitChatGPTConversationAddress(CONVERSATION, sessions, lookup)).toEqual({
      sessionId: TAB,
      conversationId: CONVERSATION,
      create: false,
    });
  });

  it("may create a missing conversation owner ONLY through explicit open, including UUIDv4 conversations", () => {
    expect(resolveExplicitChatGPTConversationAddress(CONVERSATION, sessions, () => null)).toEqual({
      sessionId: null,
      conversationId: CONVERSATION,
      create: true,
    });
    const v4 = "8844dff8-f152-4f3c-8d4f-f0d6c6997c9a";
    expect(resolveExplicitChatGPTConversationAddress(v4, sessions, () => null)).toEqual({
      sessionId: null,
      conversationId: v4,
      create: true,
    });
  });

  it("refuses hidden/archived owners and duplicate owners rather than creating a replacement", () => {
    const archived: BrowserSession = {
      ...sessions[0]!,
      hidden: true,
      archive: { archivedAt: "2026-10-27", basis: "completion", conversationUrl: lookup(TAB)! },
    };
    expect(() =>
      resolveExplicitChatGPTConversationAddress(CONVERSATION, [archived], () => null),
    ).toThrow(/restore that session/);
    expect(() =>
      resolveExplicitChatGPTConversationAddress(
        CONVERSATION,
        [...sessions, { id: other, title: "Duplicate" }],
        () => lookup(TAB),
      ),
    ).toThrow(/Several T3 sessions/);
  });

  it("requires a canonical lowercase conversation UUID", () => {
    expect(() => resolveExplicitChatGPTConversationAddress("not-an-id", [], () => null)).toThrow(
      /canonical/,
    );
  });
});
