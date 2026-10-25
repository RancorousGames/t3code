import type { EnvironmentId } from "@t3tools/contracts";
import {
  refreshSameBrowser,
  normalizeChatGPTRefreshBootstrap,
  type RefreshReceipt,
} from "./chatGPTSameBrowserRefresh";
import {
  assertChatGPTRefreshSafe,
  wakeChatGPTRefreshPredecessor,
  navigateChatGPTRefreshSafe,
  inspectBrowserSession,
  runChatGPTSessionControl,
} from "./chatGPTSessionControl";
import { readChatGPTBrowserSessions } from "./chatGPTBrowserSessions";
import { chatGPTConversationIdFromUrl } from "./chatGPTConversationIdentity";
import { sendInitialChatGPTPrompt } from "./chatGPTBrowserAutomation";
import { buildChatGPTSessionHandoffPrompt } from "./chatGPTSessionHandoff";

async function hash(text: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Existing browser, parent, project and selection are never rewritten. This
 * separate durable journal retains every old canonical URL across restarts. */
export async function refreshChatGPTDesktop(input: {
  environmentId: EnvironmentId;
  operationId: string;
  sessionId: string;
  priorConversationId: string;
  prompt?: string | undefined;
  phase: "begin" | "status" | "restore" | "finalize";
}) {
  const sessions = readChatGPTBrowserSessions(input.environmentId);
  const session = sessions.find((s) => s.id === input.sessionId);
  if (!session || session.hidden) throw new Error("Exact visible refresh browser required.");
  const key = `t3code:chatgpt-browser:refresh:v1:${input.environmentId}`;
  const read = (): RefreshReceipt[] => {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    if (
      !Array.isArray(value) ||
      value.some(
        (r) =>
          !r ||
          typeof r.operationId !== "string" ||
          typeof r.sessionId !== "string" ||
          typeof r.priorConversationId !== "string" ||
          typeof r.priorUrl !== "string" ||
          typeof r.bootstrapHash !== "string" ||
          !Number.isSafeInteger(r.generation) ||
          r.generation < 1 ||
          !["unknown", "submitted", "committed", "restored"].includes(r.status),
      )
    )
      throw new Error("Refresh history is unreadable; preserve it for recovery.");
    return value;
  };
  let runtimeId: string | null = null;
  let guardedConversationId: string | null = null;
  const existing = read().find((r) => r.operationId === input.operationId);
  if (!input.prompt && (input.phase === "begin" || !existing))
    throw new Error("Initial refresh requires a prompt.");
  const bootstrapHash = input.prompt
    ? await hash(
        buildChatGPTSessionHandoffPrompt(input.prompt, session.id, session.parentSessionId),
      )
    : existing!.bootstrapHash;
  // Unloaded/hibernated is a normal browser lifecycle state, not a reason to
  // allocate another T3 session. Recovery precedes the durable navigation
  // intent; an unrecovered guest leaves the predecessor completely untouched.
  if (input.phase === "begin" && !existing) {
    await wakeChatGPTRefreshPredecessor(input.environmentId, session, input.priorConversationId);
  }
  return refreshSameBrowser({ ...input, bootstrapHash }, input.phase, {
    read,
    write: (receipts) => window.localStorage.setItem(key, JSON.stringify(receipts)),
    assertSafe: async (id) => {
      if (
        JSON.stringify(readChatGPTBrowserSessions(input.environmentId)) !== JSON.stringify(sessions)
      )
        throw new Error("Browser hierarchy changed during refresh.");
      const checked = await assertChatGPTRefreshSafe(input.environmentId, session, id);
      if (runtimeId && checked !== runtimeId) throw new Error("Refresh browser runtime changed.");
      runtimeId = checked;
      guardedConversationId = id;
    },
    navigate: async (url) => {
      if (!runtimeId) throw new Error("No safe refresh runtime.");
      await navigateChatGPTRefreshSafe(
        input.environmentId,
        session,
        runtimeId,
        guardedConversationId,
        url,
      );
    },
    send: async () => {
      const receipt = await sendInitialChatGPTPrompt({
        ...input,
        prompt: input.prompt!,
        requestId: input.operationId,
        // A refresh reservation is distinct from the immutable creation receipt.
        readSessions: () =>
          readChatGPTBrowserSessions(input.environmentId).map((s) =>
            s.id === session.id ? { ...s, spawnRequestId: input.operationId } : s,
          ),
      });
      if (receipt.delivery !== "user_turn_observed")
        throw new Error(
          "Refresh submit unconfirmed; read status, never repeat navigation or send.",
        );
    },
    observe: async () => {
      const observed = await inspectBrowserSession(input.environmentId, session);
      const conversationId = chatGPTConversationIdFromUrl(observed.observedGuestUrl);
      if (!conversationId || conversationId === input.priorConversationId)
        return { conversationId, bootstrapHash: null, assistantReplied: false };
      const data = (await runChatGPTSessionControl({
        environmentId: input.environmentId,
        sessions,
        action: "read",
        sessionId: session.id,
        expectedConversationId: conversationId,
        count: 1,
        from: "start",
        maxMessageChars: 100_000,
        neverWake: true,
      })) as {
        conversationGuardValidated?: boolean;
        verifiedConversationId?: string;
        session?: {
          messages?: Array<{ role: string; turn: number; turnKey?: string; text: string }>;
        };
      };
      const user = data.session?.messages?.find((m) => m.role === "user" && m.turn === 0);
      const assistant = data.session?.messages?.find((m) => m.role === "assistant" && m.turn === 0);
      if (
        !data.conversationGuardValidated ||
        data.verifiedConversationId !== conversationId ||
        !user?.turnKey
      )
        return { conversationId, bootstrapHash: null, assistantReplied: false };
      return {
        conversationId,
        bootstrapHash: await hash(normalizeChatGPTRefreshBootstrap(user.text)),
        assistantReplied:
          observed.activity === "idle" &&
          observed.status === "done_or_idle" &&
          assistant?.turnKey === user.turnKey &&
          !!assistant?.text.trim(),
      };
    },
  });
}
