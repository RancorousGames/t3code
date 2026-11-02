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
const reconcile = vi.fn(async (_input: unknown): Promise<{ state: "observed" | "pending" | "route_changed" }> =>
  ({ state: "pending" }));
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
  sessions.mockReset();
  sessions.mockResolvedValue(ledger);
  send.mockReset();
  send.mockResolvedValue();
  reconcile.mockReset();
  reconcile.mockResolvedValue({ state: "pending" });
  vi.stubGlobal("window", {
    desktopBridge: {
      listOpenRigAgents: list, listOpenRigManagedSessions: sessions,
      sendOpenRigAgentMessage: send,
      reconcileOpenRigHumanSend: reconcile,
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
  vi.useRealTimers();
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
    expect(send).toHaveBeenCalledWith({ id: "real-seat", message: expect.stringMatching(
      /^\[T3-HUMAN-DELIVERY:[a-f0-9-]{36}\]\nProgress please$/iu,
    ) });
    expect(control("Outgoing message").props.value).toBe("");
    expect(sendButton().props.disabled).toBe(true);
  });

  it("disables sending to a missing/legacy primary without invoking the transport", async () => {
    sessions.mockResolvedValueOnce({ primarySessionId: null, sessions: [] } as never);
    await mount();
    await choose();
    await enter("Do not send");
    expect(sendButton().props.disabled).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain("Recipient has no active conversation right now.");
    expect(send).not.toHaveBeenCalled();
  });

  it("holds an UNKNOWN receipt through tab switches until exact recipient observation", async () => {
    vi.useFakeTimers();
    send.mockRejectedValueOnce(new Error("OpenRig did not return a matching T3 delivery acknowledgement; outcome unknown."));
    await mount();
    await choose();
    await enter("Only once");
    await act(async () => { sendButton().props.onClick(); });
    expect(send).toHaveBeenCalledTimes(1);
    expect(sendButton().props.disabled).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain("Checking delivery automatically");
    await act(async () => { renderer.update(<OpenRigHumanSendTab active={false} />); });
    await act(async () => { renderer.unmount(); });
    expect(readHumanSendState(window.localStorage).holds["real-seat"]?.state).toBe("uncertain");
    await mount();
    expect(sendButton().props.disabled).toBe(true);
    reconcile.mockResolvedValue({ state: "observed" });
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(readHumanSendState(window.localStorage).holds["real-seat"]).toBeUndefined();
    expect(sendButton().props.disabled).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reconciles a rejected IPC after a possible side effect without ever re-POSTing", async () => {
    vi.useFakeTimers();
    send.mockRejectedValueOnce(new Error("UnknownError: Effect.tryPromise"));
    await mount();
    await choose();
    await enter("Only once, even after a lost acknowledgement");
    await act(async () => { sendButton().props.onClick(); });
    expect(send).toHaveBeenCalledTimes(1);
    expect(sendButton().props.disabled).toBe(true);
    const marker = storage.get("t3code:openrig-human-send-drafts:v1");
    expect(marker).toContain('"state":"uncertain"');
    reconcile.mockResolvedValue({ state: "observed" });
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      id: agent.id, managedSessionId: "managed-1",
      target: expect.objectContaining({ conversationId: "real-conversation" }),
    }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(sendButton().props.disabled).toBe(true); // Draft cleared only after observed user turn.
    expect(control("Outgoing message").props.value).toBe("");
    expect(readHumanSendState(window.localStorage).holds[agent.id]).toBeUndefined();
  });

  it("retries only a proven pre-POST offline preflight and keeps the same attempt marker", async () => {
    vi.useFakeTimers();
    await mount();
    await choose();
    await enter("Will send once when online");
    sessions.mockRejectedValueOnce(new Error("OpenRig offline, no POST"));
    await act(async () => { sendButton().props.onClick(); });
    expect(send).not.toHaveBeenCalled();
    expect(readHumanSendState(window.localStorage).holds[agent.id]?.state).toBe("retryable");
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(send).toHaveBeenCalledTimes(1);
    expect(readHumanSendState(window.localStorage).holds[agent.id]).toBeUndefined();
  });

  it("refuses to redirect a retryable message when the exact managed destination rotates", async () => {
    vi.useFakeTimers();
    await mount();
    await choose();
    await enter("Must remain addressed to the original conversation");
    send.mockRejectedValueOnce(new Error("OpenRig message not sent: guarded pre-POST rejection"));
    await act(async () => { sendButton().props.onClick(); });
    expect(send).toHaveBeenCalledTimes(1);
    expect(readHumanSendState(window.localStorage).holds[agent.id]?.state).toBe("retryable");
    sessions.mockResolvedValue({ ...ledger, primarySessionId: "managed-2",
      sessions: [{ ...ledger.sessions[0]!, id: "managed-2",
        target: { kind: "chatgpt-conversation", conversationId: "other-conversation" } }] } as never);
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(send).toHaveBeenCalledTimes(1);
    expect(readHumanSendState(window.localStorage).holds[agent.id]?.state).toBe("route_changed");
  });

  it("recovers an interrupted in-flight send as indeterminate, not as a new send", () => {
    const key = "t3code:openrig-human-send-drafts:v1";
    storage.set(key, JSON.stringify({ selectedId: "real-seat",
      drafts: { "real-seat": "Pending" },
      holds: { "real-seat": { text: "Pending", state: "sending" } }, feedback: {} }));
    expect(readHumanSendState(window.localStorage).holds["real-seat"]?.state).toBe("uncertain");
  });
});
