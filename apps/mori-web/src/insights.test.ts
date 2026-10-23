import assert from "node:assert/strict";
import { test } from "node:test";
import type { MoriGlossaryEntry, MoriRow } from "./model.ts";
import { adoptText, checkRow, findUsages, glossaryHits, markText, statusOf, visibleRows } from "./insights.ts";

const glossary: MoriGlossaryEntry[] = [
  { id: "g1", en: "Ember", jp: "残り火", explanation: "" },
  { id: "g2", en: "lamp", jp: "灯", explanation: "" },
];
const row = (r: Partial<MoriRow>): MoriRow => ({ id: "r", source: "", final: "", status: "pending", ...r });

test("flags each missing and invented placeholder separately but accepts reordered ones", () => {
  const source = "{name} has %d <b>Ember</b>";
  assert.deepEqual(checkRow(row({ source, final: "{name}の<b>残り火</b>は%d" }), glossary), []);
  const kinds = checkRow(row({ source, final: "{nam}の残り火は%d" }), glossary).map(w => w.kind);
  assert.deepEqual(kinds, ["missing-token", "missing-token", "missing-token", "extra-token"]);
});

test("reports the token itself so the editor can insert it", () => {
  const missing = checkRow(row({ source: "Hi {name}", final: "やあ" }), glossary).find(w => w.kind === "missing-token");
  assert.equal(missing?.token, "{name}");
});

test("flags line break mismatches and unused glossary terms", () => {
  const warnings = checkRow(row({ source: "Take the Ember.\nGo.", final: "火を取れ。" }), glossary);
  assert.deepEqual(warnings.map(w => w.kind), ["linebreaks", "glossary"]);
});

test("nothing is checked until a curated text exists", () => {
  assert.deepEqual(checkRow(row({ source: "Take the Ember.", ai: "残り火を取れ。" }), glossary), []);
});

test("glossary terms match whole words only", () => {
  assert.equal(glossaryHits("The lamplighter waits", glossary).length, 0);
  assert.equal(glossaryHits("Light the lamp!", glossary).length, 1);
  assert.equal(findUsages([row({ source: "lamplighter" }), row({ id: "b", source: "a lamp" })], "lamp").total, 1);
});

test("adopting a version keeps the replaced curated text and never touches locked rows", () => {
  const edited = adoptText(row({ source: "Hi", final: "やあ", status: "translated" }), "こんにちは");
  assert.equal(edited.final, "こんにちは");
  assert.deepEqual(edited.history?.map(v => v.text), ["やあ", "こんにちは"]);
  const locked = row({ source: "Hi", final: "やあ", isLocked: true });
  assert.strictEqual(adoptText(locked, "x"), locked);
});

test("marks tokens and glossary terms in display text", () => {
  const parts = markText("Ember x{n}", glossary);
  assert.deepEqual(parts.map(p => p.kind), ["term", "plain", "token"]);
});

test("status is derived from the text, not trusted from the stored field", () => {
  assert.equal(statusOf(row({ final: "訳" })), "translated");
  assert.equal(statusOf(row({ ai: "案" })), "draft");
  assert.equal(statusOf(row({ legacy: "旧" })), "draft");
  assert.equal(statusOf(row({ final: "  ", status: "translated" })), "pending");
});

test("visible lines keep the active line even when it no longer matches the filter", () => {
  const rows = [row({ id: "a", final: "done" }), row({ id: "b", characterId: "ayla" }), row({ id: "c" })];
  const names = new Map([["ayla", "Ayla"]]);
  const view = { filter: "todo" as const, query: "", speaker: "any", file: null };
  assert.deepEqual(visibleRows(rows, view, names, "a", glossary).map(r => r.id), ["a", "b", "c"]);
  assert.deepEqual(visibleRows(rows, { ...view, speaker: "none" }, names, null, glossary).map(r => r.id), ["c"]);
  assert.deepEqual(visibleRows(rows, { ...view, query: "ayl" }, names, null, glossary).map(r => r.id), ["b"]);
});
