import type { EnvironmentId } from "@t3tools/contracts";
import {
  rebootSameBrowser,
  normalizeChatGPTRebootBootstrap,
  type RebootReceipt,
} from "./chatGPTSameBrowserReboot";
import {
  inspectBrowserSession,
  runChatGPTSessionControl,
  markChatGPTRebootGeneration,
} from "./chatGPTSessionControl";
import { readChatGPTBrowserSessions } from "./chatGPTBrowserSessions";
import { recordChatGPTSessionRebootedAt } from "./chatGPTSessionTimestamps";
import { chatGPTConversationIdFromUrl } from "./chatGPTConversationIdentity";
import { sendInitialChatGPTPrompt } from "./chatGPTBrowserAutomation";
import {
  findRebootBrowserSlot,
  replaceRebootBrowserSlot,
  archivePriorRebootUnknownSend,
  recordPriorRebootState,
} from "./chatGPTRebootAnyState";
import { buildChatGPTSessionHandoffPrompt } from "./chatGPTSessionHandoff";
import { resolveT3RebootPredecessor } from "./chatGPTRebootCurrentConversation";

async function hash(text: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Existing browser, parent, project and selection are never rewritten. This
 * separate durable journal retains every old canonical URL across restarts. */
export async function rebootChatGPTDesktop(input: {
  environmentId: EnvironmentId;
  operationId: string;
  sessionId: string;
  priorConversationId?: string | undefined;
  prompt?: string | undefined;
  phase: "begin" | "status" | "restore" | "finalize";
}) {
  const sessions = readChatGPTBrowserSessions(input.environmentId);
  const session = sessions.find((s) => s.id === input.sessionId);
  if (!session) throw new Error("Exact existing reboot browser required.");
  // Stable-session callers provide no ChatGPT ID. T3 determines it locally.
  const priorConversationId = input.priorConversationId ?? resolveT3RebootPredecessor({
    environmentId: input.environmentId, session, requestId: input.operationId,
  });
  const key = `t3code:chatgpt-browser:refresh:v1:${input.environmentId}`;
  const read = (): RebootReceipt[] => {
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
      throw new Error("Reboot history is unreadable; preserve it for recovery.");
    return value;
  };
  let runtimeId: string | null = null;
  let prepared = false;
  const existing = read().find((r) => r.operationId === input.operationId);
  if (!input.prompt && (input.phase === "begin" || !existing))
    throw new Error("Initial reboot requires a prompt.");
  const bootstrapHash = input.prompt
    ? await hash(
        buildChatGPTSessionHandoffPrompt(input.prompt, session.id, session.parentSessionId),
      )
    : existing!.bootstrapHash;
  // Reboot never waits for the predecessor to become idle or load correctly.
  // Begin remains protected by a durable operation receipt before host mutation.
  const receipt = await rebootSameBrowser({ ...input, priorConversationId, bootstrapHash }, input.phase, {
    read,
    write: (receipts) => window.localStorage.setItem(key, JSON.stringify(receipts)),
    assertSafe: async (id) => {
      // A different canonical predecessor is a different operation, not merely
      // an unusual browser state.
      if (id !== priorConversationId) throw new Error("Reboot predecessor identity changed.");
      if (!readChatGPTBrowserSessions(input.environmentId).some((item) => item.id === session.id))
        throw new Error("Reboot browser slot no longer exists.");
      runtimeId = await findRebootBrowserSlot(input.environmentId, session.id);
      if (!prepared) {
        let backup: "backed_up_empty" | "backed_up_nonempty" | "unavailable" = "unavailable";
        try {
          const result = await Promise.race([
            runChatGPTSessionControl({
              environmentId: input.environmentId,
              sessions: [session],
              action: "snapshot",
              sessionId: session.id,
            }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_500)),
          ]);
          if (
            result &&
            typeof result === "object" &&
            "status" in result &&
            (result.status === "backed_up_empty" || result.status === "backed_up_nonempty")
          )
            backup = result.status;
        } catch {
          // An unreadable/working/errored predecessor is not a reboot blocker.
        }
        recordPriorRebootState(input.environmentId, session.id, id, input.operationId, backup);
        prepared = true;
      }
    },
    navigate: async (url) => {
      if (!runtimeId) throw new Error("Reboot browser slot is unavailable.");
      if (url !== "https://chatgpt.com/")
        throw new Error("Reboot must start at the new ChatGPT conversation home.");
      // Persist old-generation UNKNOWN evidence without replaying its message.
      archivePriorRebootUnknownSend(
        input.environmentId,
        session.id,
        priorConversationId,
        input.operationId,
      );
      markChatGPTRebootGeneration(input.environmentId, session.id);
      await replaceRebootBrowserSlot(runtimeId);
    },
    send: async () => {
      const receipt = await sendInitialChatGPTPrompt({
        ...input,
        prompt: input.prompt!,
        requestId: input.operationId,
        newManagedWorker: false,
        // A reboot reservation is distinct from the immutable creation receipt.
        readSessions: () =>
          readChatGPTBrowserSessions(input.environmentId).map((s) =>
            s.id === session.id ? { ...s, spawnRequestId: input.operationId } : s,
          ),
      });
      if (receipt.delivery !== "user_turn_observed")
        throw new Error("Reboot submit unconfirmed; read status, never repeat navigation or send.");
    },
    observe: async () => {
      const observed = await inspectBrowserSession(input.environmentId, session);
      const conversationId = chatGPTConversationIdFromUrl(observed.observedGuestUrl);
      if (!conversationId || conversationId === priorConversationId)
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
        bootstrapHash: await hash(normalizeChatGPTRebootBootstrap(user.text)),
        assistantReplied:
          observed.activity === "idle" &&
          observed.status === "done_or_idle" &&
          assistant?.turnKey === user.turnKey &&
          !!assistant?.text.trim(),
      };
    },
  });
  if (
    receipt.status === "committed" &&
    input.phase === "finalize" &&
    existing?.status !== "committed"
  ) {
    recordChatGPTSessionRebootedAt(input.environmentId, input.sessionId);
  }
  return receipt;
}
