import type { DesktopOpenRigInboxItem } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  OpenRigRichInboxMessage,
  parseInboxRichContent,
  parseHumanFormV2,
  parseRichForm,
  validateRichAnswers,
} from "./OpenRigRichInboxMessage";

const native = {
  version: 2,
  title: "Plan the deployment",
  questions: [
    {
      id: "target",
      type: "single-select",
      prompt: "Which environment?",
      options: [
        { id: "staging", label: "Staging" },
        { id: "production", label: "Production" },
      ],
    },
    {
      id: "features",
      type: "multi-select",
      prompt: "Which features?",
      minSelected: 1,
      maxSelected: 2,
      options: [
        { id: "search", label: "Search" },
        { id: "alerts", label: "Alerts" },
        { id: "logs", label: "Logs" },
      ],
    },
    { id: "rollout", type: "slider", prompt: "Rollout percent", min: 0, max: 100, step: 5 },
  ],
  media: [
    { type: "image", url: "https://example.com/chart.png", alt: "Deployment chart" },
    { type: "link", url: "https://example.com/plan", label: "Deployment plan" },
  ],
};
const legacy = {
  version: 1,
  title: "Legacy preview",
  questions: [
    {
      id: "target",
      type: "choice",
      label: "Which environment?",
      options: [
        { id: "staging", label: "Staging" },
        { id: "production", label: "Production" },
      ],
    },
  ],
};
const item: DesktopOpenRigInboxItem = {
  id: "qitem-example-1",
  sender: "agent@rig",
  recipient: "human@kernel",
  humanIntent: "decision",
  humanForm: native,
  subject: "Deployment decision",
  body: "Please review **the plan**: [Overview](https://example.com/details).",
  createdAt: "2026-10-18T13:00:00.000Z",
  state: "pending",
  requiresAction: true,
  sourceType: "queue",
};
const storage = new Map<string, string>();
const submit = vi.fn();
const announce = vi.fn();
let rendered: ReactTestRenderer | undefined;
beforeEach(() => {
  storage.clear();
  submit.mockReset();
  announce.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    desktopBridge: { submitOpenRigHumanResponse: submit },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
  });
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => {}) } });
});
afterEach(() => {
  if (rendered) act(() => rendered?.unmount());
  rendered = undefined;
  vi.unstubAllGlobals();
});
async function mount(current = item, answerWriteAvailable: boolean | undefined = true) {
  await act(async () => {
    rendered = create(
      <OpenRigRichInboxMessage
        item={current}
        address="human@kernel"
        answerWriteAvailable={answerWriteAvailable}
        onAnnouncement={announce}
      />,
    );
  });
}
function output() {
  return JSON.stringify(rendered!.toJSON());
}
async function click(label: string) {
  await act(async () => {
    rendered!.root.findByProps({ "aria-label": label }).props.onClick();
  });
}
async function changeCheckbox(label: string, checked: boolean) {
  await act(async () => {
    rendered!.root
      .findByProps({ "aria-label": label })
      .props.onChange({ currentTarget: { checked } });
  });
}
async function selectValidAnswers() {
  await click("Which environment?: Staging");
  await changeCheckbox("Which features?: Search", true);
  await click("Use slider value: Rollout percent");
}

describe("agent-authored OpenRig v2 human forms", () => {
  it("parses native v2 queue forms and renders questions, markdown links and media", async () => {
    expect(parseInboxRichContent(item).form?.version).toBe(2);
    expect(parseInboxRichContent(item).text).toContain("**the plan**");
    await mount();
    expect(output()).toContain("Deployment chart");
    expect(output()).toContain("Deployment plan");
    expect(output()).toContain("Which environment?");
    expect(output()).toContain("Rollout percent");
    expect(output()).toContain("Please review");
  });

  it("rejects unknown version, duplicate IDs, unsound slider bounds, unsafe media schemes", () => {
    expect(parseHumanFormV2({ ...native, version: 3 })).toBeNull();
    expect(
      parseHumanFormV2({ ...native, questions: [...native.questions, native.questions[0]] }),
    ).toBeNull();
    expect(
      parseHumanFormV2({
        ...native,
        media: [{ type: "link", url: "javascript:alert(1)", label: "Bad" }],
      }),
    ).toBeNull();
    expect(
      parseHumanFormV2({ ...native, questions: [{ id: "evil", type: "script", prompt: "Run" }] }),
    ).toBeNull();
    expect(
      parseHumanFormV2({
        ...native,
        questions: [{ id: "bad", type: "slider", prompt: "Bad", min: 0, max: 4, step: 0 }],
      }),
    ).toBeNull();
  });

  it("validates required choices, multi-select bounds, and slider values", () => {
    const form = parseInboxRichContent(item).form!;
    expect(validateRichAnswers(form, { rollout: 0 })).toContain("Choose an answer");
    expect(validateRichAnswers(form, { target: "staging", rollout: 0, features: [] })).toContain(
      "Choose 1",
    );
    expect(
      validateRichAnswers(form, { target: "staging", rollout: 50, features: ["search", "logs"] }),
    ).toBeNull();
  });

  it("submits a single versioned, recipient-scoped batch after explicit click", async () => {
    submit.mockResolvedValue({
      version: 2,
      qitemId: item.id,
      actor: "human@kernel",
      acceptedIntoQueue: true,
      status: "recorded",
      complete: true,
      answeredCount: 3,
      remainingQuestionIds: [],
      replyQitemId: "qitem-answer-1",
      delivery: "queued",
      deliveredToAgent: false,
    });
    await mount();
    await click("Send answers");
    expect(output()).toContain("Choose an answer");
    expect(submit).not.toHaveBeenCalled();
    await selectValidAnswers();
    expect(submit).not.toHaveBeenCalled();
    await click("Send answers");
    expect(submit).toHaveBeenCalledWith({
      version: 2,
      destination: "human@kernel",
      qitemId: item.id,
      answers: [
        { questionId: "target", value: "staging" },
        { questionId: "features", value: ["search"] },
        { questionId: "rollout", value: 0 },
      ],
    });
    expect(output()).toContain("OpenRig recorded");
    expect(output()).toContain("Agent delivery: queued");
    expect(announce).toHaveBeenCalledWith(expect.stringContaining("Agent delivery is not implied"));
    await click("Send answers");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("preserves local drafts and declines to claim success for read-only 503", async () => {
    submit.mockRejectedValue(new Error("OpenRig human answer endpoint returned HTTP 503."));
    await mount();
    await selectValidAnswers();
    await click("Send answers");
    expect(output()).toContain("nothing was submitted");
    expect(output()).not.toContain("OpenRig recorded");
    const key = [...storage.keys()].find((key) => key.includes("draft"));
    expect(key).toBeTruthy();
    expect(storage.get(key!)).toContain("staging");
    await act(async () => {
      rendered!.unmount();
    });
    rendered = undefined;
    await mount();
    expect(
      rendered!.root.findByProps({ "aria-label": "Which environment?: Staging" }).props[
        "aria-pressed"
      ],
    ).toBe(true);
    await click("Copy answer summary");
    expect(announce).toHaveBeenCalledWith(expect.stringContaining("not been sent"));
  });

  it("prevents changing previously recorded server answers and suppresses resending a closed decision", async () => {
    await mount({
      ...item,
      humanAnswers: { target: "staging", features: ["alerts"], rollout: 50 },
      state: "done",
    });
    expect(output()).toContain("Recorded");
    await click("Send answers");
    expect(submit).not.toHaveBeenCalled();
  });

  it("shows a writer-unavailable native v2 form with selectable drafts but no false send affordance", async () => {
    await mount(item, false);
    expect(output()).toContain("durable answer writer is unavailable");
    expect(rendered!.root.findByProps({ "aria-label": "Send answers" }).props.disabled).toBe(true);
    await selectValidAnswers();
    expect([...storage.values()].join(" ")).toContain("staging");
    expect(submit).not.toHaveBeenCalled();
    await click("Copy answer summary");
    expect(announce).toHaveBeenCalledWith(expect.stringContaining("not been sent"));
  });

  it("treats an older bridge with unreported writer capability as draft-only", async () => {
    await act(async () => {
      rendered = create(
        <OpenRigRichInboxMessage item={item} address="human@kernel" onAnnouncement={announce} />,
      );
    });
    expect(output()).toContain("did not report OpenRig answer-writer availability");
    expect(rendered!.root.findByProps({ "aria-label": "Send answers" }).props.disabled).toBe(true);
    await click("Which environment?: Staging");
    expect([...storage.values()].join(" ")).toContain("staging");
    expect(submit).not.toHaveBeenCalled();
  });

  it("projects real legacy queue humanQuestions as read-only selections instead of losing them", async () => {
    const legacyItem = {
      ...item,
      humanForm: undefined,
      humanQuestions: [
        {
          id: "db",
          question: "Which database?",
          options: [
            { id: "pg", label: "Postgres" },
            { id: "sqlite", label: "SQLite" },
          ],
        },
      ],
    };
    expect(parseInboxRichContent(legacyItem).form?.version).toBe(1);
    await mount(legacyItem);
    expect(output()).toContain("Which database?");
    expect(output()).toContain("Legacy OpenRig choices");
    expect(rendered!.root.findByProps({ "aria-label": "Send answers" }).props.disabled).toBe(true);
    await click("Which database?: Postgres");
    expect([...storage.values()].join(" ")).toContain("pg");
    expect(submit).not.toHaveBeenCalled();
  });

  it("displays legacy body-fenced preview with no route to authoritative submission", async () => {
    const body = "```openrig-form\n" + JSON.stringify(legacy) + "\n```";
    const old = { ...item, humanForm: undefined, body };
    expect(parseRichForm(legacy)?.version).toBe(1);
    expect(parseInboxRichContent(old).form?.version).toBe(1);
    await mount(old);
    expect(output()).toContain("display-only preview");
    await click("Which environment?: Staging");
    await click("Send answers");
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not authorize form embedded in body to impersonate v2 server-backed humanForm", () => {
    const body = "```openrig-form\n" + JSON.stringify(native) + "\n```";
    expect(parseInboxRichContent({ ...item, humanForm: undefined, body }).form).toBeNull();
  });
});
