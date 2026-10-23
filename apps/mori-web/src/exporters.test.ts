import test from "node:test";
import assert from "node:assert/strict";
import { buildInterchangeExport } from "./exporters.ts";
import type { MoriProject } from "./model.ts";

const project = (): MoriProject => ({
  id: "testing", name: "小さな Game", lastModified: "2026-10-20",
  rows: [
    { id: "dialogue.1", source: 'Hello, "{PLAYER}"!\nReady?', final: 'こんにちは、"{PLAYER}"！\n準備は？',
      status: "translated", characterId: "h" },
    { id: "npc.2", source: "Line two", ai: "AI text", final: "", status: "draft" },
  ],
  characters: [{ id: "h", name: "Hero", role: "NPC", tone: "casual", description: "" }],
  glossary: [], context: { global: "", project: "" },
});

test("CSV interchange preserves Japanese, quotes, newlines and does not silently use AI", () => {
  const data = buildInterchangeExport(project(), "csv");
  assert.ok(data.data.startsWith("\ufeff"));
  assert.match(data.data, /"こんにちは、""\{PLAYER\}""！\n準備は？"/);
  assert.equal(data.filled, 1);
  assert.equal(data.empty, 1);
  assert.ok(!data.data.includes("AI text"));
});

test("AI fallback is opt-in and never mutates curated text", () => {
  const p = project();
  const report = buildInterchangeExport(p, "json", "curated-or-draft");
  const values = JSON.parse(report.data).strings;
  assert.equal(values[0].translation, p.rows[0]?.final);
  assert.equal(values[1].translation, "AI text");
  assert.equal(p.rows[1]?.final, "");
});

test("PO is correctly quoted and always carries the ID", () => {
  const data = buildInterchangeExport(project(), "po");
  assert.ok(data.data.includes('msgctxt "dialogue.1"'));
  assert.ok(data.data.includes('msgid "Hello, \\"{PLAYER}\\"!\\nReady?"'));
  assert.ok(data.data.includes('msgstr "こんにちは、\\"{PLAYER}\\"！\\n準備は？"'));
});
