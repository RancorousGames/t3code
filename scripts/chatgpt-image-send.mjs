// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Local image-send CLI owns binary staging and receipt persistence.
import * as FS from "node:fs";
import * as Path from "node:path";
import * as Crypto from "node:crypto";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const CHUNK_CHARS = 6000;
const UPLOAD_POLL_MS = 350;
const UPLOAD_MISSING_RETRY_POLLS = 15; // React should stage an attachment within seconds.
const UPLOAD_STALLED_RETRY_POLLS = 65; // A stalled upload is safe to remove before submitting.
const UPLOAD_MAX_POLLS = 210; // Covers three bounded upload attempts without submitting twice.
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const expression = (body) => "(() => { " + body + " })()";
const receiptDir = (home) => Path.join(home, "userdata", "chatgpt-image-deliveries-v1");
const receiptPath = (home, id) => Path.join(receiptDir(home), id + ".json");
const lockPath = (home, sessionId) => Path.join(receiptDir(home), sessionId + ".lock");

// A crashed sender must not lock a session forever. New locks record their PID;
// never reclaim a lock while that process is alive. Old empty locks have no
// owner evidence, so require a generous age threshold before reclaiming them.
function acquireImageLock(home, sessionId, requestId) {
  const path = lockPath(home, sessionId);
  const owner = JSON.stringify({ pid: process.pid, requestId, createdAt: Date.now() });
  const create = () => {
    const fd = FS.openSync(path, "wx");
    try {
      FS.writeFileSync(fd, owner, { flush: true });
    } catch (error) {
      FS.closeSync(fd);
      try {
        FS.unlinkSync(path);
      } catch {}
      throw error;
    }
    return fd;
  };
  try {
    return { fd: create(), path };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  // Serialize orphan recovery separately from the actual session lock.
  const recoveryPath = path + ".recovery";
  let recovery;
  try {
    recovery = FS.openSync(recoveryPath, "wx");
  } catch {
    throw new Error("An image send or orphan-lock recovery is already active for this session.");
  }
  try {
    let stat;
    try {
      stat = FS.statSync(path);
    } catch (error) {
      if (error?.code === "ENOENT") return { fd: create(), path };
      throw error;
    }
    let old = null;
    try {
      old = JSON.parse(FS.readFileSync(path, "utf8"));
    } catch {
      /* Legacy empty lock, or a sender interrupted before writing metadata. */
    }
    const ownerPid = Number.isSafeInteger(old?.pid) && old.pid > 0 ? old.pid : null;
    if (ownerPid) {
      try {
        process.kill(ownerPid, 0);
        throw new Error("Image send owner process is still alive.");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    } else if (Date.now() - stat.mtimeMs < 10 * 60_000) {
      throw new Error(
        "Image send lock has no owner metadata and is not yet old enough to reclaim.",
      );
    }
    // While recovery guard is held, only reclaim the exact file inspected.
    const current = FS.statSync(path);
    if (
      current.ino !== stat.ino ||
      current.mtimeMs !== stat.mtimeMs ||
      FS.readFileSync(path, "utf8") !== (old ? JSON.stringify(old) : "")
    )
      throw new Error("Image send lock changed during stale-owner inspection.");
    FS.unlinkSync(path);
    return { fd: create(), path };
  } finally {
    FS.closeSync(recovery);
    try {
      FS.unlinkSync(recoveryPath);
    } catch {}
  }
}

function persist(home, record) {
  FS.mkdirSync(receiptDir(home), { recursive: true });
  const target = receiptPath(home, record.requestId);
  const temporary = target + "." + process.pid + ".tmp";
  FS.writeFileSync(temporary, JSON.stringify({ ...record, updatedAt: Date.now() }), {
    flag: "w",
    flush: true,
  });
  FS.renameSync(temporary, target);
}
function publicReceipt(record) {
  return {
    action: "send",
    requestId: record.requestId,
    sessionId: record.sessionId,
    verifiedConversationId: record.conversationId,
    conversationGuardValidated: true,
    status: record.status,
    delivery:
      record.status === "delivered"
        ? "user_turn_observed"
        : record.status === "partial"
          ? "text_only_observed"
          : "unconfirmed",
    messageSent: record.status === "delivered" || record.status === "partial",
    sendAttempted: record.sendAttempted === true,
    attachmentObserved: record.status === "delivered",
    imageName: record.imageName,
    imageCount: record.imageCount ?? 0,
    ...(record.reason ? { reason: record.reason } : {}),
    imageDelivery: true,
  };
}
export function imageSendReceipt(home, requestId) {
  if (!UUID.test(requestId ?? ""))
    throw new Error("Image receipt requires an exact requestId UUID.");
  const file = receiptPath(home, requestId);
  if (!FS.existsSync(file)) return null;
  const r = JSON.parse(FS.readFileSync(file, "utf8"));
  return publicReceipt(r);
}

async function guardedEval(
  control,
  id,
  sessionId,
  expressionText,
  postSubmitImageRequestId = null,
) {
  if (expressionText.length > 8000) throw new Error("Guest expression exceeds 8000 characters.");
  const result = await control({
    action: "experimental_evaluate",
    sessionId,
    expectedConversationId: id,
    expression: expressionText,
    allowComposerDraft: true,
    ...(postSubmitImageRequestId ? { postSubmitImageRequestId } : {}),
  });
  if (result?.result?.ok !== true)
    throw new Error("Guest evaluation failed: " + JSON.stringify(result?.result ?? result));
  return result.result.value;
}

function sourceProps() {
  return `
    const e=document.querySelector('[contenteditable="true"][role="textbox"],#prompt-textarea,[data-testid="composer-input"]');
    if(!e)return null;
    for(const root of [e,e.parentElement,e.parentElement?.parentElement]){
      let f=root?.[Object.keys(root).find(k=>k.startsWith("__reactFiber"))];
      for(let i=0;f&&i<90;i++,f=f.return){
        const p=f.memoizedProps;
        if(typeof p?.onSubmit==="function"&&typeof p?.submitDisabled==="boolean"
          &&Object.prototype.hasOwnProperty.call(p,"allowBackgroundSubmit"))return p;
      }
    }
    return null;
  `;
}

function imagePreflight(id) {
  return expression(`
    const editor=document.querySelector('[contenteditable="true"][role="textbox"],#prompt-textarea,[data-testid="composer-input"]');
    if(!editor)return {ok:false,reason:"composer_missing"};
    const draft=editor instanceof HTMLTextAreaElement?editor.value:editor.innerText||editor.textContent||"";
    const previous=window.__t3ChatGPTImageSend;
    if(previous?.phase==="pending_cleanup"){
      // A text-only/failed send can leave temporary attachment state while
      // ChatGPT finishes submitting. Reconcile it on the next preflight
      // instead of blocking a worker until the three-minute orphan timer.
      try{previous.dismissOwnAttachment?.();}catch{}
      const priorProps=previous.findProps?.();
      if(!priorProps?.isSubmitting&&!priorProps?.isWaitingForFileUploads&&
          !priorProps?.attachments?.length){
        clearTimeout(previous.styleTimeout);
        previous.style?.remove();
        previous.phase="finished";
      }
    }
    if(previous?.phase&&!["submitted","finished"].includes(previous.phase))
      return {ok:false,reason:"another_image_send_active"};
    const stop=document.querySelector('[data-testid="stop-button"],[data-testid="composer-stop-button"],button[aria-label="Stop generating"]');
    if(stop?.getClientRects().length&&!stop.disabled)return {ok:false,reason:"generation_active"};
    const findProps=()=>{ ${sourceProps()} };
    const p=findProps();
    if(!p)return {ok:false,reason:"callback_unavailable"};
    if(p.isSubmitting||p.isWaitingForFileUploads||p.attachments?.length)
      return {ok:false,reason:"composer_busy_or_attachments_present"};
    // The upload is temporary T3-owned state. Keep the attachment preview
    // out of the human composer while React completes the authenticated upload.
    // This does not replace ChatGPT's upload protocol with an undocumented API.
    // ProseMirror's document, not innerText, preserves markup and mentions.
    // React's preserveDraft=true can also exclude staged attachments from the
    // submitted turn. Snapshot the draft and restore it *after* a normal send.
    const editorFiber=editor.parentElement?.[Object.keys(editor.parentElement).find(k=>k.startsWith("__reactFiber"))];
    let composerFiber=editorFiber, composerView=null;
    for(let i=0;composerFiber&&i<90;i++,composerFiber=composerFiber.return){
      const view=composerFiber.memoizedProps?.composerController?.view;
      if(view?.state?.doc&&typeof view.dispatch==="function"){composerView=view;break;}
    }
    if(draft.trim()&&!composerView)return {ok:false,reason:"draft_view_unavailable"};
    const style=document.createElement("style");
    style.textContent='[data-composer-body] [class*="ComposerLayoutAttachments"] {display:none !important;}';
    document.head.appendChild(style);
    const state={
      id:${JSON.stringify(id)},chunks:[],phase:"transfer",findProps,
      originalDraft:draft,style,uploadId:null,composerView,
      originalDoc:composerView?.state.doc,
      selectionBookmark:composerView?.state.selection?.getBookmark?.(),
    };
    state.restoreDraft=()=>{
      if(!state.originalDraft.trim()||!state.composerView?.state)return false;
      const view=state.composerView;
      const now=view.state.doc;
      if(now.eq(state.originalDoc))return true;
      // If a human has typed new text since submission, never replace it.
      if(now.textContent.trim())return false;
      let transaction=view.state.tr.replaceWith(0,now.content.size,state.originalDoc.content);
      try{
        if(state.selectionBookmark)transaction=transaction.setSelection(state.selectionBookmark.resolve(transaction.doc));
      }catch{}
      view.dispatch(transaction);
      return true;
    };
    // Removes only the attachment bound to this request's uploadId. Removing by
    // uploadId never touches the draft text or other attachments, so it is safe
    // even after a human edit. Returns true when nothing of ours remains.
    state.dismissOwnAttachment=()=>{
      const p=state.findProps();
      if(!state.uploadId)return true;
      if(!p||p.isSubmitting)return false;
      if(!p.attachments?.some(a=>a.uploadId===state.uploadId))return true;
      p.onAttachmentRemove(state.uploadId,"user");
      return true;
    };
    // A killed CLI or lost IPC response must not reveal a stranded T3 image
    // after the temporary hiding style expires.
    state.styleTimeout=setTimeout(()=>{
      style.remove();
      if(state.phase!=="finished"){
        try{state.dismissOwnAttachment();}catch{}
        state.phase="finished";
      }
    },180000);
    window.__t3ChatGPTImageSend=state;
    return {ok:true};
  `);
}

function attachmentStatus(id) {
  return expression(`
    const s=window.__t3ChatGPTImageSend;
    if(s?.id!==${JSON.stringify(id)})return {ok:false,reason:"transfer_lost"};
    const p=s.findProps();
    if(!p)return {ok:false,reason:"callback_lost"};
    const e=document.querySelector('[contenteditable="true"][role="textbox"],#prompt-textarea,[data-testid="composer-input"]');
    const draft=e instanceof HTMLTextAreaElement?e.value:e?.innerText||e?.textContent||"";
    const view=s.composerView;
    const changed=view?.state?.doc&&s.originalDoc
      ? !view.state.doc.eq(s.originalDoc) : draft!==s.originalDraft;
    const attachments=Array.isArray(p.attachments)?p.attachments:[];
    const attachment=attachments.length===1?attachments[0]:null;
    // Preflight and staging both require an empty composer, so the single
    // attachment that appears after staging is ours. ChatGPT re-encodes,
    // resizes and renames images, so name/size/mime are NOT identity: bind the
    // first uploadId seen and use only that from then on (also for cleanup).
    if(attachment?.uploadId&&!s.uploadId)s.uploadId=attachment.uploadId;
    const owned=!!attachment&&!!s.uploadId&&attachment.uploadId===s.uploadId;
    return {ok:true,draftChanged:changed,uploads:document.querySelectorAll('[aria-label^="Uploading "]').length,
      attachments:attachments.length,attachmentStatus:attachment?.status||null,
      owned,uploadId:attachment?.uploadId||null,hasFileId:!!attachment?.id,
      attachmentName:attachment?.name||null,attachmentSize:attachment?.size??null,
      expectedName:s.file?.name||null,expectedSize:s.file?.size??null,
      ready:owned&&attachment?.status==="ready"&&!!attachment.id&&!!attachment.uploadId,
      pending:!!p.isWaitingForFileUploads,submitting:!!p.isSubmitting};
  `);
}

function stageUploadExpression(id, attempt, fileName, mime, size) {
  return expression(`
    const s=window.__t3ChatGPTImageSend;
    if(s?.id!==${JSON.stringify(id)}||!["transfer","uploading"].includes(s.phase))
      return {ok:false,reason:"stage_state_lost"};
    const p=s.findProps();
    if(!p||p.isSubmitting||p.isWaitingForFileUploads||p.attachments?.length)
      return {ok:false,reason:"stage_composer_busy"};
    const editor=s.composerView;
    if(editor?.state?.doc&&s.originalDoc&&!editor.state.doc.eq(s.originalDoc))
      return {ok:false,reason:"draft_changed"};
    let file=s.file;
    if(!file){
      const decoded=atob(s.chunks.join(""));
      s.chunks=[];
      const bytes=Uint8Array.from(decoded,c=>c.charCodeAt(0));
      file=new File([bytes],${JSON.stringify(fileName)},{type:${JSON.stringify(mime)}});
      if(file.size!==${size})return {ok:false,reason:"image_size_mismatch"};
      s.file=file;
    }
    const labels=["Attach photos","Attach photos or videos","Attach files"];
    const label=labels[${attempt}];
    const input=[...document.querySelectorAll("input[type=file]")]
      .find(i=>i.getAttribute("aria-label")===label&&!i.disabled);
    if(!input)return {ok:false,reason:"file_handler_missing",label};
    const key=Object.keys(input).find(k=>k.startsWith("__reactProps"));
    const onChange=key&&input[key]?.onChange;
    if(typeof onChange!=="function")return {ok:false,reason:"react_file_handler_unavailable",label};
    s.phase="uploading";s.stageAttempt=${attempt};s.uploadId=null;
    const selected={id:input.id,files:[file],value:""};
    onChange({currentTarget:selected,target:selected});
    return {ok:true,route:"react_handler",label,fileInputCount:input.files?.length||0};
  `);
}

function resetUploadExpression(id) {
  return expression(`
    const s=window.__t3ChatGPTImageSend;
    if(s?.id!==${JSON.stringify(id)}||s.phase!=="uploading")
      return {ok:false,reason:"stage_state_lost"};
    const p=s.findProps();
    if(!p||p.isSubmitting)return {ok:false,reason:"submit_in_progress"};
    const a=p.attachments||[];
    if(!a.length)return {ok:true,empty:true};
    if(a.length!==1||!a[0].uploadId||a[0].status==="ready")
      return {ok:false,reason:"cannot_safely_reset",status:a[0]?.status,attachments:a.length};
    // Cancel only the image from this request. A newly added human
    // attachment is never removed.
    if(!s.uploadId||a[0].uploadId!==s.uploadId)
      return {ok:false,reason:"upload_owner_mismatch"};
    p.onAttachmentRemove(a[0].uploadId,"user");
    return {ok:true,removedId:a[0].uploadId};
  `);
}

function sendExpression(id, message, conversationId) {
  return expression(`
    const s=window.__t3ChatGPTImageSend;
    if(s?.id!==${JSON.stringify(id)}||s.phase!=="uploading")return {ok:false,reason:"transfer_not_ready"};
    if(location.pathname!==${JSON.stringify("/c/" + conversationId)})return {ok:false,reason:"conversation_mismatch"};
    const p=s.findProps();
    if(!p||!Array.isArray(p.attachments)||p.attachments.length!==1||p.isWaitingForFileUploads||p.isSubmitting
        ||p.attachments[0]?.status!=="ready"||!p.attachments[0]?.id||!p.attachments[0]?.uploadId
        ||!s.uploadId||p.attachments[0]?.uploadId!==s.uploadId)
      return {ok:false,reason:"attachment_not_ready"};
    const e=document.querySelector('[contenteditable="true"][role="textbox"],#prompt-textarea,[data-testid="composer-input"]');
    const draft=e instanceof HTMLTextAreaElement?e.value:e?.innerText||e?.textContent||"";
    const changed=s.composerView?.state?.doc&&s.originalDoc
      ? !s.composerView.state.doc.eq(s.originalDoc) : draft!==s.originalDraft;
    if(changed)return {ok:false,reason:"draft_changed"};
    s.phase="submitted";
    s.submitOutcome="pending";
    try{
      // preserveDraft=true can omit staged image attachments from the send.
      // A normal submission consumes the upload; afterward restore the
      // snapshot through ProseMirror rather than mutating the visible DOM.
      const result=p.onSubmit(${JSON.stringify(message)},performance.now(),{preserveDraft:false},true);
      const settled=(value)=>{
        s.submitOutcome=value===false?"rejected":value===true?"accepted":"completed";
        // ChatGPT can clear the ProseMirror view asynchronously. Restore only
        // if the original draft was erased; never override newer human edits.
        if(s.originalDraft.trim()){
          for(const ms of [0,100,500,1500]){
            setTimeout(()=>{try{s.restoreDraft?.()}catch{}},ms);
          }
        }
      };
      if(result?.then)Promise.resolve(result).then(settled,error=>{
        s.submitOutcome="rejected";s.submitError=String(error).slice(0,160);
        try{s.restoreDraft?.()}catch{}
      });
      else settled(result);
    }catch(error){
      // A throwing callback may still have sent a request. Treat it as UNKNOWN.
      s.submitOutcome="threw";s.submitError=String(error).slice(0,160);
    }
    return {ok:true,submitted:true,attachmentsBefore:1};
  `);
}

function deliveryProbe(marker) {
  return expression(`
    const el=[...document.querySelectorAll('[class*="group/user-message"]')]
      .find(n=>(n.innerText||n.textContent||"").includes(${JSON.stringify(marker)}));
    const s=window.__t3ChatGPTImageSend;
    const p=s?.findProps?.();
    return {
      found:!!el,
      imageCount:el?.querySelectorAll('img[alt="User attachment"],img[src^="data:image/"]')?.length||0,
      callbackOutcome:s?.submitOutcome||"pending",
      callbackError:s?.submitError||null,
      ownAttachment:!!s?.uploadId&&p?.attachments?.some(a=>a.uploadId===s.uploadId)===true,
      busy:!!(p?.isSubmitting||p?.isWaitingForFileUploads),
    };
  `);
}

/** One-shot, precisely guarded browser image send. An UNKNOWN is never replayed. */
export async function sendChatGPTImage(input, { home, control, wait = delay } = {}) {
  const { sessionId, message, imagePath } = input;
  if (
    !UUID.test(sessionId ?? "") ||
    (input.expectedConversationId !== undefined && !UUID.test(input.expectedConversationId)) ||
    typeof message !== "string" ||
    !message.trim() ||
    message.length > 8000 ||
    typeof imagePath !== "string" ||
    !Path.isAbsolute(imagePath)
  )
    throw new Error(
      "Image send requires a T3 session UUID, optional conversation UUID, nonempty message and absolute imagePath.",
    );
  const requestId = input.requestId ?? Crypto.randomUUID();
  if (!UUID.test(requestId)) throw new Error("Image send requestId must be a stable UUID.");

  const extension = Path.extname(imagePath).toLowerCase();
  const mime = MIME[extension];
  if (!mime) throw new Error("Image send supports PNG, JPEG or WebP only.");
  const image = FS.readFileSync(imagePath);
  if (image.length === 0 || image.length > MAX_IMAGE_BYTES)
    throw new Error("Image must be between 1 byte and 2 MiB.");
  let expectedConversationId = input.expectedConversationId;
  if (!expectedConversationId) {
    const observed = await control({ action: "read", sessionId, count: 1, wakeForSend: true });
    const candidate = observed?.session?.conversationId;
    if (
      !UUID.test(candidate ?? "") ||
      observed?.session?.observedGuestUrl !== "https://chatgpt.com/c/" + candidate
    )
      throw new Error("No current exact conversation binding for image send.");
    expectedConversationId = candidate;
  }
  const guard = await control({
    action: "read",
    sessionId,
    count: 1,
    wakeForSend: true,
    expectedConversationId,
  });
  if (
    !UUID.test(expectedConversationId ?? "") ||
    guard?.verifiedConversationId !== expectedConversationId ||
    guard?.conversationGuardValidated !== true ||
    guard?.session?.conversationId !== expectedConversationId ||
    guard?.session?.observedGuestUrl !== "https://chatgpt.com/c/" + expectedConversationId
  )
    throw new Error("The mounted ChatGPT conversation was not verified; image not sent.");
  const sha256 = Crypto.createHash("sha256").update(image).digest("hex");
  const payloadHash = Crypto.createHash("sha256")
    .update(JSON.stringify([sessionId, expectedConversationId, message, sha256]))
    .digest("hex");
  const previous = imageSendReceipt(home, requestId);
  if (previous) {
    const source = JSON.parse(FS.readFileSync(receiptPath(home, requestId), "utf8"));
    if (source.payloadHash !== payloadHash)
      throw new Error("The image requestId already belongs to a different send.");
    // A crashed sender can leave a reserved/uploading receipt before calling
    // onSubmit. Only the exact same requestId may resume, and only after the
    // live composer preflight below proves no staged attachment remains.
    if (source.sendAttempted || !["reserved", "uploading"].includes(source.status))
      return { ...previous, reconciled: true };
  }
  const record = {
    requestId,
    sessionId,
    conversationId: expectedConversationId,
    imageName: Path.basename(imagePath),
    payloadHash,
    status: "reserved",
    imageCount: 0,
    sendAttempted: false,
    reason: null,
  };
  FS.mkdirSync(receiptDir(home), { recursive: true });
  const lock = acquireImageLock(home, sessionId, requestId);
  try {
    const fresh = imageSendReceipt(home, requestId);
    if (fresh) {
      const existing = JSON.parse(FS.readFileSync(receiptPath(home, requestId), "utf8"));
      if (existing.payloadHash !== payloadHash)
        throw new Error("Image request payload changed while waiting for session lock.");
      if (existing.sendAttempted || !["reserved", "uploading"].includes(existing.status))
        return { ...fresh, reconciled: true };
    }
    persist(home, record);
    const experiment = (js, postSubmit = false) =>
      guardedEval(control, expectedConversationId, sessionId, js, postSubmit ? requestId : null);
    const before = await experiment(imagePreflight(requestId));
    if (!before?.ok) {
      Object.assign(record, { status: "not_sent", reason: before?.reason ?? "Preflight refused" });
      persist(home, record);
      return publicReceipt(record);
    }
    const encoded = image.toString("base64");
    for (let pos = 0, i = 0; pos < encoded.length; pos += CHUNK_CHARS, i++) {
      const chunk = encoded.slice(pos, pos + CHUNK_CHARS);
      const r = await experiment(
        expression(`
        const s=window.__t3ChatGPTImageSend;
        if(s?.id!==${JSON.stringify(requestId)}||s.phase!=="transfer"||s.chunks.length!==${i})
          return {ok:false,reason:"transfer_mismatch"};
        s.chunks.push(${JSON.stringify(chunk)});
        return {ok:true};
      `),
      );
      if (!r?.ok) throw new Error("Image transfer failed before upload: " + JSON.stringify(r));
    }
    let stage = await experiment(
      stageUploadExpression(requestId, 0, Path.basename(imagePath), mime, image.length),
    );
    if (!stage?.ok) throw new Error("Image attachment failed: " + JSON.stringify(stage));
    record.stageRoute = stage.route;
    record.fileInputCountAfterChange = stage.fileInputCount;
    record.stageAttempts = [{ attempt: 0, label: stage.label }];
    record.status = "uploading";
    persist(home, record);
    let ready = false;
    let currentAttempt = 0;
    let pollsOnStage = 0;
    let lastUpload = null;
    for (let i = 0; i < UPLOAD_MAX_POLLS; i++) {
      const s = await experiment(attachmentStatus(requestId));
      lastUpload = s;
      if (
        !s?.ok ||
        s.draftChanged ||
        s.submitting ||
        s.attachments > 1 ||
        (s.attachments === 1 && !s.owned)
      )
        throw new Error("Attachment became unsafe: " + JSON.stringify(s));
      if (s.ready && !s.uploads && !s.pending) {
        ready = true;
        break;
      }
      pollsOnStage++;
      const missing = s.attachments === 0 && pollsOnStage >= UPLOAD_MISSING_RETRY_POLLS;
      const stalled =
        s.attachments === 1 &&
        (["error", "failed"].includes(s.attachmentStatus) ||
          pollsOnStage >= UPLOAD_STALLED_RETRY_POLLS);
      if (currentAttempt < 2 && (missing || stalled)) {
        // No user turn was sent. Re-stage through a different React handler
        // only after the prior attachment is absent or explicitly cancelled.
        const reset = await experiment(resetUploadExpression(requestId));
        if (!reset?.ok)
          throw new Error(
            "Upload retry could not safely cancel: " + JSON.stringify({ reset, lastUpload: s }),
          );
        let cleared = false;
        for (let n = 0; n < 12; n++) {
          const state = await experiment(attachmentStatus(requestId));
          if (
            !state?.ok ||
            state.draftChanged ||
            state.submitting ||
            state.attachments > 1 ||
            (state.attachments === 1 && !state.owned)
          )
            throw new Error("Upload changed during retry: " + JSON.stringify(state));
          if (state.attachments === 0 && !state.pending) {
            cleared = true;
            break;
          }
          await wait(UPLOAD_POLL_MS);
        }
        if (!cleared)
          throw new Error(
            "Previous upload did not clear before retry: " + JSON.stringify(lastUpload),
          );
        currentAttempt++;
        stage = await experiment(
          stageUploadExpression(
            requestId,
            currentAttempt,
            Path.basename(imagePath),
            mime,
            image.length,
          ),
        );
        if (!stage?.ok) throw new Error("Retry image attachment failed: " + JSON.stringify(stage));
        record.stageAttempts.push({
          attempt: currentAttempt,
          label: stage.label,
          recoveredFrom: missing ? "missing_attachment" : s.attachmentStatus || "stalled_upload",
        });
        persist(home, record);
        pollsOnStage = 0;
        continue;
      }
      await wait(UPLOAD_POLL_MS);
    }
    record.lastUploadStatus = lastUpload;
    if (!ready)
      throw new Error(
        "Image upload did not finish before deadline: " +
          JSON.stringify({ stageAttempts: record.stageAttempts, lastUpload }),
      );
    record.uploadReadyObserved = true;
    // The browser callback may submit even if IPC acknowledgment is lost.
    record.status = "submitting";
    record.sendAttempted = true;
    persist(home, record);
    const marker = "[T3-IMAGE:" + requestId + "]";
    const sent = await experiment(
      sendExpression(requestId, marker + " " + message, expectedConversationId),
    );
    if (!sent?.ok) {
      record.status = "not_sent";
      record.sendAttempted = false;
      record.reason = sent?.reason ?? "Submit callback not invoked";
      persist(home, record);
      return publicReceipt(record);
    }
    let lastObserved = null;
    for (let i = 0; i < 70; i++) {
      // Generation can start immediately after onSubmit; receipt observation is
      // permitted only against this exact submitted image request.
      const observed = await experiment(deliveryProbe(marker), true);
      lastObserved = observed;
      // User text can appear before ChatGPT renders its image. Give the
      // attachment a short bounded opportunity to render before reporting partial delivery.
      if (observed?.found && (observed.imageCount > 0 || i >= 12)) {
        record.imageCount = observed.imageCount;
        record.status = observed.imageCount > 0 ? "delivered" : "partial";
        record.reason =
          observed.imageCount > 0 ? null : "Text observed without the image attachment.";
        persist(home, record);
        return publicReceipt(record);
      }
      // React can resolve false without sending anything. Wait briefly for
      // a late user turn before reporting failure, but never blindly retry.
      if (i >= 8 && observed?.callbackOutcome === "rejected" && !observed.busy)
        throw new Error(
          "React submit rejected: " + (observed.callbackError ?? "callback returned false"),
        );
      await wait(400);
    }
    throw new Error(
      "Callback invoked, but matching user turn was not observed. " +
        "outcome=" +
        (lastObserved?.callbackOutcome ?? "unavailable") +
        ", ownAttachment=" +
        !!lastObserved?.ownAttachment +
        ", busy=" +
        !!lastObserved?.busy,
    );
  } catch (error) {
    if (record.sendAttempted) {
      record.status = "unknown";
      record.reason = String(error).slice(0, 500);
    } else {
      record.status = "not_sent";
      record.reason = String(error).slice(0, 500);
    }
    persist(home, record);
    return publicReceipt(record);
  } finally {
    try {
      await guardedEval(
        control,
        expectedConversationId,
        sessionId,
        expression(`
        const s=window.__t3ChatGPTImageSend;
        if(s?.id===${JSON.stringify(requestId)}){
          // An UNKNOWN is never retried. If React is still submitting, let
          // the guarded orphan timer retry cleanup after the submission settles.
          let deferredCleanup=false;
          const failed=${["not_sent", "unknown", "partial"].includes(record.status)};
          // An upload that appeared after the last status poll is still ours.
          const a=s.findProps?.()?.attachments;
          if(failed&&!s.uploadId&&s.phase==="uploading"&&a?.length===1&&a[0].uploadId)
            s.uploadId=a[0].uploadId;
          if(failed&&s.uploadId){
            try{deferredCleanup=!s.dismissOwnAttachment?.();}catch{deferredCleanup=true;}
          }
          s.chunks=[];s.phase=deferredCleanup?"pending_cleanup":"finished";
          if(!deferredCleanup)clearTimeout(s.styleTimeout);
          s.style?.remove();
        }
        return true;
      `),
        requestId,
      );
    } catch {
      /* The guest may have navigated after submission. */
    }
    try {
      FS.closeSync(lock.fd);
    } catch {}
    try {
      FS.unlinkSync(lock.path);
    } catch {}
  }
}
