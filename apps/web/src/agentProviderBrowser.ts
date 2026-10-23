import type { AgentProviderV1DesktopWork, AgentProviderV1HistoryPage } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import { chatGPTConversationIdFromUrl } from "./chatGPTConversationIdentity";
import { readChatGPTBrowserSessions } from "./chatGPTBrowserSessions";
import {
  inspectBrowserSession,
  isLoadedChatGPTBrowserGuest,
  runChatGPTSessionControl,
} from "./chatGPTSessionControl";

type WorkResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      code: "Busy" | "ConversationChanged" | "Unavailable" | "InvalidInput";
      message: string;
    };

export async function executeAgentProviderBrowserWork(
  environmentId: EnvironmentId,
  work: AgentProviderV1DesktopWork,
): Promise<WorkResult> {
  if (work.environmentId !== environmentId)
    return { ok: false, code: "Unavailable", message: "Desktop environment changed." };
  const sessions = readChatGPTBrowserSessions(environmentId);
  // Only exact original T3 browser session UUIDs resolve here. Never create,
  // navigate, infer from conversation IDs, or wake an unloaded guest.
  const entry = sessions.find((session) => session.id === work.browserSessionId);
  if (!entry || !isLoadedChatGPTBrowserGuest(environmentId, entry))
    return {
      ok: false,
      code: "Unavailable",
      message: "Exact browser guest is not mounted and awake.",
    };
  try {
    const inspected = await inspectBrowserSession(environmentId, entry, "end", 1, false);
    if (chatGPTConversationIdFromUrl(inspected.observedGuestUrl) !== work.expectedConversationId)
      return {
        ok: false,
        code: "ConversationChanged",
        message: "Observed guest URL does not match requested ChatGPT conversation.",
      };
    if (work.action === "history") {
      const result = (await runChatGPTSessionControl({
        environmentId,
        sessions,
        sessionId: entry.id,
        action: "read",
        from: "end",
        count: 20,
        maxMessageChars: 6000,
        expectedConversationId: work.expectedConversationId,
        neverWake: true,
      })) as {
        verifiedConversationId: string;
        session: Awaited<ReturnType<typeof inspectBrowserSession>>;
      };
      const session = result.session;
      if (
        result.verifiedConversationId !== work.expectedConversationId ||
        ["unavailable", "loading", "hibernated"].includes(session.status)
      )
        return {
          ok: false,
          code: "Unavailable",
          message: "Guest transcript is not currently readable.",
        };
      const items: AgentProviderV1HistoryPage["items"][number][] = session.messages.map(
        (row, index) => ({
          // DOM keys are per-current-page evidence, not durable provider message IDs.
          id: `dom:${encodeURIComponent(row.turnKey ?? `visible-${row.turn}`)}:${row.role}:${index}`,
          revision: 0,
          kind: row.role === "user" ? "user" : "assistant",
          author: row.role,
          parts: [{ type: "text", text: row.text }],
          streaming:
            row.role === "assistant" &&
            index === session.messages.length - 1 &&
            session.activity === "working",
          completeness: "Partial",
        }),
      );
      const page: AgentProviderV1HistoryPage = {
        items,
        older: null,
        newer: null,
        complete: false,
        warning: `DOM-only, newest bounded 20 turn groups (each displayed message max 6000 chars); ${session.totalTurns} total turn groups in the currently rendered page. No authoritative pagination, cursor, archived turns, or message timestamps.`,
      };
      return { ok: true, data: page };
    }
    if (work.action === "submit") {
      if (!work.text?.trim())
        return {
          ok: false,
          code: "InvalidInput",
          message: "Browser submit requires nonempty text.",
        };
      // This is the SAME guarded read/send as the existing T3 desktop path;
      // both calls reject a hibernated guest and recheck the live URL.
      const previous = (await runChatGPTSessionControl({
        environmentId,
        sessions,
        sessionId: entry.id,
        action: "read",
        count: 1,
        expectedConversationId: work.expectedConversationId,
        neverWake: true,
      })) as { session: { status: string; activity: string } };
      if (
        previous.session.activity !== "idle" ||
        !["done_or_idle", "waiting_for_input"].includes(previous.session.status)
      )
        return { ok: false, code: "Busy", message: "Exact ChatGPT guest is not confirmed idle." };
      const sent = (await runChatGPTSessionControl({
        environmentId,
        sessions,
        sessionId: entry.id,
        action: "send",
        message: work.text,
        expectedConversationId: work.expectedConversationId,
        neverWake: true,
      })) as {
        messageSent: boolean;
        delivery: "unknown" | "user_turn_observed";
        verifiedConversationId?: string;
      };
      return {
        ok: true,
        data: {
          messageSent: sent.messageSent,
          delivery: sent.delivery,
          verifiedConversationId: sent.verifiedConversationId ?? null,
        },
      };
    }
    return { ok: false, code: "InvalidInput", message: "Unknown desktop browser action." };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Unknown browser bridge failure.";
    if (
      /conversation guard mismatch|expectedConversationId|Session URL|guest changed|conversation/i.test(
        message,
      )
    )
      return { ok: false, code: "ConversationChanged", message };
    // An exception may follow the Enter side-effect. Do not signal safe retry.
    if (work.action === "submit")
      return {
        ok: true,
        data: {
          messageSent: false,
          delivery: "unknown",
          verifiedConversationId: work.expectedConversationId,
        },
      };
    return { ok: false, code: "Unavailable", message };
  }
}
