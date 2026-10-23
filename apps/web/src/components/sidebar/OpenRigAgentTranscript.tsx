import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useEffect, useMemo, useRef } from "react";

import { useThreadProjection, useThreadShell } from "../../state/entities";

const VISIBLE_MESSAGES = 40;
const MESSAGE_CHARACTERS = 6_000;

/**
 * Read-only view of an OpenRig seat's primary native T3 thread, from the same
 * client store the chat view uses. Shows only what T3 has loaded; it never
 * synthesizes replies, progress or completion.
 */
export function OpenRigAgentTranscript({
  agentName,
  environmentId,
  threadId,
  historyHref,
}: {
  agentName: string;
  environmentId: string;
  threadId: string;
  historyHref: string;
}) {
  const ref = useMemo(
    () => scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId)),
    [environmentId, threadId],
  );
  const shell = useThreadShell(ref);
  // Only open a detail stream for a thread this client already knows.
  const thread = useThreadProjection(shell ? ref : null);
  const all = useMemo(
    () => (thread?.projection.messages ?? []).filter((message) => message.role !== "system" && !message.notification),
    [thread],
  );
  const visible = all.slice(-VISIBLE_MESSAGES);
  const scroller = useRef<HTMLDivElement>(null);
  const last = visible[visible.length - 1];
  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [last?.id, last?.text.length]);

  if (!shell)
    return (
      <p className="px-4 py-6 text-center text-xs leading-relaxed text-muted-foreground">
        This T3 client has not loaded the primary thread (environment {environmentId}). Open the{" "}
        <a className="underline" href={historyHref}>full history</a> from a client connected to that environment.
      </p>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 px-4 py-1.5 text-2xs text-muted-foreground">
        <span className="min-w-0 truncate font-medium text-foreground">{shell.title}</span>
        <span>T3 thread: {shell.runtime?.status ?? "no runtime reported"}</span>
        {shell.runtime?.lastError && <span role="alert" className="text-destructive">{shell.runtime.lastError}</span>}
        <span className="flex-1" />
        <span>{all.length > visible.length ? `Last ${visible.length} of ${all.length} messages` : `${all.length} messages`}</span>
        <a className="font-medium underline" href={historyHref}>Open full history</a>
      </div>
      <div
        ref={scroller}
        role="log"
        aria-label={`Conversation transcript for ${agentName}`}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3"
      >
        {!thread && <p role="status" className="text-xs text-muted-foreground">Loading transcript…</p>}
        {thread && visible.length === 0 && (
          <p className="text-xs text-muted-foreground">No messages in this thread yet.</p>
        )}
        {visible.map((message) => {
          const mine = message.role === "user";
          const text = message.text.length > MESSAGE_CHARACTERS
            ? message.text.slice(0, MESSAGE_CHARACTERS) + "\n… (open full history for the rest)"
            : message.text;
          return (
            <article
              key={message.id}
              aria-label={`${mine ? "Input to" : "Reply from"} ${agentName}`}
              className={`max-w-[88%] rounded-xl border px-3 py-2 text-xs leading-relaxed ${mine ? "ml-auto border-info/30 bg-info/8" : "border-border bg-muted/30"}`}
            >
              <header className="mb-1 flex items-center gap-2 text-3xs text-muted-foreground">
                <span className="font-semibold">{mine ? "To agent" : agentName}</span>
                <time dateTime={DateTime.formatIso(message.createdAt)}>
                  {new Date(DateTime.toEpochMillis(message.createdAt)).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                </time>
                {message.streaming && <span className="text-info">streaming</span>}
              </header>
              <p className="whitespace-pre-wrap break-words">{text || "(no text)"}</p>
            </article>
          );
        })}
      </div>
    </div>
  );
}
