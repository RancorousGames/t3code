import type { ContextMenuItem } from "@t3tools/contracts";
import type { ChatGPTSessionModel } from "./chatGPTSessionModel";

/** Display and command surfaces share this vocabulary; guards stay with their existing handlers. */
export type ChatGPTSessionActionId =
  | "open" | "keep_working" | "answer" | "send" | "reload" | "stop_continue"
  | "retry_recovery" | "check_delivery" | "confirm_delivered" | "wake"
  | "snooze" | "unsnooze" | "complete" | "archive" | "hide" | "unhide"
  | "agent_reboot" | "copy_url" | "open_browser";

export interface ChatGPTSessionActionContext {
  model: ChatGPTSessionModel;
  hasConversationUrl?: boolean;
  canSend?: boolean;
  canStop?: boolean;
  canReload?: boolean;
  canReboot?: boolean;
}

export interface ChatGPTSessionActionResult {
  ok: boolean;
  message?: string;
}

export interface ChatGPTSessionAction {
  id: ChatGPTSessionActionId;
  label(context: ChatGPTSessionActionContext): string;
  available(context: ChatGPTSessionActionContext): boolean;
  danger?: boolean;
  run(sessionId: string, runGuarded: ChatGPTSessionActionRunner): Promise<ChatGPTSessionActionResult>;
}

/**
 * The registry performs no guest operations. Each caller supplies its existing
 * guarded command handler, so UNKNOWN-send, reload, and reboot fences cannot be
 * bypassed by invoking the same action from another surface.
 */
export type ChatGPTSessionActionRunner = (
  id: ChatGPTSessionActionId,
  sessionId: string,
) => Promise<ChatGPTSessionActionResult>;

const define = (
  id: ChatGPTSessionActionId,
  label: string,
  available: ChatGPTSessionAction["available"],
  danger = false,
): ChatGPTSessionAction => ({
  id,
  label: () => label,
  available,
  ...(danger ? { danger } : {}),
  run: (sessionId, runGuarded) => runGuarded(id, sessionId),
});

const always = () => true;
const canSend = (context: ChatGPTSessionActionContext) => context.canSend === true &&
  context.model.attention !== "unconfirmed_send";
const snoozed = (context: ChatGPTSessionActionContext) => context.model.residency === "snoozed";
const hidden = (context: ChatGPTSessionActionContext) => context.model.residency === "hidden";

export const CHATGPT_SESSION_ACTIONS: readonly ChatGPTSessionAction[] = [
  define("open", "Open session", always),
  define("answer", "Answer", (context) => context.model.attention === "question"),
  define("send", "Send message", canSend),
  define("keep_working", "Keep working", canSend),
  define("stop_continue", "Stop then continue", (context) => context.canStop === true && canSend(context)),
  define("retry_recovery", "Retry recovery", (context) =>
    context.model.attention === "error" || context.model.attention === "recovery_stopped" ||
    context.model.activity === "interrupted"),
  define("check_delivery", "Check delivery", (context) => context.model.attention === "unconfirmed_send"),
  define("confirm_delivered", "Confirm delivered", (context) => context.model.attention === "unconfirmed_send"),
  define("reload", "Reload session", (context) => context.canReload === true),
  define("wake", "Wake session", (context) =>
    ["unloaded", "hibernated", "loading"].includes(context.model.residency)),
  define("snooze", "Snooze", (context) => !snoozed(context) && !hidden(context)),
  define("unsnooze", "Unsnooze", snoozed),
  define("complete", "Mark complete", (context) => context.model.bucket !== "completed"),
  define("archive", "Archive", (context) => context.model.bucket === "completed"),
  define("hide", "Hide", (context) => !hidden(context)),
  define("unhide", "Unhide", hidden),
  define("agent_reboot", "Reboot agent", (context) => context.canReboot === true, true),
  define("copy_url", "Copy ChatGPT URL", (context) => context.hasConversationUrl === true),
  define("open_browser", "Open browser", always),
];

/** The model is authoritative for the primary action; no second priority rule. */
export function primaryChatGPTSessionAction(
  context: ChatGPTSessionActionContext,
): ChatGPTSessionAction | null {
  const id = context.model.primaryAction;
  if (!id) return null;
  return CHATGPT_SESSION_ACTIONS.find((action) => action.id === id && action.available(context)) ?? null;
}

/** Primary first, then the same list on sidebar, palette, and dashboard. */
export function availableChatGPTSessionActions(
  context: ChatGPTSessionActionContext,
): readonly ChatGPTSessionAction[] {
  const available = CHATGPT_SESSION_ACTIONS.filter((action) => action.available(context));
  const primary = primaryChatGPTSessionAction(context);
  return primary ? [primary, ...available.filter((action) => action.id !== primary.id)] : available;
}

/**
 * Registry-defined native menu actions. The rest of the sidebar menu only
 * contains metadata editors (parent, project, role, highlight, etc.).
 */
export function chatGPTNativeActionMenu(
  context: ChatGPTSessionActionContext,
): ContextMenuItem<string>[] {
  const nativeIds: readonly ChatGPTSessionActionId[] = [
    "open", "reload", "unsnooze", "agent_reboot",
  ];
  return availableChatGPTSessionActions(context)
    .filter((action) => nativeIds.includes(action.id))
    .map((action, index) => ({
      id: `registry:${action.id}`,
      label: action.label(context),
      ...(index === 0 ? {} : { separatorBefore: action.danger === true }),
    }));
}

export async function runChatGPTSessionAction(
  id: ChatGPTSessionActionId,
  sessionId: string,
  context: ChatGPTSessionActionContext,
  runGuarded: ChatGPTSessionActionRunner,
): Promise<ChatGPTSessionActionResult> {
  const action = CHATGPT_SESSION_ACTIONS.find((candidate) => candidate.id === id);
  if (!action || !action.available(context))
    return { ok: false, message: "Action unavailable for this session." };
  return action.run(sessionId, runGuarded);
}
