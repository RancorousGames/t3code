// @vitest-environment node
import type { DesktopOpenRigSeatSessions, DesktopOpenRigSeatTopology } from "@t3tools/contracts";
import { act, type ReactElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../env", () => ({ isElectron: true }));

import { useOpenRigManagerChatGPTSessions } from "./useOpenRigManagerChatGPTSessions";

const topology: DesktopOpenRigSeatTopology = {
  source: "openrig-rigspec",
  seats: [
    {
      id: "manager",
      rigId: "omni-command",
      rigName: "Omni",
      name: "Project Manager",
      logicalId: "projects-t3",
      role: "project-manager",
      parentIds: [],
      childIds: [],
    },
    {
      id: "specialist",
      rigId: "omni-command",
      rigName: "Omni",
      name: "Pretend Manager",
      logicalId: "worker-123",
      role: "specialist",
      parentIds: [],
      childIds: [],
    },
  ],
};
const ledger: DesktopOpenRigSeatSessions = {
  version: 1,
  seatId: "manager",
  primarySessionId: "record-1",
  sessions: [
    {
      id: "record-1",
      seatId: "manager",
      operationId: "op",
      mode: "chatgpt",
      status: "active",
      primary: true,
      target: { kind: "chatgpt-conversation", conversationId: "conversation-1" },
      targetKey: null,
      projectId: null,
      environmentId: "env-1",
      threadId: null,
      conversationId: "conversation-1",
      attachedTabUuid: "browser-1",
      parentSeatId: null,
      parentManagedSessionId: null,
      provenance: {},
      intent: { title: "manager" },
      createdAt: "",
      updatedAt: "",
      error: null,
      observed: {},
      modelCompletionVerified: false,
    },
  ],
  legacyBinding: null,
  legacyAutoImported: false,
  pendingRecoveryCount: 0,
  launchPolicy: {
    explicitOperationIdRequired: true,
    duplicateOperationRetrySafe: false,
    automaticUnknownRetry: false,
    implicitAdoption: false,
  },
};

function Probe(): ReactElement {
  const ids = useOpenRigManagerChatGPTSessions("env-1");
  return <output>{[...ids].join(",")}</output>;
}

let renderer: ReactTestRenderer | null = null;
function rendered() {
  return renderer!.root.findByType("output").children.join("");
}
function bridge(
  discover: () => Promise<DesktopOpenRigSeatTopology>,
  managed: (id: string) => Promise<DesktopOpenRigSeatSessions>,
) {
  const events = new Map<string, () => void>();
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: (key: string, fn: () => void) => events.set(key, fn),
    removeEventListener: (key: string) => events.delete(key),
  });
  vi.stubGlobal("window", {
    desktopBridge: {
      discoverOpenRigSeats: discover,
      listOpenRigManagedSessions: managed,
    },
    setInterval: () => 13,
    clearInterval: () => undefined,
  });
  return events;
}

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("read-only OpenRig manager sidebar attribution", () => {
  it("reads RigSpec roles and only the manager's durable active ChatGPT attachment", async () => {
    const managed = vi.fn(async (_id: string) => ledger);
    bridge(async () => topology, managed);
    await act(async () => {
      renderer = create(<Probe />);
    });
    expect(managed).toHaveBeenCalledExactlyOnceWith("manager");
    expect(rendered()).toBe("browser-1");
  });

  it("fails closed on bridge unavailability instead of recognizing manager-looking names", async () => {
    bridge(
      async () => {
        throw new Error("offline");
      },
      async () => ledger,
    );
    await act(async () => {
      renderer = create(<Probe />);
    });
    expect(rendered()).toBe("");
  });

  it("ignores a failed manager ledger response and never includes a worker seat", async () => {
    const read = vi.fn(async (_id: string): Promise<DesktopOpenRigSeatSessions> => {
      throw new Error("OpenRig ledger unavailable");
    });
    bridge(async () => topology, read);
    await act(async () => {
      renderer = create(<Probe />);
    });
    expect(read).toHaveBeenCalledExactlyOnceWith("manager");
    expect(rendered()).toBe("");
  });
});
