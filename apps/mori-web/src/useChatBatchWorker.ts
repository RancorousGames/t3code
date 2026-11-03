import { useCallback, useEffect, useRef, useState } from "react";
import { chatGPTConversationIdFromUrl } from "../../web/src/chatGPTConversationIdentity.ts";
import { inspectChatGPTPage, type PageInspection } from "../../web/src/chatGPTSessionDom.ts";
import { chatGPTWebviewAutomation } from "../../web/src/chatGPTWebviewAutomation.ts";
import { CHAT_BATCH_SIZE, chooseChatBatch, makeChatBatch, mergeChatBatchDrafts, parseChatBatchAnswer, type ChatBatchRequest } from "./chat-batches.ts";
import { notify } from "./Notifications.tsx";
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
  invalidResponseFingerprint?: string | undefined;
  invalidResponseSince?: number | undefined;
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
  focusRowId?: string | null;
  guestRef: React.RefObject<Guest | null>;
  readyIdRef: React.RefObject<string | null>;
  toast: (text: string) => void;
  openSession: (id: string) => void;
}) {
  const { project, prefs, actions, activeId, focusRowId, guestRef, readyIdRef, toast, openSession } = input;
  const [job, setJob] = useState<PendingJob | null>(() => restore(project.id));
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const jobRef = useRef(job);
  const projectRef = useRef(project);
  projectRef.current = project;
  const applying = useRef(false);
  const inFlight = useRef(false);
  const draftable = chooseChatBatch(project, CHAT_BATCH_SIZE, focusRowId);

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
      toast(`Sent ${request.ids.length} ${request.ids.length === 1 ? "line" : "lines"} to ChatGPT. Waiting for JSON proposals.`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "ChatGPT batch submission failed.";
      if (prepared) updateJob({ ...prepared, stage: prepared.stage === "unknown" ? "unknown" : "failed", error: message });
      toast(message);
    } finally { setSending(false); }
  };

  // Valid JSON is accepted as AI drafts automatically. The source snapshot
  // is verified before all proposals are merged in one project update.
  const commitReady = useCallback((pending: PendingJob) => {
    if (applying.current || jobRef.current?.request.requestId !== pending.request.requestId ||
        pending.request.projectId !== projectRef.current.id ||
        !pending.proposals?.length || pending.stage !== "ready") return;
    applying.current = true;
    try {
      const merged = mergeChatBatchDrafts(projectRef.current, pending.request, pending.proposals);
      if (merged.added) {
        const request = pending.request;
        const proposals = pending.proposals;
        actions.updateProject(current => mergeChatBatchDrafts(current, request, proposals).project);
      }
      updateJob(null);
      if (merged.added) notify(`${merged.added} more AI ${merged.added === 1 ? "translation" : "translations"} just added`, "success");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not save ChatGPT drafts.";
      updateJob({ ...pending, stage: "failed", error: message });
      notify(message, "warning");
    } finally {
      applying.current = false;
    }
  }, [actions, updateJob]);

  // Complete interrupted jobs that already received valid JSON before reload.
  useEffect(() => {
    if (job?.stage === "ready" && job.proposals?.length) commitReady(job);
  }, [job?.request.requestId, job?.stage, commitReady]);

  const check = useCallback(async () => {
    const pending = jobRef.current;
    if (!pending || (pending.stage !== "sent" && pending.stage !== "unknown" &&
        !(pending.stage === "failed" && pending.error?.includes("parseable JSON"))) ||
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
        const ready: PendingJob = { ...pending, stage: "ready", proposals, error: undefined };
        updateJob(ready);
        commitReady(ready);
      } catch (cause) {
        // ChatGPT may briefly report idle while its JSON answer is still
        // streaming. A single invalid/partial response is NOT a failed batch.
        // Require the SAME invalid answer to remain unchanged for 20 seconds.
        if (page.activity !== "idle") return;
        const fingerprint = `${response.text.length}:${response.text.slice(-180)}`;
        const stableSince = pending.invalidResponseFingerprint === fingerprint
          ? pending.invalidResponseSince ?? Date.now() : Date.now();
        if (pending.stage === "failed") return; // Manual Check reply may recover later.
        if (Date.now() - stableSince < 20_000) {
          updateJob({ ...pending, invalidResponseFingerprint: fingerprint, invalidResponseSince: stableSince });
          return;
        }
        const message = cause instanceof Error ? cause.message : "Invalid ChatGPT JSON response.";
        updateJob({ ...pending, stage: "failed", error: message });
        notify(message, "warning");
      }
    } catch { /* Navigation or guest teardown; don't resend. */ }
    finally { inFlight.current = false; setChecking(false); }
  }, [activeId, guestRef, readyIdRef, updateJob, commitReady]);

  useEffect(() => {
    if (!job || (job.stage !== "sent" && job.stage !== "unknown" &&
        !(job.stage === "failed" && job.error?.includes("parseable JSON"))) ||
        activeId !== job.request.sessionId) return;
    const immediate = window.setTimeout(() => { void check(); }, 1800);
    // After a renderer restart, guest DOM often becomes ready *after* the
    // initial failed-job probe. Continue checking that exact response without
    // ever re-sending the request; malformed replies can be repaired later.
    const poll = window.setInterval(() => { void check(); }, job.stage === "failed" ? 15_000 : 5_000);
    return () => { window.clearTimeout(immediate); window.clearInterval(poll); };
  }, [job?.request.requestId, job?.stage, job?.request.sessionId, activeId, check]);

  const discard = () => {
    if (!jobRef.current) return;
    if (jobRef.current.stage === "sent" || jobRef.current.stage === "unknown") {
      if (!window.confirm("Discard tracking for this batch? The ChatGPT conversation and any response will remain in the browser.")) return;
    }
    updateJob(null);
  };

  const status = !job ? "" :
    job.stage === "staged" ? "Preparing batch…" :
    job.stage === "sent" ? "ChatGPT translating…" :
    job.stage === "unknown" ? "Send uncertain · check conversation" :
    job.stage === "ready" ? `${job.proposals?.length ?? 0} suggestions ready` :
    job.error ?? "Batch failed";

  return {
    job, status, sending, checking, draftable,
    run, check, discard,
    resume: () => job?.request.sessionId && openSession(job.request.sessionId),
  };
}
