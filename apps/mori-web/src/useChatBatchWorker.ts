import { useCallback, useEffect, useRef, useState } from "react";
import { chatGPTConversationIdFromUrl } from "../../web/src/chatGPTConversationIdentity.ts";
import { isChatGPTHomeUrl } from "../../web/src/chatGPTBrowserPrewarm.ts";
import { inspectChatGPTPage, type PageInspection } from "../../web/src/chatGPTSessionDom.ts";
import { chatGPTWebviewAutomation } from "../../web/src/chatGPTWebviewAutomation.ts";
import { CHAT_BATCH_SIZE, chooseChatBatch, makeChatBatch, mergeChatBatchDrafts, parseChatBatchAnswer, type ChatBatchRequest } from "./chat-batches.ts";
import { notify } from "./Notifications.tsx";
import { nativeMori } from "./backend.ts";
import { MATRIX_BATCH_EVENT, readMatrixBatchPlan, saveMatrixBatchPlan, type MatrixBatchPlan } from "./matrix-batch.ts";
import { canDraft } from "./ai-batch.ts";
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
  planId?: string;
  planCursorEnd?: number;
  planSkipped?: number;
};

const storageKey = (id: string) => `mori.ai-chat.batch:${id}`;
const VIEW = (id: string) => `mori-chatgpt:${id}`;
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
  const [plan, setPlan] = useState<MatrixBatchPlan | null>(() => readMatrixBatchPlan(project.id));
  const planRef = useRef(plan);
  const dispatching = useRef(false);
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const jobRef = useRef(job);
  const projectRef = useRef(project);
  projectRef.current = project;
  const applying = useRef(false);
  const inFlight = useRef(false);
  const draftable = chooseChatBatch(project, CHAT_BATCH_SIZE, focusRowId);
  const updatePlan = useCallback((next: MatrixBatchPlan) => {
    planRef.current = next;
    setPlan(next);
    saveMatrixBatchPlan(next);
  }, []);

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
    planRef.current = readMatrixBatchPlan(project.id);
    setPlan(planRef.current);
    const onChange = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== project.id) return;
      planRef.current = readMatrixBatchPlan(project.id);
      setPlan(planRef.current);
    };
    window.addEventListener(MATRIX_BATCH_EVENT, onChange);
    return () => window.removeEventListener(MATRIX_BATCH_EVENT, onChange);
  }, [project.id]);

  const run = async (chunk?: { ids: string[]; planId: string; cursorEnd: number; skipped: number }) => {
    if (!chunk && (planRef.current?.stage === "running" || planRef.current?.stage === "paused")) {
      toast("Finish or stop the Matrix translation queue first.");
      return;
    }
    if (sending || jobRef.current) {
      toast("Finish or discard the current ChatGPT translation batch first.");
      return;
    }
    if (!activeId || !guestRef.current || readyIdRef.current !== activeId) {
      toast("Open a ChatGPT session and wait for its composer to become ready.");
      return;
    }
    const rows = chunk ? chunk.ids.map(id => projectRef.current.rows.find(row => row.id === id)) : draftable;
    if (!rows.length || rows.some(row => !row || !canDraft(row) || row.ai?.trim())) {
      toast("One or more lines are no longer eligible for a new AI draft.");
      if (chunk && planRef.current?.id === chunk.planId) updatePlan({ ...planRef.current, stage: "paused", error: "Translation candidates changed. Review the queue." });
      return;
    }
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
      if (expected === null && !isChatGPTHomeUrl(current.url)) {
        throw Error("Open a ChatGPT conversation before starting this batch.");
      }
      const request = makeChatBatch(projectRef.current, prefs, rows.filter((row): row is NonNullable<typeof row> => !!row), sessionId, crypto.randomUUID());
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
      prepared = { request, conversationId: expected, folder: fileReceipt.folder, stage: "staged",
        ...(chunk ? { planId: chunk.planId, planCursorEnd: chunk.cursorEnd, planSkipped: chunk.skipped } : {}) };
      updateJob(prepared);
      const runtimeId = VIEW(sessionId);
      const expiresAt = Date.now() + 8_000;
      const sameGuest = () => readyIdRef.current === sessionId && guestRef.current === guest;
      const stillAtTarget = () => sameGuest() &&
        (expected ? sameConversation(expected, guest.getURL()) : isChatGPTHomeUrl(guest.getURL()));
      let submitted = false;
      // The mounted ChatGPT React callback may appear after the basic editor
      // readiness probe. Only a definite no-callback result permits waiting.
      while (Date.now() < expiresAt) {
        if (!stillAtTarget())
          throw Error("ChatGPT session changed before batch dispatch; no message sent.");
        // Persist before every potentially irreversible callback. A lost IPC
        // response is UNKNOWN and must never cause a second batch submission.
        prepared = { ...prepared, stage: "unknown" };
        updateJob(prepared);
        const outcome = await chatGPTWebviewAutomation.directSubmit(runtimeId, {
          text: request.message,
          ...(expected ? { expectedConversationId: expected } : { expectedNewChat: true }),
          sendExpiresAt: expiresAt,
        });
        if (outcome === "submitted") {
          submitted = true;
          break;
        }
        prepared = { ...prepared, stage: "staged" };
        updateJob(prepared);
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
      }
      if (!submitted)
        throw Error("ChatGPT's direct-submit callback did not become ready; no message was sent.");

      // A callback return is NOT a delivery receipt. Require the exact batch
      // marker to appear in a rendered user turn, even across first-chat navigation.
      const marker = `MONKU_TRANSLATION_BATCH_ID: ${request.requestId}`;
      const verificationDeadline = Date.now() + 10_000;
      while (Date.now() < verificationDeadline && sameGuest()) {
        const page = await guest.executeJavaScript(inspectExpression(12)) as PageInspection;
        const observedConversation = chatGPTConversationIdFromUrl(page.url);
        if (expected ? observedConversation !== expected : !observedConversation) {
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
          continue;
        }
        if (page.messages.some((entry) => entry.role === "user" && entry.text.includes(marker))) {
          prepared = { ...prepared, stage: "sent", conversationId: observedConversation };
          updateJob(prepared);
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
      if (prepared.stage !== "sent")
        throw Error("ChatGPT direct submit was invoked but its user turn is unconfirmed; check this conversation, do not resend.");
      toast(`Sent ${request.ids.length} ${request.ids.length === 1 ? "line" : "lines"} to ChatGPT. Waiting for JSON proposals.`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "ChatGPT batch submission failed.";
      if (prepared) updateJob({ ...prepared, stage: prepared.stage === "unknown" ? "unknown" : "failed", error: message });
      if (chunk && planRef.current?.id === chunk.planId) updatePlan({ ...planRef.current, stage: "paused", error: message });
      toast(message);
    } finally { setSending(false); }
  };

  // Advance only after a verified response has been saved. A staged or uncertain
  // send stays attached to the exact request and is never automatically replayed.
  useEffect(() => {
    if (plan?.stage !== "running") return;
    const advance = async () => {
      const current = planRef.current;
      if (!current || current.stage !== "running" || dispatching.current ||
        sending || jobRef.current || activeId !== current.sessionId ||
        !guestRef.current || readyIdRef.current !== current.sessionId) return;
      const selected: string[] = [];
      let skipped = 0;
      let end = current.cursor;
      while (end < current.ids.length && selected.length < CHAT_BATCH_SIZE) {
        const id = current.ids[end++]!;
        const row = projectRef.current.rows.find(candidate => candidate.id === id);
        if (!row || !canDraft(row) || row.ai?.trim()) skipped++;
        else selected.push(id);
      }
      if (!selected.length) {
        const finished = end >= current.ids.length;
        updatePlan({ ...current, cursor: end, skipped: current.skipped + skipped,
          stage: finished ? "done" : "running" });
        return;
      }
      dispatching.current = true;
      try { await run({ ids: selected, planId: current.id, cursorEnd: end, skipped }); }
      finally { dispatching.current = false; }
    };
    const first = window.setTimeout(() => { void advance(); }, 900);
    const interval = window.setInterval(() => { void advance(); }, 2500);
    return () => { window.clearTimeout(first); window.clearInterval(interval); };
  }, [plan?.id, plan?.cursor, plan?.stage, activeId, sending]);

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
      const currentPlan = planRef.current;
      if (pending.planId && currentPlan?.id === pending.planId && pending.planCursorEnd !== undefined) {
        const cursor = Math.max(currentPlan.cursor, pending.planCursorEnd);
        const completed = cursor >= currentPlan.ids.length;
        const newlySkipped = pending.planCursorEnd > currentPlan.cursor ? pending.planSkipped ?? 0 : 0;
        updatePlan({ ...currentPlan, cursor, skipped: currentPlan.skipped + newlySkipped,
          stage: completed && currentPlan.stage === "running" ? "done" : currentPlan.stage, error: undefined });
        if (completed && currentPlan.stage === "running") notify("Translation queue finished.", "success");
      }
      updateJob(null);
      if (merged.added && !pending.planId) notify(`${merged.added} more AI ${merged.added === 1 ? "translation" : "translations"} just added`, "success");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not save ChatGPT drafts.";
      updateJob({ ...pending, stage: "failed", error: message });
      if (pending.planId && planRef.current?.id === pending.planId) updatePlan({ ...planRef.current, stage: "paused", error: message });
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
        if (pending.planId && planRef.current?.id === pending.planId) updatePlan({ ...planRef.current, stage: "paused", error: message });
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
    if (jobRef.current.planId && planRef.current?.id === jobRef.current.planId) {
      updatePlan({ ...planRef.current, stage: "stopped", error: "Tracking discarded; this queue cannot resume automatically." });
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
    job, plan, status, sending, checking, draftable,
    run, check, discard,
    resume: () => job?.request.sessionId && openSession(job.request.sessionId),
  };
}
