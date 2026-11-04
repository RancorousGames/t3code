// @vitest-environment node
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { chatGPTDirectSubmitExpression, directSubmitOutcome } from "./chatGPTDirectSubmit";

function guest(url: string, draft: string) {
  let called = 0;
  let text: string | null = null;
  class Element {
    innerText = draft;
    parentElement: Record<string, unknown> | null = null;
  }
  class Button extends Element { disabled = false; getClientRects() { return []; } }
  const editor = new Element();
  const fiber = {
    memoizedProps: {
      submitDisabled: false,
      allowBackgroundSubmit: true,
      onSubmit: function onSubmit(message: string) {
        const serialization_metadata = true;
        void serialization_metadata;
        called++;
        text = message;
      },
    },
    return: null,
  };
  editor.parentElement = { __reactFiber$fixture: fiber };
  const parsed = new URL(url);
  const context = {
    URL,
    Date,
    performance: { now: () => 10 },
    HTMLElement: Element,
    HTMLButtonElement: Button,
    location: { href: url, protocol: parsed.protocol, hostname: parsed.hostname,
      pathname: parsed.pathname, hash: parsed.hash },
    document: { querySelector: (selector: string) =>
      selector.includes("data-composer-markdown") ? editor : null },
  };
  return {
    evaluate(expression: string) {
      return runInNewContext(expression, context) as { submitted: boolean; reason?: string };
    },
    outcome: () => ({ called, text, draft: editor.innerText }),
  };
}

describe("ChatGPT React direct submission", () => {
  it("submits a fresh backend chat without modifying an existing human draft", () => {
    const fake = guest("https://chatgpt.com/", "Draft with unicode 🇩🇰\n and spaces  ");
    const result = fake.evaluate(chatGPTDirectSubmitExpression({
      text: "First message", expectedNewChat: true,
    }));
    expect(result).toEqual({ submitted: true });
    expect(fake.outcome()).toEqual({
      called: 1, text: "First message", draft: "Draft with unicode 🇩🇰\n and spaces  ",
    });
  });

  it("refuses the same explicit first message on a changed URL", () => {
    const fake = guest("https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", "draft");
    const result = fake.evaluate(chatGPTDirectSubmitExpression({
      text: "First message", expectedNewChat: true,
    }));
    expect(directSubmitOutcome(result)).toBe("not_submitted");
    expect(fake.outcome()).toEqual({ called: 0, text: null, draft: "draft" });
  });

  it("accepts an exact existing conversation, refuses an unrelated one", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const fake = guest(`https://chatgpt.com/c/${id}`, "keep this");
    expect(directSubmitOutcome(fake.evaluate(chatGPTDirectSubmitExpression({
      text: "Queue", expectedConversationId: id,
    })))).toBe("submitted");
    expect(directSubmitOutcome(fake.evaluate(chatGPTDirectSubmitExpression({
      text: "Wrong", expectedConversationId: "22222222-2222-4222-8222-222222222222",
    })))).toBe("not_submitted");
    expect(fake.outcome()).toEqual({ called: 1, text: "Queue", draft: "keep this" });
  });
});
