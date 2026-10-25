import { useAtomValue } from "@effect/atom-react";
import { DndContext, PointerSensor, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowDownUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CrownIcon,
  EyeOffIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  chatGPTBrowserLastUrlKey,
  chatGPTBrowserLastWorkingKey,
  chatGPTBrowserThreadRef,
  useChatGPTBrowserSessions,
  type ChatGPTSessionRemovalSource,
} from "../../chatGPTBrowserSessions";
import { isElectron } from "../../env";
import { readChatGPTSpawnReceipts } from "../../chatGPTSpawnReceipts";
import {
  readChatGPTSessionTimeline,
  formatChatGPTSessionDateTime,
  recordChatGPTSessionActiveAt,
} from "../../chatGPTSessionTimestamps";
import {
  applyConfirmedChatGPTSessionMetadata,
  groupChatGPTSessions,
  layoutChatGPTSessions,
  type ChatGPTSessionSortActivity,
  type ChatGPTSessionSortMode,
  type ChatGPTPermanentProject,
} from "../../chatGPTSessionGrouping";
import { shortcutLabelForCommand } from "../../keybindings";
import { searchChatGPTSessionGroups } from "../../chatGPTSessionSearch";
import {
  chatGPTWorkerVisibilityStorageKey,
  chatGPTVerifiedWorkerEvidenceKey,
  captureVerifiedChatGPTWorkerIdentities,
  childChatGPTSessionIds,
  filterChatGPTWorkerGroups,
  linkedChatGPTWorkerIds,
  restoreVerifiedChatGPTWorkerIds,
  type VerifiedChatGPTWorkerIdentity,
} from "../../chatGPTWorkerVisibility";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { resolveSnoozePresets } from "../Sidebar.snooze";
import { useClientSettings } from "../../hooks/useSettings";
import { removeLocalStorageItem, useLocalStorage } from "../../hooks/useLocalStorage";
import * as Schema from "effect/Schema";
import { readThreadPreviewState } from "../../previewStateStore";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { previewEnvironment } from "../../state/preview";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { closePreviewSession } from "../preview/closePreviewSession";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import {
  ChatGPTBrowserRecoveryCoordinator,
  type ChatGPTRecoveryPhase,
} from "./ChatGPTBrowserRecoveryCoordinator";
import { recordSessionClick } from "./chatGPTConversationRecovery";
import {
  readChatGPTRecoveryEvents,
  readChatGPTRecoveryState,
} from "../../chatGPTRecoveryDiagnostics";
import { chatGPTRecoveryHoverDetails } from "./chatGPTRecoveryHoverDetails";
import { ChatGPTBrowserSessionRuntime } from "./ChatGPTBrowserSessionRuntime";
import { ChatGPTWorkerCleanupCoordinator } from "./ChatGPTWorkerCleanupCoordinator";
import { ChatGPTUnusedManualSessionCleanup } from "./ChatGPTUnusedManualSessionCleanup";
import { ChatGPTBrowserSelectionRecovery } from "./ChatGPTBrowserSelectionRecovery";
import { ChatGPTProjectStatusIcon } from "./ChatGPTProjectStatusIcon";
import {
  CHATGPT_SESSION_BORDER_COLORS,
  chatGPTSessionBorderRingClass,
  chatGPTSidebarProjectTitles,
} from "./chatGPTSidebarVisuals";
import { useOpenRigManagerChatGPTSessions } from "./useOpenRigManagerChatGPTSessions";
import { ChatGPTSessionIcon } from "./ChatGPTSessionIcon";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";
import { useChatGPTBrowserSessionActivity } from "./ChatGPTBrowserSessionActivity";
import { chatGPTActivityColorClass } from "./chatGPTActivity";

const VerifiedWorkerEvidenceSchema = Schema.Array(
  Schema.Struct({
    sessionId: Schema.String,
    parentSessionId: Schema.String,
    spawnRequestId: Schema.String,
  }),
);

export function ChatGPTBrowserNewSessionAction() {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const { createSession } = useChatGPTBrowserSessions(environmentId);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  if (!isElectron || !environmentId) return null;
  const shortcutLabel = shortcutLabelForCommand(keybindings, "chatgpt.newSession");
  return (
    <SidebarHeaderIconButton
      label="New ChatGPT session"
      tooltip={shortcutLabel ? `New ChatGPT session (${shortcutLabel})` : "New ChatGPT session"}
      onClick={() =>
        void navigate({
          to: "/browser/$browserSessionId",
          params: { browserSessionId: createSession(undefined, { explicitlyUserCreated: true }) },
        })
      }
    >
      <ChatGPTSessionIcon />
    </SidebarHeaderIconButton>
  );
}

function SortableBrowserSessionRow({
  id,
  activity,
  disabled,
  children,
}: {
  id: string;
  activity: ReturnType<typeof useChatGPTBrowserSessionActivity>;
  disabled: boolean;
  children: (
    dragHandleProps: ReturnType<typeof useSortable>,
    activity: ReturnType<typeof useChatGPTBrowserSessionActivity>,
  ) => ReactNode;
}) {
  const sortable = useSortable({ id, disabled });
  return (
    <SidebarMenuItem
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
        opacity: sortable.isDragging ? 0.5 : undefined,
        position: sortable.isDragging ? "relative" : undefined,
        zIndex: sortable.isDragging ? 1 : undefined,
      }}
    >
      {children(sortable, activity)}
    </SidebarMenuItem>
  );
}

// Tracking stays mounted even when a project or the entire list is collapsed.
function BrowserSessionActivityMonitor({
  id,
  environmentId,
  onChange,
}: {
  id: string;
  environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironmentId>>;
  onChange: (
    id: string,
    activity: ReturnType<typeof useChatGPTBrowserSessionActivity> | null,
  ) => void;
}) {
  const activity = useChatGPTBrowserSessionActivity(environmentId, id);
  useEffect(() => {
    onChange(id, activity);
  }, [
    id,
    onChange,
    activity.age,
    activity.label,
    activity.lastWorkingAt,
    activity.recoveryProblem,
  ]);
  useEffect(() => () => onChange(id, null), [id, onChange]);
  return null;
}

function DroppableProjectHeader({ id, children }: { id: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `group:${id}` });
  return (
    <SidebarMenuItem ref={setNodeRef} className={isOver ? "rounded-md bg-accent" : undefined}>
      {children}
    </SidebarMenuItem>
  );
}

const UNKNOWN_ACTIVITY: ReturnType<typeof useChatGPTBrowserSessionActivity> = {
  age: "unknown",
  label: "ChatGPT status unknown",
  lastWorkingAt: 0,
  recoveryProblem: null,
};

export function ChatGPTBrowserSidebarEntry({
  showCreateAction = true,
}: {
  showCreateAction?: boolean;
}) {
  const navigate = useNavigate();
  const activeSessionId = useParams({ strict: false, select: (params) => params.browserSessionId });
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const environmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const verifiedManagerSessionIds = useOpenRigManagerChatGPTSessions(environmentId);
  const {
    sessions,
    createSession,
    reorderSessions,
    renameSession,
    removeSession,
    setSessionHidden,
    setSessionProject,
    setSessionParent,
    setSessionSnooze,
    setSessionBorderColor,
    syncInferredMetadata,
    pruneExpiredHidden,
  } = useChatGPTBrowserSessions(environmentId);
  // Old worker sessions may have a durable, exact creation receipt even though
  // the session index itself predates createdAt. Decode this journal only once.
  const spawnCreation = useMemo(() => {
    if (!environmentId) return new Map<string, { requestId: string; createdAt: number }>();
    try {
      return new Map(
        readChatGPTSpawnReceipts(environmentId).map((receipt) => [
          receipt.sessionId,
          { requestId: receipt.requestId, createdAt: receipt.createdAt },
        ]),
      );
    } catch {
      return new Map<string, { requestId: string; createdAt: number }>();
    }
  }, [environmentId, sessions]);
  const close = useAtomCommand(previewEnvironment.close);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [recoveryPhases, setRecoveryPhases] = useState<Record<string, ChatGPTRecoveryPhase>>({});
  // Re-selecting the already-open row must run the click recovery again.
  const [selectionRecoveryClick, setSelectionRecoveryClick] = useState(0);
  const onRecoveryPhaseChange = useCallback((id: string, phase: ChatGPTRecoveryPhase | null) => {
    setRecoveryPhases((current) => {
      if (phase === current[id] || (!phase && !(id in current))) return current;
      const next = { ...current };
      if (phase) next[id] = phase;
      else delete next[id];
      return next;
    });
  }, []);
  const [title, setTitle] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [showWorkers, setShowWorkers] = useLocalStorage(
    chatGPTWorkerVisibilityStorageKey(environmentId),
    true,
    Schema.Boolean,
  );
  const [verifiedWorkerSnapshot, setVerifiedWorkerSnapshot] = useLocalStorage(
    chatGPTVerifiedWorkerEvidenceKey(environmentId),
    [] as VerifiedChatGPTWorkerIdentity[],
    VerifiedWorkerEvidenceSchema,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const isSearching = searchQuery.trim().length > 0;
  const [sortMode, setSortMode] = useLocalStorage(
    `t3code:chatgpt-browser:sort:${environmentId ?? "unconnected"}`,
    "started" as ChatGPTSessionSortMode,
    Schema.Literals(["started", "activity"]),
  );
  const [sectionCollapsed, setSectionCollapsed] = useLocalStorage(
    `t3code:chatgpt-browser:collapsed:${environmentId ?? "unconnected"}`,
    false,
    Schema.Boolean,
  );
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useLocalStorage(
    `t3code:chatgpt-browser:collapsed-groups:${environmentId ?? "unconnected"}`,
    [] as string[],
    Schema.Array(Schema.String),
  );
  const collapsedGroups = useMemo(() => new Set(collapsedGroupKeys), [collapsedGroupKeys]);
  const [permanentProjects, setPermanentProjects] = useLocalStorage(
    `t3code:chatgpt-browser:permanent-projects:${environmentId ?? "unconnected"}`,
    [] as ChatGPTPermanentProject[],
    Schema.Array(Schema.Struct({ key: Schema.String, title: Schema.String })),
  );
  const permanentProjectKeys = useMemo(
    () => new Set(permanentProjects.map((project) => project.key)),
    [permanentProjects],
  );
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    sessionId?: string;
    groupKey?: string;
  } | null>(null);
  // Tied to the menu instance so reopening the context menu starts collapsed.
  const [borderSubmenuFor, setBorderSubmenuFor] = useState<typeof contextMenu>(null);
  const borderSubmenuOpen = contextMenu !== null && borderSubmenuFor === contextMenu;
  const snoozePresets = useMemo(
    () => (contextMenu ? resolveSnoozePresets(new Date(), timestampFormat) : []),
    [contextMenu, timestampFormat],
  );
  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    window.addEventListener("click", dismiss);
    window.addEventListener("keydown", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("keydown", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [contextMenu]);
  const [activities, setActivities] = useState<
    Record<string, ReturnType<typeof useChatGPTBrowserSessionActivity>>
  >({});
  const recordActivity = useCallback(
    (id: string, activity: ReturnType<typeof useChatGPTBrowserSessionActivity> | null) => {
      setActivities((current) => {
        const old = current[id];
        if (!activity) {
          if (!old) return current;
          const updated = { ...current };
          delete updated[id];
          return updated;
        }
        if (
          old?.age === activity.age &&
          old.label === activity.label &&
          old.lastWorkingAt === activity.lastWorkingAt &&
          old.recoveryProblem === activity.recoveryProblem
        )
          return current;
        return { ...current, [id]: activity };
      });
    },
    [],
  );
  const registeredProjects = useMemo(
    () =>
      projects
        .filter((project) => project.environmentId === environmentId)
        .map((project) => ({
          id: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
        })),
    [environmentId, projects],
  );
  const recognizedGroups = useMemo(
    () => groupChatGPTSessions(sessions, registeredProjects, permanentProjects),
    [sessions, registeredProjects, permanentProjects],
  );
  const projectTitles = useMemo(
    () => chatGPTSidebarProjectTitles(sessions, recognizedGroups),
    [sessions, recognizedGroups],
  );
  // One-time inferred associations become durable metadata instead of being
  // regenerated whenever a page fails, changes its title, or T3 restarts.
  useEffect(() => {
    const predicted = new Map(
      recognizedGroups.flatMap((group) =>
        group.rows.map(
          ({ session }) =>
            [
              session.id,
              group.key && group.key !== "other" && group.title ? group.title : undefined,
            ] as const,
        ),
      ),
    );
    // Direct user confirmations survive even when their group has only one
    // member and therefore doesn't get a project heading.
    const updates = applyConfirmedChatGPTSessionMetadata(sessions).map((session) => ({
      id: session.id,
      ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
      ...((session.project ?? predicted.get(session.id))
        ? { project: session.project ?? predicted.get(session.id) }
        : {}),
    }));
    if (
      updates.some((update) =>
        sessions.some(
          (session) =>
            session.id === update.id &&
            ((!session.project && update.project) ||
              (!session.parentSessionId && update.parentSessionId)),
        ),
      )
    ) {
      syncInferredMetadata(updates);
    }
  }, [recognizedGroups, sessions, syncInferredMetadata]);
  // Remove only sessions with a verified hiding timestamp, not legacy hidden
  // sessions whose original hide date is unknown.
  useEffect(() => {
    if (!environmentId) return;
    const removeExpired = () => {
      for (const id of pruneExpiredHidden(Date.now())) {
        const ref = chatGPTBrowserThreadRef(environmentId, id);
        for (const snapshot of Object.values(readThreadPreviewState(ref).sessions)) {
          void closePreviewSession({
            closePreview: close,
            snapshot,
            tabId: snapshot.tabId,
            threadRef: ref,
          }).catch((error: unknown) => {
            console.warn("[ChatGPT hidden expiry] Could not close preview:", error);
          });
        }
        removeLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, id));
        removeLocalStorageItem(chatGPTBrowserLastWorkingKey(environmentId, id));
      }
    };
    removeExpired();
    const timer = setInterval(removeExpired, 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, [environmentId, pruneExpiredHidden, close]);
  const isSnoozed = (session: { readonly snoozedUntil?: number | undefined }) =>
    typeof session.snoozedUntil === "number" && session.snoozedUntil > clockNow;
  // Visibility only affects sidebar rows. Recovery, activity monitoring and
  // webview runtime all continue using the full non-hidden session list.
  const visibleSessions = sessions.filter((session) => !session.hidden);
  const hiddenSessions = sessions.filter((session) => session.hidden);
  // The verified manager seat ledger, not a parent link or title, determines
  // which nested manager rows are exempt from the worker visibility toggle.
  const workerIds = useMemo(
    () =>
      verifiedManagerSessionIds === null
        ? restoreVerifiedChatGPTWorkerIds(sessions, verifiedWorkerSnapshot)
        : linkedChatGPTWorkerIds(sessions, verifiedManagerSessionIds),
    [sessions, verifiedManagerSessionIds, verifiedWorkerSnapshot],
  );
  // Outages must not clear a verified identity snapshot; equally, never
  // manufacture new worker identities from parent links while OpenRig is offline.
  useEffect(() => {
    if (verifiedManagerSessionIds === null) return;
    const fresh = captureVerifiedChatGPTWorkerIdentities(sessions, verifiedManagerSessionIds);
    if (JSON.stringify(fresh) !== JSON.stringify(verifiedWorkerSnapshot)) {
      setVerifiedWorkerSnapshot(fresh);
    }
  }, [sessions, verifiedManagerSessionIds, verifiedWorkerSnapshot, setVerifiedWorkerSnapshot]);
  // Show/hide is strictly a display filter: every child row is toggleable, even if OpenRig is offline.
  const childIds = useMemo(() => childChatGPTSessionIds(sessions), [sessions]);
  const visibleWorkerCount = visibleSessions.filter((session) => childIds.has(session.id)).length;
  const snoozedSessions = visibleSessions.filter(isSnoozed);
  const showingHidden = showHidden && hiddenSessions.length > 0;
  // Like Hidden, the Snoozed view falls back to active sessions once it empties.
  const showingSnoozed = !showingHidden && showSnoozed && snoozedSessions.length > 0;
  const displayedSessions = showingHidden
    ? hiddenSessions
    : visibleSessions.filter((session) =>
        showingSnoozed ? isSnoozed(session) : !isSnoozed(session),
      );
  const groupedSessions = useMemo(() => {
    const groups = layoutChatGPTSessions(
      displayedSessions,
      registeredProjects,
      showingHidden ? "started" : sortMode,
      activities as Readonly<Record<string, ChatGPTSessionSortActivity>>,
      permanentProjects,
    );
    const filtered = filterChatGPTWorkerGroups(
      groups,
      childIds,
      showingHidden || showWorkers,
      permanentProjectKeys,
    );
    // Always provide a stable drop target for the default Other project.
    return filtered.some((group) => group.key === "other")
      ? filtered
      : [...filtered, { key: "other", title: "Other", rows: [] }];
  }, [
    displayedSessions,
    registeredProjects,
    showingHidden,
    sortMode,
    activities,
    permanentProjects,
    childIds,
    showWorkers,
    permanentProjectKeys,
  ]);
  const searchResults = useMemo(
    () => searchChatGPTSessionGroups(groupedSessions, searchQuery),
    [groupedSessions, searchQuery],
  );
  const searchedSessionIds = useMemo(
    () => new Set(searchResults.flatMap((group) => group.rows.map(({ session }) => session.id))),
    [searchResults],
  );
  const [closingId, setClosingId] = useState<string | null>(null);
  const closingRef = useRef<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const closeSession = async (sessionId: string, source: ChatGPTSessionRemovalSource) => {
    if (!environmentId || closingRef.current !== null) return;
    closingRef.current = sessionId;
    setClosingId(sessionId);
    try {
      const threadRef = chatGPTBrowserThreadRef(environmentId, sessionId);
      const snapshots = Object.values(readThreadPreviewState(threadRef).sessions);
      const results = await Promise.all(
        snapshots.map((snapshot) =>
          closePreviewSession({
            closePreview: close,
            snapshot,
            tabId: snapshot.tabId,
            threadRef,
          }),
        ),
      );
      if (results.some((result) => result._tag === "Failure")) return;
      removeSession(sessionId, source);
      removeLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, sessionId));
      removeLocalStorageItem(chatGPTBrowserLastWorkingKey(environmentId, sessionId));
      if (activeSessionId === sessionId) {
        const next = visibleSessions.find((session) => session.id !== sessionId);
        if (next) {
          await navigate({
            to: "/browser/$browserSessionId",
            params: { browserSessionId: next.id },
          });
        } else {
          await navigate({ to: "/" });
        }
      }
    } finally {
      closingRef.current = null;
      setClosingId(null);
    }
  };

  // The desktop shell intercepts Ctrl/Cmd+W before Electron's native Window
  // menu can close the app; handle the resulting action using the same close
  // path as the X button so preview tabs and session metadata are cleaned up.
  const closeSelectedSession = useEffectEvent(() => {
    if (
      !activeSessionId ||
      closingId !== null ||
      !visibleSessions.some((session) => session.id === activeSessionId)
    )
      return;
    void closeSession(activeSessionId, "desktop-menu-action");
  });

  useEffect(() => {
    return window.desktopBridge?.onMenuAction?.((action) => {
      if (action === "close-chatgpt-session") closeSelectedSession();
    });
  }, []);

  const hideSession = async (sessionId: string) => {
    setSessionHidden(sessionId, true);
    if (activeSessionId !== sessionId) return;
    const next = visibleSessions.find((session) => session.id !== sessionId);
    if (next) {
      await navigate({ to: "/browser/$browserSessionId", params: { browserSessionId: next.id } });
    } else {
      await navigate({ to: "/" });
    }
  };

  if (!isElectron || !environmentId) return null;

  const searchToggle = (
    <Button
      size="icon-xs"
      variant="ghost-muted"
      aria-label={searchOpen ? "Close ChatGPT session search" : "Search ChatGPT sessions"}
      aria-expanded={searchOpen}
      aria-pressed={searchOpen}
      title={searchOpen ? "Close session search" : "Search sessions"}
      onClick={() => {
        setSearchOpen((current) => !current);
        setSearchQuery("");
        setSectionCollapsed(false);
      }}
    >
      <SearchIcon aria-hidden />
    </Button>
  );

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        {showingHidden || showingSnoozed ? (
          // Hidden and Snoozed are alternate lists; this row replaces the header
          // while one is shown.
          <div className="flex min-w-0 items-center gap-1 ps-1">
            <Badge variant="secondary">
              {showingHidden
                ? `Hidden · ${hiddenSessions.length}`
                : `Snoozed · ${snoozedSessions.length}`}
            </Badge>
            <span className="flex-1" />
            {searchToggle}
            <Button
              size="xs"
              variant="ghost-muted"
              aria-label="Back to ChatGPT sessions"
              onClick={() => {
                setShowHidden(false);
                setShowSnoozed(false);
              }}
            >
              Back
            </Button>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-1">
            <span className="min-w-0 flex-1 truncate ps-2 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
              ChatGPT
            </span>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`Sort ChatGPT sessions: ${sortMode === "started" ? "Started" : "Last active/status"}. Click to switch to ${sortMode === "started" ? "Last active/status" : "Started"}.`}
              title={
                sortMode === "started"
                  ? "Started order (switch to last active/status)"
                  : "Last active/status (switch to started order)"
              }
              onClick={() =>
                setSortMode((current) => (current === "started" ? "activity" : "started"))
              }
            >
              <ArrowDownUpIcon aria-hidden />
            </Button>
            {searchToggle}
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`ChatGPT view options${showWorkers ? "" : " (workers hidden)"}`}
                    title="View options"
                    // Highlighted while the list differs from the default view.
                    data-pressed={showWorkers ? undefined : ""}
                  />
                }
              >
                <SlidersHorizontalIcon aria-hidden />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuGroup>
                  <MenuGroupLabel>View options</MenuGroupLabel>
                  <MenuCheckboxItem
                    checked={showWorkers}
                    onCheckedChange={(checked) => setShowWorkers(checked)}
                    aria-label={`Show child ChatGPT sessions (${visibleWorkerCount})`}
                    title="Toggle child sessions in the sidebar only; sessions continue running and are not closed or unloaded."
                  >
                    <span className="flex items-center gap-4">
                      <span className="flex-1">Show workers</span>
                      <span className="text-xs text-muted-foreground">
                        {visibleWorkerCount}
                      </span>
                    </span>
                  </MenuCheckboxItem>
                  {snoozedSessions.length > 0 && (
                    <MenuItem
                      inset
                      aria-label={`Show snoozed ChatGPT sessions (${snoozedSessions.length})`}
                      onClick={() => {
                        setShowSnoozed(true);
                        setShowHidden(false);
                        setSectionCollapsed(false);
                      }}
                    >
                      <MenuItemLabel>Snoozed sessions</MenuItemLabel>
                      <span className="ms-auto ps-4 text-xs text-muted-foreground">
                        {snoozedSessions.length}
                      </span>
                    </MenuItem>
                  )}
                  {hiddenSessions.length > 0 && (
                    <MenuItem
                      inset
                      aria-label={`Show hidden ChatGPT sessions (${hiddenSessions.length})`}
                      onClick={() => {
                        setShowHidden(true);
                        setShowSnoozed(false);
                        setSectionCollapsed(false);
                      }}
                    >
                      <MenuItemLabel>Hidden sessions</MenuItemLabel>
                      <span className="ms-auto ps-4 text-xs text-muted-foreground">
                        {hiddenSessions.length}
                      </span>
                    </MenuItem>
                  )}
                </MenuGroup>
                <MenuSeparator />
                <MenuItem
                  inset
                  aria-label="Worker auto-cleanup settings and dry-run preview"
                  onClick={() => setCleanupOpen(true)}
                >
                  <MenuItemLabel>Worker cleanup…</MenuItemLabel>
                </MenuItem>
              </MenuPopup>
            </Menu>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={
                sectionCollapsed ? "Expand ChatGPT sessions" : "Collapse ChatGPT sessions"
              }
              title={sectionCollapsed ? "Expand ChatGPT sessions" : "Collapse ChatGPT sessions"}
              aria-expanded={!sectionCollapsed}
              onClick={() => setSectionCollapsed((current) => !current)}
            >
              {sectionCollapsed ? <ChevronDownIcon aria-hidden /> : <ChevronUpIcon aria-hidden />}
            </Button>
          </div>
        )}
      </SidebarMenuItem>
      <ChatGPTUnusedManualSessionCleanup
        environmentId={environmentId}
        activeSessionId={activeSessionId}
        managerIds={verifiedManagerSessionIds}
        now={clockNow}
      />
      <ChatGPTWorkerCleanupCoordinator
        environmentId={environmentId}
        sessions={sessions}
        verifiedWorkerIds={workerIds}
        managerAttributionAvailable={verifiedManagerSessionIds !== null}
        open={cleanupOpen}
        onOpenChange={setCleanupOpen}
      />
      {searchOpen && (
        <SidebarMenuItem>
          <div className="flex min-w-0 items-center gap-1 px-1 py-1">
            <Input
              autoFocus
              aria-label="Search ChatGPT sessions"
              placeholder="Search sessions…"
              className="min-w-0 flex-1"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSearchOpen(false);
                  setSearchQuery("");
                }
              }}
            />
            {searchQuery && (
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Clear ChatGPT session search"
                title="Clear search"
                onClick={() => setSearchQuery("")}
              >
                <XIcon aria-hidden />
              </Button>
            )}
          </div>
        </SidebarMenuItem>
      )}
      {showCreateAction && !sectionCollapsed ? (
        <SidebarMenuItem>
          <SidebarMenuButton
            onClick={() =>
              void navigate({
                to: "/browser/$browserSessionId",
                params: {
                  browserSessionId: createSession(undefined, { explicitlyUserCreated: true }),
                },
              })
            }
          >
            <PlusIcon aria-hidden />
            <span>New ChatGPT session</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : null}
      <ChatGPTBrowserSelectionRecovery
        environmentId={environmentId}
        sessionId={activeSessionId}
        enabled={visibleSessions.some((session) => session.id === activeSessionId)}
        clickToken={selectionRecoveryClick}
      />
      <ChatGPTBrowserRecoveryCoordinator
        environmentId={environmentId}
        onPhaseChange={onRecoveryPhaseChange}
        redIds={visibleSessions
          .filter((session) => !isSnoozed(session) && activities[session.id]?.age === "invalid")
          .map((session) => session.id)}
        wakeupIds={visibleSessions
          .filter(
            (session) =>
              !isSnoozed(session) &&
              !readChatGPTRecoveryState(environmentId, session.id).escalationReason &&
              (activities[session.id]?.age === "unknown" ||
                activities[session.id]?.age === "inactive" ||
                activities[session.id]?.label ===
                  "ChatGPT page unavailable: the ChatGPT composer is unavailable" ||
                !activities[session.id]),
          )
          .map((session) => session.id)}
        sessionIds={visibleSessions
          .filter((session) => !isSnoozed(session))
          .map((session) => session.id)}
        deferredIds={[
          ...new Set(
            [...recognizedGroups, ...groupedSessions]
              .filter((group) => group.key && collapsedGroups.has(group.key))
              .flatMap((group) => group.rows.map(({ session }) => session.id))
              .filter((id) => !isSearching || !searchedSessionIds.has(id)),
          ),
        ]}
      />
      {visibleSessions.map((session) => (
        <Fragment key={session.id}>
          <ChatGPTBrowserSessionRuntime
            environmentId={environmentId}
            sessionId={session.id}
            suspended={closingId === session.id}
          />
          <BrowserSessionActivityMonitor
            id={session.id}
            environmentId={environmentId}
            onChange={recordActivity}
          />
        </Fragment>
      ))}
      {!sectionCollapsed && (
        <DndContext
          sensors={sensors}
          onDragEnd={({ active, over, activatorEvent }) => {
            if (showingHidden || isSearching || !over || active.id === over.id) return;
            const dragged = String(active.id),
              target = String(over.id);
            // Activity mode flattens projects into one status queue. Resolve
            // drag destinations using actual project assignments, never the
            // synthetic queue key (which would silently clear a project).
            const projectGroups = sortMode === "activity" ? recognizedGroups : groupedSessions;
            const project = target.startsWith("group:")
              ? groupedSessions.find((group) => group.key === target.slice(6))
              : projectGroups.find((group) =>
                  group.rows.some(({ session }) => session.id === target),
                );
            if (!project) return;
            const from = projectGroups.find((group) =>
              group.rows.some(({ session }) => session.id === dragged),
            );
            if (target.startsWith("group:") || from?.key !== project.key) {
              setSessionProject(dragged, project.key === "other" ? null : project.title);
              return;
            }
            if (activatorEvent instanceof MouseEvent && activatorEvent.shiftKey) {
              setSessionParent(dragged, target);
            } else if (sortMode === "started") {
              reorderSessions(dragged, target);
            }
          }}
        >
          <SortableContext
            items={searchResults.flatMap((group) =>
              group.key && !isSearching && collapsedGroups.has(group.key)
                ? []
                : group.rows.map(({ session }) => session.id),
            )}
            strategy={verticalListSortingStrategy}
          >
            {searchResults.map((group) => (
              <Fragment key={group.key ?? "ungrouped"}>
                {group.key !== null && group.title !== null && (
                  <DroppableProjectHeader id={group.key}>
                    <SidebarMenuButton
                      size="sm"
                      aria-expanded={isSearching || !collapsedGroups.has(group.key)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setContextMenu({
                          x: event.clientX,
                          y: event.clientY,
                          groupKey: group.key!,
                        });
                      }}
                      onClick={() => {
                        if (isSearching) return;
                        setCollapsedGroupKeys((current) =>
                          current.includes(group.key!)
                            ? current.filter((key) => key !== group.key)
                            : [...current, group.key!],
                        );
                      }}
                    >
                      {!isSearching && collapsedGroups.has(group.key) ? (
                        <ChevronRightIcon aria-hidden />
                      ) : (
                        <ChevronDownIcon aria-hidden />
                      )}
                      <span className="truncate font-medium">{group.title}</span>
                      {permanentProjectKeys.has(group.key) && (
                        <CrownIcon
                          aria-label="Permanent project"
                          className="size-3 text-muted-foreground"
                        />
                      )}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {group.rows.length}
                      </span>
                    </SidebarMenuButton>
                  </DroppableProjectHeader>
                )}
                {(group.key === null || isSearching || !collapsedGroups.has(group.key)) &&
                  group.rows.map(({ session, depth, childCount }) => (
                    <SortableBrowserSessionRow
                      key={session.id}
                      id={session.id}
                      activity={activities[session.id] ?? UNKNOWN_ACTIVITY}
                      disabled={showingHidden || isSearching || renamingId === session.id}
                    >
                      {(sortable, activity) => {
                        const recoveryEligible =
                          !session.hidden && !isSnoozed(session) && activity.age !== "unloaded";
                        const recoveryBlocked =
                          readChatGPTRecoveryState(environmentId, session.id).escalationReason !==
                          null;
                        const recoveryPhase =
                          recoveryEligible &&
                          !["working", "recent", "inactive"].includes(activity.age)
                            ? (recoveryPhases[session.id] ?? null)
                            : null;
                        // Missing composers are still periodically inspected and given
                        // background render time. Keep the recovery spinner visible while
                        // those checks are pending, not only during explicit reloads.
                        const waitingForPage =
                          activity.age === "invalid" &&
                          activity.label ===
                            "ChatGPT page unavailable: the ChatGPT composer is unavailable";
                        const queued =
                          recoveryEligible &&
                          (activity.age === "invalid" || activity.recoveryProblem !== null);
                        const recoveryLabel =
                          queued && recoveryBlocked
                            ? "Marked for recovery; waiting for safe retry or human review"
                            : recoveryPhase === "refreshing"
                              ? "Refreshing ChatGPT conversation to recover it"
                              : recoveryPhase === "checking"
                                ? "Confirming a recoverable ChatGPT error"
                                : recoveryPhase === "queued"
                                  ? "Confirmed ChatGPT error; queued for automatic recovery"
                                  : queued
                                    ? waitingForPage
                                      ? "Checking unavailable ChatGPT page for automatic recovery"
                                      : activity.recoveryProblem === "interrupted"
                                        ? "Queued for automatic recovery if the connection stays interrupted"
                                        : "Queued for automatic recovery; waiting for its turn or retry cooldown"
                                    : null;
                        const recoveryDetails =
                          activity.age === "invalid" ||
                          activity.age === "interrupted" ||
                          activity.age === "delivery-timeout"
                            ? chatGPTRecoveryHoverDetails({
                                age: activity.age,
                                label: activity.label,
                                phase: recoveryPhase,
                                state: readChatGPTRecoveryState(environmentId, session.id),
                                events: readChatGPTRecoveryEvents(environmentId, session.id, 25),
                                now: clockNow,
                              })
                            : null;
                        const recoveryTooltip = recoveryDetails ? (
                          <div className="flex max-w-80 flex-col gap-1 text-left">
                            <span className="font-semibold">ChatGPT recovery</span>
                            {recoveryDetails.map((detail) => (
                              <span key={detail}>{detail}</span>
                            ))}
                          </div>
                        ) : null;
                        const spawn = spawnCreation.get(session.id);
                        const timeline = readChatGPTSessionTimeline(
                          environmentId,
                          session,
                          activity.lastWorkingAt,
                          spawn && spawn.requestId === session.spawnRequestId
                            ? spawn.createdAt
                            : undefined,
                        );
                        // One shared hover body for both the drag/status icon and the
                        // session title: retain the richer recovery diagnostics.
                        const withTimeline = (summary: ReactNode) => (
                          <div className="flex max-w-80 flex-col gap-2 text-left">
                            <div>{summary}</div>
                            <div className="flex flex-col gap-1 border-t border-border pt-2 text-xs">
                              <span>
                                Created: {formatChatGPTSessionDateTime(timeline.createdAt)}
                              </span>
                              <span>
                                Last active: {formatChatGPTSessionDateTime(timeline.lastActiveAt)}
                              </span>
                              <span>
                                Last refresh: {formatChatGPTSessionDateTime(timeline.lastRefreshAt)}
                              </span>
                            </div>
                          </div>
                        );
                        const isVerifiedManager =
                          verifiedManagerSessionIds?.has(session.id) === true;
                        const projectTitle = projectTitles.get(session.id);
                        // A user-chosen border replaces the manager ring color but keeps its tint.
                        const borderRing = chatGPTSessionBorderRingClass(session.borderColor);
                        return (
                          <div
                            className={`flex min-w-0 items-center gap-0 ${isVerifiedManager ? "rounded-md bg-info/10" : ""} ${borderRing ? `rounded-md ring-2 ring-inset ${borderRing}` : isVerifiedManager ? "ring-1 ring-inset ring-info/80" : ""}`}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              setContextMenu({
                                x: event.clientX,
                                y: event.clientY,
                                sessionId: session.id,
                              });
                            }}
                            style={{ paddingLeft: `${Math.min(depth, 5) * 12}px` }}
                          >
                            <Tooltip>
                              {showingHidden ? (
                                <TooltipTrigger
                                  render={
                                    <span
                                      role="status"
                                      aria-label={`${projectTitle ? `${projectTitle} project. ` : ""}${isVerifiedManager ? "Verified OpenRig manager. " : ""}${recoveryLabel ?? activity.label}`}
                                      className={`flex size-6 shrink-0 items-center justify-center ${chatGPTActivityColorClass(activity.age)}`}
                                    />
                                  }
                                >
                                  <ChatGPTProjectStatusIcon
                                    project={projectTitle}
                                    age={activity.age}
                                    recovering={recoveryLabel !== null}
                                  />
                                </TooltipTrigger>
                              ) : (
                                <TooltipTrigger
                                  render={
                                    <button
                                      type="button"
                                      aria-label={`Drag ${session.title} to reorder, drop onto a project to assign, or Shift-drop onto a session to set its parent. ${projectTitle ? `${projectTitle} project. ` : ""}${isVerifiedManager ? "Verified OpenRig manager. " : ""}${recoveryLabel ?? activity.label}`}
                                      className={`flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing ${chatGPTActivityColorClass(activity.age)}`}
                                      {...sortable.attributes}
                                      {...sortable.listeners}
                                    />
                                  }
                                >
                                  <ChatGPTProjectStatusIcon
                                    project={projectTitle}
                                    age={activity.age}
                                    recovering={recoveryLabel !== null}
                                  />
                                </TooltipTrigger>
                              )}
                              <TooltipPopup>
                                {withTimeline(
                                  recoveryTooltip ??
                                    `${projectTitle ? `${projectTitle} project · ` : ""}${isVerifiedManager ? "OpenRig manager · " : ""}${recoveryLabel ?? (showingHidden ? activity.label : `Drag to reorder or onto a project; Shift-drop on a session to nest. ${activity.label}`)}`,
                                )}
                              </TooltipPopup>
                            </Tooltip>
                            <div className="min-w-0 flex-1">
                              {renamingId === session.id ? (
                                <Input
                                  autoFocus
                                  aria-label="Browser session name"
                                  value={title}
                                  onChange={(event) => setTitle(event.target.value)}
                                  onBlur={() => {
                                    renameSession(session.id, title);
                                    setRenamingId(null);
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") event.currentTarget.blur();
                                    if (event.key === "Escape") setRenamingId(null);
                                  }}
                                />
                              ) : (
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <SidebarMenuButton
                                        size="sm"
                                        isActive={activeSessionId === session.id}
                                        aria-current={
                                          activeSessionId === session.id ? "page" : undefined
                                        }
                                        onClick={() => {
                                          setSelectionRecoveryClick((value) => value + 1);
                                          recordSessionClick(
                                            environmentId,
                                            session.id,
                                            sessions.map((item) => item.id),
                                          );
                                          recordChatGPTSessionActiveAt(environmentId, session.id);
                                          if (session.hidden) {
                                            setSessionHidden(session.id, false);
                                            setShowHidden(false);
                                          }
                                          void navigate({
                                            to: "/browser/$browserSessionId",
                                            params: { browserSessionId: session.id },
                                          });
                                        }}
                                        onDoubleClick={() => {
                                          setTitle(session.title);
                                          setRenamingId(session.id);
                                        }}
                                      >
                                        {isVerifiedManager && (
                                          <CrownIcon
                                            aria-label="Verified OpenRig manager"
                                            className="size-3.5 shrink-0 text-info"
                                          />
                                        )}
                                        <span
                                          className={`min-w-0 flex-1 truncate ${chatGPTActivityColorClass(activity.age)}`}
                                        >
                                          {session.title}
                                        </span>
                                        {childCount > 0 && (
                                          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                                            {childCount}
                                          </span>
                                        )}
                                      </SidebarMenuButton>
                                    }
                                  />
                                  <TooltipPopup>
                                    {withTimeline(
                                      recoveryTooltip ??
                                        (showingHidden
                                          ? "Restore session"
                                          : "Double-click to rename"),
                                    )}
                                  </TooltipPopup>
                                </Tooltip>
                              )}
                            </div>
                            <Button
                              size="icon-xs"
                              variant="ghost-muted"
                              aria-label={`Rename ${session.title}`}
                              title="Rename session"
                              onClick={() => {
                                setTitle(session.title);
                                setRenamingId(session.id);
                              }}
                            >
                              <PencilIcon aria-hidden />
                            </Button>
                            {!showingHidden && (
                              <Button
                                size="icon-xs"
                                variant="ghost-muted"
                                aria-label={`Hide ${session.title}`}
                                title="Hide session"
                                disabled={closingId !== null}
                                onClick={() => void hideSession(session.id)}
                              >
                                <EyeOffIcon aria-hidden />
                              </Button>
                            )}
                            <Button
                              size="icon-xs"
                              variant="ghost-muted"
                              aria-label={`Close ${session.title}`}
                              disabled={closingId !== null}
                              onClick={() => void closeSession(session.id, "sidebar-user-action")}
                            >
                              <XIcon aria-hidden />
                            </Button>
                          </div>
                        );
                      }}
                    </SortableBrowserSessionRow>
                  ))}
              </Fragment>
            ))}
          </SortableContext>
          {isSearching && searchResults.length === 0 && (
            <SidebarMenuItem>
              <p role="status" className="px-2 py-2 text-xs text-muted-foreground">
                No matching ChatGPT sessions
              </p>
            </SidebarMenuItem>
          )}
        </DndContext>
      )}
      {contextMenu && (
        <div
          role="menu"
          aria-label="ChatGPT session and project actions"
          className="fixed z-[200] min-w-44 rounded-md border border-border bg-popover p-1 shadow-lg"
          style={{
            left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 200)),
            top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 320)),
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {(() => {
            const group =
              recognizedGroups.find((entry) => entry.key === contextMenu.groupKey) ??
              groupedSessions.find((entry) => entry.key === contextMenu.groupKey);
            const ids = contextMenu.sessionId
              ? [contextMenu.sessionId]
              : (group?.rows.map(({ session }) => session.id) ?? []);
            const members = sessions.filter((session) => ids.includes(session.id));
            const snoozed = members.length > 0 && members.every(isSnoozed);
            const setUntil = (until: number | null) => {
              setSessionSnooze(ids, until);
              setContextMenu(null);
            };
            return (
              <>
                {contextMenu.groupKey &&
                  group?.title &&
                  contextMenu.groupKey !== "other" &&
                  !contextMenu.groupKey.startsWith("status:") && (
                    <button
                      type="button"
                      role="menuitem"
                      className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                      onClick={() => {
                        const key = contextMenu.groupKey!;
                        const name = group.title!;
                        setPermanentProjects((current) =>
                          current.some((project) => project.key === key)
                            ? current.filter((project) => project.key !== key)
                            : [...current, { key, title: name }],
                        );
                        setContextMenu(null);
                      }}
                    >
                      {permanentProjectKeys.has(contextMenu.groupKey)
                        ? "Remove permanent"
                        : "Make permanent"}
                    </button>
                  )}
                {snoozed ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => setUntil(null)}
                  >
                    Unsnooze
                  </button>
                ) : (
                  <>
                    {snoozePresets.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        role="menuitem"
                        className="flex w-full items-center justify-between gap-4 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                        onClick={() => setUntil(Date.parse(preset.snoozedUntil))}
                      >
                        <span>{preset.label}</span>
                        <span className="text-xs text-muted-foreground">{preset.whenLabel}</span>
                      </button>
                    ))}
                    <button
                      type="button"
                      role="menuitem"
                      className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                      onClick={() => {
                        setContextMenu(null);
                        void requestCustomSnooze().then((choice) => {
                          if (choice) setSessionSnooze(ids, Date.parse(choice.snoozedUntil));
                        });
                      }}
                    >
                      Custom snooze…
                    </button>
                  </>
                )}
                {contextMenu.sessionId && (
                  <div
                    className="relative"
                    onMouseEnter={() => setBorderSubmenuFor(contextMenu)}
                    onMouseLeave={() => setBorderSubmenuFor(null)}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      aria-haspopup="menu"
                      aria-expanded={borderSubmenuOpen}
                      className="flex w-full items-center justify-between gap-4 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                      onClick={() => setBorderSubmenuFor(borderSubmenuOpen ? null : contextMenu)}
                    >
                      <span>Border</span>
                      <ChevronRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
                    </button>
                    {borderSubmenuOpen && (
                      <div
                        role="menu"
                        aria-label="Session border color"
                        className="absolute top-0 left-full z-[201] min-w-32 rounded-md border border-border bg-popover p-1 shadow-lg"
                      >
                        {[
                          ...CHATGPT_SESSION_BORDER_COLORS,
                          { id: null, label: "None", swatch: null },
                        ].map((option) => {
                          const current =
                            (sessions.find((entry) => entry.id === contextMenu.sessionId)
                              ?.borderColor ?? null) === option.id;
                          return (
                            <button
                              key={option.id ?? "none"}
                              type="button"
                              role="menuitemradio"
                              aria-checked={current}
                              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                              onClick={() => {
                                setSessionBorderColor(contextMenu.sessionId!, option.id);
                                setContextMenu(null);
                              }}
                            >
                              <span
                                aria-hidden
                                className={`size-3 shrink-0 rounded-full ${option.swatch ?? "border border-muted-foreground"}`}
                              />
                              <span className={current ? "font-medium" : undefined}>
                                {option.label}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
                {contextMenu.sessionId &&
                  sessions.find((entry) => entry.id === contextMenu.sessionId)?.parentSessionId && (
                    <button
                      type="button"
                      role="menuitem"
                      className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                      onClick={() => {
                        setSessionParent(contextMenu.sessionId!, null);
                        setContextMenu(null);
                      }}
                    >
                      Detach from parent
                    </button>
                  )}
              </>
            );
          })()}
        </div>
      )}
    </SidebarMenu>
  );
}
