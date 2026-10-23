import type {
  DesktopOpenRigHumanResponseInput,
  DesktopOpenRigInboxItem,
} from "@t3tools/contracts";

export type HumanInboxAction = "fetch_unread" | "fetch_recent_read" | "set_state" | "reply";
export type HumanInboxState = "read" | "unread" | "archived" | "trash" | "inbox";
export type HumanInboxSource = DesktopOpenRigInboxItem["sourceType"];

const READ = "t3code:openrig-human-inbox-read:v1";
const ARCHIVED = "t3code:openrig-human-inbox-archived:v1";
const TRASH = "t3code:openrig-human-inbox-deleted:v1";
const MAX_KEYS = 4_000;
const MAX_FETCH = 50;

const keyFor = (address: string, item: Pick<DesktopOpenRigInboxItem, "sourceType" | "id">) =>
  JSON.stringify([address, item.sourceType, item.id]);

function readKeys(key: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(window.localStorage.getItem(key) ?? "[]"); }
  catch { throw new Error("T3 local inbox state is unreadable; refusing to guess which messages are unread."); }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string"))
    throw new Error("T3 local inbox state is invalid.");
  return parsed.slice(-MAX_KEYS);
}

function writeKeys(key: string, keys: readonly string[]) {
  window.localStorage.setItem(key, JSON.stringify([...new Set(keys)].slice(-MAX_KEYS)));
  if (JSON.stringify(readKeys(key)) !== JSON.stringify([...new Set(keys)].slice(-MAX_KEYS)))
    throw new Error("T3 inbox state was not persisted.");
}

export async function runOpenRigHumanInboxControl(input: {
  action: HumanInboxAction;
  address?: string | undefined;
  limit?: number | undefined;
  itemId?: string | undefined;
  sourceType?: HumanInboxSource | undefined;
  state?: HumanInboxState | undefined;
  answers?: DesktopOpenRigHumanResponseInput["answers"] | undefined;
}) {
  const { action } = input;
  if (!["fetch_unread", "fetch_recent_read", "set_state", "reply"].includes(action))
    throw new Error("Unknown human inbox action.");
  if (!Number.isSafeInteger(input.limit ?? 20) || (input.limit ?? 20) < 1 ||
      (input.limit ?? 20) > MAX_FETCH)
    throw new Error("limit must be an integer from 1 to 50.");
  const address = input.address ?? "human@kernel";
  if (!/^(?:human(?:-[A-Za-z0-9._-]+)?@(kernel|host)|[A-Za-z0-9._:-]+@external)$/.test(address))
    throw new Error("Invalid human inbox address.");
  const reader = window.desktopBridge?.readOpenRigOperatorInbox;
  if (!reader) throw new Error("Human inbox is unavailable in the T3 desktop.");
  const snapshot = await reader(address);
  if (!snapshot.available || snapshot.address !== address)
    throw new Error(snapshot.reason ?? "OpenRig human inbox source unavailable; no empty inbox inferred.");
  const read = new Set(readKeys(READ));
  const archived = new Set(readKeys(ARCHIVED));
  const trashed = new Set(readKeys(TRASH));
  const enriched = snapshot.items
    .map((item) => {
      const id = keyFor(address, item);
      return {
        ...item,
        localState: {
          read: read.has(id),
          folder: trashed.has(id) ? "trash" as const :
            archived.has(id) ? "archived" as const : "inbox" as const,
        },
      };
    })
    .sort((a,b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  if (action === "fetch_unread" || action === "fetch_recent_read") {
    const filtered = enriched.filter((item) => item.localState.folder === "inbox" &&
      item.localState.read === (action === "fetch_recent_read"));
    return { action, address, items: filtered.slice(0, input.limit ?? 20),
      returned: Math.min(filtered.length, input.limit ?? 20),
      truncated: snapshot.truncated || filtered.length > (input.limit ?? 20),
      sourceAvailable: true, note: "Read and folder states are local T3 UI state, not OpenRig queue acknowledgements." };
  }
  if (!input.itemId?.trim() || !input.sourceType ||
      !["queue","mailbox","human_gate"].includes(input.sourceType))
    throw new Error("An exact itemId and sourceType are required.");
  const matches = enriched.filter((item) => item.id === input.itemId &&
    item.sourceType === input.sourceType);
  if (matches.length !== 1)
    throw new Error("Exact message not found in the loaded inbox; nothing changed.");
  const item = matches[0]!;
  const key = keyFor(address, item);
  if (action === "set_state") {
    if (!input.state || !["read","unread","archived","trash","inbox"].includes(input.state))
      throw new Error("set_state requires state=read,unread,archived,trash or inbox.");
    if (input.state === "read" || input.state === "unread") {
      const updated = readKeys(READ).filter((id) => id !== key);
      if (input.state === "read") updated.push(key);
      writeKeys(READ, updated);
    } else {
      const previousArchive = readKeys(ARCHIVED).filter((id) => id !== key);
      const previousTrash = readKeys(TRASH).filter((id) => id !== key);
      if (input.state === "archived") previousArchive.push(key);
      if (input.state === "trash") previousTrash.push(key);
      writeKeys(ARCHIVED, previousArchive);
      writeKeys(TRASH, previousTrash);
    }
    window.dispatchEvent(new Event("t3:openrig-human-inbox-local-state-changed"));
    const afterRead = readKeys(READ).includes(key);
    const afterArchive = readKeys(ARCHIVED).includes(key);
    const afterTrash = readKeys(TRASH).includes(key);
    if (input.state === "read" && !afterRead || input.state === "unread" && afterRead ||
        input.state === "archived" && (!afterArchive || afterTrash) ||
        input.state === "trash" && (!afterTrash || afterArchive) ||
        input.state === "inbox" && (afterTrash || afterArchive))
      throw new Error("T3 local inbox change not verified.");
    return { action, itemId: item.id, sourceType: item.sourceType, address, state: input.state,
      persisted: true, scope: "local-t3-inbox", originalOpenRigState: item.state };
  }
  // Only the already-implemented v2 durable answer path is supported. Ordinary
  // text/approval/spawn responses cannot be invented by a local CLI bridge.
  if (address !== "human@kernel" || item.sourceType !== "queue" ||
      item.recipient !== address || item.humanIntent !== "decision" ||
      item.state !== "pending" || !item.humanForm ||
      typeof item.humanForm !== "object" || !("version" in item.humanForm) ||
      item.humanForm.version !== 2)
    throw new Error("Reply requires an exact pending direct v2 human question; ordinary text reply transport is not available.");
  const answers = input.answers;
  if (!Array.isArray(answers) || !answers.length || answers.length > 8 ||
      answers.some((a) => !a || !/^[A-Za-z0-9_-]{1,40}$/u.test(a.questionId) ||
        !(typeof a.value === "string" && a.value.length <= 120 ||
          typeof a.value === "number" && Number.isFinite(a.value) ||
          Array.isArray(a.value) && a.value.length <= 12 &&
            a.value.every((v: unknown) => typeof v === "string" && v.length <= 120))) ||
      new Set(answers.map(a => a.questionId)).size !== answers.length)
    throw new Error("reply requires 1..8 unique bounded v2 question answers.");
  const questions = "questions" in item.humanForm ? item.humanForm.questions : null;
  if (!Array.isArray(questions) || !answers.every((answer) =>
      questions.some((question: unknown) => {
        if (!question || typeof question !== "object" || !("id" in question)) return false;
        return question.id === answer.questionId;
      })))
    throw new Error("Reply questionId is not part of the exact pending human form.");
  const sender = window.desktopBridge?.submitOpenRigHumanResponse;
  if (!sender) throw new Error("Durable human answer writer unavailable; nothing submitted.");
  const outcome = await sender({
    version: 2, destination: "human@kernel", qitemId: item.id, answers,
  });
  if (!outcome.acceptedIntoQueue || outcome.actor !== address ||
      outcome.qitemId !== item.id || outcome.deliveredToAgent !== false)
    throw new Error("OpenRig did not acknowledge the exact durable human reply; do not retry blindly.");
  return { action, itemId: item.id, sourceType: item.sourceType, address,
    acceptedIntoQueue: true, deliveredToAgent: false, receipt: outcome };
}
