// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CHATGPT_LOAD_FAILURE_EXPRESSION,
  RECOVERY_GLOBAL_MS,
  RECOVERY_PER_SESSION_MS,
  RECOVERY_SCAN_MS,
  cooldownElapsed,
  hasChatGPTLoadFailure,
  orderedCandidates,
  readRecentSessionClicks,
  recentClicksKey,
  readRecentClickedParent,
  recordSessionClick,
  readRecoveryHistory,
  recordRecoveryAttempt,
  recoveryKey,
} from "./chatGPTConversationRecovery";

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
});
afterEach(() => vi.restoreAllMocks());

describe("ChatGPT conversation failure detection", () => {
  it("detects an actual visible error panel with its Retry button", () => {
    document.body.innerHTML =
      "<main><div><h2>Could not load this ChatGPT conversation</h2><button>Retry</button></div></main>";
    expect(hasChatGPTLoadFailure()).toBe(true);
    expect(window.eval(CHATGPT_LOAD_FAILURE_EXPRESSION)).toBe(true);
  });

  it("ignores an ordinary chat message quoting the error", () => {
    document.body.innerHTML =
      '<main><div data-message-author-role="user"><p>Could not load this ChatGPT conversation</p>' +
      "<button>Retry</button></div></main>";
    expect(hasChatGPTLoadFailure()).toBe(false);
  });

  it("ignores a missing, hidden or unrelated Retry button", () => {
    document.body.innerHTML =
      "<main><div><h2>Could not load this ChatGPT conversation</h2></div></main>";
    expect(hasChatGPTLoadFailure()).toBe(false);
    document.body.innerHTML =
      "<main><div hidden><h2>Could not load this ChatGPT conversation</h2><button>Retry</button></div></main>";
    expect(hasChatGPTLoadFailure()).toBe(false);
    document.body.innerHTML =
      "<main><div><h2>Could not load this ChatGPT conversation</h2></div></main><footer><button>Retry</button></footer>";
    expect(hasChatGPTLoadFailure()).toBe(false);
  });

  it("never refreshes a page which is currently generating", () => {
    document.body.innerHTML =
      "<main><div><h2>Could not load this ChatGPT conversation</h2><button>Retry</button></div>" +
      '<button data-testid="stop-button">Stop</button></main>';
    expect(hasChatGPTLoadFailure()).toBe(false);
  });
});

describe("serialized recovery cooldowns", () => {
  it("checks every 30 seconds, with 30 seconds global and 2 minutes per session", () => {
    expect(RECOVERY_SCAN_MS).toBe(30_000);
    expect(RECOVERY_GLOBAL_MS).toBe(30_000);
    expect(RECOVERY_PER_SESSION_MS).toBe(120_000);
    const now = 1_800_000;
    recordRecoveryAttempt("local", "comit", now, ["comit", "other"]);
    const history = readRecoveryHistory("local");
    expect(history.lastAttemptAt).toBe(now);
    expect(history.bySession.comit).toBe(now);
    expect(
      cooldownElapsed(history.lastAttemptAt, now + RECOVERY_GLOBAL_MS - 1, RECOVERY_GLOBAL_MS),
    ).toBe(false);
    expect(
      cooldownElapsed(history.lastAttemptAt, now + RECOVERY_GLOBAL_MS, RECOVERY_GLOBAL_MS),
    ).toBe(true);
    expect(
      cooldownElapsed(
        history.bySession.comit!,
        now + RECOVERY_PER_SESSION_MS - 1,
        RECOVERY_PER_SESSION_MS,
      ),
    ).toBe(false);
    expect(orderedCandidates(["comit", "other"], history)).toEqual(["other", "comit"]);
    recordRecoveryAttempt("local", "other", now + RECOVERY_GLOBAL_MS, ["comit", "other"]);
    expect(orderedCandidates(["comit", "other"], readRecoveryHistory("local"))).toEqual([
      "comit",
      "other",
    ]);
  });

  it("prioritizes expanded groups ahead of collapsed projects even with recent clicks", () => {
    const history = { lastAttemptAt: 0, bySession: { collapsed: 0, expanded: 100 } };
    expect(
      orderedCandidates(["collapsed", "expanded"], history, ["collapsed"], new Set(["collapsed"])),
    ).toEqual(["expanded", "collapsed"]);
    expect(
      orderedCandidates(["collapsed", "expanded"], history, [], new Set(["collapsed", "expanded"])),
    ).toEqual(["collapsed", "expanded"]);
  });

  it("keeps throttle state across remounts and prunes closed tabs", () => {
    recordRecoveryAttempt("local", "comit", 1000, ["comit", "other"]);
    recordRecoveryAttempt("local", "other", 2000, ["other"]);
    const state = JSON.parse(localStorage.getItem(recoveryKey("local"))!);
    expect(state).toEqual({ lastAttemptAt: 2000, bySession: { other: 2000 } });
    expect(readRecoveryHistory("another")).toEqual({ lastAttemptAt: 0, bySession: {} });
    expect(cooldownElapsed(3000, 1000, RECOVERY_GLOBAL_MS)).toBe(true);
  });

  it("persists exact click order for subsequent scans and app restarts", () => {
    recordSessionClick("local", "other", ["comit", "other", "third"]);
    recordSessionClick("local", "comit", ["comit", "other", "third"]);
    recordSessionClick("local", "other", ["comit", "other", "third"]);
    expect(readRecentSessionClicks("local")).toEqual(["other", "comit"]);
    expect(JSON.parse(localStorage.getItem(recentClicksKey("local"))!)).toEqual(["other", "comit"]);

    const history = { lastAttemptAt: 0, bySession: { other: 9999, comit: 0 } };
    expect(
      orderedCandidates(["comit", "other", "third"], history, readRecentSessionClicks("local")),
    ).toEqual(["other", "comit", "third"]);
    // Reads from durable storage again, just as a newly mounted coordinator does.
    expect(readRecentSessionClicks("local")).toEqual(["other", "comit"]);
    expect(readRecentSessionClicks("another")).toEqual([]);
  });

  it("uses a recent selected parent but rejects stale or absent selection", () => {
    vi.spyOn(Date, "now").mockReturnValue(100_000);
    recordSessionClick("local", "parent", ["parent", "other"]);
    expect(readRecentClickedParent("local", ["parent", "other"], 100_001)).toBe("parent");
    expect(readRecentClickedParent("local", ["other"], 100_001)).toBeNull();
    expect(readRecentClickedParent("local", ["parent"], 100_000 + 5 * 60_000)).toBeNull();
    expect(readRecentClickedParent("another", ["parent"], 100_002)).toBeNull();
  });

  it("does not include closed or hidden session ids in the recovery candidate list", () => {
    recordSessionClick("local", "hidden", ["visible", "hidden", "closed"]);
    recordSessionClick("local", "visible", ["visible", "hidden"]);
    expect(readRecentSessionClicks("local")).toEqual(["visible", "hidden"]);
    expect(
      orderedCandidates(
        ["visible"],
        { lastAttemptAt: 0, bySession: {} },
        readRecentSessionClicks("local"),
      ),
    ).toEqual(["visible"]);
    recordSessionClick("local", "closed", ["visible", "hidden"]);
    expect(readRecentSessionClicks("local")).toEqual(["visible", "hidden"]);
  });

  it("recovers gracefully from malformed click-history storage", () => {
    localStorage.setItem(recentClicksKey("local"), "{bad json");
    expect(readRecentSessionClicks("local")).toEqual([]);
    localStorage.setItem(recentClicksKey("local"), JSON.stringify(["a", 4, "a", null, "b"]));
    expect(readRecentSessionClicks("local")).toEqual(["a", "b"]);
  });
});
