import type { DesktopOpenRigInbox } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (children: unknown) => children,
}));

import {
  OpenRigOperatorInbox,
  detectInboxArrivals,
  inboxAttentionKind,
  isUserInboxAttention,
  inboxSpeechPreview,
} from "./OpenRigOperatorInbox";

const local = { address: "human@kernel", label: "Local operator seat" };
const external = { address: "owner@external", label: "Registered owner" };
const sample: DesktopOpenRigInbox = {
  available: true,
  address: "human@kernel",
  addresses: [local, external],
  pendingCount: 2,
  count: 3,
  truncated: false,
  items: [
    {
      id: "queue-1",
      sender: "builder@rig",
      subject: "Build complete",
      body: "Here is the result",
      state: "done",
      requiresAction: false,
      sourceType: "queue",
      createdAt: "2026-10-18T12:00:00.000Z",
    },
    {
      id: "gate-1",
      sender: "reviewer@rig",
      subject: "Approval required",
      body: "Approve the proof",
      state: "blocked",
      requiresAction: true,
      sourceType: "human_gate",
      createdAt: "2026-10-18T13:00:00.000Z",
    },
    {
      id: "mail-1",
      sender: "global-manager@rig",
      subject: "Status report",
      body: "Progress update",
      state: "pending",
      requiresAction: true,
      sourceType: "mailbox",
      createdAt: "2026-10-18T14:00:00.000Z",
    },
  ],
};
const offline: DesktopOpenRigInbox = {
  available: false,
  reason: "Queue projection is unavailable",
  address: "human@kernel",
  addresses: [local],
  items: [],
  pendingCount: null,
  count: 0,
  truncated: false,
};
const read = vi.fn<(address: string) => Promise<DesktopOpenRigInbox>>();
const speak = vi.fn<(text: string) => Promise<void>>();
const storage = new Map<string, string>();
let rendered: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  read.mockReset();
  speak.mockReset();
  speak.mockResolvedValue();
  storage.clear();
  vi.stubGlobal("window", {
    desktopBridge: { readOpenRigOperatorInbox: read, speakOpenRigPreview: speak },
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    innerWidth: 1800,
    innerHeight: 1000,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    },
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    body: { nodeType: 1 },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

afterEach(() => {
  if (rendered) act(() => rendered?.unmount());
  rendered = undefined;
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => {
    rendered = create(<OpenRigOperatorInbox />);
  });
}
function output() {
  return JSON.stringify(rendered!.toJSON());
}
async function click(label: string) {
  await act(async () => {
    rendered!.root.findByProps({ "aria-label": label }).props.onClick();
  });
}
async function changeCheckbox(label: string, value: boolean) {
  await act(async () => {
    rendered!.root
      .findByProps({ "aria-label": label })
      .props.onChange({ currentTarget: { checked: value } });
  });
}
async function refreshWhileClosed() {
  const calls = vi.mocked(document.addEventListener).mock.calls;
  const listener = calls.find(([name]) => name === "visibilitychange")?.[1] as
    | EventListener
    | undefined;
  if (!listener) throw new Error("No visibility refresh listener.");
  await act(async () => {
    listener(new Event("visibilitychange"));
  });
}
function displayMessages() {
  return rendered!.root.findAllByProps({ role: "listitem" });
}

async function contextMessage(subject: string) {
  await act(async () => {
    rendered!.root
      .findByProps({ "aria-label": `Open inbox message: ${subject}` })
      .props.onContextMenu({
        preventDefault: () => {},
        clientX: 430,
        clientY: 245,
      });
  });
}
async function manageMessages() {
  await act(async () => {
    rendered!.root.findByProps({ "aria-label": "Manage inbox messages" }).props.onClick({
      currentTarget: { getBoundingClientRect: () => ({ left: 450, bottom: 230 }) },
    });
  });
}

describe("OpenRig floating desktop inbox", () => {
  it("keeps the received inbox flow while exposing a separate Send tab", async () => {
    read.mockResolvedValue(sample);
    await mount();
    await click("OpenRig human inbox");
    expect(rendered!.root.findByProps({ "aria-label": "Human Inbox Received tab" }).props["aria-selected"]).toBe(true);
    await click("Filter OpenRig inbox: All");
    expect(output()).toContain("Build complete");
    await click("Human Inbox Send tab");
    expect(rendered!.root.findByProps({ "aria-label": "Human Inbox Send tab" }).props["aria-selected"]).toBe(true);
    expect(output()).toContain("Human Inbox Send panel");
    await click("Human Inbox Received tab");
    expect(rendered!.root.findByProps({ "aria-label": "Human Inbox Received tab" }).props["aria-selected"]).toBe(true);
    expect(output()).toContain("Build complete");
  });
  it("dismisses on an outside click, but keeps the inbox while its context menu is open", async () => {
    read.mockResolvedValue(sample);
    await mount();
    await click("OpenRig human inbox");
    const pointerdown = vi.mocked(document.addEventListener).mock.calls
      .filter(([name]) => name === "pointerdown").at(-1)?.[1] as ((event: PointerEvent) => void) | undefined;
    expect(pointerdown).toBeDefined();
    await manageMessages();
    await act(async () => pointerdown!({ button: 0, target: document.body } as unknown as PointerEvent));
    expect(rendered!.root.findAllByProps({ "aria-label": "OpenRig human inbox window" })).toHaveLength(1);
    await click("Dismiss inbox menu");
    await act(async () => pointerdown!({ button: 0, target: document.body } as unknown as PointerEvent));
    expect(rendered!.root.findAllByProps({ "aria-label": "OpenRig human inbox window" })).toHaveLength(0);
    expect(rendered!.root.findByProps({ "aria-label": "OpenRig human inbox" }).props["aria-expanded"]).toBe(false);
  });
  it("shows decisions and explicitly requested/exceptional updates, with diagnostic history grouped beneath its origin", async () => {
    const requested = {
      ...sample.items[0]!,
      id: "requested",
      subject: "Requested completion",
      humanIntent: "update" as const,
      notificationReason: "requested" as const,
    };
    const milestone = {
      ...sample.items[0]!,
      id: "milestone",
      subject: "All tasks done",
      humanIntent: "update" as const,
      notificationReason: "milestone" as const,
    };
    const diagnostic = {
      ...sample.items[0]!,
      id: "recovery",
      subject: "Stuck sweep: unclaimed-obligation",
      relatedTo: "queue-1",
      requiresAction: true,
    };
    expect(isUserInboxAttention(sample.items[0]!, "human@kernel")).toBe(false);
    expect(isUserInboxAttention(sample.items[1]!, "human@kernel")).toBe(true);
    expect(isUserInboxAttention(requested, "human@kernel")).toBe(true);
    expect(isUserInboxAttention(milestone, "human@kernel")).toBe(true);
    expect(isUserInboxAttention(diagnostic, "human@kernel")).toBe(false);
    read.mockResolvedValue({
      ...sample,
      count: 6,
      items: [...sample.items, requested, milestone, diagnostic],
    });
    await mount();
    await click("OpenRig human inbox");
    expect(displayMessages()).toHaveLength(3); // decision + two allowed notifications
    await click("Filter OpenRig inbox: All");
    expect(displayMessages()).toHaveLength(5); // diagnostics collapse into original
    await click("Open inbox message: Build complete");
    expect(output()).toContain("Internal recovery history");
    expect(output()).toContain("Stuck sweep: unclaimed-obligation");
  });

  it("only enables canonical Reply for verified direct queue items with live writer capability", async () => {
    const direct = {
      ...sample.items[0]!,
      id: "qitem-replyable-77",
      sourceType: "queue" as const,
      state: "pending",
      sender: "manager@omni",
      recipient: "human@kernel",
      attentionKind: "message" as const,
      replyEligible: true,
    };
    const send = vi.fn(
      async (input: {
        requestId: string;
        qitemId: string;
        expectedRecipient: string;
        message: string;
      }) => ({
        outcome: "accepted" as const,
        requestId: input.requestId,
        qitemId: input.qitemId,
        replyQitemId: "qitem-reply-mocked",
        recipient: input.expectedRecipient,
        source: "human@kernel" as const,
        messageSha256: "validated-in-main",
        acceptedIntoQueue: true as const,
        deliveredToAgent: false as const,
        status: "recorded" as const,
        delivery: "queued" as const,
      }),
    );
    (
      window as unknown as { desktopBridge: Record<string, unknown> }
    ).desktopBridge.sendOpenRigOperatorReply = send;
    read.mockResolvedValue({
      ...sample,
      items: [direct],
      count: 1,
      pendingCount: 0,
      replyWriteAvailable: true,
    });
    await mount();
    await click("OpenRig human inbox");
    await click("Filter OpenRig inbox: All");
    await click("Open inbox message: Build complete");
    await act(async () => {
      rendered!.root.findByProps({ "aria-label": "Ordinary OpenRig reply draft" }).props.onChange({
        currentTarget: { value: "Please implement the fix." },
      });
    });
    expect(rendered!.root.findByProps({ children: "Submit reply" }).props.disabled).toBe(false);
    await act(async () => rendered!.root.findByProps({ children: "Submit reply" }).props.onClick());
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceType: "queue",
        qitemId: direct.id,
        destination: "human@kernel",
        expectedRecipient: direct.sender,
        message: "Please implement the fix.",
      }),
    );
    expect(output()).toContain("durably accepted");

    await act(async () => rendered!.unmount());
    rendered = undefined;
    read.mockResolvedValue({
      ...sample,
      items: [{ ...direct, replyEligible: false }],
      count: 1,
      replyWriteAvailable: true,
    });
    await mount();
    await click("OpenRig human inbox");
    await click("Filter OpenRig inbox: All");
    await click("Open inbox message: Build complete");
    expect(rendered!.root.findByProps({ children: "Submit reply" }).props.disabled).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not turn explicit automatic notices into needs-attention alerts or replyable records", async () => {
    const warning = {
      ...sample.items[0]!,
      id: "qitem-warning-1",
      requiresAction: false,
      sender: "daemon@kernel",
      attentionKind: "notice" as const,
      replyEligible: false,
      replyUnavailableReason: "automated_notice",
    };
    expect(inboxAttentionKind(warning, "human@kernel")).toBe("none");
    // The exact 2026-10-24 regression: a failed terminal wake about an
    // informational message arrived as a false "instant reply" to the human.
    const undelivered = {
      ...warning,
      id: "qitem-recovery-019a7a6bd26da7dc",
      subject: "Stuck sweep: undelivered-wake on qitem-20261024004615-ea7b30a9683a6849 (0 min)",
      requiresAction: true,
      attentionKind: undefined,
    };
    expect(inboxAttentionKind(undelivered, "human@kernel")).toBe("none");
    expect(isUserInboxAttention(undelivered, "human@kernel")).toBe(false);
    read.mockResolvedValue({
      ...sample,
      items: [warning],
      count: 1,
      pendingCount: 0,
      replyWriteAvailable: true,
    });
    await mount();
    expect(output()).not.toContain("alerts or read-only decisions in loaded results");
    await click("OpenRig human inbox");
    await click("Filter OpenRig inbox: All");
    await click("Open inbox message: Build complete");
    expect(rendered!.root.findByProps({ children: "Submit reply" }).props.disabled).toBe(true);
  });
  it("uses a compact prominent sidebar launcher; details are a separate two-column window", async () => {
    read.mockResolvedValue(sample);
    await mount();
    expect(read).toHaveBeenCalledWith("human@kernel");
    expect(
      rendered!.root.findByProps({ "aria-label": "OpenRig human inbox" }).props["aria-expanded"],
    ).toBe(false);
    expect(
      rendered!.root.findByProps({ "aria-label": "1 unread items requiring your attention" }),
    ).toBeTruthy();
    expect(
      rendered!.root.findByProps({
        "aria-label": "1 alerts or read-only decisions in loaded results",
      }),
    ).toBeTruthy();
    expect(output()).not.toContain("pending native answer forms in loaded results");
    expect(output()).not.toContain("Build complete");
    await click("OpenRig human inbox");
    expect(rendered!.root.findByProps({ "aria-label": "OpenRig human inbox window" })).toBeTruthy();
    expect(output()).toContain("Select a message");
    expect(output()).toContain("grid-cols-[minmax(150px,36%)_minmax(0,1fr)]");
    expect(displayMessages()).toHaveLength(1); // default For you hides routine updates
    await click("Filter OpenRig inbox: All");
    expect(displayMessages()).toHaveLength(3);
    expect(output()).toContain("Select a message");
    await click("Close human inbox");
    expect(output()).not.toContain("Select a message");
  });

  it("opens a message in the right pane, marks only that record read and persists it", async () => {
    read.mockResolvedValue(sample);
    await mount();
    await click("OpenRig human inbox");
    await click("Filter OpenRig inbox: All");
    await click("Open inbox message: Build complete");
    expect(output()).toContain("Here is the result");
    expect(
      rendered!.root.findByProps({ "aria-label": "1 unread items requiring your attention" }),
    ).toBeTruthy();
    await click("Mark inbox message unread: Build complete");
    expect(
      rendered!.root.findByProps({ "aria-label": "1 unread items requiring your attention" }),
    ).toBeTruthy();
    await click("Open inbox message: Build complete");
    await act(async () => {
      rendered!.unmount();
    });
    rendered = undefined;
    await mount();
    expect(
      rendered!.root.findByProps({ "aria-label": "1 unread items requiring your attention" }),
    ).toBeTruthy();
  });

  it("shows search, actionable filtering, copy affordance and a mark-loaded-read control", async () => {
    read.mockResolvedValue(sample);
    await mount();
    await click("OpenRig human inbox");
    await click("Filter OpenRig inbox: Forms");
    expect(displayMessages()).toHaveLength(0);
    await click("Filter OpenRig inbox: Alerts");
    expect(displayMessages()).toHaveLength(1);
    await click("Filter OpenRig inbox: All");
    await click("Mark all loaded as read");
    expect(
      rendered!.root.findAllByProps({ "aria-label": "1 unread items requiring your attention" }),
    ).toHaveLength(0);
    await click("Filter OpenRig inbox: Unread");
    expect(output()).toContain("You're caught up");
    await click("Filter OpenRig inbox: All");
    await act(async () => {
      rendered!.root
        .findByProps({ "aria-label": "Search human inbox messages" })
        .props.onChange({ currentTarget: { value: "reviewer" } });
    });
    expect(displayMessages()).toHaveLength(1);
    await click("Open inbox message: Approval required");
    expect(output()).toContain("no approval has been sent");
    expect(output()).toContain("no native T3");
  });

  it("does not notify on first connection; shows one clickable toast for new genuine items", async () => {
    read.mockResolvedValue(sample);
    await mount();
    expect(output()).not.toContain("New human message");
    const newItem = {
      ...sample.items[0]!,
      id: "queue-2",
      sender: "new-agent@rig",
      subject: "Requested update",
      humanIntent: "update" as const,
      notificationReason: "requested" as const,
      body: "Please inspect this new message.",
    };
    read.mockResolvedValue({ ...sample, count: 4, items: [...sample.items, newItem] });
    await refreshWhileClosed();
    expect(
      rendered!.root.findByProps({ "aria-label": "New OpenRig message notification" }),
    ).toBeTruthy();
    expect(output()).toContain("new-agent@rig");
    expect(output()).toContain("Please inspect this new message.");
    await click("Read new message from new-agent@rig");
    expect(output()).toContain("Please inspect this new message.");
    expect(output()).not.toContain("New human message");
    expect(
      rendered!.root.findByProps({ "aria-label": "1 unread items requiring your attention" }),
    ).toBeTruthy();
    await click("Close human inbox");
    await click("OpenRig human inbox");
    await click("Refresh OpenRig human inbox");
    expect(output()).not.toContain("New human message");
  });

  it("keeps independent persistent sound, popup and AISpeak settings; speech respects 20 words", async () => {
    read.mockResolvedValue(sample);
    await mount();
    await click("OpenRig human inbox");
    await changeCheckbox("Enable inbox notification sound", false);
    await changeCheckbox("Enable AISpeak message previews", true);
    expect(storage.get("t3code:openrig-human-inbox-sound:v1")).toBe("off");
    expect(storage.get("t3code:openrig-human-inbox-speech:v1")).toBe("on");
    const newItem = {
      ...sample.items[0]!,
      id: "queue-2",
      subject: "Requested release update",
      humanIntent: "update" as const,
      notificationReason: "requested" as const,
      body: "One two three four five six seven eight nine ten eleven twelve thirteen fourteen quinze sixteen seventeen dix-neuf twenty long text",
    };
    read.mockResolvedValue({ ...sample, items: [newItem, ...sample.items], count: 4 });
    await click("Close human inbox");
    await refreshWhileClosed();
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0]![0].trim().split(/\s+/u).length).toBeLessThanOrEqual(20);
    await click("OpenRig human inbox");
    await changeCheckbox("Enable notification popups", false);
    expect(storage.get("t3code:openrig-human-inbox-notifications:v1")).toBe("off");
    expect(output()).not.toContain("New human message");
    await click("Close human inbox");
    const later = { ...newItem, id: "queue-3", subject: "Third message" };
    read.mockResolvedValue({ ...sample, items: [later, newItem, ...sample.items], count: 5 });
    await refreshWhileClosed();
    expect(output()).not.toContain("New human message");
    expect(speak).toHaveBeenCalledTimes(2);
    expect(inboxSpeechPreview(newItem).split(/\s+/u).length).toBeLessThanOrEqual(20);
  });

  it("right-click archives a single message and restores it from Archived, persisting across remounts", async () => {
    read.mockResolvedValue(sample);
    await mount();
    await click("OpenRig human inbox");
    await click("Filter OpenRig inbox: All");
    await contextMessage("Build complete");
    expect(rendered!.root.findByProps({ "aria-label": "Message context menu" })).toBeTruthy();
    await click("Archive locally");
    expect(displayMessages()).toHaveLength(2);
    expect(output()).toContain("1 for you");
    expect(output()).toContain("OpenRig originals were not changed");
    expect(storage.get("t3code:openrig-human-inbox-archived:v1")).toContain("queue-1");
    await act(async () => {
      rendered?.unmount();
    });
    rendered = undefined;
    await mount();
    await click("OpenRig human inbox");
    await click("Filter OpenRig inbox: All");
    expect(displayMessages()).toHaveLength(2);
    await click("Filter OpenRig inbox: Archived");
    expect(displayMessages()).toHaveLength(1);
    await contextMessage("Build complete");
    await click("Restore to inbox");
    expect(displayMessages()).toHaveLength(0);
    await click("Filter OpenRig inbox: All");
    expect(displayMessages()).toHaveLength(3);
  });

  it("right-click moves to local trash, hides across refresh and restores without touching server", async () => {
    read.mockResolvedValue(sample);
    await mount();
    await click("OpenRig human inbox");
    await click("Filter OpenRig inbox: All");
    await contextMessage("Approval required");
    await click("Move to local trash");
    expect(displayMessages()).toHaveLength(2);
    expect(output()).not.toContain("1 alerts or read-only decisions in loaded results");
    await click("Refresh OpenRig human inbox");
    expect(displayMessages()).toHaveLength(2);
    await click("Filter OpenRig inbox: Trash");
    expect(displayMessages()).toHaveLength(1);
    await contextMessage("Approval required");
    await click("Restore to inbox");
    await click("Filter OpenRig inbox: All");
    expect(displayMessages()).toHaveLength(3);
    expect(read).toHaveBeenCalled();
    expect(storage.get("t3code:openrig-human-inbox-deleted:v1")).toBe("[]");
  });

  it("has one-place batch archive for all loaded read and all loaded messages, plus restore", async () => {
    read.mockResolvedValue(sample);
    await mount();
    await click("OpenRig human inbox");
    await click("Filter OpenRig inbox: All");
    await click("Open inbox message: Build complete");
    await manageMessages();
    expect(rendered!.root.findByProps({ "aria-label": "Bulk message actions" })).toBeTruthy();
    await click("Archive all loaded read (1)");
    expect(displayMessages()).toHaveLength(2);
    await manageMessages();
    await click("Archive all loaded inbox (2)");
    expect(displayMessages()).toHaveLength(0);
    await click("Filter OpenRig inbox: Archived");
    expect(displayMessages()).toHaveLength(3);
    await manageMessages();
    await click("Restore all loaded archived (3)");
    await click("Filter OpenRig inbox: All");
    expect(displayMessages()).toHaveLength(3);
  });

  it("requires a confirm step to delete all loaded read or all loaded, with a reversible Trash", async () => {
    read.mockResolvedValue(sample);
    await mount();
    await click("OpenRig human inbox");
    await click("Filter OpenRig inbox: All");
    await click("Open inbox message: Build complete");
    await manageMessages();
    await click("Move all loaded read to trash (1)");
    expect(
      rendered!.root.findByProps({ "aria-label": "Confirm local bulk deletion" }),
    ).toBeTruthy();
    expect(output()).toContain("OpenRig's original messages");
    await click("Cancel local bulk deletion");
    expect(displayMessages()).toHaveLength(3);
    await manageMessages();
    await click("Move all loaded read to trash (1)");
    await click("Confirm move to local trash");
    expect(displayMessages()).toHaveLength(2);
    await manageMessages();
    await click("Move all loaded inbox to trash (2)");
    await click("Confirm move to local trash");
    expect(displayMessages()).toHaveLength(0);
    await click("Filter OpenRig inbox: Trash");
    expect(displayMessages()).toHaveLength(3);
    await manageMessages();
    await click("Restore all loaded trash (3)");
    await click("Filter OpenRig inbox: All");
    expect(displayMessages()).toHaveLength(3);
  });

  it("keeps a message open after reading it in the Unread filter", async () => {
    read.mockResolvedValue(sample);
    await mount();
    await click("OpenRig human inbox");
    await click("Filter OpenRig inbox: Unread");
    await click("Open inbox message: Build complete");
    expect(displayMessages()).toHaveLength(2);
    expect(output()).toContain("Here is the result");
  });

  it("distinguishes unavailable from empty, and never turns truncated counts into global unread totals", async () => {
    read.mockResolvedValue(offline);
    await mount();
    await click("OpenRig human inbox");
    expect(output()).toContain("Queue projection is unavailable");
    expect(output()).not.toContain("No messages for this address");
    await click("Close human inbox");
    read.mockResolvedValue({ ...sample, count: 50, pendingCount: null, truncated: true });
    await click("OpenRig human inbox");
    await click("Refresh OpenRig human inbox");
    expect(output()).toContain("More messages exist");
    expect(output()).toContain("loaded results");
    expect(output()).not.toContain("50 unread");
  });
});

describe("actual server action flags versus response forms", () => {
  const recovery = {
    id: "qitem-stuck-sweep",
    sender: "openrig@kernel",
    recipient: "human@kernel",
    subject: "Stuck sweep: unclaimed-obligation",
    body: "Recovery warning: no worker has claimed this obligation.",
    state: "pending",
    humanIntent: null,
    requiresAction: true,
    sourceType: "queue" as const,
    createdAt: "2026-10-23T12:00:00.000Z",
  };
  const decision = {
    ...recovery,
    id: "qitem-real-decision",
    sender: "planner@rig",
    subject: "Select deployment plan",
    humanIntent: "decision" as const,
    humanForm: {
      version: 2,
      title: "Deployment plan",
      questions: [
        {
          id: "target",
          type: "single-select",
          prompt: "Deploy where?",
          options: [
            { id: "prod", label: "Production" },
            { id: "test", label: "Staging" },
          ],
        },
        {
          id: "flags",
          type: "multi-select",
          prompt: "Enable which flags?",
          minSelected: 1,
          maxSelected: 2,
          options: [
            { id: "a", label: "Alerts" },
            { id: "b", label: "Metrics" },
          ],
        },
        { id: "ratio", type: "slider", prompt: "Traffic percentage", min: 0, max: 100, step: 10 },
      ],
    },
  };

  it("excludes the real unclaimed-obligation warning from the form badge and explains missing questions", async () => {
    const warnings = Array.from({ length: 5 }, (_, index) => ({
      ...recovery,
      id: `qitem-stuck-${index}`,
    }));
    read.mockResolvedValue({ ...sample, items: warnings, pendingCount: 5, count: 5 });
    await mount();
    expect(inboxAttentionKind(warnings[0]!, "human@kernel")).toBe("none");
    expect(output()).not.toContain("pending native answer forms in loaded results");
    expect(output()).not.toContain("5 alerts or read-only decisions in loaded results");
    await click("OpenRig human inbox");
    await click("Filter OpenRig inbox: Forms");
    expect(displayMessages()).toHaveLength(0);
    await click("Filter OpenRig inbox: Alerts");
    expect(displayMessages()).toHaveLength(0);
    await click("Filter OpenRig inbox: All");
    expect(displayMessages()).toHaveLength(5);
    await act(async () => {
      rendered!.root
        .findAllByProps({
          "aria-label": "Open inbox message: Stuck sweep: unclaimed-obligation",
        })[0]!
        .props.onClick();
    });
    expect(output()).not.toContain("supplied no answerable");
    expect(output()).not.toContain("not a multiple-choice prompt");
    expect(output()).not.toContain("Send answers");
    expect(rendered!.root.findByProps({ "aria-label": "Reply to OpenRig message" })).toBeTruthy();
    expect(output()).toContain(
      "Ordinary Reply unavailable until the OpenRig writer is configured.",
    );
    expect(rendered!.root.findByProps({ children: "Submit reply" }).props.disabled).toBe(true);
  });

  it("counts genuine native v2 choices separately from alerts while showing writer unavailability", async () => {
    read.mockResolvedValue({
      ...sample,
      items: [decision, recovery],
      pendingCount: 2,
      count: 2,
      answerWriteAvailable: false,
    } as DesktopOpenRigInbox);
    await mount();
    expect(inboxAttentionKind(decision, "human@kernel")).toBe("form");
    expect(output()).toContain("1 pending native answer forms in loaded results");
    expect(output()).not.toContain("alerts or read-only decisions in loaded results");
    await click("OpenRig human inbox");
    await click("Filter OpenRig inbox: Forms");
    expect(displayMessages()).toHaveLength(1);
    await click("Open inbox message: Select deployment plan");
    expect(output()).toContain("Deploy where?");
    expect(output()).toContain("Enable which flags?");
    expect(output()).toContain("Traffic percentage");
    expect(output()).toContain("durable answer writer is unavailable");
    expect(rendered!.root.findByProps({ "aria-label": "Send answers" }).props.disabled).toBe(true);
    expect(rendered!.root.findByProps({ "aria-label": "Reply to OpenRig message" })).toBeTruthy();
    expect(rendered!.root.findByProps({ children: "Submit reply" }).props.disabled).toBe(true);
  });
});

describe("human inbox arrival checkpoint", () => {
  it("keeps a per-destination durable baseline and ignores repeated reads", () => {
    const items = sample.items;
    expect(detectInboxArrivals("human@kernel", items)).toEqual([]);
    expect(detectInboxArrivals("human@kernel", items)).toEqual([]);
    expect(detectInboxArrivals("owner@external", items)).toEqual([]);
    const next = { ...items[0]!, id: "new" };
    expect(detectInboxArrivals("human@kernel", [next, ...items])).toEqual([next]);
    expect(detectInboxArrivals("human@kernel", [next, ...items])).toEqual([]);
  });
});
