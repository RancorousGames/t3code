import assert from "node:assert/strict";
import { test } from "node:test";
import { createDemoProject, editFinalText, parseMoriProject, recordFinalVersion } from "./model.ts";

test("loads existing mori format without discarding additional project fields", () => {
  const base = createDemoProject();
  const loaded = parseMoriProject({ ...base, futureField: { preserved: true } });
  assert.deepEqual(loaded.futureField, { preserved: true });
  assert.equal(loaded.rows.length, 3);
});

test("rejects malformed project data", () => {
  assert.throws(() => parseMoriProject({ name: "No rows" }), /Not a valid/);
  assert.throws(() => parseMoriProject({ id: "x", name: "Y", rows: [{ source: "missing id" }] }), /Invalid translation row/);
});

test("locked strings cannot be changed and editing never implicitly unlocks them", () => {
  const row = createDemoProject().rows[2]!;
  assert.strictEqual(editFinalText(row, "overwrite"), row);
  const draft = editFinalText({ ...row, isLocked: false }, "new");
  assert.equal(draft.final, "new");
  assert.equal(draft.status, "translated");
  assert.equal(draft.isLocked, false);
});

test("history is recorded only for new curated versions", () => {
  const row = createDemoProject().rows[0]!;
  const edited = recordFinalVersion(editFinalText(row, "translation"));
  assert.equal(edited.history?.length, 1);
  assert.equal(recordFinalVersion(edited).history?.length, 1);
});
