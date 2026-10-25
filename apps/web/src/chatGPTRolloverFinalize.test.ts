import { describe, expect, it } from "vite-plus/test";
import { finalizeChatGPTRolloverHierarchy, type ChatGPTRolloverPlan } from "./chatGPTRolloverFinalize";
import type { BrowserSession } from "./chatGPTBrowserSessions";

const OLD = "385e7c81-23f5-48f3-89de-c1f9c63893d2";
const NEXT = "e47e787b-d36f-4043-9bf0-a4cdf3e2b3ee";
const BOSS = "1c045bfd-08d7-49b8-83b4-142ba0d250f8";
const oldConversation = "6adad460-5cf4-83ed-b576-b7020f7da0a8";
const newConversation = "6adbe8bc-26f4-83ed-aee4-c3aaed20c87c";
const plan: ChatGPTRolloverPlan = {
  priorId: OLD, successorId: NEXT,
  priorConversationId: oldConversation, successorConversationId: newConversation,
  priorConversationUrl: `https://chatgpt.com/c/${oldConversation}`,
  archivedAt: "2026-10-24T01:00:00.000Z",
};

const sessions = (): BrowserSession[] => [
  { id: BOSS, title: "Omni Coordinator", project: "t3code" },
  { id: OLD, title: "T3 Code Manager OLD", parentSessionId: BOSS, project: "t3code" },
  { id: NEXT, title: "T3 Code Manager (continuation)", parentSessionId: OLD, project: "omni-command" },
  { id: "a", title: "Worker A", parentSessionId: OLD, project: "t3code" },
  { id: "b", title: "Worker B", parentSessionId: OLD, project: "t3code" },
  { id: "grandchild", title: "Subworker", parentSessionId: "a", project: "t3code" },
  { id: "newWorker", title: "New worker", parentSessionId: NEXT, project: "t3code" },
];

describe("OpenRig same-seat T3 hierarchy takeover", () => {
  it("inherits tenured direct workers, keeps subtrees, moves successor to old position and archives old", () => {
    const result = finalizeChatGPTRolloverHierarchy(sessions(), plan);
    const byId = new Map(result.map(s => [s.id, s]));
    expect(byId.get(NEXT)?.parentSessionId).toBe(BOSS);
    expect(byId.get(NEXT)?.project).toBe("t3code");
    expect(byId.get("a")?.parentSessionId).toBe(NEXT);
    expect(byId.get("b")?.parentSessionId).toBe(NEXT);
    expect(byId.get("grandchild")?.parentSessionId).toBe("a");
    expect(byId.get("newWorker")?.parentSessionId).toBe(NEXT);
    expect(byId.get(OLD)?.hidden).toBe(true);
    expect(byId.get(OLD)?.archive?.conversationUrl).toBe(plan.priorConversationUrl);
    expect(byId.get(OLD)?.archive?.basis).toBe("manager_decision");
    expect(byId.get(OLD)?.archive?.restoredAt).toBeUndefined();
    expect(byId.get(OLD)?.archive?.archivedAt).toBe(plan.archivedAt);
    expect(result).toHaveLength(sessions().length);
    expect(sessions()[1]?.hidden).toBeUndefined();
  });

  it("is idempotent after an acknowledged persistence without moving grandchildren twice", () => {
    const first = finalizeChatGPTRolloverHierarchy(sessions(), plan);
    const second = finalizeChatGPTRolloverHierarchy(first, plan);
    expect(second).toEqual(first);
  });

  it("rejects unrelated successors, cycles, unknown tabs and changed conversation identity", () => {
    const original = sessions();
    expect(() => finalizeChatGPTRolloverHierarchy(original, {...plan,successorId:"bad"})).toThrow();
    expect(() => finalizeChatGPTRolloverHierarchy(original, {...plan,priorConversationId:newConversation})).toThrow();
    const other = original.map(s=>s.id===NEXT? {...s,parentSessionId:"a"}:s);
    expect(() => finalizeChatGPTRolloverHierarchy(other,plan)).toThrow();
    const cyclic = original.map(s=>s.id===BOSS? {...s,parentSessionId:NEXT}:s);
    expect(() => finalizeChatGPTRolloverHierarchy(cyclic,plan)).toThrow();
  });
});

it("reparents an independent root manager successor without touching nested workers or deleting predecessor", () => {
  const initial = sessions().map((s) =>
    s.id === OLD || s.id === NEXT ? { ...s, parentSessionId: null } : s,
  );
  const result = finalizeChatGPTRolloverHierarchy(initial, plan);
  const prior = result.find((s) => s.id === OLD)!;
  const successor = result.find((s) => s.id === NEXT)!;
  expect(successor.parentSessionId).toBeNull();
  expect(result.find((s) => s.id === "a")?.parentSessionId).toBe(NEXT);
  expect(result.find((s) => s.id === "grandchild")?.parentSessionId).toBe("a");
  expect(prior.hidden).toBe(true);
  expect(prior.archive?.conversationUrl).toBe(plan.priorConversationUrl);
  expect(result).toHaveLength(initial.length);
});
