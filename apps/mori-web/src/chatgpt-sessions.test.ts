import test from "node:test";
import assert from "node:assert/strict";
import { normalizedChatGPTUrl, normalizedMoriBrowserUrl, deserializeChatSessions } from "./chatgpt-sessions.ts";

test("ChatGPT URL filter accepts only conversation/home endpoints", () => {
  assert.equal(normalizedChatGPTUrl("https://chatgpt.com"), "https://chatgpt.com/");
  assert.equal(normalizedChatGPTUrl("https://chatgpt.com/c/a1234567-89ab-4cde-8f00-123456789abc?x=2"),
    "https://chatgpt.com/c/a1234567-89ab-4cde-8f00-123456789abc");
  assert.equal(normalizedChatGPTUrl("https://not-chatgpt.com/c/a123"), null);
  assert.equal(normalizedChatGPTUrl("file:///etc/passwd"), null);
  assert.equal(normalizedChatGPTUrl("https://chatgpt.com/gpts"), null);
});
test("AI browser URL bar accepts provider links and retains non-ChatGPT tabs", () => {
  assert.equal(normalizedMoriBrowserUrl("aistudio.google.com/prompts/new_chat"), "https://aistudio.google.com/prompts/new_chat");
  assert.equal(normalizedMoriBrowserUrl("https://gemini.google.com/"), "https://gemini.google.com/");
  assert.equal(normalizedMoriBrowserUrl("https://claude.ai/"), "https://claude.ai/");
  assert.equal(normalizedMoriBrowserUrl("https://grok.com/"), "https://grok.com/");
  assert.equal(normalizedMoriBrowserUrl("http://localhost:5173/"), "http://localhost:5173/");
  assert.equal(normalizedMoriBrowserUrl("javascript:alert(1)"), null);
  assert.equal(deserializeChatSessions([{ id: "ai", title: "Gemini", projectId: "mori", url: "https://gemini.google.com/", changedAt: 1 }])[0]?.url,
    "https://gemini.google.com/");
});

test("saved sessions preserve project isolation, hidden tabs, URLs and avoid duplicate IDs", () => {
  const raw = [
    { id: "one", title: "Translation voice", projectId: "mori", url: "https://chatgpt.com/c/abc-123", hidden: true, changedAt: 22 },
    { id: "one", title: "duplicate", projectId: "mori", url: "https://chatgpt.com/" },
    { id: "two", title: "Other project", projectId: "other", url: "https://chatgpt.com/" },
    { id: "three", title: "bad", projectId: "mori", url: "javascript:alert(1)" },
  ];
  const sessions = deserializeChatSessions(raw);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]?.hidden, true);
  assert.equal(sessions[0]?.projectId, "mori");
  assert.equal(sessions[0]?.url, "https://chatgpt.com/c/abc-123");
  assert.equal(sessions[1]?.projectId, "other");
});
