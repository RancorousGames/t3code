import { describe, expect, it } from "vite-plus/test";

import type { BrowserSession } from "./chatGPTBrowserSessions";
import {
  EMPTY_MANUAL_CHAT_MAX_IDLE_MS,
  emptyManualChatEligibility,
} from "./chatGPTUnusedManualSessionPolicy";

const createdAt = 100_000;
const manual: BrowserSession = {
  id: "manual-1",
  title: "ChatGPT 2",
  manualEmptyCandidateCreatedAt: createdAt,
};

function evaluate({
  session = manual,
  sessions = [session],
  now = createdAt + EMPTY_MANUAL_CHAT_MAX_IDLE_MS,
  lastTouchedAt = 0,
  managerIds = new Set<string>(),
  activeSessionId,
  hasUncertainSend = false,
  recoveryPending = false,
  hasConversationUrl = false,
}: {
  session?: BrowserSession;
  sessions?: BrowserSession[];
  now?: number;
  lastTouchedAt?: number;
  managerIds?: Set<string> | null;
  activeSessionId?: string;
  hasUncertainSend?: boolean;
  recoveryPending?: boolean;
  hasConversationUrl?: boolean;
} = {}) {
  return emptyManualChatEligibility({
    session,
    sessions,
    now,
    lastTouchedAt,
    managerIds,
    activeSessionId,
    hasUncertainSend,
    recoveryPending,
    hasConversationUrl,
  });
}

describe("T3-0047 conservative unused manual new-chat eligibility", () => {
  it("only becomes eligible after a full 30 minutes since BOTH creation and last interaction", () => {
    expect(evaluate({ now: createdAt + EMPTY_MANUAL_CHAT_MAX_IDLE_MS - 1 })).toBe(
      "not-idle-for-30-minutes",
    );
    expect(evaluate()).toBe("eligible");
    expect(evaluate({ lastTouchedAt: createdAt + 1 })).toBe("not-idle-for-30-minutes");
    expect(
      evaluate({
        lastTouchedAt: createdAt + 1,
        now: createdAt + EMPTY_MANUAL_CHAT_MAX_IDLE_MS + 1,
      }),
    ).toBe("eligible");
  });

  it("never selects legacy, inferred, backend, manually renamed or explicitly protected guests", () => {
    expect(evaluate({ session: { id: "legacy", title: "ChatGPT 1" } })).toBe(
      "legacy-or-unverified-origin",
    );
    expect(evaluate({ session: { ...manual, manualEmptyCandidateCreatedAt: 0 } })).toBe(
      "legacy-or-unverified-origin",
    );
    for (const override of [
      { spawnRequestId: "worker" },
      { borderColor: "blue" },
      { hidden: true },
      { project: "Work" },
      { snoozedUntil: createdAt + 6000 },
      { title: "Pinned notes" },
      { completion: { declaredAt: "now", observedTurns: 1, observedUrl: null } },
    ]) {
      expect(evaluate({ session: { ...manual, ...override } })).toBe("protected-metadata");
    }
    expect(evaluate({ activeSessionId: manual.id })).toBe("protected-metadata");
  });

  it("fails closed on managers, parents, descendants, in-flight sends, recovery or navigation", () => {
    expect(evaluate({ managerIds: null })).toBe("manager-seat-unknown");
    expect(evaluate({ managerIds: new Set([manual.id]) })).toBe("protected-by-manager-seat");
    expect(evaluate({ session: { ...manual, parentSessionId: null } })).toBe(
      "child-or-parent-session",
    );
    expect(
      evaluate({ sessions: [manual, { id: "child", title: "Child", parentSessionId: manual.id }] }),
    ).toBe("child-or-parent-session");
    expect(evaluate({ hasUncertainSend: true })).toBe("send-or-recovery-uncertain");
    expect(evaluate({ recoveryPending: true })).toBe("send-or-recovery-uncertain");
    expect(evaluate({ hasConversationUrl: true })).toBe("conversation-or-navigation-observed");
    expect(evaluate({ session: { ...manual, manualEmptyCandidateDisqualified: true } })).toBe(
      "conversation-or-navigation-observed",
    );
  });
});
