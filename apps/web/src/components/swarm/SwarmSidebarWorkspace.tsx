import {
  ChevronDownIcon,
  ChevronRightIcon,
  NetworkIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { randomUUID } from "../../lib/utils";

type SwarmSummary = {
  id: string;
  name: string;
  coordinator: string;
  members: number;
  messages: number;
};
type SwarmMember = {
  alias: string;
  kind: "native" | "chatgpt";
  threadId?: string;
  environmentId?: string;
  sessionId?: string;
  conversationId?: string;
};
type SwarmMessage = {
  key: string;
  at: string;
  messageId: string;
  author: string;
  body: string;
  mentions: string[];
};
type SwarmWake = {
  id: string;
  target: string;
  state: string;
  deliveryId: string;
  detail?: unknown;
  liveReceipt?: { status?: string };
  statusCheckError?: string;
};
type SwarmGoal = {
  goalId: string;
  goal: string;
  coordinatorMember: string;
  maxConcurrentWorkers: number;
};
type SwarmAssignment = {
  assignmentId: string;
  member: string;
  title: string;
  status: string;
  receipt?: { taskId?: string; error?: string };
};
type SwarmBoard = {
  goals: SwarmGoal[];
  plans: { goalId: string; assignments: SwarmAssignment[] }[];
  assignments: SwarmAssignment[];
  id: string;
  name: string;
  coordinator: string;
  members: SwarmMember[];
  messages: SwarmMessage[];
  wakes: SwarmWake[];
};

async function swarmCall<T>(
  action: string,
  args: Record<string, unknown> = {},
  enabled = false,
): Promise<T> {
  const response = await fetch("/api/swarm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action, ...args, ...(enabled ? { enabled: true } : {}) }),
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const reason =
      typeof payload === "object" && payload !== null && "error" in payload
        ? String(payload.error)
        : "Swarm service request failed.";
    throw new Error(reason);
  }
  return payload as T;
}

const fieldLabel = "block space-y-1 text-xs font-medium text-muted-foreground";
const fieldValue = "text-sm";
const textareaClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

function SwarmWorkspace({
  close,
  selectedId,
  onCreated,
}: {
  close: () => void;
  selectedId: string | null;
  onCreated: (id: string) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [board, setBoard] = useState<SwarmBoard | null>(null);
  const [name, setName] = useState("");
  const [coordinator, setCoordinator] = useState("Human operator");
  const [memberAlias, setMemberAlias] = useState("");
  const [memberKind, setMemberKind] = useState<SwarmMember["kind"]>("native");
  const [threadId, setThreadId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [body, setBody] = useState("");
  const [mentionText, setMentionText] = useState("");
  const [outcomes, setOutcomes] = useState<SwarmWake[]>([]);
  const [goal, setGoal] = useState("");
  const [coordinatorMember, setCoordinatorMember] = useState("");
  const [maxConcurrentWorkers, setMaxConcurrentWorkers] = useState(2);
  const pendingGoal = useRef<{
    goalId: string;
    goal: string;
    coordinatorMember: string;
    maxConcurrentWorkers: number;
  } | null>(null);
  const pendingCreate = useRef<{ id: string; name: string; coordinator: string } | null>(null);
  const pendingPost = useRef<{ messageId: string; body: string; mentions: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadBoard = async (id: string) => {
    const next = await swarmCall<SwarmBoard>("read", { swarmId: id });
    setBoard(next);
  };

  const act = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!enabled) return;
    void act(async () => {
      const id =
        pendingCreate.current?.name === name && pendingCreate.current?.coordinator === coordinator
          ? pendingCreate.current.id
          : randomUUID();
      pendingCreate.current = { id, name, coordinator };
      const created = await swarmCall<{ id: string }>("create", { id, name, coordinator }, true);
      pendingCreate.current = null;
      await loadBoard(created.id);
      onCreated(created.id);
    });
  };

  const attach = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!board || !enabled) return;
    void act(async () => {
      const member =
        memberKind === "native"
          ? {
              threadId: threadId.trim(),
              ...(environmentId.trim() ? { environmentId: environmentId.trim() } : {}),
            }
          : { sessionId: sessionId.trim(), conversationId: conversationId.trim() };
      await swarmCall(
        "attach",
        {
          swarmId: board.id,
          kind: memberKind,
          member: memberAlias.trim(),
          ...member,
        },
        true,
      );
      setMemberAlias("");
      await loadBoard(board.id);
    });
  };

  const post = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!board || !enabled) return;
    void act(async () => {
      const mentions = [
        ...new Set(
          mentionText
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean),
        ),
      ];
      // Preserve the event ID if the UI needs to recover an uncertain transport result.
      const mentionKey = mentions.join(",");
      const messageId =
        pendingPost.current?.body === body && pendingPost.current?.mentions === mentionKey
          ? pendingPost.current.messageId
          : randomUUID();
      // Preserve the event ID across ambiguous HTTP outcomes for this exact payload.
      pendingPost.current = { messageId, body, mentions: mentionKey };
      const result = await swarmCall<{ wakes: SwarmWake[] }>(
        "post",
        {
          swarmId: board.id,
          author: "human",
          body,
          ...(mentions.length ? { mentions } : {}),
          messageId,
        },
        true,
      );
      pendingPost.current = null;
      setOutcomes(result.wakes);
      setBody("");
      setMentionText("");
      await loadBoard(board.id);
    });
  };

  const startGoal = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!board || !enabled || !coordinatorMember || board.goals.length > 0) return;
    void act(async () => {
      const request = { goal: goal.trim(), coordinatorMember, maxConcurrentWorkers };
      const goalId =
        pendingGoal.current &&
        pendingGoal.current.goal === request.goal &&
        pendingGoal.current.coordinatorMember === request.coordinatorMember &&
        pendingGoal.current.maxConcurrentWorkers === request.maxConcurrentWorkers
          ? pendingGoal.current.goalId
          : randomUUID();
      pendingGoal.current = { goalId, ...request };
      await swarmCall("goal", { swarmId: board.id, goalId, ...request }, true);
      pendingGoal.current = null;
      setGoal("");
      await loadBoard(board.id);
    });
  };

  const refreshDelivery = () => {
    if (!board) return;
    void act(async () => {
      const result = await swarmCall<{ wakes: SwarmWake[] }>("delivery", { swarmId: board.id });
      setOutcomes(result.wakes);
      await loadBoard(board.id);
    });
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- read the selected persisted board when its workspace opens
  useEffect(() => {
    if (!selectedId) return;
    let mounted = true;
    void swarmCall<SwarmBoard>("read", { swarmId: selectedId }).then(
      (value) => {
        if (mounted) setBoard(value);
      },
      (cause: unknown) => {
        if (mounted) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      mounted = false;
    };
  }, [selectedId]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup className="flex h-[min(820px,calc(100dvh-24px))] w-[min(980px,calc(100vw-24px))] max-w-none flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <NetworkIcon className="size-4" /> Swarm workspace
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            Existing sessions stay intact. Launching delegated workers requires an explicit, bounded
            goal.
          </p>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-5">
          <div className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
            <span>
              {enabled ? "Swarm changes enabled for this workspace" : "Swarm changes are OFF"}
            </span>
            <Button size="xs" variant="outline" onClick={() => setEnabled((value) => !value)}>
              {enabled ? "Disable changes" : "Enable changes"}
            </Button>
          </div>
          {error && (
            <p
              className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
          {!board ? (
            <form onSubmit={create} className="space-y-3 rounded-lg border border-border p-4">
              <h3 className="font-semibold">Create a swarm</h3>
              <label className={fieldLabel}>
                Swarm name
                <Input
                  size="sm"
                  placeholder="e.g. Combat review"
                  value={name}
                  maxLength={120}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </label>
              <label className={fieldLabel}>
                Coordinator
                <Input
                  size="sm"
                  value={coordinator}
                  maxLength={120}
                  onChange={(event) => setCoordinator(event.target.value)}
                  required
                />
              </label>
              <Button disabled={!enabled || busy || !name.trim()} type="submit" size="sm">
                Create swarm
              </Button>
              {!enabled && (
                <p className="text-xs text-muted-foreground">
                  Enable changes above to create a swarm.
                </p>
              )}
            </form>
          ) : (
            <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(210px,0.65fr)_minmax(0,1.35fr)]">
              <section className="space-y-4">
                <div className="rounded-lg border border-border p-3">
                  <h3 className="font-semibold">{board.name}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Coordinator: {board.coordinator}
                  </p>
                  <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                    {board.id}
                  </p>
                  <Button
                    variant="ghost-muted"
                    size="xs"
                    onClick={() => void act(() => loadBoard(board.id))}
                    disabled={busy}
                  >
                    <RefreshCwIcon /> Refresh board
                  </Button>
                </div>
                <div className="rounded-lg border border-border p-3">
                  <h3 className="text-sm font-semibold">Autonomous coordinator</h3>
                  {board.goals.length > 0 ? (
                    <div className="mt-2 space-y-2 text-xs">
                      {board.goals.map((entry) => (
                        <div key={entry.goalId}>
                          <p className="whitespace-pre-wrap break-words">{entry.goal}</p>
                          <p className="mt-1 text-muted-foreground">
                            @{entry.coordinatorMember} · max {entry.maxConcurrentWorkers} workers
                          </p>
                        </div>
                      ))}
                      {board.plans.map((plan) => (
                        <div key={plan.goalId}>
                          <strong>Team plan</strong>
                          {plan.assignments.map((item) => (
                            <p key={item.assignmentId} className="mt-1 break-words">
                              @{item.member}: {item.title} —{" "}
                              {board.assignments.find(
                                (assigned) => assigned.assignmentId === item.assignmentId,
                              )?.status ?? "planned"}
                            </p>
                          ))}
                        </div>
                      ))}
                      <p className="text-muted-foreground">
                        Coordination runs in the attached native T3 thread. Verification and
                        completion are separate.
                      </p>
                    </div>
                  ) : (
                    <form onSubmit={startGoal} className="mt-2 space-y-2">
                      <label className={fieldLabel}>
                        Goal
                        <textarea
                          className={textareaClass + " min-h-20"}
                          value={goal}
                          maxLength={12000}
                          required
                          onChange={(e) => setGoal(e.target.value)}
                        />
                      </label>
                      <label className={fieldLabel}>
                        Coordinator (existing native T3 thread)
                        <select
                          className={textareaClass}
                          value={coordinatorMember}
                          required
                          onChange={(e) => setCoordinatorMember(e.target.value)}
                        >
                          <option value="">Choose coordinator</option>
                          {board.members
                            .filter((member) => member.kind === "native")
                            .map((member) => (
                              <option key={member.alias} value={member.alias}>
                                @{member.alias}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label className={fieldLabel}>
                        Max concurrent workers (2–12)
                        <Input
                          type="number"
                          min={2}
                          max={12}
                          size="sm"
                          value={maxConcurrentWorkers}
                          onChange={(e) => setMaxConcurrentWorkers(Number(e.target.value))}
                        />
                      </label>
                      <Button
                        type="submit"
                        size="sm"
                        disabled={
                          !enabled ||
                          busy ||
                          !goal.trim() ||
                          !coordinatorMember ||
                          maxConcurrentWorkers < 2 ||
                          maxConcurrentWorkers > 12
                        }
                      >
                        Authorize goal and notify coordinator
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        This authorizes up to the selected number of native/ChatGPT delegations. No
                        background worker launcher or scheduler is installed.
                      </p>
                    </form>
                  )}
                </div>
                <div className="rounded-lg border border-border p-3">
                  <h3 className="mb-2 text-sm font-semibold">
                    Participants ({board.members.length})
                  </h3>
                  {board.members.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Attach an existing native thread or ChatGPT session.
                    </p>
                  ) : (
                    board.members.map((member) => (
                      <div
                        key={member.alias}
                        className="border-b border-border/60 py-2 last:border-0"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-sm font-medium">@{member.alias}</div>
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost-muted"
                            disabled={!enabled || busy}
                            onClick={() =>
                              void act(async () => {
                                await swarmCall(
                                  "detach",
                                  { swarmId: board.id, member: member.alias },
                                  true,
                                );
                                await loadBoard(board.id);
                              })
                            }
                          >
                            Detach
                          </Button>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {member.kind === "native" ? "Native T3 thread" : "ChatGPT browser"}
                        </div>
                        <div className="break-all font-mono text-[10px] text-muted-foreground">
                          {member.threadId ?? member.sessionId}
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <form onSubmit={attach} className="space-y-2 rounded-lg border border-border p-3">
                  <h3 className="text-sm font-semibold">Attach participant</h3>
                  <label className={fieldLabel}>
                    Alias
                    <Input
                      size="sm"
                      value={memberAlias}
                      placeholder="reviewer"
                      onChange={(e) => setMemberAlias(e.target.value)}
                      required
                    />
                  </label>
                  <label className={fieldLabel}>
                    Session type
                    <select
                      className={textareaClass + " " + fieldValue}
                      value={memberKind}
                      onChange={(e) => setMemberKind(e.target.value as SwarmMember["kind"])}
                    >
                      <option value="native">Native T3 thread</option>
                      <option value="chatgpt">ChatGPT browser session</option>
                    </select>
                  </label>
                  {memberKind === "native" ? (
                    <>
                      <label className={fieldLabel}>
                        Thread ID
                        <Input
                          size="sm"
                          value={threadId}
                          onChange={(e) => setThreadId(e.target.value)}
                          required
                        />
                      </label>
                      <label className={fieldLabel}>
                        Environment ID (required for opaque thread IDs)
                        <Input
                          size="sm"
                          value={environmentId}
                          onChange={(e) => setEnvironmentId(e.target.value)}
                        />
                      </label>
                    </>
                  ) : (
                    <>
                      <label className={fieldLabel}>
                        T3 browser session UUID
                        <Input
                          size="sm"
                          value={sessionId}
                          onChange={(e) => setSessionId(e.target.value)}
                          required
                        />
                      </label>
                      <label className={fieldLabel}>
                        ChatGPT /c/ conversation UUID
                        <Input
                          size="sm"
                          value={conversationId}
                          onChange={(e) => setConversationId(e.target.value)}
                          required
                        />
                      </label>
                    </>
                  )}
                  <Button size="sm" variant="outline" disabled={busy || !enabled} type="submit">
                    Attach existing
                  </Button>
                </form>
              </section>
              <section className="flex min-h-0 flex-col gap-3">
                <div className="rounded-lg border border-border">
                  <div className="flex items-center justify-between border-b border-border px-3 py-2">
                    <h3 className="text-sm font-semibold">
                      Shared board ({board.messages.length})
                    </h3>
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      onClick={refreshDelivery}
                      disabled={busy}
                    >
                      <RefreshCwIcon /> Deliveries
                    </Button>
                  </div>
                  <div className="max-h-[310px] min-h-36 space-y-3 overflow-y-auto p-3">
                    {board.messages.length === 0 && (
                      <p className="text-xs text-muted-foreground">No board messages yet.</p>
                    )}
                    {board.messages.map((message) => (
                      <article
                        key={message.key}
                        className="rounded-md border border-border/70 bg-muted/20 p-3"
                      >
                        <div className="flex flex-wrap justify-between gap-2 text-xs">
                          <strong>{message.author}</strong>
                          <time className="text-muted-foreground">
                            {new Date(message.at).toLocaleString()}
                          </time>
                        </div>
                        <p className="mt-2 whitespace-pre-wrap break-words text-sm">
                          {message.body}
                        </p>
                        {message.mentions.length > 0 && (
                          <div className="mt-2 text-xs text-muted-foreground">
                            Wakes: {message.mentions.map((name) => "@" + name).join(", ")}
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                </div>
                <form onSubmit={post} className="space-y-2 rounded-lg border border-border p-3">
                  <h3 className="text-sm font-semibold">Post to board</h3>
                  <textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder="Shared message..."
                    className={textareaClass + " min-h-20 resize-y"}
                    maxLength={28000}
                    required
                  />
                  <label className={fieldLabel}>
                    Optional explicit wake mentions (comma-separated aliases)
                    <Input
                      size="sm"
                      value={mentionText}
                      onChange={(e) => setMentionText(e.target.value)}
                      placeholder="native, browser"
                    />
                  </label>
                  <Button size="sm" type="submit" disabled={!enabled || busy || !body.trim()}>
                    Post{mentionText.trim() ? " and notify" : ""}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Use @alias in your message to wake a participant automatically, or specify
                    explicit aliases above. Detaching never closes the original session.
                  </p>
                </form>
                {(outcomes.length > 0 || board.wakes.length > 0) && (
                  <div className="rounded-lg border border-border p-3">
                    <h3 className="text-sm font-semibold">Delivery outcomes</h3>
                    {(outcomes.length > 0 ? outcomes : board.wakes).map((wake) => (
                      <div key={wake.id} className="mt-2 text-xs">
                        <strong>@{wake.target}</strong>: {wake.liveReceipt?.status ?? wake.state}
                        {wake.statusCheckError && (
                          <span className="text-destructive"> — {wake.statusCheckError}</span>
                        )}
                        <div className="break-all font-mono text-[10px] text-muted-foreground">
                          {wake.deliveryId}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}

/** Separate opt-in sidebar workspace; no changes to normal thread routing or Caffy. */
export function SwarmSidebarWorkspace() {
  const [expanded, setExpanded] = useState(false);
  const [swarms, setSwarms] = useState<SwarmSummary[]>([]);
  const [workspace, setWorkspace] = useState<string | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const response = await swarmCall<{ swarms: SwarmSummary[] }>("list");
      setSwarms(response.swarms);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const expand = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) void refresh();
  };

  return (
    <div className="mt-1 border-t border-sidebar-border/60 pt-1">
      <div className="flex items-center gap-1 px-2">
        <button
          type="button"
          onClick={expand}
          aria-expanded={expanded}
          className="flex flex-1 items-center gap-1.5 py-1 text-left text-xs font-semibold text-sidebar-muted-foreground hover:text-sidebar-foreground"
        >
          {expanded ? (
            <ChevronDownIcon className="size-3" />
          ) : (
            <ChevronRightIcon className="size-3" />
          )}
          <NetworkIcon className="size-3.5" />
          Swarms {swarms.length > 0 && <span>({swarms.length})</span>}
        </button>
        {expanded && (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Refresh swarms"
            onClick={() => void refresh()}
          >
            <RefreshCwIcon />
          </Button>
        )}
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="New swarm"
          onClick={() => setWorkspace("new")}
        >
          <PlusIcon />
        </Button>
      </div>
      {expanded && (
        <div className="px-2 pb-1">
          {error && (
            <div className="text-xs text-destructive" role="alert">
              {error}
            </div>
          )}
          {swarms.length === 0 && !error && (
            <p className="py-1 pl-4 text-xs text-sidebar-muted-foreground">No swarms yet.</p>
          )}
          {swarms.map((swarm) => (
            <button
              key={swarm.id}
              type="button"
              onClick={() => setWorkspace(swarm.id)}
              className="w-full rounded-md px-3 py-1.5 text-left hover:bg-sidebar-row-hover"
            >
              <span className="block truncate text-xs font-medium">{swarm.name}</span>
              <span className="block truncate text-[10px] text-sidebar-muted-foreground">
                {swarm.members} members · {swarm.messages} board messages
              </span>
            </button>
          ))}
        </div>
      )}
      {workspace !== null && (
        <SwarmWorkspace
          key={workspace}
          close={() => setWorkspace(null)}
          selectedId={workspace === "new" ? null : workspace}
          onCreated={() => {
            void refresh();
          }}
        />
      )}
    </div>
  );
}
