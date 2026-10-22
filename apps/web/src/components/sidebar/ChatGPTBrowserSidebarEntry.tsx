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
  ClockIcon,
  EyeOffIcon,
  PencilIcon,
  PlusIcon,
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
} from "../../chatGPTBrowserSessions";
import { isElectron } from "../../env";
import {
  applyConfirmedChatGPTSessionMetadata,
  groupChatGPTSessions,
  layoutChatGPTSessions,
  type ChatGPTSessionSortActivity,
  type ChatGPTSessionSortMode,
} from "../../chatGPTSessionGrouping";
import { shortcutLabelForCommand } from "../../keybindings";
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
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { ChatGPTBrowserRecoveryCoordinator } from "./ChatGPTBrowserRecoveryCoordinator";
import { recordSessionClick } from "./chatGPTConversationRecovery";
import { ChatGPTBrowserSessionRuntime } from "./ChatGPTBrowserSessionRuntime";
import { ChatGPTSessionIcon } from "./ChatGPTSessionIcon";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";
import {
  ChatGPTBrowserSessionActivityIcon,
  useChatGPTBrowserSessionActivity,
} from "./ChatGPTBrowserSessionActivity";
import { chatGPTActivityColorClass } from "./chatGPTActivity";

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
          params: { browserSessionId: createSession() },
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
  }, [id, onChange, activity.age, activity.label, activity.lastWorkingAt]);
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
    syncInferredMetadata,
    pruneExpiredHidden,
  } = useChatGPTBrowserSessions(environmentId);
  const close = useAtomCommand(previewEnvironment.close);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [showHidden, setShowHidden] = useState(false);
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
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    sessionId?: string;
    groupKey?: string;
  } | null>(null);
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
          old.lastWorkingAt === activity.lastWorkingAt
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
    () => groupChatGPTSessions(sessions, registeredProjects),
    [sessions, registeredProjects],
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
  const visibleSessions = sessions.filter((session) => !session.hidden);
  const hiddenSessions = sessions.filter((session) => session.hidden);
  const snoozedSessions = visibleSessions.filter(isSnoozed);
  const showingHidden = showHidden && hiddenSessions.length > 0;
  const displayedSessions = showingHidden
    ? hiddenSessions
    : visibleSessions.filter((session) => (showSnoozed ? isSnoozed(session) : !isSnoozed(session)));
  const groupedSessions = useMemo(() => {
    const groups = layoutChatGPTSessions(
      displayedSessions,
      registeredProjects,
      showingHidden ? "started" : sortMode,
      activities as Readonly<Record<string, ChatGPTSessionSortActivity>>,
    );
    // Always provide a stable drop target for the default Other project.
    return groups.some((group) => group.key === "other")
      ? groups
      : [...groups, { key: "other", title: "Other", rows: [] }];
  }, [displayedSessions, registeredProjects, showingHidden, sortMode, activities]);
  const [closingId, setClosingId] = useState<string | null>(null);
  const closingRef = useRef<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const closeSession = async (sessionId: string) => {
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
      removeSession(sessionId);
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
    void closeSession(activeSessionId);
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

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div className="flex min-w-0 items-center gap-1">
          {hiddenSessions.length > 0 && (
            <Button
              size="sm"
              variant="ghost-muted"
              aria-label={
                showingHidden
                  ? "Back to ChatGPT sessions"
                  : `Show hidden ChatGPT sessions (${hiddenSessions.length})`
              }
              aria-pressed={showingHidden}
              title={showingHidden ? "Back to sessions" : "Show hidden sessions"}
              onClick={() => {
                setShowHidden(!showingHidden);
                setSectionCollapsed(false);
              }}
            >
              <EyeOffIcon aria-hidden />
              <span>{showingHidden ? "Back" : `Hidden (${hiddenSessions.length})`}</span>
            </Button>
          )}
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
          {snoozedSessions.length > 0 && (
            <Button
              size="sm"
              variant="ghost-muted"
              aria-pressed={showSnoozed}
              title={showSnoozed ? "Show active sessions" : "Show snoozed sessions"}
              onClick={() => {
                setShowSnoozed(!showSnoozed);
                setShowHidden(false);
              }}
            >
              <ClockIcon aria-hidden className="size-3.5" />
              <span>{showSnoozed ? "Back" : snoozedSessions.length}</span>
            </Button>
          )}
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={sectionCollapsed ? "Expand ChatGPT sessions" : "Collapse ChatGPT sessions"}
            title={sectionCollapsed ? "Expand ChatGPT sessions" : "Collapse ChatGPT sessions"}
            aria-expanded={!sectionCollapsed}
            onClick={() => setSectionCollapsed((current) => !current)}
          >
            {sectionCollapsed ? <ChevronDownIcon aria-hidden /> : <ChevronUpIcon aria-hidden />}
          </Button>
        </div>
      </SidebarMenuItem>
      {showCreateAction && !sectionCollapsed ? (
        <SidebarMenuItem>
          <SidebarMenuButton
            onClick={() =>
              void navigate({
                to: "/browser/$browserSessionId",
                params: { browserSessionId: createSession() },
              })
            }
          >
            <PlusIcon aria-hidden />
            <span>New ChatGPT session</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : null}
      <ChatGPTBrowserRecoveryCoordinator
        environmentId={environmentId}
        sessionIds={visibleSessions
          .filter((session) => !isSnoozed(session))
          .map((session) => session.id)}
        deferredIds={[
          ...new Set(
            [...recognizedGroups, ...groupedSessions]
              .filter((group) => group.key && collapsedGroups.has(group.key))
              .flatMap((group) => group.rows.map(({ session }) => session.id)),
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
            if (showingHidden || !over || active.id === over.id) return;
            const dragged = String(active.id),
              target = String(over.id);
            const project = target.startsWith("group:")
              ? groupedSessions.find((group) => group.key === target.slice(6))
              : groupedSessions.find((group) =>
                  group.rows.some(({ session }) => session.id === target),
                );
            if (!project) return;
            const from = groupedSessions.find((group) =>
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
            items={groupedSessions.flatMap((group) =>
              group.key && collapsedGroups.has(group.key)
                ? []
                : group.rows.map(({ session }) => session.id),
            )}
            strategy={verticalListSortingStrategy}
          >
            {groupedSessions.map((group) => (
              <Fragment key={group.key ?? "ungrouped"}>
                {group.key !== null && group.title !== null && (
                  <DroppableProjectHeader id={group.key}>
                    <SidebarMenuButton
                      size="sm"
                      aria-expanded={!collapsedGroups.has(group.key)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setContextMenu({
                          x: event.clientX,
                          y: event.clientY,
                          groupKey: group.key!,
                        });
                      }}
                      onClick={() =>
                        setCollapsedGroupKeys((current) =>
                          current.includes(group.key!)
                            ? current.filter((key) => key !== group.key)
                            : [...current, group.key!],
                        )
                      }
                    >
                      {collapsedGroups.has(group.key) ? (
                        <ChevronRightIcon aria-hidden />
                      ) : (
                        <ChevronDownIcon aria-hidden />
                      )}
                      <span className="truncate font-medium">{group.title}</span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {group.rows.length}
                      </span>
                    </SidebarMenuButton>
                  </DroppableProjectHeader>
                )}
                {(group.key === null || !collapsedGroups.has(group.key)) &&
                  group.rows.map(({ session, depth, childCount }) => (
                    <SortableBrowserSessionRow
                      key={session.id}
                      id={session.id}
                      activity={activities[session.id] ?? UNKNOWN_ACTIVITY}
                      disabled={showingHidden || renamingId === session.id}
                    >
                      {(sortable, activity) => (
                        <div
                          className="flex min-w-0 items-center gap-0"
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
                                    aria-label={activity.label}
                                    className={`flex size-6 shrink-0 items-center justify-center ${chatGPTActivityColorClass(activity.age)}`}
                                  />
                                }
                              >
                                <ChatGPTBrowserSessionActivityIcon age={activity.age} />
                              </TooltipTrigger>
                            ) : (
                              <TooltipTrigger
                                render={
                                  <button
                                    type="button"
                                    aria-label={`Drag ${session.title} to reorder, drop onto a project to assign, or Shift-drop onto a session to set its parent. ${activity.label}`}
                                    className={`flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing ${chatGPTActivityColorClass(activity.age)}`}
                                    {...sortable.attributes}
                                    {...sortable.listeners}
                                  />
                                }
                              >
                                <ChatGPTBrowserSessionActivityIcon age={activity.age} />
                              </TooltipTrigger>
                            )}
                            <TooltipPopup>
                              {showingHidden
                                ? activity.label
                                : `Drag to reorder or onto a project; Shift-drop on a session to nest. ${activity.label}`}
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
                              <SidebarMenuButton
                                size="sm"
                                isActive={activeSessionId === session.id}
                                aria-current={activeSessionId === session.id ? "page" : undefined}
                                title={showingHidden ? "Restore session" : "Double-click to rename"}
                                onClick={() => {
                                  recordSessionClick(
                                    environmentId,
                                    session.id,
                                    sessions.map((item) => item.id),
                                  );
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
                                <span className={chatGPTActivityColorClass(activity.age)}>
                                  {session.title}
                                </span>
                                {childCount > 0 && (
                                  <span className="ml-auto text-xs text-muted-foreground">
                                    {childCount}
                                  </span>
                                )}
                              </SidebarMenuButton>
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
                            onClick={() => void closeSession(session.id)}
                          >
                            <XIcon aria-hidden />
                          </Button>
                        </div>
                      )}
                    </SortableBrowserSessionRow>
                  ))}
              </Fragment>
            ))}
          </SortableContext>
        </DndContext>
      )}
      {contextMenu && (
        <div
          role="menu"
          aria-label="ChatGPT snooze actions"
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
