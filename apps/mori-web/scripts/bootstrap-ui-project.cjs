#!/usr/bin/env node
"use strict";
/*
 * Rebuild the Mori interface self-translation project from all UI labels
 * actually instrumented by the Vite AST localization transform.
 *
 * Run from repo root:
 *   node apps/mori-web/scripts/bootstrap-ui-project.cjs --install
 *
 * Existing translated rows and reviewer edits are preserved by stable
 * content-derived IDs. No translation is accepted as curated by this script.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { extractUi } = require("./ui-string-compiler.cjs");

const root = path.resolve(__dirname, "..");
const repo = path.resolve(root, "../..");
const srcRoot = path.join(root, "src");
const output = path.join(root, "localization", "MonkuNoMoriUI.mori");
const seed = JSON.parse(fs.readFileSync(path.join(root, "localization", "seed.ja.json"), "utf8"));
const projectId = "mori_self_ui_ja";
const TS_UI_FILES = new Set(["shortcuts.ts", "prefs.ts", "insights.ts", "useChatBatchWorker.ts", "drafter.ts"]);
const isUiFile = file =>
  (file.endsWith(".tsx") && !file.includes(".test.")) || TS_UI_FILES.has(file);
const directionText = /(?:EN\s*(?:[-–]|→|->)\s*JA|English\s*(?:[-–]|→|->)\s*Japanese)/i;

const inventory = new Map();
const add = (source, file, line, kind) => {
  const normalized = String(source).replace(/\s+/g, " ").trim();
  if (!normalized || directionText.test(normalized)) return;
  const id = "ui." + crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 14);
  const entry = inventory.get(id) ?? { id, source: normalized, locations: new Set() };
  entry.locations.add(file + ":" + line + " (" + kind + ")");
  inventory.set(id, entry);
};

const partial = [];
for (const filename of fs.readdirSync(srcRoot).filter(isUiFile).sort()) {
  const code = fs.readFileSync(path.join(srcRoot, filename), "utf8");
  const result = extractUi(code, filename);
  for (const entry of result.entries) {
    add(entry.source, entry.file, entry.line, entry.kind);
  }
  partial.push(...result.fragments);
}
for (const [source, japanese] of Object.entries(seed)) {
  if (typeof japanese !== "string") throw Error("Invalid Japanese seed for " + source);
  add(source, "localization/seed.ja.json", 1, "seed");
}

const rows = [...inventory.values()]
  .sort((a,b) => a.source.localeCompare(b.source, "en"))
  .map(entry => ({
    id: entry.id,
    source: entry.source,
    ai: "",
    final: seed[entry.source] || "",
    status: seed[entry.source] ? "translated" : "pending",
    sourceFile: [...entry.locations][0].split(":")[0],
    note: [...entry.locations].slice(0, 8).join("; "),
  }));

const glossary = [
  ["Matrix", "マトリクス"], ["AI Chats", "AIチャット"], ["Characters", "キャラクター"],
  ["Glossary", "用語集"], ["Settings", "設定"], ["Draft", "下書き"],
  ["Project", "プロジェクト"], ["Translation", "翻訳"], ["Source", "原文"],
].map(([en, jp], i) => ({
  id: "self-glossary-" + i, en, jp,
  explanation: "Consistent terminology for Monku's own desktop interface.",
}));

const project = {
  id: projectId,
  name: "Monku no Mori · Interface",
  rows, characters: [], glossary,
  context: {
    global: "Translate Monku no Mori's UI into concise, natural Japanese. Preserve {0}, {1}, and other numbered placeholders: their order may change in Japanese. Never translate actual project data, code identifiers, tags, keyboard shortcuts, filenames, or proper product names. Prefer standard Japanese desktop software terminology. Translate messages, controls, tooltips, and status text.",
    project: "This is Monku no Mori's own interface translation project, not game dialogue. It covers menus, forms, buttons, tooltips, warnings, notifications, dynamic status messages, accessibility text and dialog labels. Source locations are in each row's notes; repeated English strings reuse one translation.",
  },
  sourceFiles: [...new Set(rows.map(row => row.sourceFile))],
  lastModified: new Date().toISOString(),
};

fs.writeFileSync(output, JSON.stringify(project, null, 2) + "\n", "utf8");
console.log("Cataloged " + rows.length + " distinct UI labels from JSX, UI attributes, status messages, and controls.");
console.log("Seeded Japanese: " + rows.filter(row => row.final).length + ". JSX text fragments: " + partial.length + ".");

if (process.argv.includes("--install")) {
  (async () => {
    if (!process.env.APPDATA) throw Error("APPDATA missing");
    const { createProjectStore } = require(path.join(repo, "apps/mori-desktop/project-store.cjs"));
    const store = createProjectStore(path.join(process.env.APPDATA, "MonkuNoMori"));
    const previous = await store.load(projectId);
    if (previous) {
      const byId = new Map(previous.rows.map(row => [row.id, row]));
      for (const row of project.rows) {
        const saved = byId.get(row.id);
        if (saved?.source !== row.source) continue;
        row.ai = saved.ai ?? row.ai;
        // Preserve curated user work; a blank untouched row may adopt a new
        // bundled seed, but an existing AI draft stays a draft, not approval.
        row.final = saved.final?.trim() ? saved.final : saved.ai?.trim() ? "" : row.final;
        row.status = row.final?.trim() ? "translated" : row.ai?.trim() ? "draft" : "pending";
        if (saved.history) row.history = saved.history;
        if (saved.isLocked) row.isLocked = saved.isLocked;
      }
      // Preserve genuinely worked-on rows whose English source has disappeared,
      // so the user never loses historical work in an unrelated source refactor.
      const activeIds = new Set(project.rows.map(row => row.id));
      project.rows.push(...previous.rows.filter(row =>
        !activeIds.has(row.id) && !directionText.test(row.source) &&
        (row.final?.trim() || row.ai?.trim()))
        .map(row => ({ ...row, sourceFile: "_retired/" + (row.sourceFile ?? "unknown") })));
      project.glossary = previous.glossary?.length ? previous.glossary : project.glossary;
      // Replace outdated seeded EN/JA-only bootstrap rules with live UI guidance,
      // but preserve user-edited project-local style notes if present.
      if (previous.context?.global &&
          !previous.context.global.startsWith("Translate concise, natural Japanese UI strings.")) {
        project.context = previous.context;
      }
    }
    await store.save(project);
    console.log((previous ? "Updated" : "Installed") + " native Mori UI project; " +
      project.rows.filter(row => row.ai?.trim()).length + " AI drafts preserved.");
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
