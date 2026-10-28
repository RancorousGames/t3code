import { describe, expect, it } from "vite-plus/test";
import type { BrowserSession } from "../../chatGPTBrowserSessions";
import { layoutChatGPTSessions } from "../../chatGPTSessionGrouping";
import { filterChatGPTWorkerGroups } from "../../chatGPTWorkerVisibility";
import {
  projectHideableWorkerIds,
  projectOpenRigManagerTabIds,
  readManagerRoleSnapshot,
  type CachedOpenRigManagerBinding,
} from "./chatGPTManagerRoleProjection";
import { chatGPTSessionDisplayRole } from "./chatGPTSidebarVisuals";

const PARENT = "omni-coordinator";
const MANAGER = "7d73c7cc-0d17-4dba-a7b7-b60424bf3e9b";
const WORKER = "ordinary-backend-child";
const CONVERSATION = "6adf941e-9e98-83eb-8288-ad96526fe708";
const records: BrowserSession[] = [
  { id: PARENT, title: "Omni Coordinator" },
  {
    id: MANAGER,
    title: "Omni Project Manager — New",
    creationOrigin: "backend",
    parentSessionId: PARENT,
    spawnRequestId: "c3f41bc8-5df5-4d59-81e1-273069951594",
  },
  {
    id: WORKER,
    title: "Omni Project Manager — counterfeit title",
    creationOrigin: "backend",
    parentSessionId: PARENT,
    spawnRequestId: "normal-worker-request",
  },
];
const verified: CachedOpenRigManagerBinding = {
  t3SessionId: MANAGER,
  conversationId: CONVERSATION,
  seatId: "rig-manager-seat",
  managedSessionId: "rig-execution",
  role: "manager",
  roleSource: "openrig-rigspec",
  status: "verified",
};
const ids = (groups: ReturnType<typeof layoutChatGPTSessions>) =>
  groups.flatMap((group) => group.rows.map((row) => row.session.id));

describe("T3-0150 verified manager seat projection", () => {
  it("does not revive arbitrary UUIDs from persistent manager-role storage", () => {
    const raw = JSON.stringify([
      verified,
      { ...verified, roleSource: "title" },
      { ...verified, managedSessionId: null },
      { ...verified, status: "revoked" },
    ]);
    expect(readManagerRoleSnapshot(raw)).toEqual([verified]);
    expect(readManagerRoleSnapshot("{broken json")).toEqual([]);
    expect(readManagerRoleSnapshot(JSON.stringify([MANAGER]))).toEqual([]);
  });

  it("a legitimate backend child manager retains lineage, crown role, and Hide Workers exemption", () => {
    const managers = projectOpenRigManagerTabIds(records, new Set([MANAGER]), [], new Map());
    expect(records[1]?.parentSessionId).toBe(PARENT);
    expect(records[1]?.spawnRequestId).toBe("c3f41bc8-5df5-4d59-81e1-273069951594");
    expect(chatGPTSessionDisplayRole(records[1]!, managers.has(MANAGER))).toBe("manager");
    expect(chatGPTSessionDisplayRole(records[2]!, managers.has(WORKER))).toBe("worker");
    const hidden = projectHideableWorkerIds(records, new Set([MANAGER]), managers, new Set());
    const shown = filterChatGPTWorkerGroups(
      layoutChatGPTSessions(records, [], "started", {}),
      hidden,
      false,
      new Set(),
    );
    expect(ids(shown)).toContain(MANAGER);
    expect(ids(shown)).not.toContain(WORKER);
  });

  it("no title, prompt, parent link, spawn receipt, or arbitrary cache UUID confers a manager", () => {
    const managers = projectOpenRigManagerTabIds(
      records,
      new Set(),
      [verified],
      new Map([[MANAGER, CONVERSATION]]),
    );
    expect(managers.size).toBe(0); // complete authoritative revoke outranks an old snapshot
    const withoutSeat = projectOpenRigManagerTabIds(
      records,
      null,
      [{ ...verified, seatId: null }],
      new Map([[MANAGER, CONVERSATION]]),
    );
    expect(withoutSeat.size).toBe(0);
    const withoutRigSource = projectOpenRigManagerTabIds(
      records,
      null,
      [{ ...verified, roleSource: null }],
      new Map([[MANAGER, CONVERSATION]]),
    );
    expect(withoutRigSource.size).toBe(0);
    expect(chatGPTSessionDisplayRole(records[2]!, false)).toBe("worker");
  });

  it("restores exactly last-verified manager after unload/restart while OpenRig is offline", () => {
    const ids = projectOpenRigManagerTabIds(
      records,
      null,
      [verified],
      new Map([[MANAGER, CONVERSATION]]),
    );
    expect([...ids]).toEqual([MANAGER]);
    const hidden = projectHideableWorkerIds(records, null, ids, new Set([MANAGER, WORKER]));
    expect([...hidden]).toEqual([WORKER]);
    expect(
      projectOpenRigManagerTabIds(
        records,
        null,
        [verified],
        new Map([[MANAGER, "different-conversation"]]),
      ).size,
    ).toBe(0);
    expect(projectOpenRigManagerTabIds(records, null, [verified], new Map()).size).toBe(0);
  });

  it("does not hide new/unclassified children during an outage, even with backend origin", () => {
    const managers = projectOpenRigManagerTabIds(records, null, [], new Map());
    expect(projectHideableWorkerIds(records, null, managers, new Set([WORKER]))).toEqual(
      new Set([WORKER]),
    );
    const newWorker = { ...records[2]!, id: "unclassified-child" };
    expect(
      projectHideableWorkerIds([...records, newWorker], null, managers, new Set([WORKER])).has(
        newWorker.id,
      ),
    ).toBe(false);
  });

  it("revocation/seat transfer or same-slot Agent Reboot cannot reuse a stale conversation marker", () => {
    const afterTransfer = projectOpenRigManagerTabIds(
      records,
      new Set(),
      [verified],
      new Map([[MANAGER, CONVERSATION]]),
    );
    expect(afterTransfer.has(MANAGER)).toBe(false);
    const afterReboot = projectOpenRigManagerTabIds(
      records,
      null,
      [verified],
      new Map([[MANAGER, "new-6adf-conversation"]]),
    );
    expect(afterReboot.has(MANAGER)).toBe(false);
  });
});
