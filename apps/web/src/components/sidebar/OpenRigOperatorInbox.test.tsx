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
  it("uses a compact prominent sidebar launcher; details are a separate two-column window", async () => {
    read.mockResolvedValue(sample);
    await mount();
    expect(read).toHaveBeenCalledWith("human@kernel");
    expect(
      rendered!.root.findByProps({ "aria-label": "OpenRig human inbox" }).props["aria-expanded"],
    ).toBe(false);
    expect(
      rendered!.root.findByProps({ "aria-label": "3 unread messages on this device" }),
    ).toBeTruthy();
    expect(
      rendered!.root.findByProps({
        "aria-label": "2 alerts or read-only decisions in loaded results",
      }),
    ).toBeTruthy();
    expect(output()).not.toContain("pending native answer forms in loaded results");
    expect(output()).not.toContain("Build complete");
    await click("OpenRig human inbox");
    expect(rendered!.root.findByProps({ "aria-label": "OpenRig human inbox window" })).toBeTruthy();
    expect(output()).toContain("Select a message");
    expect(output()).toContain("grid-cols-[minmax(150px,36%)_minmax(0,1fr)]");
    expect(displayMessages()).toHaveLength(3);
    expect(output()).toContain("Select a message");
    await click("Close human inbox");
    expect(output()).not.toContain("Select a message");
  });

  it("opens a message in the right pane, marks only that record read and persists it", async () => {
    read.mockResolvedValue(sample);
    await mount();
    await click("OpenRig human inbox");
    await click("Open inbox message: Build complete");
    expect(output()).toContain("Here is the result");
    expect(
      rendered!.root.findByProps({ "aria-label": "2 unread messages on this device" }),
    ).toBeTruthy();
    await click("Mark inbox message unread: Build complete");
    expect(
      rendered!.root.findByProps({ "aria-label": "3 unread messages on this device" }),
    ).toBeTruthy();
    await click("Open inbox message: Build complete");
    await act(async () => {
      rendered!.unmount();
    });
    rendered = undefined;
    await mount();
    expect(
      rendered!.root.findByProps({ "aria-label": "2 unread messages on this device" }),
    ).toBeTruthy();
  });

  it("shows search, actionable filtering, copy affordance and a mark-loaded-read control", async () => {
    read.mockResolvedValue(sample);
    await mount();
    await click("OpenRig human inbox");
    await click("Filter OpenRig inbox: Forms");
    expect(displayMessages()).toHaveLength(0);
    await click("Filter OpenRig inbox: Alerts");
    expect(displayMessages()).toHaveLength(2);
    await click("Filter OpenRig inbox: All");
    await click("Mark all loaded as read");
    expect(
      rendered!.root.findAllByProps({ "aria-label": "3 unread messages on this device" }),
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
      subject: "Another update",
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
      rendered!.root.findByProps({ "aria-label": "3 unread messages on this device" }),
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
      subject: "New release",
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
    await contextMessage("Build complete");
    expect(rendered!.root.findByProps({ "aria-label": "Message context menu" })).toBeTruthy();
    await click("Archive locally");
    expect(displayMessages()).toHaveLength(2);
    expect(output()).toContain("2 inbox");
    expect(output()).toContain("OpenRig originals were not changed");
    expect(storage.get("t3code:openrig-human-inbox-archived:v1")).toContain("queue-1");
    await act(async () => {
      rendered?.unmount();
    });
    rendered = undefined;
    await mount();
    await click("OpenRig human inbox");
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
    await contextMessage("Approval required");
    await click("Move to local trash");
    expect(displayMessages()).toHaveLength(2);
    expect(
      rendered!.root.findByProps({
        "aria-label": "1 alerts or read-only decisions in loaded results",
      }),
    ).toBeTruthy();
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
    expect(inboxAttentionKind(warnings[0]!, "human@kernel")).toBe("alert");
    expect(output()).not.toContain("pending native answer forms in loaded results");
    expect(output()).toContain("5 alerts or read-only decisions in loaded results");
    await click("OpenRig human inbox");
    await click("Filter OpenRig inbox: Forms");
    expect(displayMessages()).toHaveLength(0);
    await click("Filter OpenRig inbox: Alerts");
    expect(displayMessages()).toHaveLength(5);
    await act(async () => {
      rendered!.root
        .findAllByProps({
          "aria-label": "Open inbox message: Stuck sweep: unclaimed-obligation",
        })[0]!
        .props.onClick();
    });
    expect(output()).toContain("supplied no answerable");
    expect(output()).toContain("not a multiple-choice prompt");
    expect(output()).not.toContain("Send answers");
    expect(rendered!.root.findByProps({ "aria-label": "Reply to OpenRig message" })).toBeTruthy();
    expect(output()).toContain("no supported ordinary human Reply endpoint yet");
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
    expect(output()).toContain("1 alerts or read-only decisions in loaded results");
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
