import { useState } from "react";
import type { ChatGPTSessionQuestion } from "../chatGPTSessionQuestion";
import { Button } from "./ui/button";

/** Native-thread-inspired question card for ChatGPT browser sessions. */
export function ChatGPTSessionQuestionPanel({
  question, onAnswer,
}: {
  question: ChatGPTSessionQuestion;
  onAnswer: (answer: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState("");
  const [custom, setCustom] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  if (question.status !== "pending") return (
    <div className="border-b border-lime-500/20 bg-lime-500/5 px-5 py-2 text-xs text-lime-200" role="status">
      Answer queued for this session: {question.answer}. Delivery is tracked in the message queue.
    </div>
  );
  const answer = selected === "__custom__" ? custom.trim() : selected;
  return (
    <section aria-label="Agent needs your answer" className="shrink-0 border-b border-lime-500/30 bg-lime-500/[0.07] px-5 py-4">
      <div className="flex items-center justify-between gap-2">
        <span className="rounded-full border border-lime-400/50 bg-lime-400/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-lime-300">
          Needs your answer
        </span>
        <span className="text-xs text-muted-foreground">Agent is waiting</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm font-medium">{question.prompt}</p>
      <div className="mt-3 flex flex-col gap-1.5" role="radiogroup" aria-label="Answer choices">
        {question.options.map((option) => (
          <label key={option} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${selected === option ? "border-lime-400/70 bg-lime-400/10" : "border-border/70 bg-card/40"}`}>
            <input type="radio" name={`answer-${question.id}`} checked={selected === option}
              onChange={() => setSelected(option)} />
            <span>{option}</span>
          </label>
        ))}
        {question.allowCustom && (
          <label className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${selected === "__custom__" ? "border-lime-400/70 bg-lime-400/10" : "border-border/70 bg-card/40"}`}>
            <input className="mt-1" type="radio" name={`answer-${question.id}`}
              checked={selected === "__custom__"} onChange={() => setSelected("__custom__")} />
            <textarea className="min-h-12 flex-1 resize-y rounded bg-transparent outline-none placeholder:text-muted-foreground"
              aria-label="Your own answer" placeholder="Write your answer"
              value={custom} maxLength={4000}
              onFocus={() => setSelected("__custom__")}
              onChange={(event) => setCustom(event.target.value)} />
          </label>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-destructive" role="alert">{error}</p>}
      <div className="mt-3 flex justify-end">
        <Button size="sm" disabled={!answer.trim() || submitting} onClick={() => {
          setSubmitting(true);
          setError("");
          void onAnswer(answer).catch((cause: unknown) =>
            setError(`Could not queue your answer: ${String(cause)}`)).finally(() => setSubmitting(false));
        }}>Submit answer</Button>
      </div>
    </section>
  );
}
