import type { DesktopOpenRigInbox, DesktopOpenRigInboxItem } from "@t3tools/contracts";
import {
  AlertCircleIcon,
  BellIcon,
  CheckCheckIcon,
  ArchiveIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  Trash2Icon,
  ChevronRightIcon,
  InboxIcon,
  RefreshCwIcon,
  SearchIcon,
  Volume2Icon,
  VolumeXIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { isElectron } from "../../env";
import { OpenRigFloatingWindow, type FloatingSize } from "./OpenRigFloatingWindow";
import { OpenRigHumanReplyComposer, type HumanReplyRequest } from "./OpenRigHumanReplyComposer";
import { OpenRigRichInboxMessage, isNativeInboxDecision } from "./OpenRigRichInboxMessage";
import { OpenRigCanonicalSpawnApprovals } from "./OpenRigSpawnApproval";
import { observeResize } from "../../lib/observeResize";

type InboxItem = DesktopOpenRigInboxItem;
type Filter = "focus" | "all" | "unread" | "action" | "alerts" | "archived" | "trash";
type AttentionKind = "form" | "approval" | "legacy" | "alert" | "none";

/** Server requiresAction also marks recovery sweeps and unread mailbox notices.
 * It is not evidence of a native form the human can submit from T3. */
export function inboxAttentionKind(item: InboxItem, address: string): AttentionKind {
  // Old daemon versions can mistakenly flag automated sweeps as actionable.
  if (
    item.sourceType === "mailbox" ||
    (item.sourceType === "queue" && /^Stuck sweep:/i.test(item.subject))
  )
    return "none";
  if (isNativeInboxDecision(item, address)) return "form";
  if (item.attentionKind === "notice" || item.attentionKind === "message") return "none";
  if (item.sourceType === "spawn_approval") return "approval";
  if (item.sourceType === "human_gate" && item.requiresAction && item.state !== "done")
    return "approval";
  if (item.humanQuestions != null && item.state === "pending") return "legacy";
  // An older daemon may mark every human-destined legacy message as actionable.
  // A bare boolean without an actual decision marker is not enough to interrupt.
  if (item.requiresAction && (item.humanIntent === "decision" || item.attentionKind === "decision"))
    return "alert";
  return "none";
}

/** A human decision or explicitly requested/exceptional progress notification. */
export function isUserInboxAttention(item: InboxItem, address: string): boolean {
  if (item.humanIntent === "update")
    return (
      item.sourceType === "queue" &&
      (item.notificationReason === "requested" || item.notificationReason === "milestone")
    );
  return inboxAttentionKind(item, address) !== "none";
}

function attentionLabel(kind: AttentionKind, item: InboxItem) {
  switch (kind) {
    case "form":
      return "Answer form";
    case "approval":
      return "Approval blocked · no form here";
    case "legacy":
      return "Legacy choices · preview only";
    case "alert":
      return item.humanIntent === "decision"
        ? "Decision flagged · form missing"
        : "Alert · no reply form";
    case "none":
      return "";
  }
}
type InboxFolder = "archived" | "trash";
type Menu =
  | { kind: "item"; key: string; x: number; y: number }
  | { kind: "bulk"; x: number; y: number };
type BulkDelete = { keys: string[]; label: string };
const ARCHIVE_KEY = "t3code:openrig-human-inbox-archived:v1";
const TRASH_KEY = "t3code:openrig-human-inbox-deleted:v1";
type Notice = { address: string; item: InboxItem; additional: number };

const POLL_INTERVAL_MS = 20_000;
const GEOMETRY_KEY = "t3code:openrig-human-inbox-geometry:v1";
const MIN_SIZE: FloatingSize = { width: 340, height: 360 };
function isEditable(target: EventTarget | null) {
  const element = target as { tagName?: string; isContentEditable?: boolean } | null;
  return Boolean(
    element?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(element?.tagName ?? ""),
  );
}
const TOAST_DURATION_MS = 9_000;
const READ_KEY = "t3code:openrig-human-inbox-read:v1";
const SEEN_PREFIX = "t3code:openrig-human-inbox-observed:v2:";
const SOUND_KEY = "t3code:openrig-human-inbox-sound:v1";
const SPEECH_KEY = "t3code:openrig-human-inbox-speech:v1";
const NOTICES_KEY = "t3code:openrig-human-inbox-notifications:v1";
const MAX_KEYS = 4_000;

export function inboxKey(address: string, item: InboxItem) {
  return JSON.stringify([address, item.sourceType, item.id]);
}

function readStoredString(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStoredString(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* session-only preference */
  }
}
function readKeys(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readStoredString(key) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string").slice(-MAX_KEYS)
      : [];
  } catch {
    return [];
  }
}
function dateLabel(value: string) {
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? value
    : time.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
function shortLabel(value: string) {
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? value
    : time.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function sourceLabel(item: InboxItem) {
  return item.sourceType === "human_gate"
    ? "Human decision"
    : item.sourceType === "mailbox"
      ? "Mailbox"
      : "Direct message";
}
export function inboxPreview(item: InboxItem, limit = 180): string {
  const cleaned = item.body.replace(/\s+/gu, " ").trim();
  return cleaned.length > limit ? cleaned.slice(0, limit - 1).trimEnd() + "…" : cleaned;
}
/** AISpeak's actual script accepts at most 20 words; it is NOT character-only. */
export function inboxSpeechPreview(item: InboxItem): string {
  return [item.sender + ".", item.subject + ".", inboxPreview(item, 220)]
    .join(" ")
    .trim()
    .split(/\s+/u)
    .slice(0, 20)
    .join(" ")
    .slice(0, 160)
    .trim();
}

/**
 * No initial historical-message toasts. A first successful sync establishes a
 * durable baseline per recipient, while later additions trigger at most one
 * audible/visible notification per polling batch. Read receipts are distinct.
 */
export function detectInboxArrivals(address: string, items: readonly InboxItem[]): InboxItem[] {
  const key = SEEN_PREFIX + address;
  const previous = readStoredString(key);
  const known = new Set(readKeys(key));
  const incoming = items.filter((item) => !known.has(inboxKey(address, item)));
  writeStoredString(
    key,
    JSON.stringify([...known, ...items.map((item) => inboxKey(address, item))].slice(-MAX_KEYS)),
  );
  return previous === null ? [] : incoming;
}

function chime() {
  try {
    const AudioContextConstructor = window.AudioContext;
    if (!AudioContextConstructor) return;
    const context = new AudioContextConstructor();
    const start = context.currentTime;
    for (const [offset, frequency] of [
      [0, 660],
      [0.12, 880],
    ] as const) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.055, start + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.17);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.18);
    }
    window.setTimeout(() => {
      void context.close();
    }, 600);
  } catch {
    /* No audio device / autoplay restriction: still show notification. */
  }
}

export function OpenRigOperatorInbox() {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("human@kernel");
  const [addresses, setAddresses] = useState([
    { address: "human@kernel", label: "Local operator seat" },
  ]);
  const [snapshot, setSnapshot] = useState<DesktopOpenRigInbox | null>(null);
  const [connection, setConnection] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [filter, setFilter] = useState<Filter>("focus");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [readIds, setReadIds] = useState<string[]>(() => readKeys(READ_KEY));
  const [archivedIds, setArchivedIds] = useState<string[]>(() => readKeys(ARCHIVE_KEY));
  const [trashedIds, setTrashedIds] = useState<string[]>(() => readKeys(TRASH_KEY));
  const [menu, setMenu] = useState<Menu | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<BulkDelete | null>(null);
  const [sound, setSound] = useState(() => readStoredString(SOUND_KEY) !== "off");
  const [speech, setSpeech] = useState(() => readStoredString(SPEECH_KEY) === "on");
  const [notifications, setNotifications] = useState(() => readStoredString(NOTICES_KEY) !== "off");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [position, setPosition] = useState({ left: 338, top: 100 });
  const [announcement, setAnnouncement] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const openRef = useRef(false);
  const soundRef = useRef(sound);
  const speechRef = useRef(speech);
  const notificationsRef = useRef(notifications);
  // Suppress repeat alerts for an ID even if a backend page reorders.
  // Local OMCP requests update the same T3 preferences as sidebar actions.
  useEffect(() => {
    const update = () => {
      setReadIds(readKeys(READ_KEY));
      setArchivedIds(readKeys(ARCHIVE_KEY));
      setTrashedIds(readKeys(TRASH_KEY));
    };
    window.addEventListener("t3:openrig-human-inbox-local-state-changed", update);
    return () => window.removeEventListener("t3:openrig-human-inbox-local-state-changed", update);
  }, []);
  useEffect(() => {
    writeStoredString(READ_KEY, JSON.stringify(readIds));
  }, [readIds]);
  useEffect(() => {
    writeStoredString(ARCHIVE_KEY, JSON.stringify(archivedIds));
  }, [archivedIds]);
  useEffect(() => {
    writeStoredString(TRASH_KEY, JSON.stringify(trashedIds));
  }, [trashedIds]);
  useEffect(() => {
    soundRef.current = sound;
    writeStoredString(SOUND_KEY, sound ? "on" : "off");
  }, [sound]);
  useEffect(() => {
    speechRef.current = speech;
    writeStoredString(SPEECH_KEY, speech ? "on" : "off");
  }, [speech]);
  useEffect(() => {
    notificationsRef.current = notifications;
    writeStoredString(NOTICES_KEY, notifications ? "on" : "off");
  }, [notifications]);

  const refresh = useCallback(async (destination: string) => {
    const version = ++requestId.current;
    setLoading(true);
    try {
      const reader = window.desktopBridge?.readOpenRigOperatorInbox;
      if (!reader) throw new Error("This T3 desktop does not support the Human Inbox.");
      const result = await reader(destination);
      if (version !== requestId.current) return;
      setSnapshot(result);
      setAddresses([...result.addresses]);
      setUpdated(new Date());
      setConnection(result.available ? "ready" : "error");
      setErrorMessage(
        result.available ? "" : (result.reason ?? "OpenRig's inbox reader is unavailable."),
      );
      if (result.available) {
        const arrivals = detectInboxArrivals(destination, result.items).filter((item) =>
          isUserInboxAttention(item, destination),
        );
        if (arrivals.length > 0) {
          const newest = arrivals[0]!;
          if (notificationsRef.current && !openRef.current)
            setNotice({ address: destination, item: newest, additional: arrivals.length - 1 });
          if (soundRef.current) chime();
          if (speechRef.current) {
            const speak = window.desktopBridge?.speakOpenRigPreview;
            if (speak)
              void speak(inboxSpeechPreview(newest)).catch(() => {
                setAnnouncement("AISpeak could not play the new message preview.");
              });
          }
        }
      }
    } catch (error) {
      if (version !== requestId.current) return;
      setConnection("error");
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (version === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => refresh(address));
    const timer = window.setInterval(() => {
      void refresh(address);
    }, POLL_INTERVAL_MS);
    const visible = () => {
      if (document.visibilityState === "visible") void refresh(address);
    };
    document.addEventListener?.("visibilitychange", visible);
    return () => {
      requestId.current++;
      window.clearInterval(timer);
      document.removeEventListener?.("visibilitychange", visible);
    };
  }, [refresh, address]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const updatePosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({
      left: Math.max(12, Math.min(rect.right + 12, window.innerWidth - 340)),
      top: Math.max(75, Math.min(rect.top, window.innerHeight - 180)),
    });
  }, []);
  useEffect(() => {
    if (!open && !notice) return;
    updatePosition();
    window.addEventListener?.("resize", updatePosition);
    // The sidebar can be resized without resizing the viewport.
    const root = buttonRef.current?.closest('[data-slot="sidebar"]');
    const stopObserving = root ? observeResize(root, updatePosition) : () => {};
    return () => {
      window.removeEventListener?.("resize", updatePosition);
      stopObserving();
    };
  }, [open, notice, updatePosition]);

  const markRead = useCallback((keys: string[]) => {
    setReadIds((prior) => {
      const known = new Set(prior);
      const fresh = keys.filter((k) => !known.has(k));
      return fresh.length ? [...prior, ...fresh].slice(-MAX_KEYS) : prior;
    });
  }, []);
  const markUnread = useCallback((key: string) => {
    setReadIds((prior) => prior.filter((item) => item !== key));
  }, []);

  const items = snapshot?.available
    ? [...snapshot.items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    : [];
  const knownRead = useMemo(() => new Set(readIds), [readIds]);
  const archived = useMemo(() => new Set(archivedIds), [archivedIds]);
  const trashed = useMemo(() => new Set(trashedIds), [trashedIds]);
  const active = items.filter(
    (item) => !archived.has(inboxKey(address, item)) && !trashed.has(inboxKey(address, item)),
  );
  const archivedItems = items.filter(
    (item) => archived.has(inboxKey(address, item)) && !trashed.has(inboxKey(address, item)),
  );
  const trashedItems = items.filter((item) => trashed.has(inboxKey(address, item)));
  const unread = active.filter((item) => !knownRead.has(inboxKey(address, item)));
  const attention = active.filter((item) => isUserInboxAttention(item, address));
  const unreadAttention = attention.filter((item) => !knownRead.has(inboxKey(address, item)));
  const action = active.filter((item) => inboxAttentionKind(item, address) === "form");
  const alerts = active.filter((item) =>
    ["approval", "legacy", "alert"].includes(inboxAttentionKind(item, address)),
  );
  // The current desktop schema may omit this newer OpenRig capability field.
  // Do not conflate an omitted value with server-confirmed writer unavailability.
  const answerWriteAvailable = snapshot?.answerWriteAvailable;
  const replyWriteAvailable = snapshot?.available === true && snapshot.replyWriteAvailable === true;
  const filtered = (
    filter === "archived" ? archivedItems : filter === "trash" ? trashedItems : active
  ).filter((item) => {
    // Derivative diagnostics are shown within the originating message, not as
    // separate new correspondence. An orphan remains accessible in All.
    if (
      filter !== "archived" &&
      filter !== "trash" &&
      item.relatedTo &&
      items.some((parent) => parent.id === item.relatedTo)
    )
      return false;
    const related = items.filter((child) => child.relatedTo === item.id);
    const matches =
      !search.trim() ||
      [
        item.subject,
        item.sender,
        item.body,
        ...related.flatMap((child) => [child.subject, child.body]),
      ].some((value) => value.toLowerCase().includes(search.trim().toLowerCase()));
    return (
      matches &&
      (filter === "all" ||
        (filter === "focus"
          ? isUserInboxAttention(item, address)
          : filter === "unread"
            ? !knownRead.has(inboxKey(address, item))
            : filter === "action"
              ? inboxAttentionKind(item, address) === "form"
              : filter === "alerts"
                ? inboxAttentionKind(item, address) !== "none" &&
                  inboxAttentionKind(item, address) !== "form"
                : true))
    );
  });
  // Keep the right-hand detail visible when opening a message marks it read
  // and therefore removes it from the Unread list.
  const chosen =
    (filter === "archived" ? archivedItems : filter === "trash" ? trashedItems : active).find(
      (item) => inboxKey(address, item) === selected,
    ) ?? null;
  const relatedDiagnostics = chosen ? items.filter((item) => item.relatedTo === chosen.id) : [];

  // No OpenRig delete/archive endpoint exists. These are reversible local T3
  // folders that only hide records in this installation; queue decisions and
  // delivery semantics on the OpenRig server remain completely unchanged.
  const moveMessages = (keys: string[], destination: InboxFolder | "inbox") => {
    if (!keys.length) return;
    const moving = new Set(keys);
    setArchivedIds((prior) => {
      const kept = prior.filter((key) => !moving.has(key));
      return destination === "archived" ? [...kept, ...keys].slice(-MAX_KEYS) : kept;
    });
    setTrashedIds((prior) => {
      const kept = prior.filter((key) => !moving.has(key));
      return destination === "trash" ? [...kept, ...keys].slice(-MAX_KEYS) : kept;
    });
    setSelected((prior) => (prior && moving.has(prior) ? null : prior));
    setNotice((prior) => (prior && moving.has(inboxKey(prior.address, prior.item)) ? null : prior));
    setMenu(null);
    setAnnouncement(
      destination === "inbox"
        ? `Restored ${keys.length} message(s) to this device's inbox.`
        : `${destination === "archived" ? "Archived" : "Moved to local trash"} ${keys.length} message(s) on this device only. OpenRig originals were not changed.`,
    );
  };
  const showItemMenu = (key: string, x: number, y: number) => {
    setMenu({ kind: "item", key, x, y });
  };
  const showBulkMenu = (x: number, y: number) => setMenu({ kind: "bulk", x, y });
  const executeMenu = (action: string) => {
    if (!menu) return;
    if (menu.kind === "item") {
      const key = menu.key;
      if (action === "markRead") markRead([key]);
      if (action === "markUnread") markUnread(key);
      if (action === "archive") moveMessages([key], "archived");
      if (action === "trash") moveMessages([key], "trash");
      if (action === "restore") moveMessages([key], "inbox");
      if (action === "copy") {
        const item = items.find((entry) => inboxKey(address, entry) === key);
        if (item)
          void navigator.clipboard
            ?.writeText(`${item.subject}\nFrom: ${item.sender}\n\n${item.body}`)
            .then(
              () => setAnnouncement("Message copied."),
              () => setAnnouncement("Copy unavailable."),
            );
      }
    } else {
      const currentKeys = active.map((item) => inboxKey(address, item));
      const readKeys = active
        .filter((item) => knownRead.has(inboxKey(address, item)))
        .map((item) => inboxKey(address, item));
      if (action === "archiveAll") moveMessages(currentKeys, "archived");
      if (action === "archiveRead") moveMessages(readKeys, "archived");
      if (action === "trashAll" || action === "trashRead" || action === "trashArchived") {
        const keys =
          action === "trashAll"
            ? currentKeys
            : action === "trashRead"
              ? readKeys
              : archivedItems.map((item) => inboxKey(address, item));
        setConfirmDelete({
          keys,
          label:
            action === "trashRead"
              ? "all loaded read messages"
              : action === "trashArchived"
                ? "all loaded archived messages"
                : "all loaded inbox messages",
        });
      }
      if (action === "restoreArchived")
        moveMessages(
          archivedItems.map((item) => inboxKey(address, item)),
          "inbox",
        );
      if (action === "restoreTrash")
        moveMessages(
          trashedItems.map((item) => inboxKey(address, item)),
          "inbox",
        );
    }
    setMenu(null);
  };
  const itemMenu =
    menu?.kind === "item" ? items.find((item) => inboxKey(address, item) === menu.key) : null;
  const folderForItem =
    itemMenu && trashed.has(inboxKey(address, itemMenu))
      ? "trash"
      : itemMenu && archived.has(inboxKey(address, itemMenu))
        ? "archived"
        : "all";
  const menuActions: { id: string; label: string; destructive?: boolean }[] =
    menu?.kind === "item"
      ? [
          {
            id: knownRead.has(menu.key) ? "markUnread" : "markRead",
            label: knownRead.has(menu.key) ? "Mark unread" : "Mark read",
          },
          ...(folderForItem === "all"
            ? [{ id: "archive", label: "Archive locally" }]
            : [{ id: "restore", label: "Restore to inbox" }]),
          ...(folderForItem === "trash"
            ? []
            : [{ id: "trash", label: "Move to local trash", destructive: true }]),
          { id: "copy", label: "Copy message" },
        ]
      : filter === "trash"
        ? [{ id: "restoreTrash", label: `Restore all loaded trash (${trashedItems.length})` }]
        : filter === "archived"
          ? [
              {
                id: "restoreArchived",
                label: `Restore all loaded archived (${archivedItems.length})`,
              },
              {
                id: "trashArchived",
                label: `Move all loaded archived to trash (${archivedItems.length})`,
                destructive: true,
              },
            ]
          : [
              {
                id: "archiveRead",
                label: `Archive all loaded read (${active.length - unread.length})`,
              },
              { id: "archiveAll", label: `Archive all loaded inbox (${active.length})` },
              {
                id: "trashRead",
                label: `Move all loaded read to trash (${active.length - unread.length})`,
                destructive: true,
              },
              {
                id: "trashAll",
                label: `Move all loaded inbox to trash (${active.length})`,
                destructive: true,
              },
            ];

  const openInbox = useCallback(
    (item?: InboxItem, destination?: string) => {
      if (destination && destination !== address) setAddress(destination);
      if (item) {
        setFilter("focus");
        setSearch("");
        const key = inboxKey(destination ?? address, item);
        setSelected(key);
        markRead([key]);
      }
      openRef.current = true;
      setOpen(true);
      setNotice(null);
      window.setTimeout(() => searchRef.current?.focus(), 0);
    },
    [address, markRead],
  );
  const closeInbox = useCallback(() => {
    openRef.current = false;
    setMenu(null);
    setConfirmDelete(null);
    setOpen(false);
    buttonRef.current?.focus();
  }, []);
  const openMessage = (item: InboxItem) => {
    const key = inboxKey(address, item);
    setSelected(key);
    markRead([key]);
  };
  // The inbox is nonmodal: Escape typed in the main app must not close it. The
  // window handles its own Escape; menus and the confirmation render outside it.
  useEffect(() => {
    if (!open || (!menu && !confirmDelete)) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (confirmDelete) setConfirmDelete(null);
      else setMenu(null);
    };
    document.addEventListener?.("keydown", keydown);
    return () => document.removeEventListener?.("keydown", keydown);
  }, [open, menu, confirmDelete]);
  const escapeInbox = () => {
    if (confirmDelete) setConfirmDelete(null);
    else if (menu) setMenu(null);
    else closeInbox();
  };
  const defaultGeometry = useCallback((viewport: FloatingSize) => {
    const rect = buttonRef.current?.getBoundingClientRect?.();
    const left = rect ? rect.right + 12 : 338;
    return {
      left,
      top: 64,
      width: Math.min(970, viewport.width - left - 22),
      height: Math.min(790, viewport.height - 90),
    };
  }, []);

  if (!isElectron) return null;

  const overlays = (
    <>
      {notice && !open && notifications && (
        <aside
          role="status"
          aria-label="New OpenRig message notification"
          className="fixed z-60 w-[min(370px,calc(100vw-28px))] overflow-hidden rounded-xl border border-info/40 bg-popover text-popover-foreground shadow-2xl"
          style={{ left: position.left, top: position.top }}
        >
          <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-info/10 px-3 py-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-info">
              <BellIcon className="size-4" /> New human message
              {notice.additional ? ` +${notice.additional} more` : ""}
            </span>
            <button
              aria-label="Dismiss inbox notification"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setNotice(null)}
              type="button"
            >
              <XIcon className="size-4" />
            </button>
          </div>
          <button
            aria-label={`Read new message from ${notice.item.sender}`}
            className="block w-full p-3 text-left hover:bg-muted/30"
            type="button"
            onClick={() => openInbox(notice.item, notice.address)}
          >
            <span className="block truncate text-sm font-semibold">{notice.item.sender}</span>
            <span className="mt-0.5 block truncate text-xs font-medium">{notice.item.subject}</span>
            <span className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
              {inboxPreview(notice.item, 190)}
            </span>
            <span className="mt-2 block text-2xs font-semibold text-info">
              Open in Human Inbox →
            </span>
          </button>
        </aside>
      )}
      {open && (
        <OpenRigFloatingWindow
          id="openrig-human-inbox"
          label="OpenRig human inbox window"
          storageKey={GEOMETRY_KEY}
          defaultGeometry={defaultGeometry}
          minSize={MIN_SIZE}
          compactBelow={640}
          panelRef={panelRef}
          onEscape={escapeInbox}
          onKeyDown={(event) => {
            if (event.key === "/" && !isEditable(event.target)) {
              event.preventDefault();
              searchRef.current?.focus();
            }
          }}
          header={() => (
            <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-info/10 text-info">
                <InboxIcon className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold">Human inbox</h2>
                <p className="text-2xs text-muted-foreground">
                  {connection === "ready"
                    ? `${attention.length}${snapshot?.truncated ? "+" : ""} for you · ${unreadAttention.length}${snapshot?.truncated ? "+" : ""} unread`
                    : "OpenRig connection unavailable"}{" "}
                  {updated &&
                    ` · Updated ${updated.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`}
                </p>
              </div>
              <button
                type="button"
                aria-label="Refresh OpenRig human inbox"
                disabled={loading}
                className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                onClick={() => void refresh(address)}
              >
                <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} />
              </button>
              <button
                type="button"
                aria-label="Close human inbox"
                className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={closeInbox}
              >
                <XIcon className="size-5" />
              </button>
            </header>
          )}
        >
          {({ compact }) => (
            <>
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  Inbox
                  <select
                    aria-label="OpenRig human destination"
                    className="max-w-52 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                    value={address}
                    onChange={(event) => {
                      setAddress(event.currentTarget.value);
                      setSelected(null);
                      setSearch("");
                      setFilter("focus");
                    }}
                  >
                    {addresses.map((entry) => (
                      <option key={entry.address} value={entry.address}>
                        {entry.label} · {entry.address}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="flex-1" />
                <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    aria-label="Enable notification popups"
                    checked={notifications}
                    onChange={(e) => {
                      setNotifications(e.currentTarget.checked);
                      if (!e.currentTarget.checked) setNotice(null);
                    }}
                  />
                  <BellIcon className="size-3.5 text-muted-foreground" /> Popups
                </label>
                <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    aria-label="Enable inbox notification sound"
                    checked={sound}
                    onChange={(e) => setSound(e.currentTarget.checked)}
                  />
                  {sound ? (
                    <Volume2Icon className="size-3.5 text-muted-foreground" />
                  ) : (
                    <VolumeXIcon className="size-3.5 text-muted-foreground" />
                  )}{" "}
                  Sound
                </label>
                <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    aria-label="Enable AISpeak message previews"
                    checked={speech}
                    disabled={!window.desktopBridge?.speakOpenRigPreview}
                    onChange={(e) => setSpeech(e.currentTarget.checked)}
                  />
                  AISpeak <span className="text-2xs text-muted-foreground">(20 words)</span>
                </label>
              </div>
              {connection === "error" && (
                <div
                  role="status"
                  className="mx-4 mt-2 flex shrink-0 items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
                >
                  <AlertCircleIcon className="size-4 shrink-0" />{" "}
                  {errorMessage || "OpenRig inbox is unavailable."}{" "}
                  {snapshot?.available ? "Showing last synced messages." : ""}
                </div>
              )}
              {address === "human@kernel" && (
                <div className="max-h-72 shrink-0 overflow-y-auto border-b border-border px-4 py-2">
                  <OpenRigCanonicalSpawnApprovals seatId={null} seatName={(seatId) => seatId} />
                </div>
              )}
              <div
                className={
                  compact
                    ? "flex min-h-0 flex-1 flex-col"
                    : "grid min-h-0 flex-1 grid-cols-[minmax(150px,36%)_minmax(0,1fr)]"
                }
              >
                <div
                  className={`min-h-0 min-w-0 flex-col bg-muted/10 ${compact ? (chosen ? "hidden" : "flex flex-1") : "flex border-r border-border"}`}
                >
                  <div className="shrink-0 space-y-2 border-b border-border p-3">
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5">
                      <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
                      <input
                        ref={searchRef}
                        aria-label="Search human inbox messages"
                        type="search"
                        placeholder="Search messages"
                        className="h-9 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                        value={search}
                        onChange={(e) => setSearch(e.currentTarget.value)}
                        onKeyDown={(event) => {
                          // First Escape clears the query; the next one closes the inbox.
                          if (event.key === "Escape" && search) {
                            event.preventDefault();
                            setSearch("");
                          }
                        }}
                      />
                    </div>
                    <div
                      role="group"
                      aria-label="Filter OpenRig inbox"
                      className="flex flex-wrap gap-1"
                    >
                      {(
                        [
                          ["focus", "For you", attention.length],
                          ["all", "All", active.length],
                          ["unread", "Unread", unread.length],
                          ["action", "Forms", action.length],
                          ["alerts", "Alerts", alerts.length],
                          ["archived", "Archived", archivedItems.length],
                          ["trash", "Trash", trashedItems.length],
                        ] as const
                      ).map(([mode, text, count]) => (
                        <button
                          type="button"
                          key={mode}
                          aria-label={`Filter OpenRig inbox: ${text}`}
                          aria-pressed={filter === mode}
                          className={`rounded-md px-2 py-1.5 text-2xs font-medium ${filter === mode ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted"}`}
                          onClick={() => setFilter(mode)}
                        >
                          {text}{" "}
                          <span
                            className={
                              (mode === "unread" || mode === "focus") && count
                                ? "text-info"
                                : (mode === "action" || mode === "alerts") && count
                                  ? "text-warning"
                                  : ""
                            }
                          >
                            {count}
                            {snapshot?.truncated ? "+" : ""}
                          </span>
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      aria-label="Manage inbox messages"
                      className="inline-flex items-center gap-1 rounded-md border border-border/80 px-2 py-1.5 text-2xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        showBulkMenu(rect.left, rect.bottom + 6);
                      }}
                    >
                      <MoreHorizontalIcon className="size-3.5" /> Manage
                    </button>
                    {unread.length > 0 && filter !== "archived" && filter !== "trash" && (
                      <button
                        type="button"
                        aria-label="Mark all loaded as read"
                        className="flex items-center gap-1 text-2xs font-medium text-muted-foreground hover:text-foreground"
                        onClick={() => markRead(unread.map((item) => inboxKey(address, item)))}
                      >
                        <CheckCheckIcon className="size-3.5" /> Mark loaded as read
                      </button>
                    )}
                  </div>
                  <div
                    role="list"
                    aria-label="Human messages"
                    className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
                    onKeyDown={(event) => {
                      if (
                        !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
                        filtered.length === 0
                      )
                        return;
                      event.preventDefault();
                      const index = filtered.findIndex(
                        (item) => inboxKey(address, item) === selected,
                      );
                      const next =
                        event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? filtered.length - 1
                            : event.key === "ArrowDown"
                              ? Math.min(filtered.length - 1, index + 1)
                              : index < 0
                                ? filtered.length - 1
                                : Math.max(0, index - 1);
                      openMessage(filtered[next]!);
                      const rows =
                        event.currentTarget.querySelectorAll<HTMLButtonElement>(
                          'button[role="listitem"]',
                        );
                      rows[next]?.focus();
                    }}
                  >
                    {filtered.length === 0 && (
                      <p className="px-4 py-8 text-center text-xs leading-relaxed text-muted-foreground">
                        {connection === "loading"
                          ? "Loading inbox…"
                          : connection === "error" && !snapshot?.available
                            ? "Messages unavailable."
                            : search
                              ? "No matching messages."
                              : filter === "focus"
                                ? "Nothing needs your attention."
                                : filter === "unread"
                                  ? "You're caught up."
                                  : filter === "action"
                                    ? "No pending native answer forms."
                                    : filter === "alerts"
                                      ? "No alerts or read-only decisions."
                                      : filter === "archived"
                                        ? "No archived messages on this device."
                                        : filter === "trash"
                                          ? "Local trash is empty."
                                          : "No messages for this address."}
                      </p>
                    )}
                    {filtered.map((item) => {
                      const key = inboxKey(address, item);
                      const isUnread = !knownRead.has(key);
                      return (
                        <button
                          key={key}
                          type="button"
                          role="listitem"
                          aria-label={`Open inbox message: ${item.subject}`}
                          aria-current={selected === key ? "true" : undefined}
                          onClick={() => openMessage(item)}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            showItemMenu(key, event.clientX, event.clientY);
                          }}
                          onKeyDown={(event) => {
                            if (
                              event.key === "ContextMenu" ||
                              (event.shiftKey && event.key === "F10")
                            ) {
                              event.preventDefault();
                              const rect = event.currentTarget.getBoundingClientRect();
                              showItemMenu(key, rect.left + 20, rect.top + 20);
                            }
                          }}
                          className={`flex w-full items-start gap-2 border-b border-border/60 px-3 py-3 text-left transition-colors hover:bg-muted/50 ${selected === key ? "bg-info/10 border-l-3 border-l-info" : isUnread ? "bg-info/5" : ""}`}
                        >
                          <span
                            className={`mt-1.5 size-2 shrink-0 rounded-full ${isUnread ? "bg-info" : "bg-transparent"}`}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center justify-between gap-2">
                              <span
                                className={`truncate text-xs ${isUnread ? "font-bold" : "font-medium"}`}
                              >
                                {item.sender}
                              </span>
                              <time
                                dateTime={item.createdAt}
                                className="shrink-0 text-3xs text-muted-foreground"
                              >
                                {shortLabel(item.createdAt)}
                              </time>
                            </span>
                            <span
                              className={`mt-0.5 block truncate text-xs ${isUnread ? "font-semibold" : ""}`}
                            >
                              {item.subject}
                            </span>
                            <span className="mt-1 line-clamp-2 text-2xs leading-relaxed text-muted-foreground">
                              {inboxPreview(item, 110)}
                            </span>
                            {inboxAttentionKind(item, address) !== "none" && (
                              <span className="mt-1.5 inline-flex rounded bg-warning/15 px-1.5 py-0.5 text-3xs font-semibold text-warning">
                                {attentionLabel(inboxAttentionKind(item, address), item)}
                              </span>
                            )}
                          </span>
                          <ChevronRightIcon className="mt-4 size-3.5 shrink-0 text-muted-foreground/50" />
                        </button>
                      );
                    })}
                  </div>
                  <div className="shrink-0 border-t border-border px-3 py-2 text-3xs text-muted-foreground">
                    {snapshot?.truncated
                      ? "More messages exist. Counts cover loaded results only."
                      : "Read status saved locally to this T3 installation."}
                  </div>
                </div>
                <div
                  className={`min-h-0 min-w-0 flex-col ${compact && !chosen ? "hidden" : "flex flex-1"}`}
                >
                  {!chosen ? (
                    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-5 text-center text-muted-foreground">
                      <InboxIcon className="size-8 opacity-40" />
                      <p className="text-sm font-medium">Select a message</p>
                      <p className="max-w-xs text-xs">
                        Choose a message on the left to read it here, without leaving your current
                        T3 session.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="shrink-0 border-b border-border px-5 py-4">
                        {compact && (
                          <button
                            type="button"
                            aria-label="Back to inbox message list"
                            className="mb-2 inline-flex items-center gap-1 text-2xs font-medium text-muted-foreground hover:text-foreground"
                            onClick={() => setSelected(null)}
                          >
                            ← Messages
                          </button>
                        )}
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h3 className="break-words text-lg font-semibold leading-snug">
                              {chosen.subject}
                            </h3>
                            <p className="mt-1 break-all text-sm text-muted-foreground">
                              {chosen.sender}
                            </p>
                          </div>
                          <button
                            type="button"
                            aria-label={
                              knownRead.has(inboxKey(address, chosen))
                                ? `Mark inbox message unread: ${chosen.subject}`
                                : `Mark inbox message read: ${chosen.subject}`
                            }
                            className="shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
                            onClick={() =>
                              knownRead.has(inboxKey(address, chosen))
                                ? markUnread(inboxKey(address, chosen))
                                : markRead([inboxKey(address, chosen)])
                            }
                          >
                            {knownRead.has(inboxKey(address, chosen)) ? "Mark unread" : "Mark read"}
                          </button>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
                          <time dateTime={chosen.createdAt}>{dateLabel(chosen.createdAt)}</time>
                          <span>{sourceLabel(chosen)}</span>
                          {inboxAttentionKind(chosen, address) !== "none" && (
                            <span className="rounded-md bg-warning/15 px-2 py-0.5 font-semibold text-warning">
                              {attentionLabel(inboxAttentionKind(chosen, address), chosen)}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 text-sm leading-7">
                        {inboxAttentionKind(chosen, address) === "approval" && (
                          <div
                            role="status"
                            className="mb-4 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning"
                          >
                            An agent is blocked awaiting human approval. This message has no native
                            T3 approval form; the inbox is read-only and no approval has been sent.
                          </div>
                        )}
                        {inboxAttentionKind(chosen, address) === "alert" && (
                          <div
                            role="status"
                            className="mb-4 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning"
                          >
                            OpenRig flagged this record as requiring action, but supplied no
                            answerable structured decision form.{" "}
                            {chosen.humanIntent === "decision"
                              ? "The requested decision form is missing from this payload."
                              : "This is an alert or recovery/status notice, not a multiple-choice prompt."}{" "}
                            No reply or approval has been sent.
                          </div>
                        )}
                        <OpenRigRichInboxMessage
                          key={inboxKey(address, chosen)}
                          item={chosen}
                          address={address}
                          answerWriteAvailable={answerWriteAvailable}
                          onAnnouncement={setAnnouncement}
                        />
                        {relatedDiagnostics.length > 0 && (
                          <details className="mt-4 rounded-lg border border-border p-3 text-xs">
                            <summary className="cursor-pointer font-medium">
                              Internal recovery history ({relatedDiagnostics.length})
                            </summary>
                            {relatedDiagnostics.map((diagnostic) => (
                              <div key={diagnostic.id} className="mt-3 border-t border-border pt-3">
                                <p className="font-medium">{diagnostic.subject}</p>
                                <time
                                  dateTime={diagnostic.createdAt}
                                  className="text-muted-foreground"
                                >
                                  {dateLabel(diagnostic.createdAt)}
                                </time>
                                <pre className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">
                                  {diagnostic.body}
                                </pre>
                              </div>
                            ))}
                          </details>
                        )}
                        <div className="mt-5">
                          <OpenRigHumanReplyComposer
                            item={chosen}
                            address={address}
                            onAnnouncement={setAnnouncement}
                            unavailableReason={
                              chosen.replyUnavailableReason
                                ? "Reply unavailable: " +
                                  chosen.replyUnavailableReason.replaceAll("_", " ")
                                : "Ordinary Reply unavailable until the OpenRig writer is configured."
                            }
                            {...(chosen.sourceType === "queue" &&
                            chosen.replyEligible === true &&
                            chosen.recipient === "human@kernel" &&
                            address === "human@kernel" &&
                            replyWriteAvailable &&
                            window.desktopBridge?.sendOpenRigOperatorReply
                              ? {
                                  onSend: (request: HumanReplyRequest) =>
                                    window.desktopBridge!.sendOpenRigOperatorReply!({
                                      sourceType: "queue",
                                      qitemId: request.sourceId,
                                      destination: "human@kernel",
                                      requestId: request.operationId,
                                      expectedRecipient: request.to,
                                      message: request.body,
                                    }),
                                }
                              : {})}
                            {...(chosen.sourceType === "queue" &&
                            address === "human@kernel" &&
                            window.desktopBridge?.reconcileOpenRigOperatorReply
                              ? {
                                  onReconcile: (request: HumanReplyRequest) =>
                                    window.desktopBridge!.reconcileOpenRigOperatorReply!({
                                      sourceType: "queue",
                                      qitemId: request.sourceId,
                                      destination: "human@kernel",
                                      requestId: request.operationId,
                                      expectedRecipient: request.to,
                                      message: request.body,
                                    }),
                                }
                              : {})}
                          />
                        </div>
                      </div>
                      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-2 text-2xs text-muted-foreground">
                        <details className="min-w-0 break-all">
                          <summary className="cursor-pointer">Technical details</summary>
                          <span>
                            To: {address} · Record: {chosen.id} · State: {chosen.state}
                          </span>
                        </details>
                        <button
                          type="button"
                          aria-label="Message options"
                          className="shrink-0 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                          onClick={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect();
                            showItemMenu(inboxKey(address, chosen), rect.left, rect.bottom + 4);
                          }}
                        >
                          <MoreHorizontalIcon className="size-4" />
                        </button>
                        <button
                          type="button"
                          aria-label="Copy inbox message"
                          className="shrink-0 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                          onClick={() => {
                            void navigator.clipboard
                              ?.writeText(
                                `${chosen.subject}\nFrom: ${chosen.sender}\n\n${chosen.body}`,
                              )
                              .then(
                                () => setAnnouncement("Message copied."),
                                () => setAnnouncement("Copy was not available."),
                              );
                          }}
                        >
                          Copy
                        </button>
                      </footer>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </OpenRigFloatingWindow>
      )}
      {menu && open && !confirmDelete && (
        <>
          <button
            type="button"
            aria-label="Dismiss inbox menu"
            className="pointer-events-auto fixed inset-0 z-70 cursor-default"
            onClick={() => setMenu(null)}
          />
          <div
            role="menu"
            aria-label={menu.kind === "item" ? "Message context menu" : "Bulk message actions"}
            className="pointer-events-auto fixed z-80 w-64 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-2xl"
            style={{
              left: Math.max(8, Math.min(menu.x, window.innerWidth - 268)),
              top: Math.max(
                8,
                Math.min(menu.y, window.innerHeight - (menuActions.length * 37 + 30)),
              ),
            }}
          >
            {menuActions.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="menuitem"
                aria-label={entry.label}
                className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs hover:bg-muted ${entry.destructive ? "text-destructive" : "text-popover-foreground"}`}
                onClick={() => executeMenu(entry.id)}
              >
                {entry.id.startsWith("archive") ? (
                  <ArchiveIcon className="size-4 shrink-0" />
                ) : entry.id.startsWith("trash") ? (
                  <Trash2Icon className="size-4 shrink-0" />
                ) : entry.id.startsWith("restore") ? (
                  <RotateCcwIcon className="size-4 shrink-0" />
                ) : (
                  <CheckCheckIcon className="size-4 shrink-0" />
                )}
                <span>{entry.label}</span>
              </button>
            ))}
            <p className="border-t border-border/70 px-2 pt-2 text-3xs leading-relaxed text-muted-foreground">
              Local T3 organization only. OpenRig records and pending decisions are unchanged.
            </p>
          </div>
        </>
      )}
      {confirmDelete && open && (
        <div className="pointer-events-auto fixed inset-0 z-90 flex items-center justify-center bg-black/50 p-4">
          <section
            role="alertdialog"
            aria-modal="true"
            aria-label="Confirm local bulk deletion"
            className="w-full max-w-sm rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl"
          >
            <h3 className="text-base font-semibold">
              Move {confirmDelete.keys.length} messages to local trash?
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              This will hide {confirmDelete.label} from this T3 inbox on this device. OpenRig's
              original messages, agent decisions, and delivery records will NOT be deleted or
              resolved. You can restore the messages from Trash.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                aria-label="Cancel local bulk deletion"
                onClick={() => setConfirmDelete(null)}
                className="rounded-lg border border-border px-3 py-2 text-xs hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                aria-label="Confirm move to local trash"
                onClick={() => {
                  moveMessages(confirmDelete.keys, "trash");
                  setConfirmDelete(null);
                }}
                className="rounded-lg bg-destructive px-3 py-2 text-xs font-semibold text-destructive-foreground hover:bg-destructive/90"
              >
                Move to trash
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );

  return (
    <>
      <section
        aria-label="OpenRig human inbox section"
        className={`mx-2 mb-2 mt-2 overflow-hidden rounded-xl border ${connection === "ready" && unreadAttention.length ? "border-info/50 bg-info/7" : connection === "ready" && action.length ? "border-warning/40 bg-warning/5" : "border-sidebar-border bg-muted/20"}`}
      >
        <button
          ref={buttonRef}
          type="button"
          aria-label="OpenRig human inbox"
          aria-expanded={open}
          className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-sidebar-row-hover"
          onClick={() => (open ? closeInbox() : openInbox())}
        >
          <span
            className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${connection === "ready" && unreadAttention.length ? "bg-info/15 text-info" : "bg-muted/40 text-sidebar-foreground"}`}
          >
            <InboxIcon className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">Human inbox</span>
            <span className="block truncate text-2xs text-sidebar-muted-foreground">
              {connection === "ready"
                ? `${attention.length}${snapshot?.truncated ? "+" : ""} for you · ${unreadAttention.length}${snapshot?.truncated ? "+" : ""} unread`
                : connection === "loading"
                  ? "Connecting to OpenRig…"
                  : "Offline · click for details"}
            </span>
          </span>
          {connection === "ready" && unreadAttention.length > 0 && (
            <span
              aria-label={`${unreadAttention.length} unread items requiring your attention`}
              className="min-w-6 rounded-full bg-info px-1.5 py-0.5 text-center text-xs font-bold text-info-foreground"
            >
              {unreadAttention.length}
              {snapshot?.truncated ? "+" : ""}
            </span>
          )}
          {connection === "ready" && action.length > 0 && (
            <span
              aria-label={`${action.length} pending native answer forms in loaded results`}
              className="min-w-6 rounded-full bg-warning/20 px-1.5 py-0.5 text-center text-xs font-bold text-warning"
            >
              {action.length}
              {snapshot?.truncated ? "+" : ""}
            </span>
          )}
          {connection === "ready" && alerts.length > 0 && (
            <span
              aria-label={`${alerts.length} alerts or read-only decisions in loaded results`}
              className="min-w-6 rounded-full bg-muted px-1.5 py-0.5 text-center text-xs font-bold text-muted-foreground"
            >
              {alerts.length}
              {snapshot?.truncated ? "+" : ""}
            </span>
          )}
          {connection === "error" && <AlertCircleIcon className="size-4 shrink-0 text-warning" />}
          <ChevronRightIcon className="size-4 shrink-0 text-sidebar-muted-foreground" />
        </button>
      </section>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      {createPortal(overlays, document.body)}
    </>
  );
}
