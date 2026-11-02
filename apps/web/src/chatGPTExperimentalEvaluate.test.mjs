import { expect, test } from "vitest";
import { JSDOM } from "jsdom";
import { allowsChatGPTExperimentalNewChat, buildChatGPTExperimentalExpression } from "./chatGPTExperimentalEvaluate.ts";

const id = "6ae38246-bc20-83eb-9790-b06fe02eab1b";
async function evaluate(url, draft, expression = "({ mode: 'read_only_probe' })", backend = false) {
  const page = new JSDOM('<textarea id="prompt-textarea"></textarea>', {
    url,
    runScripts: "outside-only",
  });
  page.window.document.querySelector("textarea").value = draft;
  try {
    return await page.window.eval(buildChatGPTExperimentalExpression(backend ? null : id, expression, backend));
  } finally {
    page.window.close();
  }
}

test("evaluates in the exact idle conversation with an empty composer", async () => {
  expect(JSON.parse(JSON.stringify(await evaluate(`https://chatgpt.com/c/${id}`, "")))).toEqual({
    ok: true, value: { mode: "read_only_probe" },
  });
});
test("rejects a different conversation without evaluating", async () => {
  const result = await evaluate(
    "https://chatgpt.com/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "",
    "(() => { document.title = 'MUTATED'; return 1; })()",
  );
  expect(result.reason).toBe("Guest conversation changed before experiment.");
});
test("rejects a nonempty unsent draft", async () => {
  const result = await evaluate(`https://chatgpt.com/c/${id}`, "Unsent message");
  expect(result.reason).toBe("Composer has an unsent draft.");
});
test("rejects invalid experiment parameters", () => {
  expect(() => buildChatGPTExperimentalExpression(id, "")).toThrow();
  expect(() => buildChatGPTExperimentalExpression(id, "x".repeat(8001))).toThrow();
  expect(() => buildChatGPTExperimentalExpression("wrong", "1")).toThrow();
  expect(() => buildChatGPTExperimentalExpression(null, "1")).toThrow();
});

test("allows a new backend-owned chat without an existing conversation UUID", async () => {
  const backend = { id: "t3-created", creationOrigin: "backend", spawnRequestId: "spawn-123" };
  expect(allowsChatGPTExperimentalNewChat(backend, "https://chatgpt.com/")).toBe(true);
  expect(await evaluate("https://chatgpt.com/", "", "({ page: 'new' })", true)).toEqual({
    ok: true, value: { page: "new" }, observedConversationId: null,
  });
});

test("never permits a manual, unknown or user-controlled homepage", () => {
  const home = "https://chatgpt.com/";
  expect(allowsChatGPTExperimentalNewChat({ creationOrigin: "manual" }, home)).toBe(false);
  expect(allowsChatGPTExperimentalNewChat({}, home)).toBe(false);
  expect(allowsChatGPTExperimentalNewChat({ creationOrigin: "backend", humanControlled: true }, home)).toBe(false);
  expect(allowsChatGPTExperimentalNewChat({ creationOrigin: "manual", spawnRequestId: "spawn" }, home)).toBe(false);
  expect(allowsChatGPTExperimentalNewChat({ creationOrigin: "backend" }, "https://chatgpt.com/settings")).toBe(false);
  expect(allowsChatGPTExperimentalNewChat({ creationOrigin: "backend" }, "https://evil.example/")).toBe(false);
  expect(allowsChatGPTExperimentalNewChat({ creationOrigin: "backend" }, `https://chatgpt.com/c/${id}`)).toBe(false);
});

test("refuses a new backend chat with an existing draft or wrong target", async () => {
  expect((await evaluate("https://chatgpt.com/", "human draft", "true", true)).reason)
    .toBe("Composer has an unsent draft.");
  expect((await evaluate(`https://chatgpt.com/c/${id}`, "", "true", true)).reason)
    .toBe("Guest conversation changed before experiment.");
});
