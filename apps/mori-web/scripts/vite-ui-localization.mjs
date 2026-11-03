// Build-time transform: translate static JSX labels without rewriting source
// components or changing their React props. The English catalog is authoritative.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const fromViteReact = createRequire(createRequire(import.meta.url).resolve("@vitejs/plugin-react"));
const { parse } = fromViteReact("@babel/parser");

export function moriUiLocalizationPlugin() {
  const root = path.resolve(import.meta.dirname, "..");
  const src = path.join(root, "src").replaceAll("\\", "/") + "/";
  const project = path.join(root, "localization", "MonkuNoMoriUI.mori");
  let catalog;
  const load = () => new Set(JSON.parse(fs.readFileSync(project, "utf8")).rows.map(row => row.source));

  return {
    name: "mori-ui-localization",
    enforce: "pre",
    buildStart() { catalog = load(); },
    transform(code, id) {
      const filename = id.split("?")[0].replaceAll("\\", "/");
      if (!filename.startsWith(src) || !filename.endsWith(".tsx")) return null;
      if (!catalog) catalog = load();
      const ast = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] });
      const edits = [];
      const tr = value => "{__moriTr(" + JSON.stringify(value) + ")}";
      const allowed = new Set(["title", "description", "placeholder", "aria-label", "alt", "label", "tooltip", "helpText", "emptyText"]);
      const clean = value => String(value).replace(/\s+/g, " ").trim();
      function visit(node) {
        if (!node || typeof node !== "object" || !node.type) return;
        if (node.type === "JSXText") {
          const value = clean(node.value);
          const raw = code.slice(node.start, node.end);
          // Only unpadded single-line JSX text. Newlines and mixed whitespace
          // require explicit tr() calls, avoiding layout and spacing changes.
          if (value && catalog.has(value) && raw === raw.trim() && !raw.includes("\n")) {
            edits.push({ start: node.start, end: node.end, value: tr(value) });
          }
        } else if (node.type === "JSXAttribute" && allowed.has(node.name?.name)) {
          const attrValue = node.value;
          if (attrValue?.type === "StringLiteral") {
            const value = clean(attrValue.value);
            if (catalog.has(value)) edits.push({ start: attrValue.start, end: attrValue.end, value: tr(value) });
          }
        }
        for (const [key, child] of Object.entries(node)) {
          if (["start", "end", "loc", "comments", "leadingComments", "trailingComments", "extra", "errors"].includes(key)) continue;
          if (Array.isArray(child)) {
            for (const item of child) if (item?.type) visit(item);
          } else if (child?.type) visit(child);
        }
      }
      visit(ast);
      if (!edits.length) return null;
      edits.sort((a,b) => b.start - a.start);
      let transformed = code;
      for (const edit of edits) transformed =
        transformed.slice(0, edit.start) + edit.value + transformed.slice(edit.end);
      transformed = 'import { tr as __moriTr } from "./ui-localization.ts";\n' + transformed;
      return { code: transformed, map: null };
    },
  };
}
