// @vitest-environment node
// @ts-expect-error jsdom types are not installed in this workspace.
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { runOpenRigHumanInboxControl } from "./openRigHumanInboxControl";
import type { DesktopOpenRigInbox, DesktopOpenRigHumanResponseResult } from "@t3tools/contracts";

const items = [
  { id: "qitem-01", sourceType: "queue" as const, sender: "builder", recipient: "human@kernel",
    subject: "Decision", body: "Choose", state: "pending", humanIntent: "decision" as const,
    humanForm: { version: 2, questions: [{ id: "approve", type: "choice" }] },
    requiresAction: true, createdAt: "2026-10-21T10:00:00Z" },
  { id: "qitem-02", sourceType: "queue" as const, sender: "builder", recipient: "human@kernel",
    subject: "Update", body: "Completed", state: "done", requiresAction: false,
    createdAt: "2026-10-21T09:00:00Z" },
  { id: "qitem-02", sourceType: "mailbox" as const, sender: "external", recipient: "human@kernel",
    subject: "Mailbox", body: "Same id, different source", state: "pending",
    requiresAction: true, createdAt: "2026-10-21T08:00:00Z" },
];
const inbox = (): DesktopOpenRigInbox => ({ available: true, address: "human@kernel", addresses: [],
  pendingCount: 2, count: 3, truncated: false, items });
const reader = vi.fn(async () => inbox());
const writer = vi.fn(async (): Promise<DesktopOpenRigHumanResponseResult> => ({ version: 2, qitemId: "qitem-01", actor: "human@kernel",
  acceptedIntoQueue: true, status: "recorded", complete: true, answeredCount: 1,
  remainingQuestionIds: [], replyQitemId: "qitem-reply", delivery: "queued",
  deliveredToAgent: false }));

let dom: JSDOM;
beforeEach(() => {
  dom = new JSDOM("", { url: "https://t3.local/" });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("localStorage", dom.window.localStorage);
  vi.stubGlobal("Event", dom.window.Event);
  localStorage.clear();
  reader.mockClear();
  writer.mockClear();
  Object.defineProperty(window, "desktopBridge", { configurable: true,
    value: { readOpenRigOperatorInbox: reader, submitOpenRigHumanResponse: writer } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); dom.window.close(); });

describe("T3 human inbox control matches local UI flags", () => {
  const unread = async () => (await runOpenRigHumanInboxControl({ action: "fetch_unread" })) as { items: typeof items };
  const recent = async () => (await runOpenRigHumanInboxControl({ action: "fetch_recent_read" })) as { items: typeof items };
  const set = (itemId: string, sourceType: "queue" | "mailbox", state: "read" | "unread" | "archived" | "trash" | "inbox") =>
    runOpenRigHumanInboxControl({ action: "set_state", itemId, sourceType, state });
  it("starts with actual unread records and only lists read items after state persistence", async () => {
    expect((await unread()).items).toHaveLength(3);
    await expect(set("qitem-02", "queue", "read")).resolves.toMatchObject({
      persisted: true, originalOpenRigState: "done", scope: "local-t3-inbox",
    });
    const after = await recent();
    expect(after.items).toMatchObject([{ id: "qitem-02", sourceType: "queue" }]);
    expect((await unread()).items).toHaveLength(2);
    expect(items[1]?.state).toBe("done");
    await set("qitem-02", "queue", "unread");
    expect((await recent()).items).toHaveLength(0);
  });
  it("isolates same-id messages by source and preserves all reversible local folder states", async () => {
    await set("qitem-02", "queue", "archived");
    expect((await unread()).items.find((i) => i.id === "qitem-02" && i.sourceType === "queue")).toBeUndefined();
    expect((await unread()).items.find((i) => i.id === "qitem-02" && i.sourceType === "mailbox")).toBeDefined();
    await set("qitem-02", "queue", "trash");
    await set("qitem-02", "queue", "inbox");
    expect((await unread()).items).toHaveLength(3);
  });
  it("never changes local state when the exact item is not in an available snapshot", async () => {
    await expect(set("unknown", "queue", "read")).rejects.toThrow(/Exact message not found/);
    expect(localStorage.getItem("t3code:openrig-human-inbox-read:v1")).toBeNull();
    reader.mockImplementationOnce(async () => ({ ...inbox(), available: false,
      pendingCount: null, reason: "Full daemon unavailable" }));
    await expect(unread()).rejects.toThrow(/Full daemon unavailable/);
  });
  it("replies only through the canonical structured writer with an exact matching receipt", async () => {
    const accepted = await runOpenRigHumanInboxControl({
      action: "reply", itemId: "qitem-01", sourceType: "queue",
      answers: [{ questionId: "approve", value: "no" }],
    });
    expect(accepted).toMatchObject({ acceptedIntoQueue: true, deliveredToAgent: false });
    expect(writer).toHaveBeenCalledExactlyOnceWith({
      version: 2, destination: "human@kernel", qitemId: "qitem-01",
      answers: [{ questionId: "approve", value: "no" }],
    });
    await expect(runOpenRigHumanInboxControl({
      action: "reply", itemId: "qitem-02", sourceType: "mailbox",
      answers: [{ questionId: "approve", value: "no" }],
    })).rejects.toThrow(/ordinary text reply transport is not available/);
    writer.mockResolvedValueOnce({ ...await writer.mock.results[0]?.value, acceptedIntoQueue: false } as DesktopOpenRigHumanResponseResult);
    await expect(runOpenRigHumanInboxControl({
      action: "reply", itemId: "qitem-01", sourceType: "queue",
      answers: [{ questionId: "approve", value: "yes" }],
    })).rejects.toThrow(/did not acknowledge/);
  });
});
