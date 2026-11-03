import { useCallback, useEffect, useRef, useState } from "react";
import { chatGPTConversationIdFromUrl } from "../../web/src/chatGPTConversationIdentity.ts";
import { inspectChatGPTPage, type PageInspection } from "../../web/src/chatGPTSessionDom.ts";
import { chatGPTWebviewAutomation } from "../../web/src/chatGPTWebviewAutomation.ts";
import { canDraft, withAIDraft } from "./ai-batch.ts";
import { CHAT_BATCH_SIZE, chooseChatBatch, makeChatBatch, parseChatBatchAnswer, type ChatBatchRequest } from "./chat-batches.ts";
import { nativeMori } from "./backend.ts";
import type { MoriProject } from "./model.ts";
import type { MoriPrefs } from "./prefs.ts";
import type { MoriActions } from "./store.ts";

type Guest = HTMLElement & {
  executeJavaScript: (code: string) => Promise<unknown>;
  getURL: () => string;
};
type BatchStage = "staged" | "unknown" | "sent" | "ready" | "failed";
type PendingJob = {
  request: ChatBatchRequest;
  stage: BatchStage;
  conversationId: string | null;
  folder: string | null;
  proposals?: { id: string; japanese: string }[];
  error?: string | undefined;
};

const storageKey = (id: string) => `mori.ai-chat.batch:${id}`;
const VIEW = (id: string) => `mori-chatgpt:${id}`;
const COMPOSER = [
  "#prompt-textarea", '[data-testid="prompt-textarea"]', '[data-testid="composer-input"]',
  '[contenteditable="true"][role="textbox"]', "div[contenteditable=true]", "textarea",
].join(", ");

function restore(projectId: string): PendingJob | null {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(storageKey(projectId)) ?? "null");
    if (!data || typeof data !== "object" || !("request" in data)) return null;
    const job = data as PendingJob;
    if (job.request?.projectId !== projectId || !Array.isArray(job.request.ids) ||
        !["staged", "unknown", "sent", "ready", "failed"].includes(job.stage)) return null;
    return job;
  } catch { return null; }
}

function inspectExpression(count: number) {
  return `(${inspectChatGPTPage.toString()})({from:"end",count:${count},includeMessages:true,maxMessageChars:24000})`;
}

function sameConversation(expected: string | null, actualUrl: string) {
  return !expected || chatGPTConversationIdFromUrl(actualUrl) === expected;
}

export function useChatBatchWorker(input: {
  project: MoriProject;
  prefs: MoriPrefs;
  actions: MoriActions;
  activeId: string | null;
  guestRef: React.RefObject<Guest | null>;
  readyIdRef: React.RefObject<string | null>;
  toast: (text: string) => void;
  openSession: (id: string) => void;
}) {
  const { project, prefs, actions, activeId, guestRef, readyIdRef, toast, openSession } = input;
  const [job, setJob] = useState<PendingJob | null>(() => restore(project.id));
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const jobRef = useRef(job);
  const inFlight = useRef(false);
  const draftable = chooseChatBatch(project, CHAT_BATCH_SIZE);

  const updateJob = useCallback((next: PendingJob | null) => {
    jobRef.current = next;
    setJob(next);
    if (next) localStorage.setItem(storageKey(next.request.projectId), JSON.stringify(next));
    else localStorage.removeItem(storageKey(project.id));
  }, [project.id]);

  useEffect(() => {
    const next = restore(project.id);
    jobRef.current = next;
    setJob(next);
    setReviewOpen(false);
  }, [project.id]);

  const run = async () => {
    if (sending || jobRef.current) {
      toast("Finish or discard the current ChatGPT translation batch first.");
      return;
    }
    if (!activeId || !guestRef.current || readyIdRef.current !== activeId) {
      toast("Open a ChatGPT session and wait for its composer to become ready.");
      return;
    }
    if (!draftable.length) { toast("No unlocked, untranslated English lines are available."); return; }
    const guest = guestRef.current;
    const sessionId = activeId;
    setSending(true);
    let prepared: PendingJob | null = null;
    try {
      const current = await guest.executeJavaScript(inspectExpression(1)) as PageInspection;
      if (readyIdRef.current !== sessionId || activeId !== sessionId ||
          !["idle"].includes(current.activity) || current.connectionInterrupted ||
          current.conversationFull) throw Error("ChatGPT must be idle, connected, and ready before translating.");
      const expected = chatGPTConversationIdFromUrl(current.url);
      if (expected === null && !/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\/?(?:\?.*)?$/.test(current.url)) {
        throw Error("Open a ChatGPT conversation before starting this batch.");
      }
      const request = makeChatBatch(project, prefs, draftable, sessionId, crypto.randomUUID());
      const host = nativeMori();
      // Snapshot actual files before sending; a failed local write must not
      // accidentally create an untraceable ChatGPT request.
      if (!host?.saveChatBatchFiles) throw Error("AI batch requires the Monku desktop app.");
      const fileReceipt = await host.saveChatBatchFiles({
        projectId: request.projectId, requestId: request.requestId,
        ids: request.ids, files: request.files,
      });
      if (readyIdRef.current !== sessionId || guestRef.current !== guest) {
        throw Error("Session changed while preparing; no message was submitted.");
      }
      prepared = { request, conversationId: expected, folder: fileReceipt.folder, stage: "staged" };
      updateJob(prepared);
      const runtimeId = VIEW(sessionId);
      await chatGPTWebviewAutomation.waitFor(runtimeId, { selector: COMPOSER, timeoutMs: 7000 });
      await chatGPTWebviewAutomation.type(runtimeId, {
        selector: COMPOSER, text: request.message, requireEmptyComposer: true,
        expectedConversationId: expected ?? undefined,
      });
      if (guest.getURL() !== current.url && expected && !sameConversation(expected, guest.getURL())) {
        throw Error("Conversation changed during preparation. The staged text was not submitted.");
      }
      // Once we start the send operation, failures are UNKNOWN, never a reason
      // to retry a potentially delivered ChatGPT user turn.
      prepared = { ...prepared, stage: "unknown" };
      updateJob(prepared);
      await chatGPTWebviewAutomation.press(runtimeId, {
        key: "Enter", expectedConversationId: expected ?? undefined,
        expectedComposerText: request.message,
        sendExpiresAt: Date.now() + 8000,
      });
      prepared = { ...prepared, stage: "sent" };
      updateJob(prepared);
      toast(`Sent ${request.ids.length} lines to ChatGPT. Waiting for strict JSON proposals.`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "ChatGPT batch submission failed.";
      if (prepared) updateJob({ ...prepared, stage: prepared.stage === "unknown" ? "unknown" : "failed", error: message });
      toast(message);
    } finally { setSending(false); }
  };

  const check = useCallback(async () => {
    const pending = jobRef.current;
    if (!pending || (pending.stage !== "sent" && pending.stage !== "unknown") ||
        !guestRef.current || readyIdRef.current !== pending.request.sessionId ||
        activeId !== pending.request.sessionId || inFlight.current) return;
    inFlight.current = true;
    setChecking(true);
    try {
      const page = await guestRef.current.executeJavaScript(inspectExpression(12)) as PageInspection;
      if (jobRef.current?.request.requestId !== pending.request.requestId ||
          !sameConversation(pending.conversationId, page.url)) return;
      if (page.activity === "working" || page.connectionInterrupted || page.lastRole !== "assistant") return;
      const marker = `MONKU_TRANSLATION_BATCH_ID: ${pending.request.requestId}`;
      const turn = [...page.messages].reverse().find(message =>
        message.role === "user" && message.text.includes(marker))?.turn;
      if (turn === undefined) return;
      const response = page.messages.find(message => message.role === "assistant" && message.turn === turn);
      if (!response?.text.trim()) return;
      try {
        const proposals = parseChatBatchAnswer(response.text, pending.request);
        updateJob({ ...pending, stage: "ready", proposals, error: undefined });
        setReviewOpen(true);
        toast(`${proposals.length} ChatGPT translation suggestions ready for review.`);
      } catch (cause) {
        // A non-JSON partial answer is not accepted. It can still be streaming
        // even if the page briefly appears idle: keep polling unless the page
        // is definitely completed, in which case show a recoverable parse error.
        if (page.activity === "idle") {
          updateJob({
            ...pending, stage: "failed",
            error: cause instanceof Error ? cause.message : "Invalid ChatGPT JSON response.",
          });
        }
      }
    } catch { /* Navigation or guest teardown; don't resend. */ }
    finally { inFlight.current = false; setChecking(false); }
  }, [activeId, guestRef, readyIdRef, updateJob, toast]);

  useEffect(() => {
    if (!job || (job.stage !== "sent" && job.stage !== "unknown") || activeId !== job.request.sessionId) return;
    const immediate = window.setTimeout(() => { void check(); }, 1800);
    const poll = window.setInterval(() => { void check(); }, 5000);
    return () => { window.clearTimeout(immediate); window.clearInterval(poll); };
  }, [job?.request.requestId, job?.stage, job?.request.sessionId, activeId, check]);

  const apply = () => {
    const pending = jobRef.current;
    if (!pending?.proposals?.length || pending.stage !== "ready") return;
    const invalid = pending.proposals.filter(({ id }) => {
      const row = project.rows.find(row => row.id === id);
      return !row || !canDraft(row) || row.source !== pending.request.sources[id];
    });
    if (invalid.length) {
      toast(`Source or protected status changed for ${invalid.map(x => x.id).join(", ")}. Nothing was applied.`);
      return;
    }
    if (!window.confirm(`Save ${pending.proposals.length} ChatGPT suggestions as AI drafts? Human Japanese remains unchanged.`)) return;
    for (const { id, japanese } of pending.proposals) {
      actions.updateRow(id, row =>
        row.source === pending.request.sources[id] ? withAIDraft(row, japanese) : row,
      );
    }
    updateJob(null);
    setReviewOpen(false);
    toast("ChatGPT batch saved to AI drafts. Curated Japanese was not overwritten.");
  };

  const discard = () => {
    if (!jobRef.current) return;
    if (jobRef.current.stage === "sent" || jobRef.current.stage === "unknown") {
      if (!window.confirm("Discard tracking for this batch? The ChatGPT conversation and any response will remain in the browser.")) return;
    }
    updateJob(null);
    setReviewOpen(false);
  };

  const status = !job ? "" :
    job.stage === "staged" ? "Preparing batch…" :
    job.stage === "sent" ? "ChatGPT translating…" :
    job.stage === "unknown" ? "Send uncertain · check conversation" :
    job.stage === "ready" ? `${job.proposals?.length ?? 0} suggestions ready` :
    job.error ?? "Batch failed";

  return {
    job, status, sending, checking, reviewOpen, setReviewOpen, draftable,
    run, check, apply, discard,
    resume: () => job?.request.sessionId && openSession(job.request.sessionId),
  };
}
