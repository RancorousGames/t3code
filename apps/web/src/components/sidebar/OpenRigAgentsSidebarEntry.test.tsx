import type { DesktopOpenRigAgent } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../env", () => ({ isElectron: true }));
// Isolate the sidebar from its resize and remote-runtime providers.
vi.mock("../ui/sidebar", () => ({
  SidebarMenu: ({ children }: { children: unknown }) => children,
  SidebarMenuItem: ({ children }: { children: unknown }) => children,
}));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => <button {...props} />,
}));
vi.mock("../ui/textarea", () => ({
  Textarea: (props: Record<string, unknown>) => <textarea {...props} />,
}));

import { OpenRigAgentsSidebarEntry } from "./OpenRigAgentsSidebarEntry";

const agent = {
  id: "opaque/123",
  name: "Builder",
  status: "working",
  role: "worker",
  task: "Phase 1 integration",
  sessionId: "session-a",
  sessionTitle: "Builder ChatGPT",
};
const list = vi.fn<() => Promise<DesktopOpenRigAgent[]>>();
const send = vi.fn(async (_input: { id: string; message: string }) => {});
const listSessions = vi.fn(async () => [
  { id: "session-2", title: "Existing worker", project: "Wartribes", status: "idle" },
]);
const bind = vi.fn(async (_input: { id: string; sessionId: string }) => {});
const unbind = vi.fn(async (_id: string) => {});

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  list.mockReset();
  send.mockReset();
  listSessions.mockClear();
  bind.mockClear();
  unbind.mockClear();
  vi.stubGlobal("window", {
    desktopBridge: {
      listOpenRigAgents: list,
      listOpenRigSessions: listSessions,
      bindOpenRigAgent: bind,
      unbindOpenRigAgent: unbind,
      sendOpenRigAgentMessage: send,
    },
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  });
});

afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("OpenRig sidebar", () => {
  it("can adopt an existing ChatGPT session into an unbound Rig seat", async () => {
    const unbound = { ...agent, sessionId: null, sessionTitle: null };
    list.mockResolvedValueOnce([unbound]).mockResolvedValue([agent]);
    await act(async () => {
      renderer = create(<OpenRigAgentsSidebarEntry />);
    });
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Message OpenRig agent Builder" }).props.onClick();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Choose ChatGPT session");
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "T3 session for Builder" }).props.onChange({
        currentTarget: { value: "session-2" },
      });
    });
    await act(async () => {
      const link = renderer!.root.findAllByType("button").find((b) => b.props.children === "Link");
      link?.props.onClick();
    });
    expect(bind).toHaveBeenCalledExactlyOnceWith({ id: "opaque/123", sessionId: "session-2" });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Builder ChatGPT");
  });

  it("can detach a session without deleting it from T3", async () => {
    list
      .mockResolvedValueOnce([agent])
      .mockResolvedValue([{ ...agent, sessionId: null, sessionTitle: null }]);
    await act(async () => {
      renderer = create(<OpenRigAgentsSidebarEntry />);
    });
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Message OpenRig agent Builder" }).props.onClick();
    });
    await act(async () => {
      const detach = renderer!.root
        .findAllByType("button")
        .find((b) => b.props.children === "Detach");
      detach?.props.onClick();
    });
    expect(unbind).toHaveBeenCalledExactlyOnceWith("opaque/123");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Choose ChatGPT session");
  });
  it("shows agent metadata and sends a direct message to its opaque ID", async () => {
    list.mockResolvedValue([agent]);
    await act(async () => {
      renderer = create(<OpenRigAgentsSidebarEntry />);
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Phase 1 integration");
    expect(JSON.stringify(renderer!.toJSON())).toContain("working");

    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Message OpenRig agent Builder" }).props.onClick();
    });
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Message to Builder" }).props.onChange({
        currentTarget: { value: "How is integration going?" },
      });
    });
    await act(async () => {
      renderer!.root.findByProps({ type: "submit" }).props.onClick?.();
      renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} });
    });
    expect(send).toHaveBeenCalledExactlyOnceWith({
      id: "opaque/123",
      message: "How is integration going?",
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Message sent.");
  });

  it("degrades to an offline indicator and recovers through manual refresh", async () => {
    list.mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValueOnce([agent]);
    await act(async () => {
      renderer = create(<OpenRigAgentsSidebarEntry />);
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Offline");
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Phase 1 integration");
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Refresh OpenRig agents" }).props.onClick();
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Phase 1 integration");
  });

  it("keeps the draft on failed delivery and reports the failure", async () => {
    list.mockResolvedValue([agent]);
    send.mockRejectedValue(new Error("Connection reset"));
    await act(async () => {
      renderer = create(<OpenRigAgentsSidebarEntry />);
    });
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Message OpenRig agent Builder" }).props.onClick();
    });
    await act(async () => {
      renderer!.root.findByProps({ "aria-label": "Message to Builder" }).props.onChange({
        currentTarget: { value: "retry me" },
      });
    });
    await act(async () => {
      renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} });
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Delivery unconfirmed");
    expect(renderer!.root.findByProps({ "aria-label": "Message to Builder" }).props.value).toBe(
      "retry me",
    );
  });
});
