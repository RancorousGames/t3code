// Every static user-facing Mori UI string is part of the self-localization
// project. Extractor and build transform share the same AST analysis.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { extractUi, applyEdits } = require("./ui-string-compiler.cjs");

const UI_TS_FILES = new Set(["shortcuts.ts", "prefs.ts", "insights.ts", "useChatBatchWorker.ts", "drafter.ts"]);
export const isUiSourceFile = filename =>
  (filename.endsWith(".tsx") && !filename.includes(".test.")) || UI_TS_FILES.has(path.basename(filename));

export function moriUiLocalizationPlugin() {
  const root = path.resolve(import.meta.dirname, "..");
  const srcRoot = path.join(root, "src").replaceAll("\\", "/") + "/";
  const catalogFile = path.join(root, "localization", "MonkuNoMoriUI.mori");
  let catalog = new Set();

  const load = () => new Set(
    JSON.parse(fs.readFileSync(catalogFile, "utf8")).rows.map(row => row.source),
  );

  return {
    name: "mori-ui-localization",
    enforce: "pre",
    buildStart() {
      catalog = load();
      // New English labels must be present in the editable self-localization
      // project, otherwise they silently stay English forever.
      const missing = [];
      for (const file of fs.readdirSync(srcRoot).filter(isUiSourceFile)) {
        const code = fs.readFileSync(path.join(srcRoot, file), "utf8");
        const result = extractUi(code, file);
        for (const entry of result.entries) {
          if (/(?:EN\s*(?:→|->|–|-)\s*JA|English\s*(?:→|->)\s*Japanese)/i.test(entry.source)) {
            throw Error("Redundant language-direction label in " + entry.file + ":" + entry.line + ": " + entry.source);
          }
          if (!catalog.has(entry.source)) missing.push(entry.file + ":" + entry.line + " " + entry.source);
        }
      }
      if (missing.length) {
        throw Error(
          missing.length + " Mori UI strings are absent from the localization project.\n" +
          "Run: node apps/mori-web/scripts/bootstrap-ui-project.cjs\n" +
          missing.slice(0, 12).join("\n"),
        );
      }
    },
    transform(code, id) {
      const filename = id.split("?")[0].replaceAll("\\", "/");
      if (!filename.startsWith(srcRoot) || !isUiSourceFile(filename)) return null;
      const result = extractUi(code, filename);
      const output = applyEdits(code, result.edits);
      return output ? { code: output, map: null } : null;
    },
  };
}
