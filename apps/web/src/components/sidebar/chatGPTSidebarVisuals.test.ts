// @vitest-environment node
import type {
  DesktopOpenRigManagedSession,
  DesktopOpenRigSeatSessions,
  DesktopOpenRigSeatTopology,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProjectIdentity } from "../../projectIdentity";
import {
  CHATGPT_SESSION_BORDER_COLORS,
  chatGPTSessionHighlightAccentClass,
  chatGPTSessionDisplayRole,
  chatGPTSidebarProjectTitles,
  isOpenRigManagerRole,
  verifiedManagerChatGPTTabIds,
} from "./chatGPTSidebarVisuals";

const topology: DesktopOpenRigSeatTopology = {
  source: "openrig-rigspec",
  seats: [
    {
      id: "seat-manager",
      rigId: "rig",
      rigName: "Omni",
      name: "T3 Manager",
      logicalId: "t3",
      role: "project-manager",
      parentIds: [],
      childIds: [],
    },
    {
      id: "seat-worker",
      rigId: "rig",
      rigName: "Omni",
      name: "Manager-looking worker",
      logicalId: "worker",
      role: "specialist",
      parentIds: [],
      childIds: [],
    },
  ],
};
const session = (
  overrides: Partial<DesktopOpenRigManagedSession> = {},
): DesktopOpenRigManagedSession => ({
  id: "managed-1",
  seatId: "seat-manager",
  operationId: "op-1",
  mode: "chatgpt",
  status: "active",
  primary: true,
  target: { kind: "chatgpt-conversation", conversationId: "conversation-1" },
  targetKey: null,
  projectId: null,
  environmentId: "env-1",
  threadId: null,
  conversationId: "conversation-1",
  attachedTabUuid: "browser-session-1",
  parentSeatId: null,
  parentManagedSessionId: null,
  provenance: {},
  intent: { title: "Developer" },
  createdAt: "2026-10-20T00:00:00Z",
  updatedAt: "2026-10-20T00:00:00Z",
  error: null,
  observed: {},
  modelCompletionVerified: false,
  ...overrides,
});
const ledger = (
  seatId: string,
  sessions: readonly DesktopOpenRigManagedSession[],
): DesktopOpenRigSeatSessions => ({
  version: 1,
  seatId,
  primarySessionId: null,
  sessions: [...sessions],
  legacyBinding: null,
  legacyAutoImported: false,
  pendingRecoveryCount: 0,
  launchPolicy: {
    explicitOperationIdRequired: true,
    duplicateOperationRetrySafe: false,
    automaticUnknownRetry: false,
    implicitAdoption: false,
  },
});

describe("persistent ChatGPT personal highlight palette", () => {
  it("maps every user-selectable color to a slim left-accent class and clears unknown/None", () => {
    expect(CHATGPT_SESSION_BORDER_COLORS.map((entry) => entry.id)).toEqual([
      "red",
      "orange",
      "yellow",
      "green",
      "blue",
      "purple",
      "pink",
    ]);
    for (const color of CHATGPT_SESSION_BORDER_COLORS) {
      expect(chatGPTSessionHighlightAccentClass(color.id)).toBe(color.accent);
    }
    expect(chatGPTSessionHighlightAccentClass(undefined)).toBeNull();
    expect(chatGPTSessionHighlightAccentClass("unsupported-color")).toBeNull();
  });
});

describe("ChatGPT sidebar session identities", () => {
  const backend = {
    id: "worker-1",
    title: "Worker",
    creationOrigin: "backend" as const,
    spawnRequestId: "spawn-1",
  };

  it("renders only backend-created, unadopted non-managers as workers", () => {
    expect(chatGPTSessionDisplayRole(backend, false)).toBe("worker");
    expect(chatGPTSessionDisplayRole({ ...backend, humanControlled: true }, false)).toBe("human");
    expect(
      chatGPTSessionDisplayRole(
        { ...backend, creationOrigin: "manual", spawnRequestId: undefined },
        false,
      ),
    ).toBe("human");
    expect(chatGPTSessionDisplayRole({ id: "legacy", title: "Legacy" }, false)).toBe("human");
  });

  it("never demotes a manager even when its guest was adopted or highlighted", () => {
    expect(chatGPTSessionDisplayRole(backend, true)).toBe("manager");
    expect(
      chatGPTSessionDisplayRole({ ...backend, humanControlled: true, borderColor: "blue" }, true),
    ).toBe("manager");
  });
});

describe("verified OpenRig manager browser markers", () => {
  it("reads actual RigSpec manager roles rather than titles", () => {
    expect(isOpenRigManagerRole("project-manager")).toBe(true);
    expect(isOpenRigManagerRole("global_manager")).toBe(true);
    expect(isOpenRigManagerRole("manager")).toBe(true);
    expect(isOpenRigManagerRole("specialist")).toBe(false);
    expect(isOpenRigManagerRole(null)).toBe(false);
  });

  it("recognizes only active managed ChatGPT attachments at authoritative RigSpec manager seats", () => {
    const matches = verifiedManagerChatGPTTabIds(
      topology,
      [ledger("seat-manager", [session()])],
      "env-1",
    );
    expect([...matches]).toEqual(["browser-session-1"]);
  });

  it("accepts the live OpenRig rigspec-and-managed-ledger topology source", () => {
    const enriched = { ...topology, source: "openrig-rigspec-and-managed-ledger" as const };
    const matches = verifiedManagerChatGPTTabIds(
      enriched,
      [ledger("seat-manager", [session()])],
      "env-1",
    );
    expect([...matches]).toEqual(["browser-session-1"]);
  });

  it("does not treat a manager-looking title or agent/worker seat as authority", () => {
    const matches = verifiedManagerChatGPTTabIds(
      topology,
      [
        ledger("seat-worker", [
          session({
            seatId: "seat-worker",
            id: "worker",
            attachedTabUuid: "imposter",
            title: "OpenRig Global Manager",
          }),
        ]),
      ],
      "env-1",
    );
    expect([...matches]).toEqual([]);
  });

  it("rejects legacy browser references, inactive seats, and missing managed attachments", () => {
    const variants = [
      session({ status: "unavailable" }),
      session({ mode: "native" }),
      session({ target: { kind: "t3-thread", environmentId: "env-1", threadId: "thread-1" } }),
      session({ attachedTabUuid: null }),
      session({ environmentId: "env-2" }),
      session({ seatId: "forged-manager" }),
    ];
    expect([
      ...verifiedManagerChatGPTTabIds(topology, [ledger("seat-manager", variants)], "env-1"),
    ]).toEqual([]);
  });

  it("rejects ledgers not belonging to authoritative manager seat", () => {
    expect([
      ...verifiedManagerChatGPTTabIds(topology, [ledger("seat-worker", [session()])], "env-1"),
    ]).toEqual([]);
  });

  it("accepts an explicitly adopted active ChatGPT target with a verified tab UUID", () => {
    const matches = verifiedManagerChatGPTTabIds(
      topology,
      [ledger("seat-manager", [session({ mode: "adopt" })])],
      "env-1",
    );
    expect([...matches]).toEqual(["browser-session-1"]);
  });
});

describe("stable per-project identity in ChatGPT sidebar", () => {
  it("preserves explicit project labels in a status-only activity group", () => {
    const sessions = [
      { id: "chat-1", title: "Wartribes task", project: "Wartribes" },
      { id: "chat-2", title: "Wartribes status update", project: "Wartribes" },
    ];
    const mapping = chatGPTSidebarProjectTitles(sessions, [
      { key: "status:active", title: null, rows: sessions.map((entry) => ({ session: entry })) },
    ]);
    expect([...mapping.values()]).toEqual(["Wartribes", "Wartribes"]);
    expect(deriveProjectIdentity(mapping.get("chat-1")!)).toEqual(
      deriveProjectIdentity(mapping.get("chat-2")!),
    );
  });

  it("uses the displayed parent group over a stale child project hint", () => {
    const sessions = [
      { id: "parent", title: "Wartribes manager", project: "Wartribes" },
      { id: "child", title: "Worker", project: "Omni", parentSessionId: "parent" },
    ];
    const mapping = chatGPTSidebarProjectTitles(sessions, [
      {
        key: "project:wartribes",
        title: "Wartribes",
        rows: sessions.map((entry) => ({ session: entry })),
      },
    ]);
    expect(mapping.get("child")).toBe("Wartribes");
  });

  it("retains inferred project identity for unpersisted grouped sessions; never invents one for Other", () => {
    const sessions = [
      { id: "chat-1", title: "Spears" },
      { id: "chat-2", title: "Towers" },
      { id: "unknown", title: "Untitled" },
    ];
    const mapping = chatGPTSidebarProjectTitles(sessions, [
      {
        key: "project:wartribes",
        title: "Wartribes",
        rows: sessions.slice(0, 2).map((entry) => ({ session: entry })),
      },
      { key: "other", title: "Other", rows: [{ session: sessions[2]! }] },
    ]);
    expect(mapping.get("chat-1")).toBe("Wartribes");
    expect(mapping.get("chat-2")).toBe("Wartribes");
    expect(mapping.has("unknown")).toBe(false);
  });
});
