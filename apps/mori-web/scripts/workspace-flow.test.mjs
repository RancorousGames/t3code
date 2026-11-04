import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writeWorkspace, readWorkspace, readMatrixScroll, forgetWorkspace } from "../src/workspace-state.ts";
import { recordPendingEdit, recoverPendingEdits, clearPendingEdits } from "../src/recovery-journal.ts";

const stored = new Map();
globalThis.localStorage = {
  getItem: key => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, value),
  removeItem: key => stored.delete(key),
};
const original = JSON.parse(readFileSync(new URL("../localization/MonkuNoMoriUI.mori", import.meta.url), "utf8"));

test("each project gets its own workspace, including scroll and selection", () => {
  writeWorkspace("p1", { screen: "matrix", activeId: "a", scrollTop: 490, scrollLeft: 40, view: { filter: "todo", query: "hello" } });
  writeWorkspace("p2", { screen: "project", activeId: "b" });
  assert.equal(readWorkspace("p1").activeId, "a");
  assert.deepEqual(readMatrixScroll("p1"), { top: 490, left: 40 });
  assert.equal(readWorkspace("p2").activeId, "b");
  assert.equal(readWorkspace("p2").scrollTop, undefined);
  forgetWorkspace("p1");
  assert.deepEqual(readWorkspace("p1"), {});
  assert.equal(readWorkspace("p2").screen, "project");
});

test("crash journal restores pending row edits but not unrelated translations", () => {
  const before = { ...original, id: "crash", rows: original.rows.slice(0, 3), lastModified: "2026-11-04T01:00:00Z" };
  const row = { ...before.rows[1], final: "保存中", status: "translated" };
  const next = { ...before, rows: [before.rows[0], row, before.rows[2]], lastModified: "2026-11-04T01:00:01Z" };
  recordPendingEdit(before, next, row.id);
  const recovered = recoverPendingEdits(before);
  assert.equal(recovered?.rows[1].final, "保存中");
  assert.equal(recovered?.rows[0].final, before.rows[0].final);
  clearPendingEdits(before.id, before.lastModified);
  assert.ok(recoverPendingEdits(before));
  clearPendingEdits(before.id, next.lastModified);
  assert.equal(recoverPendingEdits(before), null);
});

test("older journal cannot overwrite a newer saved project", () => {
  const before = { ...original, id: "old-journal", rows: original.rows.slice(0, 1), lastModified: "2026-11-04T01:00:00Z" };
  recordPendingEdit(before, { ...before, lastModified: "2026-11-04T01:00:01Z", name: "New" });
  assert.equal(recoverPendingEdits({ ...before, lastModified: "2026-11-04T01:00:02Z" }), null);
});
