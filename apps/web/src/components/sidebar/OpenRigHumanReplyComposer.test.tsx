import type { DesktopOpenRigInboxItem } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  OpenRigHumanReplyComposer,
  humanReplyCopyText,
  type HumanReplyRequest,
  type HumanReplySend,
} from "./OpenRigHumanReplyComposer";

const item: DesktopOpenRigInboxItem = {
  id: "qitem-original-5",
  sender: "manager@omni-command",
  recipient: "human@kernel",
  subject: "Request",
  body: "Please send your response",
  createdAt: "2026-10-23T10:00:00Z",
  state: "pending",
  requiresAction: true,
  sourceType: "queue",
};

const storage = new Map<string, string>();
const clipboard = vi.fn(async (_text: string) => {});
const announce = vi.fn();
let rendered: ReactTestRenderer | undefined;

beforeEach(() => {
  storage.clear();
  clipboard.mockClear();
  announce.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    },
  });
  vi.stubGlobal("navigator", { clipboard: { writeText: clipboard } });
  vi.stubGlobal("crypto", {
    getRandomValues: (array: Uint8Array) => {
      array.fill(0x11);
      return array;
    },
  });
});

afterEach(() => {
  if (rendered) act(() => rendered?.unmount());
  rendered = undefined;
  vi.unstubAllGlobals();
});

async function mount(current = item, address = "human@kernel", onSend?: HumanReplySend) {
  await act(async () => {
    rendered = create(
      <OpenRigHumanReplyComposer
        item={current}
        address={address}
        {...(onSend ? { onSend } : {})}
        onAnnouncement={announce}
      />,
    );
  });
}

async function edit(text: string) {
  await act(async () => {
    rendered!.root
      .findByProps({ "aria-label": "Ordinary OpenRig reply draft" })
      .props.onChange({ currentTarget: { value: text } });
  });
}

async function click(label: string) {
  await act(async () => {
    rendered!.root.findByProps({ children: label }).props.onClick();
  });
}

function output() {
  return JSON.stringify(rendered!.toJSON());
}
function disabled(): boolean {
  return rendered!.root.findByProps({ children: "Submit reply" }).props.disabled;
}

describe("ordinary OpenRig human Reply composer", () => {
  it("stores a source- and address-scoped draft, copies provenance, never sends without a canonical adapter", async () => {
    await mount();
    expect(output()).toContain("Sending unavailable");
    expect(disabled()).toBe(true);
    await edit("Proceed with the migration.");
    expect(storage.size).toBe(1);
    expect(disabled()).toBe(true);
    await click("Copy reply");
    expect(clipboard).toHaveBeenCalledWith(
      "From: human@kernel\nTo: manager@omni-command\nIn reply to: queue/qitem-original-5\n\nProceed with the migration.",
    );
    expect(output()).toContain("Nothing was sent");
    expect(announce).toHaveBeenCalledWith(expect.stringContaining("Nothing was sent"));

    await act(async () => {
      rendered!.unmount();
    });
    rendered = undefined;
    await mount();
    expect(output()).toContain("Proceed with the migration.");
    await act(async () => {
      rendered!.unmount();
    });
    rendered = undefined;
    await mount({ ...item, sourceType: "mailbox" });
    expect(output()).not.toContain("Proceed with the migration.");
    await act(async () => {
      rendered!.unmount();
    });
    rendered = undefined;
    await mount(item, "human-alt@kernel");
    expect(output()).not.toContain("Proceed with the migration.");
  });

  it("refuses to submit when a persisted operation record cannot be written", async () => {
    await mount(item, "human@kernel", vi.fn() as HumanReplySend);
    await edit("A short response");
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: () => {
          throw new Error("quota");
        },
      },
    });
    await click("Submit reply");
    expect(output()).toContain("Not sent");
  });

  it("requires exact source, recipient, replyTo, operation and durable acceptance; locks after unknown", async () => {
    const send = vi.fn(async (request: HumanReplyRequest) => ({
      outcome: "accepted" as const,
      requestId: request.operationId,
      qitemId: request.sourceId,
      replyQitemId: "qitem-new",
      recipient: "wrong@rig",
      source: "human@kernel" as const,
      messageSha256: "not-relevant-here",
      acceptedIntoQueue: true as const,
      deliveredToAgent: false as const,
      status: "recorded" as const,
      delivery: "queued" as const,
    }));
    await mount(item, "human@kernel", send);
    await edit("Yes");
    expect(disabled()).toBe(false);
    await click("Submit reply");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toEqual({
      operationId: "11111111-1111-4111-9111-111111111111",
      sourceType: "queue",
      sourceId: item.id,
      replyTo: item.id,
      from: "human@kernel",
      to: item.sender,
      body: "Yes",
    });
    expect(output()).toContain("Outcome unknown");
    expect(disabled()).toBe(true);
    await click("Submit reply");
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => {
      rendered!.unmount();
    });
    rendered = undefined;
    await mount(item, "human@kernel", send);
    expect(output()).toContain("Outcome unknown");
    expect(disabled()).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("considers only exact matching durable receipt accepted; never equates queue acceptance with agent delivery", async () => {
    const send = vi.fn(async (request: HumanReplyRequest) => ({
      outcome: "accepted" as const,
      requestId: request.operationId,
      qitemId: request.sourceId,
      replyQitemId: "qitem-reply-10",
      recipient: request.to,
      source: "human@kernel" as const,
      messageSha256: "verified-in-MAIN",
      acceptedIntoQueue: true as const,
      deliveredToAgent: false as const,
      status: "recorded" as const,
      delivery: "queued" as const,
    }));
    await mount(item, "human@kernel", send);
    await edit("The update is approved.");
    await click("Submit reply");
    expect(send).toHaveBeenCalledTimes(1);
    expect(output()).toContain("durably accepted");
    expect(output()).toContain("agent consumption is unverified");
    expect(disabled()).toBe(true);
    expect(announce).toHaveBeenCalledWith(expect.stringContaining("delivery is not implied"));
    await act(async () => {
      rendered!.unmount();
    });
    rendered = undefined;
    await mount(item, "human@kernel", send);
    expect(output()).toContain("Reply recorded by OpenRig");
    expect(disabled()).toBe(true);
  });

  it("keeps unknown in-flight receipt locked when the transport rejects", async () => {
    const send = vi.fn(async () => {
      throw new Error("transport timed out after POST");
    });
    await mount(item, "human@kernel", send);
    await edit("Request a status report");
    await click("Submit reply");
    expect(output()).toContain("outcome unknown");
    expect(disabled()).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  });

  it("retries an uncertain reply with the original ID and text after remount", async () => {
    const send = vi.fn(async (_request: HumanReplyRequest) => ({ outcome: "unknown" as const, reason: "lost response" }));
    await mount(item, "human@kernel", send);
    await edit("Please proceed");
    await click("Submit reply");
    const original = send.mock.calls[0]![0];
    await act(async () => rendered!.unmount());
    rendered = undefined;
    const retry = vi.fn(async (request: HumanReplyRequest) => ({
      outcome: "accepted" as const, requestId: request.operationId, qitemId: request.sourceId,
      replyQitemId: "qitem-reply", recipient: request.to, source: "human@kernel" as const,
      messageSha256: "verified-in-MAIN", acceptedIntoQueue: true as const,
      deliveredToAgent: false as const, status: "idempotent" as const, delivery: "queued" as const,
    }));
    await act(async () => { rendered = create(
      <OpenRigHumanReplyComposer item={item} address="human@kernel" onRetry={retry} />,
    ); });
    await click("Retry saved reply");
    expect(retry).toHaveBeenCalledWith(original);
    expect(output()).toContain("durably accepted");
  });

  it("restores definite not-sent drafts and reconciles unknown by read-only operation ID", async () => {
    const send = vi.fn(async () => ({ outcome: "not_sent" as const, reason: "Writer offline" }));
    const lookup = vi.fn(async (request: HumanReplyRequest) => ({
      outcome: "accepted" as const,
      requestId: request.operationId,
      qitemId: request.sourceId,
      replyQitemId: "qitem-read-only",
      recipient: request.to,
      source: "human@kernel" as const,
      messageSha256: "verified-in-MAIN",
      acceptedIntoQueue: true as const,
      deliveredToAgent: false as const,
      status: "recorded" as const,
      delivery: "queued" as const,
    }));
    await mount(item, "human@kernel", send);
    await edit("Reply");
    await click("Submit reply");
    expect(send).toHaveBeenCalledOnce();
    expect(output()).toContain("Not sent");
    expect(disabled()).toBe(false);
    await act(async () => rendered!.unmount());
    rendered = undefined;
    await mount(
      item,
      "human@kernel",
      vi.fn(async () => ({ outcome: "unknown" as const, reason: "lost POST" })),
    );
    await click("Submit reply");
    expect(disabled()).toBe(true);
    await act(async () => rendered!.unmount());
    rendered = undefined;
    await act(async () => {
      rendered = create(
        <OpenRigHumanReplyComposer
          item={item}
          address="human@kernel"
          onSend={send}
          onReconcile={lookup}
        />,
      );
    });
    expect(output()).toContain("Check receipt (read-only)");
    await click("Check receipt (read-only)");
    expect(lookup).toHaveBeenCalledOnce();
    expect(output()).toContain("durably accepted");
    expect(disabled()).toBe(true);
  });

  it("copy text retains the original mailbox ID (no invented queue ID)", () => {
    expect(
      humanReplyCopyText("human@host", { ...item, id: "mail-2", sourceType: "mailbox" }, "OK"),
    ).toContain("In reply to: mailbox/mail-2");
  });
});
