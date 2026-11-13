// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Local image-send CLI owns binary staging and receipt persistence.
import * as FS from "node:fs";
import * as Path from "node:path";
import * as Crypto from "node:crypto";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const CHUNK_CHARS = 6000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const expression = (body) => "(() => { " + body + " })()";
const receiptDir = (home) => Path.join(home, "userdata", "chatgpt-image-deliveries-v1");
const receiptPath = (home, id) => Path.join(receiptDir(home), id + ".json");
const lockPath = (home, sessionId) => Path.join(receiptDir(home), sessionId + ".lock");

function persist(home, record) {
  FS.mkdirSync(receiptDir(home), { recursive: true });
  const target = receiptPath(home, record.requestId);
  const temporary = target + "." + process.pid + ".tmp";
  FS.writeFileSync(temporary, JSON.stringify({ ...record, updatedAt: Date.now() }), { flag: "w", flush: true });
  FS.renameSync(temporary, target);
}
function publicReceipt(record) {
  return {
    action: "send", requestId: record.requestId, sessionId: record.sessionId,
    verifiedConversationId: record.conversationId, conversationGuardValidated: true,
    status: record.status,
    delivery: record.status === "delivered" ? "user_turn_observed" : "unconfirmed",
    messageSent: record.status === "delivered",
    sendAttempted: record.sendAttempted === true,
    attachmentObserved: record.status === "delivered",
    imageName: record.imageName,
    imageCount: record.imageCount ?? 0,
    ...(record.reason ? { reason: record.reason } : {}),
    imageDelivery: true,
  };
}
export function imageSendReceipt(home, requestId) {
  if (!UUID.test(requestId ?? "")) throw new Error("Image receipt requires an exact requestId UUID.");
  const file = receiptPath(home, requestId);
  if (!FS.existsSync(file)) return null;
  const r = JSON.parse(FS.readFileSync(file, "utf8"));
  return publicReceipt(r);
}

async function guardedEval(control, id, sessionId, expressionText) {
  if (expressionText.length > 8000) throw new Error("Guest expression exceeds 8000 characters.");
  const result = await control({
    action: "experimental_evaluate", sessionId, expectedConversationId: id,
    expression: expressionText,
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
    if(draft.trim())return {ok:false,reason:"draft_present"};
    if(window.__t3ChatGPTImageSend?.phase&&!["submitted","finished"].includes(window.__t3ChatGPTImageSend.phase))
      return {ok:false,reason:"another_image_send_active"};
    const stop=document.querySelector('[data-testid="stop-button"],[data-testid="composer-stop-button"],button[aria-label="Stop generating"]');
    if(stop?.getClientRects().length&&!stop.disabled)return {ok:false,reason:"generation_active"};
    const findProps=()=>{ ${sourceProps()} };
    const p=findProps();
    if(!p)return {ok:false,reason:"callback_unavailable"};
    if(p.isSubmitting||p.isWaitingForFileUploads||p.attachments?.length)
      return {ok:false,reason:"composer_busy_or_attachments_present"};
    window.__t3ChatGPTImageSend={id:${JSON.stringify(id)},chunks:[],phase:"transfer",findProps};
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
    return {ok:true,draft:!!draft.trim(),uploads:document.querySelectorAll('[aria-label^="Uploading "]').length,
      attachments:Array.isArray(p.attachments)?p.attachments.length:0,
      pending:!!p.isWaitingForFileUploads,submitting:!!p.isSubmitting};
  `);
}

function sendExpression(id, message, conversationId) {
  return expression(`
    const s=window.__t3ChatGPTImageSend;
    if(s?.id!==${JSON.stringify(id)}||s.phase!=="uploading")return {ok:false,reason:"transfer_not_ready"};
    if(location.pathname!==${JSON.stringify("/c/" + conversationId)})return {ok:false,reason:"conversation_mismatch"};
    const p=s.findProps();
    if(!p||!Array.isArray(p.attachments)||p.attachments.length!==1||p.isWaitingForFileUploads||p.isSubmitting)
      return {ok:false,reason:"attachment_not_ready"};
    const e=document.querySelector('[contenteditable="true"][role="textbox"],#prompt-textarea,[data-testid="composer-input"]');
    if((e instanceof HTMLTextAreaElement?e.value:e?.innerText||e?.textContent||"").trim())
      return {ok:false,reason:"draft_changed"};
    s.phase="submitted";
    const result=p.onSubmit(${JSON.stringify(message)},performance.now(),{preserveDraft:false},true);
    if(result?.then)Promise.resolve(result).catch(()=>{});
    return {ok:true,submitted:true,attachmentsBefore:1};
  `);
}

function deliveryProbe(marker) {
  return expression(`
    const el=[...document.querySelectorAll('[class*="group/user-message"]')]
      .find(n=>(n.innerText||n.textContent||"").includes(${JSON.stringify(marker)}));
    return {found:!!el,imageCount:el?.querySelectorAll('img[alt="User attachment"],img[src^="data:image/"]')?.length||0};
  `);
}

/** One-shot, precisely guarded browser image send. An UNKNOWN is never replayed. */
export async function sendChatGPTImage(input, { home, control, wait = delay } = {}) {
  const { sessionId, message, imagePath } = input;
  if (!UUID.test(sessionId ?? "") ||
      (input.expectedConversationId !== undefined && !UUID.test(input.expectedConversationId)) ||
      typeof message !== "string" || !message.trim() || message.length > 8000 ||
      typeof imagePath !== "string" || !Path.isAbsolute(imagePath))
    throw new Error("Image send requires a T3 session UUID, optional conversation UUID, nonempty message and absolute imagePath.");
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
    if (!UUID.test(candidate ?? "") ||
        observed?.session?.observedGuestUrl !== "https://chatgpt.com/c/" + candidate)
      throw new Error("No current exact conversation binding for image send.");
    expectedConversationId = candidate;
  }
  const guard = await control({ action: "read", sessionId, count: 1, wakeForSend: true,
    expectedConversationId });
  if (!UUID.test(expectedConversationId ?? "") ||
      guard?.verifiedConversationId !== expectedConversationId ||
      guard?.conversationGuardValidated !== true ||
      guard?.session?.conversationId !== expectedConversationId ||
      guard?.session?.observedGuestUrl !== "https://chatgpt.com/c/" + expectedConversationId)
    throw new Error("The mounted ChatGPT conversation was not verified; image not sent.");
  const sha256 = Crypto.createHash("sha256").update(image).digest("hex");
  const payloadHash = Crypto.createHash("sha256")
    .update(JSON.stringify([sessionId, expectedConversationId, message, sha256])).digest("hex");
  const previous = imageSendReceipt(home, requestId);
  if (previous) {
    const source = JSON.parse(FS.readFileSync(receiptPath(home, requestId), "utf8"));
    if (source.payloadHash !== payloadHash)
      throw new Error("The image requestId already belongs to a different send.");
    return { ...previous, reconciled: true };
  }
  const record = {
    requestId, sessionId, conversationId: expectedConversationId,
    imageName: Path.basename(imagePath), payloadHash, status: "reserved",
    imageCount: 0, sendAttempted: false, reason: null,
  };
  FS.mkdirSync(receiptDir(home), { recursive: true });
  const lockFile = lockPath(home, sessionId);
  let lock;
  try { lock = FS.openSync(lockFile, "wx"); }
  catch { throw new Error("An image send is already active for this session."); }
  try {
    const fresh = imageSendReceipt(home, requestId);
    if (fresh) return fresh;
    persist(home, record);
    const experiment = (js) => guardedEval(control, expectedConversationId, sessionId, js);
    const before = await experiment(imagePreflight(requestId));
    if (!before?.ok) {
      Object.assign(record, { status: "not_sent", reason: before?.reason ?? "Preflight refused" });
      persist(home, record); return publicReceipt(record);
    }
    const encoded = image.toString("base64");
    for (let pos = 0, i = 0; pos < encoded.length; pos += CHUNK_CHARS, i++) {
      const chunk = encoded.slice(pos, pos + CHUNK_CHARS);
      const r = await experiment(expression(`
        const s=window.__t3ChatGPTImageSend;
        if(s?.id!==${JSON.stringify(requestId)}||s.phase!=="transfer"||s.chunks.length!==${i})
          return {ok:false,reason:"transfer_mismatch"};
        s.chunks.push(${JSON.stringify(chunk)});
        return {ok:true};
      `));
      if (!r?.ok) throw new Error("Image transfer failed before upload: " + JSON.stringify(r));
    }
    const stage = await experiment(expression(`
      const s=window.__t3ChatGPTImageSend;
      if(s?.id!==${JSON.stringify(requestId)}||s.phase!=="transfer")
        return {ok:false,reason:"transfer_state_lost"};
      const decoded=atob(s.chunks.join(""));
      s.chunks=[];
      const bytes=Uint8Array.from(decoded,c=>c.charCodeAt(0));
      const file=new File([bytes],${JSON.stringify(Path.basename(imagePath))},{type:${JSON.stringify(mime)}});
      if(file.size!==${image.length})return {ok:false,reason:"image_size_mismatch"};
      const input=document.querySelector('input[type="file"][aria-label="Attach photos or videos"]')
        ||document.querySelector('input[type="file"][aria-label="Attach photos"]')
        ||document.querySelector('input[type="file"][aria-label="Attach files"]');
      if(!input||input.disabled)return {ok:false,reason:"file_input_missing"};
      const transfer=new DataTransfer();transfer.items.add(file);input.files=transfer.files;
      s.phase="uploading";
      input.dispatchEvent(new Event("change",{bubbles:true}));
      return {ok:true};
    `));
    if (!stage?.ok) throw new Error("Image attachment failed: " + JSON.stringify(stage));
    record.status = "uploading";
    persist(home, record);
    let ready = false;
    for (let i = 0; i < 110; i++) {
      const s = await experiment(attachmentStatus(requestId));
      if (!s?.ok || s.draft || s.submitting || s.attachments > 1)
        throw new Error("Attachment became unsafe: " + JSON.stringify(s));
      if (s.attachments === 1 && !s.uploads && !s.pending) { ready = true; break; }
      await wait(350);
    }
    if (!ready) throw new Error("Image upload did not finish before deadline.");
    // The browser callback may submit even if IPC acknowledgment is lost.
    record.status = "submitting";
    record.sendAttempted = true;
    persist(home, record);
    const marker = "[T3-IMAGE:" + requestId + "]";
    const sent = await experiment(sendExpression(requestId, marker + " " + message, expectedConversationId));
    if (!sent?.ok) {
      record.status = "not_sent"; record.sendAttempted = false;
      record.reason = sent?.reason ?? "Submit callback not invoked";
      persist(home, record); return publicReceipt(record);
    }
    for (let i = 0; i < 70; i++) {
      const observed = await experiment(deliveryProbe(marker));
      if (observed?.found) {
        record.imageCount = observed.imageCount;
        record.status = observed.imageCount > 0 ? "delivered" : "text_only";
        record.reason = observed.imageCount > 0 ? null : "Text observed without the image attachment.";
        persist(home, record); return publicReceipt(record);
      }
      await wait(400);
    }
    throw new Error("Callback invoked, but matching user turn was not observed.");
  } catch (error) {
    if (record.sendAttempted) {
      record.status = "unknown";
      record.reason = String(error).slice(0, 250);
    } else {
      record.status = "not_sent";
      record.reason = String(error).slice(0, 250);
    }
    persist(home, record);
    return publicReceipt(record);
  } finally {
    try {
      await guardedEval(control, expectedConversationId, sessionId, expression(`
        const s=window.__t3ChatGPTImageSend;
        if(s?.id===${JSON.stringify(requestId)}) {s.chunks=[];s.phase="finished";}
        return true;
      `));
    } catch { /* The guest may have navigated after submission. */ }
    try { FS.closeSync(lock); } catch {}
    try { FS.unlinkSync(lockFile); } catch {}
  }
}
