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
import { beginChatGPTBootstrapReboot, readChatGPTBrowserSessions } from "./chatGPTBrowserSessions";
import { recordChatGPTSessionRebootedAt } from "./chatGPTSessionTimestamps";
import { chatGPTConversationIdFromUrl } from "./chatGPTConversationIdentity";
import { sendInitialChatGPTPrompt } from "./chatGPTBrowserAutomation";
import {
  findRebootBrowserSlot,
  replaceRebootBrowserSlot,
  archivePriorRebootUnknownSend,
  recordPriorRebootState,
  type RebootBrowserSlot,
} from "./chatGPTRebootAnyState";
import { buildChatGPTSessionHandoffPrompt } from "./chatGPTSessionHandoff";
import { buildChatGPTRebootContextPrompt, type ChatGPTRebootContextMode, type ChatGPTRebootExcerpt } from "./chatGPTRebootContext";
import { publicChatGPTParentId, publicChatGPTSessionId } from "./chatGPTBootstrapIdentity";
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
  contextMode?: ChatGPTRebootContextMode | undefined;
  phase: "begin" | "status" | "restore" | "finalize";
}) {
  const sessions = readChatGPTBrowserSessions(input.environmentId);
  const session = sessions.find((s) => s.id === input.sessionId);
  if (!session) throw new Error("Exact existing reboot browser required.");
  // Stable-session callers provide no ChatGPT ID. T3 determines it locally.
  const priorConversationId =
    input.priorConversationId ??
    await resolveT3RebootPredecessor({
      environmentId: input.environmentId,
      session,
      requestId: input.operationId,
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
  let browserSlot: RebootBrowserSlot | null = null;
  let prepared = false;
  const existing = read().find((r) => r.operationId === input.operationId);
  // Only begin reads the predecessor. Status/finalize MUST reuse the original
  // operation's hash and must never invent a different handover.
  let prompt = input.prompt;
  if (input.phase === "begin" && input.contextMode) {
    const prepareHistory = window.desktopBridge?.prepareChatGPTRebootTranscript;
    if (input.contextMode === "handoff" && !prepareHistory)
      throw new Error("Keep Context requires the updated T3 desktop native bridge. Rebuild/restart T3 before rebooting; no incomplete handover was sent.");
    const indexed = prepareHistory
      ? await prepareHistory({ sessionId: session.id, operationId: input.operationId, mode: input.contextMode })
      : null;
    if (input.contextMode === "handoff" && !indexed?.path)
      throw new Error("No prior-conversation transcript document could be prepared. Reboot cancelled to avoid losing task context.");
    const readExcerpts = async (from: "start" | "end", count: number):
      Promise<ChatGPTRebootExcerpt[]> => {
      try {
        const result = await runChatGPTSessionControl({
          environmentId: input.environmentId,
          sessions,
          action: "read",
          sessionId: session.id,
          from,
          count,
          maxMessageChars: 2400,
          neverWake: true,
        }) as { session?: { messages?: ChatGPTRebootExcerpt[] } };
        return result.session?.messages ?? [];
      } catch {
        // A stuck or unavailable predecessor must not prevent a reboot.
        return [];
      }
    };
    const opening = session.binding?.taskRef || indexed?.originalUserRequest ? [] : await readExcerpts("start", 2);
    const recent = indexed?.recent.length ? indexed.recent
      : input.contextMode === "handoff" ? await readExcerpts("end", 12) : [];
    prompt = buildChatGPTRebootContextPrompt({
      mode: input.contextMode,
      ...(indexed?.originalUserRequest ? { originalRequest: indexed.originalUserRequest } : {}),
      ...(indexed?.path ? { historyDocument: {
        path: indexed.path, generations: indexed.generations,
        messages: indexed.messages, limited: indexed.limited,
      } } : {}),
      title: session.title,
      ...(session.project ? { project: session.project } : {}),
      ...(session.binding ? { role: session.binding.role, taskRef: session.binding.taskRef } : {}),
      opening,
      recent,
      ...(input.prompt ? { extraInstructions: input.prompt } : {}),
    });
  }
  if (!prompt?.trim() && (input.phase === "begin" || !existing))
    throw new Error("Initial reboot requires a prompt or context mode.");
  // Only ongoing Slave/continuous-worker roles need an execution cue after routing.
  const resumeWorkAfterReboot = /\bslave\b|\bcontinuous[\s-]+worker\b/iu.test(
    `${session.title}\n${prompt ?? ""}`,
  );
  const bootstrapHash = prompt
    ? await hash(
        buildChatGPTSessionHandoffPrompt(prompt, publicChatGPTSessionId(session), publicChatGPTParentId(sessions, session), {
          resumeWorkAfterReboot,
          ...(session.project === undefined ? {} : { project: session.project }),
          ...(session.binding ? { role: session.binding.role } : {}),
        }),
      )
    : existing!.bootstrapHash;
  // Reboot never waits for the predecessor to become idle or load correctly.
  // Begin remains protected by a durable operation receipt before host mutation.
  const receipt = await rebootSameBrowser(
    { ...input, priorConversationId, bootstrapHash },
    input.phase,
    {
      read,
      write: (receipts) => window.localStorage.setItem(key, JSON.stringify(receipts)),
      assertSafe: async (id) => {
        // A different canonical predecessor is a different operation, not merely
        // an unusual browser state.
        if (id !== priorConversationId) throw new Error("Reboot predecessor identity changed.");
        if (!readChatGPTBrowserSessions(input.environmentId).some((item) => item.id === session.id))
          throw new Error("Reboot browser slot no longer exists.");
        browserSlot = await findRebootBrowserSlot(input.environmentId, session.id);
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
        if (!browserSlot) throw new Error("Reboot browser slot is unavailable.");
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
        await replaceRebootBrowserSlot(browserSlot);
        beginChatGPTBootstrapReboot(input.environmentId, session.id);
      },
      send: async () => {
        const receipt = await sendInitialChatGPTPrompt({
          ...input,
          prompt: prompt!,
          requestId: input.operationId,
          newManagedWorker: false,
          resumeWorkAfterReboot,
          // A reboot reservation is distinct from the immutable creation receipt.
          readSessions: () =>
            readChatGPTBrowserSessions(input.environmentId).map((s) =>
              s.id === session.id ? { ...s, spawnRequestId: input.operationId } : s,
            ),
        });
        if (receipt.delivery !== "user_turn_observed")
          throw new Error(
            "Reboot submit unconfirmed; read status, never repeat navigation or send.",
          );
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
        const assistant = data.session?.messages?.find(
          (m) => m.role === "assistant" && m.turn === 0,
        );
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
    },
  );
  if (
    (receipt.status === "submitted" || receipt.status === "committed") &&
    existing?.status !== "submitted" &&
    existing?.status !== "committed"
  ) {
    recordChatGPTSessionRebootedAt(input.environmentId, input.sessionId);
  }
  return receipt;
}
