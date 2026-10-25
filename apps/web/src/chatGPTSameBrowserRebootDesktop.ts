import type { EnvironmentId } from "@t3tools/contracts";
import {
  rebootSameBrowser,
  normalizeChatGPTRebootBootstrap,
  type RebootReceipt,
} from "./chatGPTSameBrowserReboot";
import {
  assertChatGPTRebootSafe,
  wakeChatGPTRebootPredecessor,
  navigateChatGPTRebootSafe,
  inspectBrowserSession,
  runChatGPTSessionControl,
} from "./chatGPTSessionControl";
import { readChatGPTBrowserSessions } from "./chatGPTBrowserSessions";
import { recordChatGPTSessionRebootedAt } from "./chatGPTSessionTimestamps";
import { chatGPTConversationIdFromUrl } from "./chatGPTConversationIdentity";
import { sendInitialChatGPTPrompt } from "./chatGPTBrowserAutomation";
import {
  inspectErroredRebootPredecessor,
  navigateOfflineChatGPTReboot,
  type OfflineRebootPredecessor,
} from "./chatGPTRebootOffline";
import { buildChatGPTSessionHandoffPrompt } from "./chatGPTSessionHandoff";

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
  priorConversationId: string;
  prompt?: string | undefined;
  phase: "begin" | "status" | "restore" | "finalize";
}) {
  const sessions = readChatGPTBrowserSessions(input.environmentId);
  const session = sessions.find((s) => s.id === input.sessionId);
  if (!session || session.hidden) throw new Error("Exact visible reboot browser required.");
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
  let guardedConversationId: string | null = null;
  let offlinePredecessor: OfflineRebootPredecessor | null = null;
  let offlineDraftBackedUp = false;
  const existing = read().find((r) => r.operationId === input.operationId);
  if (!input.prompt && (input.phase === "begin" || !existing))
    throw new Error("Initial reboot requires a prompt.");
  const bootstrapHash = input.prompt
    ? await hash(
        buildChatGPTSessionHandoffPrompt(input.prompt, session.id, session.parentSessionId),
      )
    : existing!.bootstrapHash;
  // A positively verified editor-free error can be replaced in this same
  // browser slot. Ordinary unloaded/unknown guests retain the safe wake path.
  if (input.phase === "begin" && !existing) {
    offlinePredecessor = await inspectErroredRebootPredecessor(
      input.environmentId,
      session,
      input.priorConversationId,
    );
    if (!offlinePredecessor)
      await wakeChatGPTRebootPredecessor(input.environmentId, session, input.priorConversationId);
  }
  const receipt = await rebootSameBrowser({ ...input, bootstrapHash }, input.phase, {
    read,
    write: (receipts) => window.localStorage.setItem(key, JSON.stringify(receipts)),
    assertSafe: async (id) => {
      if (
        JSON.stringify(readChatGPTBrowserSessions(input.environmentId)) !== JSON.stringify(sessions)
      )
        throw new Error("Browser hierarchy changed during reboot.");
      if (offlinePredecessor) {
        if (id !== input.priorConversationId)
          throw new Error("Offline predecessor identity changed.");
        const current = await inspectErroredRebootPredecessor(input.environmentId, session, id);
        if (
          !current ||
          current.runtimeId !== offlinePredecessor.runtimeId ||
          current.webview !== offlinePredecessor.webview
        )
          throw new Error("Offline predecessor changed before reboot.");
        if (!offlineDraftBackedUp) {
          const backup = window.desktopBridge?.savePrivateChatGPTDraftSnapshot;
          if (!backup) throw new Error("Private draft backup unavailable for offline reboot.");
          const saved = await backup({
            sessionId: session.id,
            url: `https://chatgpt.com/c/${id}`,
            draft: "",
            uncertainSend: null,
          });
          if (
            saved.uncertainSendPresent ||
            !saved.path ||
            saved.url !== `https://chatgpt.com/c/${id}`
          )
            throw new Error("Offline empty-draft backup could not be verified.");
          offlineDraftBackedUp = true;
          const after = await inspectErroredRebootPredecessor(input.environmentId, session, id);
          if (!after || after.webview !== current.webview || after.runtimeId !== current.runtimeId)
            throw new Error("Offline predecessor changed during private draft backup.");
        }
        runtimeId = current.runtimeId;
        guardedConversationId = id;
        return;
      }
      const checked = await assertChatGPTRebootSafe(input.environmentId, session, id);
      if (runtimeId && checked !== runtimeId) throw new Error("Reboot browser runtime changed.");
      runtimeId = checked;
      guardedConversationId = id;
    },
    navigate: async (url) => {
      if (!runtimeId) throw new Error("No safe reboot runtime.");
      if (offlinePredecessor) {
        await navigateOfflineChatGPTReboot(
          input.environmentId,
          session,
          input.priorConversationId,
          offlinePredecessor,
          url,
        );
        return;
      }
      await navigateChatGPTRebootSafe(
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
