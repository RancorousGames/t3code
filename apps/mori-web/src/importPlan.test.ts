import assert from "node:assert/strict";
import { test } from "node:test";
import { guessMapping, planImport, signatureOf, type Mapping } from "./importPlan.ts";
import type { StagedTable } from "./importers.ts";

const table = (path: string, headers: string[], rows: string[][]): StagedTable => ({
  name: path.split("/").pop() ?? path,
  path,
  kind: "json",
  headers,
  rows,
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

test("a duplicate Text ID blocks the import instead of merging two lines", () => {
  const plan = planImport({
    sources: [
      table("a.json", ["id", "en"], [["ui.save", "Save"]]),
      table("b.json", ["id", "en"], [["ui.save", "Save game"]]),
    ],
    mappingFor: () => ({ ...mapping, tr: "", spk: "" }),
    characterTemplates: [],
  });
  assert.equal(plan.issues.length, 1);
  assert.match(plan.issues[0] ?? "", /“ui.save” appears more than once/);
});

test("each layout uses its own mapping and blocks until both IDs and source text are mapped", () => {
  const sources = [
    table("a.csv", ["key", "english"], [["k1", "One"]]),
    table("b.csv", ["Heading", "Paragraph"], [["Tone", "Calm"]]),
  ];
  const plan = planImport({
    sources,
    mappingFor: headers => (headers[0] === "key" ? { ...mapping, id: "key", src: "english", tr: "", spk: "" } : { ...mapping, id: "", src: "Paragraph" }),
    characterTemplates: [],
  });
  assert.deepEqual(plan.issues, ["b.csv: choose the Text ID and Source text columns."]);
  assert.equal(plan.rows.length, 1);
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
