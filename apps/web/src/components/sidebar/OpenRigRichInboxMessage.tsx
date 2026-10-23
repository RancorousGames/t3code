import type {
  DesktopOpenRigHumanResponseInput,
  DesktopOpenRigHumanResponseResult,
  DesktopOpenRigInboxItem,
} from "@t3tools/contracts";
import { CheckIcon, ExternalLinkIcon, SendIcon, CopyIcon, AlertCircleIcon } from "lucide-react";
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export interface AnswerOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}
export type RichQuestion =
  | {
      type: "choice";
      id: string;
      label: string;
      hint?: string;
      required: boolean;
      options: AnswerOption[];
    }
  | {
      type: "multi";
      id: string;
      label: string;
      hint?: string;
      required: boolean;
      options: AnswerOption[];
      minSelected: number;
      maxSelected: number;
    }
  | {
      type: "slider";
      id: string;
      label: string;
      hint?: string;
      required: boolean;
      min: number;
      max: number;
      step: number;
      defaultValue: number;
      unit: string;
    }
  | {
      type: "text";
      id: string;
      label: string;
      hint?: string;
      required: boolean;
      placeholder: string;
      multiline: boolean;
    };
export interface RichMedia {
  url: string;
  alt: string;
  caption?: string;
}
export interface RichLink {
  url: string;
  label: string;
}
export interface RichForm {
  version: 1 | 2;
  title: string;
  description?: string;
  questions: RichQuestion[];
  images: RichMedia[];
  links: RichLink[];
}
export type RichAnswer = string | string[] | number;
export type RichAnswers = Record<string, RichAnswer>;

const MAX_RICH_BYTES = 16_000;
const ID = /^[A-Za-z0-9_-]{1,40}$/u;
const DRAFT_PREFIX = "t3code:openrig-human-form-draft:v1:";
const RICH_FENCE = /(?:^|\n)```openrig-form[ \t]*\r?\n([\s\S]*?)\r?\n```(?=\r?\n|$)/iu;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function short(value: unknown, limit = 500): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= limit ? text : null;
}
function url(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const candidate = new URL(value);
    return (candidate.protocol === "https:" || candidate.protocol === "http:") &&
      !candidate.username &&
      !candidate.password
      ? candidate.toString()
      : null;
  } catch {
    return null;
  }
}
function readOptions(value: unknown): AnswerOption[] | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > 12) return null;
  const ids = new Set<string>();
  const result: AnswerOption[] = [];
  for (const raw of value) {
    const entry = object(raw);
    const id = entry && short(entry.id, 40);
    const label = entry && short(entry.label, 120);
    if (!id || !ID.test(id) || !label || ids.has(id)) return null;
    ids.add(id);
    const description = short(entry!.description, 450);
    result.push({
      id,
      label,
      ...(description ? { description } : {}),
      ...(entry!.recommended === true ? { recommended: true } : {}),
    });
  }
  return result;
}

export function parseRichForm(value: unknown): RichForm | null {
  const payload = object(value);
  if (!payload || payload.version !== 1) return null;
  const title = short(payload.title, 160) ?? "Your response";
  if (!Array.isArray(payload.questions) || payload.questions.length > 8) return null;
  const ids = new Set<string>();
  const questions: RichQuestion[] = [];
  for (const raw of payload.questions) {
    const question = object(raw);
    const id = question && short(question.id, 40);
    const label = question && (short(question.label, 500) ?? short(question.question, 500));
    if (!id || !ID.test(id) || !label || ids.has(id)) return null;
    ids.add(id);
    const required = question!.required !== false;
    const hint = short(question!.hint, 800);
    const shared = { id, label, required, ...(hint ? { hint } : {}) };
    switch (question!.type) {
      case "choice":
      case "single":
      case "single_choice": {
        const options = readOptions(question!.options);
        if (!options) return null;
        questions.push({ ...shared, type: "choice", options });
        break;
      }
      case "multi":
      case "checkboxes":
      case "multi_choice": {
        const options = readOptions(question!.options);
        if (!options) return null;
        const minSelected = Number.isInteger(question!.minSelected)
          ? Number(question!.minSelected)
          : required
            ? 1
            : 0;
        const maxSelected = Number.isInteger(question!.maxSelected)
          ? Number(question!.maxSelected)
          : options.length;
        if (minSelected < 0 || minSelected > maxSelected || maxSelected > options.length)
          return null;
        questions.push({ ...shared, type: "multi", options, minSelected, maxSelected });
        break;
      }
      case "slider":
      case "range": {
        const { min, max, step } = question!;
        if (
          typeof min !== "number" ||
          typeof max !== "number" ||
          typeof step !== "number" ||
          !Number.isFinite(min) ||
          !Number.isFinite(max) ||
          !Number.isFinite(step) ||
          min >= max ||
          step <= 0 ||
          max - min > 1_000_000 ||
          (max - min) / step > 2_000
        )
          return null;
        const unit = typeof question!.unit === "string" ? question!.unit.slice(0, 12) : "";
        const candidate = question!.defaultValue;
        const initial =
          typeof candidate === "number" && Number.isFinite(candidate) ? candidate : min;
        questions.push({
          ...shared,
          type: "slider",
          min,
          max,
          step,
          defaultValue: Math.min(max, Math.max(min, initial)),
          unit,
        });
        break;
      }
      case "text": {
        const placeholder =
          typeof question!.placeholder === "string" ? question!.placeholder.slice(0, 160) : "";
        questions.push({
          ...shared,
          type: "text",
          placeholder,
          multiline: question!.multiline !== false,
        });
        break;
      }
      default:
        return null;
    }
  }
  const images: RichMedia[] = [];
  if (payload.images !== undefined) {
    if (!Array.isArray(payload.images) || payload.images.length > 6) return null;
    for (const raw of payload.images) {
      const entry = object(raw);
      const src = entry && url(entry.url);
      if (!src) return null;
      images.push({
        url: src,
        alt: short(entry!.alt, 250) ?? "Image attached by sender",
        ...(short(entry!.caption, 300) ? { caption: short(entry!.caption, 300)! } : {}),
      });
    }
  }
  const links: RichLink[] = [];
  if (payload.links !== undefined) {
    if (!Array.isArray(payload.links) || payload.links.length > 12) return null;
    for (const raw of payload.links) {
      const entry = object(raw);
      const href = entry && url(entry.url);
      const label = entry && short(entry.label, 120);
      if (!href || !label) return null;
      links.push({ url: href, label });
    }
  }
  if (!questions.length && !images.length && !links.length) return null;
  const description = short(payload.description, 1_500);
  return { version: 1, title, ...(description ? { description } : {}), questions, images, links };
}

/** Canonical OpenRig v2 humanForm, carried in the original durable queue record. */
export function parseHumanFormV2(value: unknown): RichForm | null {
  const payload = object(value);
  if (
    !payload ||
    payload.version !== 2 ||
    !Array.isArray(payload.questions) ||
    !payload.questions.length ||
    payload.questions.length > 8
  )
    return null;
  const ids = new Set<string>();
  const questions: RichQuestion[] = [];
  for (const raw of payload.questions) {
    const item = object(raw);
    const id = item && short(item.id, 40);
    const label = item && short(item.prompt, 500);
    if (!id || !ID.test(id) || !label || ids.has(id)) return null;
    ids.add(id);
    const shared = { id, label, required: true };
    if (item!.type === "single-select" || item!.type === "multi-select") {
      const options = readOptions(item!.options);
      if (!options) return null;
      if (item!.type === "single-select") {
        questions.push({ ...shared, type: "choice", options });
      } else {
        const minSelected = Number.isInteger(item!.minSelected) ? Number(item!.minSelected) : 1;
        const maxSelected = Number.isInteger(item!.maxSelected)
          ? Number(item!.maxSelected)
          : options.length;
        if (minSelected < 0 || maxSelected > options.length || maxSelected < minSelected)
          return null;
        questions.push({ ...shared, type: "multi", options, minSelected, maxSelected });
      }
    } else if (item!.type === "slider") {
      const { min, max, step } = item!;
      if (
        typeof min !== "number" ||
        typeof max !== "number" ||
        typeof step !== "number" ||
        !Number.isFinite(min) ||
        !Number.isFinite(max) ||
        !Number.isFinite(step) ||
        max <= min ||
        step <= 0 ||
        (max - min) / step > 2_000
      )
        return null;
      questions.push({ ...shared, type: "slider", min, max, step, defaultValue: min, unit: "" });
    } else return null;
  }
  const images: RichMedia[] = [];
  const links: RichLink[] = [];
  if (payload.media !== undefined) {
    if (!Array.isArray(payload.media) || payload.media.length > 12) return null;
    for (const raw of payload.media) {
      const media = object(raw);
      const href = media && url(media.url);
      if (!href) return null;
      if (media!.type === "image") {
        images.push({ url: href, alt: short(media!.alt, 250) ?? "Image from agent" });
      } else if (media!.type === "link") {
        const label = short(media!.label, 120);
        if (!label) return null;
        links.push({ url: href, label });
      } else return null;
    }
  }
  return {
    version: 2,
    title: short(payload.title, 160) ?? "Your response",
    questions,
    images,
    links,
  };
}

export function parseInboxRichContent(item: DesktopOpenRigInboxItem): {
  text: string;
  form: RichForm | null;
  invalid: boolean;
} {
  if (item.humanForm !== undefined && item.humanForm !== null) {
    const form = parseHumanFormV2(item.humanForm);
    return { text: item.body, form, invalid: form === null };
  }
  // Legacy queue questions are actual structured options, but use a different
  // reply protocol. Present them as editable local previews, never as v2 sends.
  if (item.humanQuestions !== undefined && item.humanQuestions !== null) {
    const questions = item.humanQuestions;
    const form = Array.isArray(questions)
      ? parseRichForm({
          version: 1,
          title: "Legacy human questions",
          questions: questions.map((q: unknown) => {
            const raw = object(q);
            return raw ? { ...raw, type: "choice", label: raw.question } : q;
          }),
        })
      : null;
    return { text: item.body, form, invalid: form === null };
  }
  const match = RICH_FENCE.exec(item.body);
  // Optional future server field. Existing OpenRig versions can embed a fenced form.
  const raw = "rich" in item && item.rich !== undefined ? item.rich : null;
  if (raw != null) {
    const form = parseRichForm(raw);
    return { text: item.body, form, invalid: form === null };
  }
  if (!match) return { text: item.body, form: null, invalid: false };
  if (match[1]!.length > MAX_RICH_BYTES) return { text: item.body, form: null, invalid: true };
  let value: unknown;
  try {
    value = JSON.parse(match[1]!);
  } catch {
    return { text: item.body, form: null, invalid: true };
  }
  const form = parseRichForm(value);
  return form
    ? {
        text: item.body.slice(0, match.index) + item.body.slice(match.index + match[0].length),
        form,
        invalid: false,
      }
    : { text: item.body, form: null, invalid: true };
}

/** Only a pending, recipient-matched native v2 queue decision is answerable here. */
export function isNativeInboxDecision(
  item: DesktopOpenRigInboxItem,
  address: string,
  form: RichForm | null = parseInboxRichContent(item).form,
): boolean {
  return (
    form?.version === 2 &&
    item.humanForm !== undefined &&
    item.sourceType === "queue" &&
    item.recipient === address &&
    item.humanIntent === "decision" &&
    address === "human@kernel" &&
    item.state === "pending"
  );
}

function draftKey(address: string, item: DesktopOpenRigInboxItem): string {
  return (
    DRAFT_PREFIX +
    encodeURIComponent(address) +
    ":" +
    encodeURIComponent(item.sourceType + ":" + item.id)
  );
}
function initialAnswers(
  address: string,
  item: DesktopOpenRigInboxItem,
  form: RichForm,
): RichAnswers {
  let saved: unknown;
  try {
    saved = JSON.parse(window.localStorage.getItem(draftKey(address, item)) ?? "{}");
  } catch {
    /* no draft */
  }
  const stored = object(saved) ?? {};
  const recorded = object(item.humanAnswers) ?? {};
  const initial: RichAnswers = Object.create(null) as RichAnswers;
  for (const q of form.questions) {
    const candidate = Object.hasOwn(recorded, q.id) ? recorded[q.id] : stored[q.id];
    if (q.type === "choice") {
      if (typeof candidate === "string" && q.options.some((option) => option.id === candidate))
        initial[q.id] = candidate;
    } else if (q.type === "multi") {
      if (Array.isArray(candidate))
        initial[q.id] = candidate
          .filter((v): v is string => typeof v === "string" && q.options.some((o) => o.id === v))
          .slice(0, q.maxSelected);
    } else if (q.type === "slider") {
      if (typeof candidate === "number" && Number.isFinite(candidate))
        initial[q.id] = Math.min(q.max, Math.max(q.min, candidate));
      else if (form.version === 1) initial[q.id] = q.defaultValue;
    } else if (q.type === "text" && typeof candidate === "string") {
      initial[q.id] = candidate.slice(0, 3_000);
    }
  }
  return initial;
}

export function validateRichAnswers(form: RichForm, answers: RichAnswers): string | null {
  for (const q of form.questions) {
    const answer = answers[q.id];
    if (q.type === "choice") {
      if (answer === undefined && !q.required) continue;
      if (typeof answer !== "string" || !q.options.some((o) => o.id === answer))
        return `Choose an answer for "${q.label}".`;
    } else if (q.type === "multi") {
      if (!Array.isArray(answer) && !q.required && q.minSelected === 0) continue;
      if (
        !Array.isArray(answer) ||
        answer.length < q.minSelected ||
        answer.length > q.maxSelected ||
        new Set(answer).size !== answer.length ||
        answer.some((a) => !q.options.some((o) => o.id === a))
      )
        return `Choose ${q.minSelected}–${q.maxSelected} for "${q.label}".`;
    } else if (q.type === "slider") {
      if (
        typeof answer !== "number" ||
        !Number.isFinite(answer) ||
        answer < q.min ||
        answer > q.max
      )
        return `Set "${q.label}" within its range.`;
    } else if (q.type === "text") {
      if (answer === undefined && !q.required) continue;
      if (typeof answer !== "string" || (q.required && !answer.trim()) || answer.length > 3_000)
        return `Enter an answer for "${q.label}".`;
    }
  }
  return null;
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-info underline underline-offset-2 hover:text-foreground"
      onClick={(event) => {
        if (!window.desktopBridge?.openExternal) return;
        event.preventDefault();
        void window.desktopBridge.openExternal(href).catch(() => {});
      }}
    >
      {children}
      <ExternalLinkIcon className="size-3 shrink-0" aria-hidden />
    </a>
  );
}
const renderMarkdown = {
  a: ({
    href,
    children,
  }: {
    href?: string | undefined;
    children?: React.ReactNode | undefined;
  }) => {
    const safe = url(href);
    return safe ? <ExternalLink href={safe}>{children}</ExternalLink> : <span>{children}</span>;
  },
  img: ({ src, alt }: { src?: string | undefined; alt?: string | undefined }) => {
    const safe = url(src);
    return safe ? (
      <img
        src={safe}
        alt={alt ?? "Image from message"}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className="my-2 max-h-80 max-w-full rounded-lg border border-border object-contain"
      />
    ) : null;
  },
};
export function RichMessageBody({ text }: { text: string }) {
  return (
    <div className="max-w-none break-words text-sm leading-7 text-foreground [&_p]:my-2 [&_h1]:text-lg [&_h2]:text-base [&_h1]:font-semibold [&_h2]:font-semibold [&_a]:break-all [&_li]:ml-4 [&_li]:list-disc [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3">
      <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={renderMarkdown}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** An answer is a draft until OpenRig confirms its durable acceptance. */
export function OpenRigRichInboxMessage({
  item,
  address,
  onAnnouncement,
  answerWriteAvailable,
}: {
  item: DesktopOpenRigInboxItem;
  address: string;
  onAnnouncement: (text: string) => void;
  /** Absent on older desktop bridges; false means the server cannot accept answers. */
  answerWriteAvailable?: boolean | undefined;
}) {
  const parsed = useMemo(() => parseInboxRichContent(item), [item]);
  const form = parsed.form;
  const [answers, setAnswers] = useState<RichAnswers>(() =>
    form ? initialAnswers(address, item, form) : {},
  );
  const [failure, setFailure] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState<DesktopOpenRigHumanResponseResult | null>(null);
  const [imagePreview, setImagePreview] = useState<RichMedia | null>(null);
  const recorded = useMemo(() => object(item.humanAnswers) ?? {}, [item.humanAnswers]);
  const isActiveDecision = isNativeInboxDecision(item, address, form);
  const isNativeForm = form?.version === 2 && item.humanForm !== undefined;
  const writerReady = answerWriteAvailable === true;
  const completed =
    Boolean(accepted?.complete) ||
    Boolean(form?.questions.length && form.questions.every((q) => Object.hasOwn(recorded, q.id))) ||
    item.state === "done";

  // Durable server answers always take priority over unsent local drafts.
  // Derive this during render so polling does not trigger set-state-in-effect.
  const effectiveAnswers: RichAnswers = { ...answers, ...(recorded as RichAnswers) };

  const update = (id: string, answer: RichAnswer) => {
    if (Object.hasOwn(recorded, id) || accepted) return;
    setAnswers((current) => {
      const next = { ...current, [id]: answer };
      try {
        window.localStorage.setItem(draftKey(address, item), JSON.stringify(next));
      } catch {
        /* session only */
      }
      return next;
    });
    setFailure("");
  };
  const copyAnswers = async () => {
    if (!form) return;
    const error = validateRichAnswers(form, effectiveAnswers);
    if (error) {
      setFailure(error);
      return;
    }
    const summary = form.questions
      .map((q) => {
        const value = effectiveAnswers[q.id];
        const label = (id: string) =>
          "options" in q ? (q.options.find((option) => option.id === id)?.label ?? id) : id;
        const readable = Array.isArray(value)
          ? value.map(label).join(", ")
          : typeof value === "string" && q.type === "choice"
            ? label(value)
            : String(value ?? "");
        return `${q.label}: ${readable}`;
      })
      .join("\n");
    try {
      await navigator.clipboard.writeText(
        `In response to OpenRig message ${item.id}\nFrom: ${item.sender}\n\n${summary}`,
      );
      onAnnouncement("Answer summary copied. It has not been sent to OpenRig.");
      setFailure("");
    } catch {
      setFailure("Clipboard unavailable. Your selections are still saved locally.");
    }
  };
  const submit = async () => {
    if (!form || !isActiveDecision || !writerReady || submitting || completed || accepted) return;
    const error = validateRichAnswers(form, effectiveAnswers);
    if (error) {
      setFailure(error);
      return;
    }
    const action = window.desktopBridge?.submitOpenRigHumanResponse;
    if (!action) {
      setFailure("This desktop version cannot submit answers. You can copy them below.");
      return;
    }
    setSubmitting(true);
    setFailure("");
    const input: DesktopOpenRigHumanResponseInput = {
      version: 2,
      destination: "human@kernel",
      qitemId: item.id,
      answers: form.questions
        .filter((q) => !Object.hasOwn(recorded, q.id))
        .map((q) => ({ questionId: q.id, value: effectiveAnswers[q.id]! })),
    };
    try {
      const result = await action(input);
      if (!result.acceptedIntoQueue || result.qitemId !== item.id) {
        setFailure("OpenRig did not confirm this response on the original queue.");
        return;
      }
      setAccepted(result);
      try {
        window.localStorage.removeItem(draftKey(address, item));
      } catch {
        /* no-op */
      }
      onAnnouncement(
        "OpenRig committed your answers to its durable queue. Agent delivery is not implied.",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setFailure(
        /\b503\b/u.test(message) || /not configured/u.test(message)
          ? "OpenRig has not enabled its secure answer writer. Your selections remain saved locally; nothing was submitted."
          : /\b409\b/u.test(message)
            ? "This decision already has a conflicting recorded answer. Refresh the inbox; nothing new was submitted."
            : `Could not confirm durable acceptance: ${message}. Your selections remain saved. Do not assume the answer was sent.`,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-5">
      <RichMessageBody text={parsed.text} />
      {parsed.invalid && (
        <p
          role="status"
          className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning"
        >
          This message contains unsupported interactive content. The original text is preserved
          below; no action has been taken.
        </p>
      )}
      {form && (
        <>
          {(form.images.length > 0 || form.links.length > 0) && (
            <section aria-label="Message attachments" className="space-y-3">
              {form.images.length > 0 && (
                <div className="grid grid-cols-2 gap-3">
                  {form.images.map((media) => (
                    <button
                      type="button"
                      key={media.url}
                      className="overflow-hidden rounded-lg border border-border bg-muted/30 text-left transition-colors hover:border-info/50"
                      aria-label={`Expand image: ${media.alt}`}
                      onClick={() => setImagePreview(media)}
                    >
                      <img
                        src={media.url}
                        alt={media.alt}
                        loading="lazy"
                        decoding="async"
                        referrerPolicy="no-referrer"
                        className="h-36 w-full object-contain"
                      />
                      {media.caption && (
                        <span className="block px-2 py-1.5 text-xs text-muted-foreground">
                          {media.caption}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {form.links.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {form.links.map((link) => (
                    <span
                      key={link.url}
                      className="rounded-md border border-border bg-muted/20 px-2 py-1 text-xs"
                    >
                      <ExternalLink href={link.url}>{link.label}</ExternalLink>
                    </span>
                  ))}
                </div>
              )}
            </section>
          )}
          {form.questions.length > 0 && (
            <section
              aria-label="Interactive response form"
              className="space-y-4 rounded-xl border border-info/25 bg-info/4 p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-base font-semibold">{form.title}</h4>
                <span className="rounded-full border border-info/25 bg-info/10 px-2 py-0.5 text-2xs font-medium text-info">
                  Agent question
                </span>
              </div>
              {form.description && (
                <p className="text-xs leading-relaxed text-muted-foreground">{form.description}</p>
              )}
              {form.questions.map((q, index) => {
                const answer = effectiveAnswers[q.id];
                return (
                  <fieldset
                    disabled={
                      submitting || completed || Boolean(accepted) || Object.hasOwn(recorded, q.id)
                    }
                    key={q.id}
                    className="space-y-2 border-t border-border/60 pt-3"
                  >
                    <legend className="text-sm font-semibold">
                      {index + 1}. {q.label}
                      {q.required && (
                        <span className="ml-1 text-warning" aria-label="Required">
                          *
                        </span>
                      )}
                    </legend>
                    {q.hint && (
                      <p className="text-xs leading-relaxed text-muted-foreground">{q.hint}</p>
                    )}
                    {q.type === "choice" && (
                      <div className="flex flex-wrap gap-2">
                        {q.options.map((option) => {
                          const active = answer === option.id;
                          return (
                            <button
                              key={option.id}
                              type="button"
                              aria-pressed={active}
                              aria-label={`${q.label}: ${option.label}`}
                              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${active ? "border-info bg-info/15 text-foreground" : "border-border bg-background hover:border-info/40"}`}
                              onClick={() => update(q.id, option.id)}
                            >
                              {active && <CheckIcon className="size-3.5" />}
                              {option.label}
                              {option.recommended && (
                                <span className="rounded bg-info/10 px-1.5 py-0.5 text-3xs text-info">
                                  Suggested
                                </span>
                              )}
                              {option.description && (
                                <span className="max-w-44 text-left text-2xs text-muted-foreground">
                                  {option.description}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {q.type === "multi" && (
                      <div className="space-y-1.5">
                        <p className="text-2xs text-muted-foreground">
                          Choose {q.minSelected}–{q.maxSelected} options
                        </p>
                        {q.options.map((option) => {
                          const chosen = Array.isArray(answer) ? answer : [];
                          const checked = chosen.includes(option.id);
                          return (
                            <label
                              key={option.id}
                              className="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-xs hover:bg-muted/30"
                            >
                              <input
                                type="checkbox"
                                aria-label={`${q.label}: ${option.label}`}
                                checked={checked}
                                className="mt-0.5 accent-info"
                                disabled={!checked && chosen.length >= q.maxSelected}
                                onChange={(e) =>
                                  update(
                                    q.id,
                                    e.currentTarget.checked
                                      ? [...chosen, option.id]
                                      : chosen.filter((id) => id !== option.id),
                                  )
                                }
                              />
                              <span>
                                <span className="font-medium">{option.label}</span>
                                {option.recommended && (
                                  <span className="ml-2 text-info">Suggested</span>
                                )}
                                {option.description && (
                                  <span className="mt-0.5 block text-2xs text-muted-foreground">
                                    {option.description}
                                  </span>
                                )}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                    {q.type === "slider" && (
                      <div className="rounded-lg border border-border bg-background/60 px-3 py-3">
                        <div className="mb-2 flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">
                            {q.min}
                            {q.unit} – {q.max}
                            {q.unit}
                          </span>
                          <output className="rounded-md bg-info/10 px-2 py-1 font-semibold tabular-nums text-info">
                            {typeof answer === "number" ? answer : q.defaultValue}
                            {q.unit}
                          </output>
                        </div>
                        <input
                          type="range"
                          aria-label={q.label}
                          min={q.min}
                          max={q.max}
                          step={q.step}
                          value={typeof answer === "number" ? answer : q.defaultValue}
                          className="w-full accent-info"
                          onChange={(e) => update(q.id, Number(e.currentTarget.value))}
                        />
                        {form.version === 2 && typeof answer !== "number" && (
                          <button
                            type="button"
                            aria-label={`Use slider value: ${q.label}`}
                            className="mt-2 rounded-md border border-info/40 bg-info/10 px-2 py-1 text-xs font-medium text-info hover:bg-info/20"
                            onClick={() => update(q.id, q.defaultValue)}
                          >
                            Confirm {q.defaultValue}
                            {q.unit}
                          </button>
                        )}
                      </div>
                    )}
                    {q.type === "text" &&
                      (q.multiline ? (
                        <textarea
                          aria-label={q.label}
                          placeholder={q.placeholder}
                          maxLength={3000}
                          rows={3}
                          className="w-full resize-y rounded-lg border border-border bg-background p-3 text-sm outline-none focus:border-info"
                          value={typeof answer === "string" ? answer : ""}
                          onChange={(e) => update(q.id, e.currentTarget.value)}
                        />
                      ) : (
                        <input
                          type="text"
                          aria-label={q.label}
                          placeholder={q.placeholder}
                          maxLength={3000}
                          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-info"
                          value={typeof answer === "string" ? answer : ""}
                          onChange={(e) => update(q.id, e.currentTarget.value)}
                        />
                      ))}
                  </fieldset>
                );
              })}
              {failure && (
                <p
                  role="alert"
                  className="flex items-start gap-1.5 rounded-lg border border-warning/30 bg-warning/10 p-2.5 text-xs text-warning"
                >
                  <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
                  {failure}
                </p>
              )}
              {accepted && (
                <p
                  role="status"
                  className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 p-2.5 text-xs font-medium text-success"
                >
                  <CheckIcon className="size-4" /> OpenRig recorded {accepted.answeredCount}{" "}
                  answer(s) on its queue.{" "}
                  {accepted.complete
                    ? "Decision closed."
                    : `${accepted.remainingQuestionIds.length} question(s) remain.`}{" "}
                  {accepted.delivery === "verified"
                    ? "Transport verified; agent consumption unconfirmed."
                    : `Agent delivery: ${accepted.delivery}.`}
                </p>
              )}
              {isNativeForm && answerWriteAvailable === false && !completed && (
                <p
                  role="status"
                  className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning"
                >
                  OpenRig's durable answer writer is unavailable. You can choose options and save a
                  local draft or copy a summary, but this form cannot be submitted from T3 now.
                </p>
              )}
              {isNativeForm && answerWriteAvailable === undefined && isActiveDecision && (
                <p
                  role="status"
                  className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning"
                >
                  This desktop did not report OpenRig answer-writer availability. Answers can be
                  drafted or copied, but sending is disabled until the server writer is verified.
                </p>
              )}
              {!isNativeForm && (
                <p
                  role="status"
                  className="rounded-md border border-warning/25 bg-warning/10 p-2 text-2xs text-warning"
                >
                  {item.humanQuestions
                    ? "Legacy OpenRig choices are display-only in T3; the native v2 answer writer cannot submit them."
                    : "This interactive form is a display-only preview, not a server-authorized decision."}{" "}
                  Copy the answer summary to reply through another channel.
                </p>
              )}
              {isNativeForm && !isActiveDecision && !completed && (
                <p role="status" className="text-2xs text-muted-foreground">
                  This request is no longer pending. Refresh for its latest state before replying.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
                <button
                  type="button"
                  aria-label="Send answers"
                  disabled={
                    !isActiveDecision ||
                    !writerReady ||
                    submitting ||
                    completed ||
                    Boolean(accepted)
                  }
                  className="inline-flex items-center gap-2 rounded-lg bg-info px-3.5 py-2 text-xs font-semibold text-info-foreground hover:bg-info/90 disabled:opacity-50"
                  onClick={() => void submit()}
                >
                  <SendIcon className="size-3.5" />
                  {submitting
                    ? "Sending…"
                    : completed
                      ? "Recorded"
                      : !isNativeForm
                        ? "Preview only"
                        : !writerReady
                          ? "Sending unavailable"
                          : accepted
                            ? "Refresh to continue"
                            : "Send answers"}
                </button>
                <button
                  type="button"
                  aria-label="Copy answer summary"
                  disabled={submitting}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs hover:bg-muted"
                  onClick={() => void copyAnswers()}
                >
                  <CopyIcon className="size-3.5" />
                  Copy answer summary
                </button>
              </div>
              <p className="text-2xs leading-relaxed text-muted-foreground">
                Choices remain local drafts until OpenRig confirms a durable queue write. A queued
                response does not prove the agent has received or acted on it.
              </p>
            </section>
          )}
        </>
      )}
      {imagePreview && (
        <div
          className="fixed inset-0 z-90 flex items-center justify-center bg-black/85 p-8"
          role="dialog"
          aria-label={`Image preview: ${imagePreview.alt}`}
          onClick={() => setImagePreview(null)}
        >
          <button
            type="button"
            className="absolute right-6 top-6 rounded-lg bg-black/60 px-3 py-2 text-sm text-white"
            onClick={() => setImagePreview(null)}
          >
            Close image
          </button>
          <figure className="max-h-full max-w-full" onClick={(e) => e.stopPropagation()}>
            <img
              src={imagePreview.url}
              alt={imagePreview.alt}
              referrerPolicy="no-referrer"
              className="max-h-[80vh] max-w-[90vw] object-contain"
            />
            {imagePreview.caption && (
              <figcaption className="mt-3 text-center text-sm text-white">
                {imagePreview.caption}
              </figcaption>
            )}
          </figure>
        </div>
      )}
    </div>
  );
}
