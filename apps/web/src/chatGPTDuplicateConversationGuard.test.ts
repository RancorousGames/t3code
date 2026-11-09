import { describe, expect, it } from "vite-plus/test";
import {
  findDuplicateChatGPTConversationOwner,
  duplicateMergeHealthRank,
  refuseChatGPTConversationMove,
} from "./chatGPTDuplicateConversationGuard";

describe("T3-0114 duplicate-conversation guard", () => {
  const url = "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const sessions = [
    { id: "current", title: "Search tab" },
    { id: "hidden", title: "Hidden", hidden: true, snoozedUntil: 9999999999999 },
    { id: "visible", title: "Original" },
  ];
  const lastUrl = (id: string) => (id === "visible" || id === "hidden" ? url : null);

  it("detects an already-held conversation, preferring visible over hidden/snoozed", () => {
    expect(findDuplicateChatGPTConversationOwner(sessions, "current", url, lastUrl)?.id).toBe(
      "visible",
    );
    expect(findDuplicateChatGPTConversationOwner(sessions, "visible", url, lastUrl)?.id).toBe(
      "hidden",
    );
    expect(sessions[1]!.hidden).toBe(true);
  });

  it("recognizes archived owners without waking or changing identity", () => {
    const archiveOwner = {
      id: "archive",
      title: "Archived",
      hidden: true,
      archive: { archivedAt: "2026-10-01", conversationUrl: url, basis: "completion" as const },
    };
    expect(
      findDuplicateChatGPTConversationOwner(
        [sessions[0]!, archiveOwner],
        "current",
        url,
        () => null,
      )?.id,
    ).toBe("archive");
  });

  it("never flags the current T3 owner or an unrelated/malformed URL", () => {
    expect(
      findDuplicateChatGPTConversationOwner([sessions[0]!], "current", url, () => url),
    ).toBeUndefined();
    expect(
      findDuplicateChatGPTConversationOwner(
        sessions,
        "current",
        "https://evil.example/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        lastUrl,
      ),
    ).toBeUndefined();
    expect(
      findDuplicateChatGPTConversationOwner(
        sessions,
        "current",
        "https://chatgpt.com/c/not-a-uuid",
        lastUrl,
      ),
    ).toBeUndefined();
  });

  it("keeps active work before loaded guests, and loaded guests before healthier unloaded tabs", () => {
    expect(duplicateMergeHealthRank("working", false)).toBeGreaterThan(
      duplicateMergeHealthRank("done_or_idle", true),
    );
    expect(duplicateMergeHealthRank("unavailable", true)).toBeGreaterThan(
      duplicateMergeHealthRank("done_or_idle", false),
    );
    expect(duplicateMergeHealthRank("done_or_idle", true)).toBeGreaterThan(
      duplicateMergeHealthRank("stuck", true),
    );
  });

  it("refuses destructive transfer when draft safety is unproven or a send is UNKNOWN", () => {
    expect(refuseChatGPTConversationMove(false)).toMatch(/unsent draft/);
    expect(refuseChatGPTConversationMove(true)).toMatch(/UNKNOWN/);
    expect(refuseChatGPTConversationMove(true)).toMatch(/preserved/);
  });
});
