import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { OpenRigHumanSendTab, readHumanSendState } from "./OpenRigHumanSendTab";

const agent = {
  id: "real-seat", name: "Worker One", status: "busy", role: "worker",
  task: null, bound: true, bindingKind: "chatgpt-conversation",
  sessionId: null, sessionTitle: "Worker conversation",
};
const ledger = {
  primarySessionId: "managed-1", sessions: [{
    id: "managed-1", status: "active", title: "Worker conversation",
    target: { kind: "chatgpt-conversation", conversationId: "real-conversation" },
  }],
};
const list = vi.fn(async () => [agent]);
const sessions = vi.fn(async () => ledger);
const send = vi.fn<(input: { id: string; message: string }) => Promise<void>>();
let renderer: ReactTestRenderer;
const storage = new Map<string, string>();

function control(label: string) {
  return renderer.root.findByProps({ "aria-label": label });
}
function sendButton() {
  return renderer.root.findAll((node) =>
    node.type === "button" && node.props.children === "Send to agent")[0]!;
}
async function mount(active = true) {
  await act(async () => { renderer = create(<OpenRigHumanSendTab active={active} />); });
}
async function choose() {
  await act(async () => {
    control("Send message to agent").props.onChange({ currentTarget: { value: agent.id } });
  });
}
async function enter(value: string) {
  await act(async () => {
    control("Outgoing message").props.onChange({ currentTarget: { value } });
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  storage.clear();
  list.mockClear();
  sessions.mockClear();
  send.mockReset();
  send.mockResolvedValue();
  vi.stubGlobal("window", {
    desktopBridge: {
      listOpenRigAgents: list, listOpenRigManagedSessions: sessions,
      sendOpenRigAgentMessage: send,
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    },
  });
});
afterEach(() => {
  if (renderer) act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

describe("Human Inbox Send tab", () => {
  it("requires a verified OpenRig managed primary and preserves the chosen recipient/draft across tab switches", async () => {
    await mount();
    expect(sendButton().props.disabled).toBe(true);
    await choose();
    await enter("Progress please");
    expect(sendButton().props.disabled).toBe(false);
    expect(sessions).toHaveBeenCalledWith("real-seat");
    await act(async () => { renderer.update(<OpenRigHumanSendTab active={false} />); });
    await act(async () => { renderer.update(<OpenRigHumanSendTab active={true} />); });
    expect(control("Outgoing message").props.value).toBe("Progress please");
    expect(control("Send message to agent").props.value).toBe(agent.id);
    await act(async () => { sendButton().props.onClick(); });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ id: "real-seat", message: "Progress please" });
    expect(control("Outgoing message").props.value).toBe("");
    expect(sendButton().props.disabled).toBe(true);
  });

  it("disables sending to a missing/legacy primary without invoking the transport", async () => {
    sessions.mockResolvedValueOnce({ primarySessionId: null, sessions: [] } as never);
    await mount();
    await choose();
    await enter("Do not send");
    expect(sendButton().props.disabled).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain("No routable active OpenRig-managed primary");
    expect(send).not.toHaveBeenCalled();
  });

  it("holds an UNKNOWN receipt through tab switches and renderer recreation until explicit reconciliation", async () => {
    send.mockRejectedValueOnce(new Error("OpenRig did not return a matching T3 delivery acknowledgement; outcome unknown."));
    await mount();
    await choose();
    await enter("Only once");
    await act(async () => { sendButton().props.onClick(); });
    expect(send).toHaveBeenCalledTimes(1);
    expect(sendButton().props.disabled).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain("Delivery outcome unknown");
    await act(async () => { renderer.update(<OpenRigHumanSendTab active={false} />); });
    await act(async () => { renderer.unmount(); });
    expect(readHumanSendState(window.localStorage).holds["real-seat"]?.state).toBe("uncertain");
    await mount();
    expect(sendButton().props.disabled).toBe(true);
    await act(async () => {
      renderer.root.findAll((node) => node.type === "button" &&
        node.props.children === "I checked the target history; clear hold")[0]!.props.onClick();
    });
    expect(sendButton().props.disabled).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("recovers an interrupted in-flight send as indeterminate, not as a new send", () => {
    const key = "t3code:openrig-human-send-drafts:v1";
    storage.set(key, JSON.stringify({ selectedId: "real-seat",
      drafts: { "real-seat": "Pending" },
      holds: { "real-seat": { text: "Pending", state: "sending" } }, feedback: {} }));
    expect(readHumanSendState(window.localStorage).holds["real-seat"]?.state).toBe("uncertain");
  });
});
