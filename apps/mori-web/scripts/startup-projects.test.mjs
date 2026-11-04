import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { isLegacyDemo, mergeUiCatalog } from "../src/startup-projects.ts";

const catalog = JSON.parse(readFileSync(new URL("../localization/MonkuNoMoriUI.mori", import.meta.url), "utf8"));

test("fresh profile offers the shipped self-translation project, not a demo", () => {
  const installed = mergeUiCatalog(catalog, null);
  assert.equal(installed.id, "mori_self_ui_ja");
  assert.ok(installed.rows.length > 500);
  assert.ok(installed.rows.some(row => row.source === "Select project"));
  assert.ok(installed.rows.some(row => row.source === "New project\u2026"));
  assert.ok(!installed.rows.some(row => row.source.includes("Lanterns of Hollowmere")));
});

test("upgrade recognizes only the former built-in demos, never user projects", () => {
  assert.equal(isLegacyDemo({ ...catalog, id: "mori_sample_hollowmere", name: "Lanterns of Hollowmere (demo)" }), true);
  assert.equal(isLegacyDemo({ ...catalog, id: "mori_skeleton_demo", name: "Demo \u2013 not a real translation project" }), true);
  assert.equal(isLegacyDemo({ ...catalog, id: "mori_sample_hollowmere", name: "My own project" }), false);
  assert.equal(isLegacyDemo({ ...catalog, id: "user-created", name: "Lanterns of Hollowmere (demo)" }), false);
});

test("repo updates add UI keys without overwriting local translations or drafts", () => {
  const first = catalog.rows[0];
  const retained = {
    ...first, final: "\u624b\u52d5\u7ffb\u8a33", ai: "AI draft", isLocked: true,
    history: [{ type: "curated", text: "\u624b\u52d5\u7ffb\u8a33", timestamp: 12 }],
    sourceFile: "old/source.tsx",
  };
  const retired = { id: "old.ui.key", source: "Old label", final: "Old translation", status: "translated", ai: "" };
  const saved = { ...catalog, rows: [retained, retired], sourceFiles: ["old/source.tsx"] };
  const merged = mergeUiCatalog(catalog, saved);
  assert.equal(merged.rows.length, catalog.rows.length + 1);
  const preserved = merged.rows.find(row => row.id === first.id);
  assert.equal(preserved.final, "\u624b\u52d5\u7ffb\u8a33");
  assert.equal(preserved.ai, "AI draft");
  assert.equal(preserved.isLocked, true);
  assert.deepEqual(preserved.history, retained.history);
  assert.equal(preserved.sourceFile, first.sourceFile);
  assert.equal(merged.rows.find(row => row.id === "old.ui.key")?.final, "Old translation");
  assert.equal(mergeUiCatalog(catalog, merged), merged);
});
