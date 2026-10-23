import { Fragment } from "react";
import { markText } from "./insights.ts";
import type { MoriGlossaryEntry } from "./model.ts";

/** Text with glossary terms underlined and placeholders as chips. Line breaks are shown as ↵. */
export function Marked({ text, glossary }: { text: string; glossary: MoriGlossaryEntry[] }) {
  return (
    <>
      {text.split("\n").map((line, lineIndex) => (
        <Fragment key={lineIndex}>
          {lineIndex > 0 && <><span className="nl">↵</span><br /></>}
          {markText(line, glossary).map((part, partIndex) => {
            if (part.kind === "token") return <span key={partIndex} className="tok">{part.text}</span>;
            if (part.kind === "term") return <span key={partIndex} className="term" title={`Glossary: ${part.term?.jp ?? ""}`}>{part.text}</span>;
            return <Fragment key={partIndex}>{part.text}</Fragment>;
          })}
        </Fragment>
      ))}
    </>
  );
}
