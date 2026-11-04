import assert from "node:assert/strict";
import { test } from "node:test";
import { appendPlan, guessMapping, planImport, signatureOf, type Mapping } from "./importPlan.ts";
import type { StagedTable } from "./importers.ts";

const table = (path: string, headers: string[], rows: string[][]): StagedTable => ({
  name: path.split("/").pop() ?? path,
  path,
  kind: "json",
  headers,
  rows,
  locs: rows.map((_, r) => ({ r: r + 1 })),
});

const mapping: Mapping = { id: "id", src: "en", tr: "ja", spk: "speaker", note: "" };
const mappingFor = () => mapping;

test("guesses the usual column names for IDs, source, translation and speakers", () => {
  const guess = guessMapping(["Text ID", "English", "Japanese", "Speaker", "Max length"]);
  assert.deepEqual(guess, { id: "Text ID", src: "English", tr: "Japanese", spk: "Speaker", note: "Max length" });
});

test("lines carry their source path, existing translations become dev drafts, and missing speakers go to Narrator", () => {
  const plan = planImport({
    sources: [table("dialogue/chapter1.json", ["id", "en", "ja", "speaker"], [
      ["ch1.001", "Hello", "こんにちは", "Ayla"],
      ["ch1.002", "Bye", "", ""],
    ])],
    mappingFor,
    characterTemplates: [],
  });
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.rows.map(r => [r.id, r.sourceFile, r.status, r.legacy ?? null, r.characterId]), [
    ["ch1.001", "dialogue/chapter1.json", "draft", "こんにちは", "ayla"],
    ["ch1.002", "dialogue/chapter1.json", "pending", null, "narrator"],
  ]);
  assert.deepEqual(plan.characters.map(c => c.name), ["Ayla", "Narrator"]);
});

test("speakers match saved character templates by name", () => {
  const plan = planImport({
    sources: [table("a.json", ["id", "en", "speaker"], [["x", "Hi", "Bram"]])],
    mappingFor: () => ({ ...mapping, tr: "" }),
    characterTemplates: [{ kind: "character", id: "t", name: "bram", role: "Ferryman", tone: "rough", description: "俺" }],
  });
  assert.equal(plan.characters[0]?.role, "Ferryman");
  assert.equal(plan.characters[0]?.description, "俺");
});

test("a duplicate Text ID is renamed with a warning instead of merging two lines", () => {
  const plan = planImport({
    sources: [
      table("a.json", ["id", "en"], [["ui.save", "Save"]]),
      table("b.json", ["id", "en"], [["ui.save", "Save game"]]),
    ],
    mappingFor: () => ({ ...mapping, tr: "", spk: "" }),
    characterTemplates: [],
  });
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.rows.map(r => r.id), ["ui.save", "ui.save (2)"]);
  assert.match(plan.warnings[0] ?? "", /“ui.save” appears more than once/);
});

test("each layout uses its own mapping; only source text is required, and missing IDs come from file and row", () => {
  const sources = [
    table("a.csv", ["key", "english"], [["k1", "One"]]),
    table("b.csv", ["Heading", "Paragraph"], [["Tone", "Calm"]]),
  ];
  const plan = planImport({
    sources,
    mappingFor: headers => (headers[0] === "key" ? { ...mapping, id: "key", src: "english", tr: "", spk: "" } : { ...mapping, id: "", src: "Paragraph", tr: "", spk: "" }),
    characterTemplates: [],
  });
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.rows.map(r => r.id), ["k1", "b:2"]);
  const blocked = planImport({ sources, mappingFor: () => ({ ...mapping, src: "" }), characterTemplates: [] });
  assert.equal(blocked.issues.length, 2);
});

test("lines without source text are skipped with a warning, and repeated English is counted", () => {
  const plan = planImport({
    sources: [table("a.json", ["id", "en"], [["a", "Save"], ["b", "  "], ["c", "Save"]])],
    mappingFor: () => ({ ...mapping, tr: "", spk: "" }),
    characterTemplates: [],
  });
  assert.deepEqual(plan.rows.map(r => r.id), ["a", "c"]);
  assert.equal(plan.warnings.length, 1);
  assert.equal(plan.stats.duplicateLines, 2);
});

test("schema signatures group sources that share headers", () => {
  assert.equal(signatureOf(["a", "b"]), signatureOf(["a", "b"]));
  assert.notEqual(signatureOf(["a", "b"]), signatureOf(["b", "a"]));
});

test("content decides the mapping when headers say nothing: Japanese is the translation, codes are IDs, prose is the source", () => {
  const guess = guessMapping(["A", "B", "C"], [
    ["menu.start", "Start a new adventure", "冒険を始める"],
    ["menu.load", "Load your saved game", "セーブデータをロード"],
  ]);
  assert.deepEqual(guess, { id: "A", src: "B", tr: "C", spk: "", note: "" });
});

test("adding to a project reuses its speakers, skips lines it already has from the same file and moves them to the new copy", () => {
  const existing = {
    id: "p", name: "P", lastModified: "", glossary: [], context: { global: "", project: "" },
    characters: [{ id: "ayla", name: "Ayla", role: "Hero", tone: "warm", description: "" }],
    rows: [{ id: "a", source: "Hi", final: "やあ", status: "translated" as const, sourceFile: "d.json", characterId: "ayla", loc: { r: 0 } }],
  };
  const plan = planImport({
    sources: [{ ...table("d.json", ["id", "en", "speaker"], [["new", "Bye", "Bram"], ["a", "Hi", "Ayla"]]), original: "[]" }],
    mappingFor: () => ({ ...mapping, tr: "" }),
    characterTemplates: [],
    existing,
  });
  assert.deepEqual(plan.rows.map(r => [r.id, r.characterId]), [["new", "bram"]]);
  assert.deepEqual(plan.characters.map(c => c.name), ["Bram"]);
  assert.equal(plan.stats.alreadyPresent, 1);
  const merged = appendPlan(existing, plan);
  assert.deepEqual(merged.rows.map(r => [r.id, r.final, r.loc?.r]), [["a", "やあ", 2], ["new", "", 1]]);
  assert.equal(merged.originals?.["d.json"], "[]");
});
