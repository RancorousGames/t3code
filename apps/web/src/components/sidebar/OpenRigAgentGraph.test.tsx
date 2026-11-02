import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AgentNetwork, NetworkSeat, TreeRow } from "./openRigNetwork";

vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (children: unknown) => children,
}));

import { OpenRigAgentGraph } from "./OpenRigAgentGraph";

const seat = (id: string, status: string, childIds: string[] = []): NetworkSeat =>
  ({
    id,
    name: id,
    status,
    childIds,
    parentIds: [],
    inTopology: true,
    role: childIds.length ? "manager" : "worker",
    ledger: "loaded",
  }) as unknown as NetworkSeat;
const manager = seat("manager", "working", ["worker"]);
const worker = seat("worker", "error");
const rows: TreeRow[] = [
  { kind: "seat", key: "seat:manager", seat: manager, depth: 0, alsoUnder: [] },
  { kind: "seat", key: "seat:worker", seat: worker, depth: 1, alsoUnder: [] },
] as unknown as TreeRow[];
const network = {
  seats: new Map([
    [manager.id, manager],
    [worker.id, worker],
  ]),
  topologyAvailable: true,
} as unknown as AgentNetwork;

let renderer: ReactTestRenderer | null = null;
const onOpenSession = vi.fn();
const onOpenAgent = vi.fn();
const onSelect = vi.fn();
const onToggle = vi.fn();
const onReloadSeatSession = vi.fn();

const mount = async (selectedId: string | null = null, collapsed = new Set<string>()) => {
  await act(async () => {
    renderer = create(
      <OpenRigAgentGraph
        network={network}
        rows={rows}
        collapsed={collapsed}
        selectedId={selectedId}
        emptyText="No seats"
        onToggle={onToggle}
        onSelect={onSelect}
        onOpenAgent={onOpenAgent}
        onOpenSession={onOpenSession}
        onReloadSeatSession={onReloadSeatSession}
        getSeatSessionId={(id) => (id === "manager" ? "browser-manager" : null)}
        childSessions={
          selectedId === "manager"
            ? [
                {
                  id: "child-browser",
                  parentId: "manager",
                  title: "Child session",
                  status: "idle",
                  working: false,
                },
              ]
            : []
        }
      />,
    );
  });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    innerWidth: 1200,
    innerHeight: 900,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setTimeout: () => 1,
    clearTimeout: vi.fn(),
  });
  vi.stubGlobal("document", {
    body: {},
    activeElement: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  onOpenSession.mockReset();
  onOpenAgent.mockReset();
  onSelect.mockReset();
  onToggle.mockReset();
  onReloadSeatSession.mockReset();
});
afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("Agent Network graph interactions", () => {
  it("opens the exact browser session on double click, never silently opens a workspace", async () => {
    await mount();
    const root = renderer!.root;
    await act(async () => root.findByProps({ "data-seat-id": "manager" }).props.onDoubleClick());
    expect(onOpenSession).toHaveBeenCalledExactlyOnceWith("browser-manager");
    expect(onOpenAgent).not.toHaveBeenCalled();
    await act(async () => root.findByProps({ "data-seat-id": "worker" }).props.onDoubleClick());
    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenAgent).not.toHaveBeenCalled();
  });

  it("gives right-click Open session, workspace and reload without mutating the seat", async () => {
    await mount();
    const root = renderer!.root;
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      currentTarget: { focus: vi.fn() },
      clientX: 80,
      clientY: 100,
    };
    await act(async () =>
      root.findByProps({ "data-seat-id": "manager" }).props.onContextMenu(event),
    );
    expect(event.preventDefault).toHaveBeenCalledOnce();
    const menu = root.findByProps({ role: "menu" });
    const items = menu.findAllByProps({ role: "menuitem" });
    const label = (item: (typeof items)[number]) =>
      item.children.filter((part) => typeof part === "string").join(" ");
    expect(items.map(label)).toEqual(
      expect.arrayContaining(["Open session", "Open workspace", "Reload"]),
    );
    const workspace = items.find((item) => label(item) === "Open workspace")!;
    await act(async () => workspace.props.onClick());
    expect(onOpenAgent).toHaveBeenCalledExactlyOnceWith("manager");
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(onReloadSeatSession).not.toHaveBeenCalled();
  });

  it("shows only the selected manager's temporary child session and opens that exact ID", async () => {
    await mount("manager");
    const root = renderer!.root;
    const child = root.findByProps({ "aria-label": "Child session Child session, idle" });
    expect(child.props.className).toContain("border-2");
    await act(async () => child.props.onDoubleClick());
    expect(onOpenSession).toHaveBeenCalledExactlyOnceWith("child-browser");
    expect(onOpenAgent).not.toHaveBeenCalled();
  });

  it("retains tone-specific borders after hover and keeps keyboard focus visible on collapse", async () => {
    await mount(null, new Set(["manager"]));
    const root = renderer!.root;
    const managerNode = root.findByProps({ "data-seat-id": "manager" });
    expect(managerNode.props.className).toContain("border-info");
    expect(managerNode.props.className).not.toContain("hover:border");
    expect(root.findAllByProps({ "data-seat-id": "worker" })).toHaveLength(0);
    expect(managerNode.props.tabIndex).toBe(0);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
