"use strict";
// Shared AST inventory and runtime transform for all user-facing Mori strings.
// Deliberately does not touch DOM/project data, identifiers, CSS or user input.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const requireFromReact = createRequire(require.resolve("@vitejs/plugin-react", { paths: [path.resolve(__dirname, "..")] }));
const { parse } = requireFromReact("@babel/parser");

const UI_PROPS = new Set([
  "title", "description", "placeholder", "aria-label", "alt", "label",
  "tooltip", "helpText", "emptyText", "caption", "message", "subtitle",
  "heading", "detail", "helperText", "labelText", "error", "warning",
]);
const UI_CALLS = new Set([
  "toast", "notify", "alert", "confirm", "prompt", "setStatus",
  "setMessage", "setError", "setFeedback", "setNotice",
]);
const TRANSLATION_FUNCTIONS = new Set(["tr", "__moriTr", "__moriFmt"]);
const normalize = value => String(value).replace(/\s+/g, " ").trim();
const human = (value, allowLowercase = false) => {
  const text = normalize(value);
  if (text.length < 2 || text.length > 440 || !/[a-zA-Z]/.test(text)) return false;
  if (/^(?:https?:|wss?:|file:|data:|blob:|\.{1,2}\/|\/|#|--|var\(|rgba?\(|url\(|persist:|mori\.|[a-z]+:\/)/i.test(text)) return false;
  if (/^[#.[\]():{}*_\d%,;\-=+|/&\\ ]+$/.test(text)) return false;
  if (!allowLowercase && /^[a-z][\w./:-]*$/.test(text)) return false; // internal identifiers and state tokens
  if (/^(?:[MmLlHhVvCcSsQqTtAaZz] ?[-.\d, ]+)+$/.test(text)) return false; // SVG path
  if (/^[-\d.% ]+(?:px|rem|fr|vh|vw)$/i.test(text)) return false;
  if (/^(?:minmax|calc|clamp|rgba?|var)\s*\(/i.test(text) || /^\{\d+\}(?:px|rem|em|fr|vh|vw|%)$/i.test(text)) return false;
  if (/^(?:\S+\.(?:ts|tsx|js|json|csv|txt|md|mori|po|docx|xlsx))$/i.test(text)) return false;
  if (/^(?:[A-Za-z0-9_-]+\/){2,}/.test(text)) return false;
  if (/^(?:[a-z]+[._:-]){2,}/.test(text)) return false;
  if (/^[\w\s]*\b(?:querySelector|getElementById|document\.|window\.|localStorage\.)\b/.test(text)) return false;
  if (/\b(?:includeMessages|executeJavaScript|querySelector|location\.href|document\.body)\b/.test(text)) return false; // guest JS, not UI
  return true;
};
const nameOf = node => node?.name ?? node?.value ?? null;
const formattedSource = node => node.quasis.map((part, i) =>
  part.value.cooked ?? part.value.raw).reduce((out, piece, i) =>
  out + (i ? "{" + (i - 1) + "}" : "") + piece, "");
const uiFile = file => "src/" + path.basename(file);

function extractUi(code, file) {
  const ast = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const entries = [];
  const edits = [];
  const tracked = new Set();
  const fragmentNotes = [];
  const ignore = new Set(["start", "end", "loc", "comments", "leadingComments", "trailingComments", "errors", "extra", "tokens"]);

  const literal = (node, kind, parent, replacement = null) => {
    if (!node || !Number.isInteger(node.start) || tracked.has(node.start)) return false;
    let source, codeValue;
    if (node.type === "StringLiteral") {
      source = node.value;
      codeValue = JSON.stringify(node.value);
    } else if (node.type === "TemplateLiteral") {
      source = formattedSource(node);
      const expressions = node.expressions.map(expr => code.slice(expr.start, expr.end));
      codeValue = JSON.stringify(source) + ", [" + expressions.join(", ") + "]";
    } else return false;
    source = normalize(source);
    // These values are application keys, not display labels. Localize only
    // where they are rendered, never inside routing or keyboard logic.
    if ((source === "Other" && kind === "ui-branch") ||
        (file === "shortcuts.ts" && kind === "ui-branch")) return false;
    if (!human(source, /^(?:jsx-|object-|ui-call:|ui-variable:|ui-option)/.test(kind))) return false;
    tracked.add(node.start);
    entries.push({ source, file: uiFile(file), line: node.loc?.start.line ?? 0, kind });
    edits.push({
      start: node.start, end: node.end,
      replacement: replacement ?? (node.type === "StringLiteral"
        ? "__moriTr(" + codeValue + ")"
        : "__moriFmt(" + codeValue + ")"),
      kind, source, ...(node.type === "TemplateLiteral" ? { templateNode: node } : {}),
    });
    return true;
  };

  function recordExistingTranslation(node, kind) {
    if (!node || node.type !== "StringLiteral") return;
    const source = normalize(node.value);
    if (!human(source, true)) return;
    entries.push({ source, file: uiFile(file), line: node.loc?.start.line ?? 0, kind });
  }

  function recordText(node, parent) {
    const source = normalize(node.value);
    if (!human(source, true)) return;
    const raw = code.slice(node.start, node.end);
    const hasDynamicNeighbor = parent?.children?.some(child =>
      child.type === "JSXExpressionContainer" &&
      child.expression?.type !== "JSXEmptyExpression");
    if (hasDynamicNeighbor) fragmentNotes.push({ source, file: uiFile(file), line: node.loc?.start.line ?? 0 });
    // Preserve single-line spacing around inline elements/expressions.
    const sameLine = !raw.includes("\n");
    const prefix = sameLine && /^\s/.test(raw) ? '" " + ' : "";
    const suffix = sameLine && /\s$/.test(raw) ? ' + " "' : "";
    const replacement = "{" + prefix + "__moriTr(" + JSON.stringify(source) + ")" + suffix + "}";
    tracked.add(node.start);
    entries.push({ source, file: uiFile(file), line: node.loc?.start.line ?? 0, kind: "jsx-text" });
    edits.push({ start: node.start, end: node.end, replacement, source, kind: "jsx-text" });
  }

  function textExpression(expr, kind) {
    if (!expr?.type) return;
    if (expr.type === "StringLiteral" || expr.type === "TemplateLiteral") {
      const accepted = literal(expr, kind, null);
      // A title made only of values can still contain English labels inside
      // interpolated conditions (e.g. Unlock vs Lock as final).
      if (!accepted && expr.type === "TemplateLiteral") {
        for (const part of expr.expressions) textExpression(part, kind);
      }
      return;
    }
    if (expr.type === "ConditionalExpression") {
      textExpression(expr.consequent, kind);
      textExpression(expr.alternate, kind);
    } else if (expr.type === "LogicalExpression") {
      textExpression(expr.left, kind);
      textExpression(expr.right, kind);
    } else if (expr.type === "SequenceExpression" || expr.type === "ArrayExpression") {
      for (const item of expr.expressions ?? expr.elements ?? []) textExpression(item, kind);
    } else if (expr.type === "BinaryExpression" && expr.operator === "+") {
      textExpression(expr.left, kind);
      textExpression(expr.right, kind);
    } else if (expr.type === "TSAsExpression" || expr.type === "TSSatisfiesExpression") {
      textExpression(expr.expression, kind);
    }
  }

  function topLevel(ancestors) {
    return !ancestors.some(parent => [
      "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ClassMethod", "ObjectMethod",
    ].includes(parent.type));
  }

  function walk(node, parent, ancestors) {
    if (!node?.type) return;
    if (node.type === "JSXText") {
      recordText(node, parent);
      return;
    }
    if (node.type === "JSXAttribute") {
      const key = nameOf(node.name);
      const value = node.value;
      if (UI_PROPS.has(key)) {
        if (value?.type === "StringLiteral") {
          const source = normalize(value.value);
          if (human(source, true)) {
            literal(value, "jsx-attribute:" + key, node, "{__moriTr(" + JSON.stringify(source) + ")}");
            return;
          }
        } else if (value?.type === "JSXExpressionContainer") {
          textExpression(value.expression, "jsx-attribute:" + key);
        }
      }
      // Event handlers contain visible status, error and toast strings too.
      // Walking them is safe; they are not translated as whole attributes.
      if (!UI_PROPS.has(key) && value?.type === "JSXExpressionContainer") {
        walk(value.expression, node, [...ancestors, node]);
      }
      return;
    }
    if (node.type === "JSXExpressionContainer") {
      // Avoid translating arbitrary data expressions e.g. project.name or row.source.
      textExpression(node.expression, "jsx-expression");
    }
    // Runtime keys are not text. Map them to a display translation at the
    // actual consumer instead of mutating a semantic discriminator.
    if (node.type === "ObjectProperty" && !node.computed &&
        ((["STATUS_LABEL", "TEMPLATE_KIND_LABEL"].some(name => ancestors.some(parent =>
          parent.type === "VariableDeclarator" && nameOf(parent.id) === name))) ||
         (file === "shortcuts.ts" && nameOf(node.key) === "group"))) {
      recordExistingTranslation(node.value, "label-map");
    }
    const pushedVersionLabel = node.type === "ObjectProperty" && nameOf(node.key) === "label" &&
      ancestors.some(a => a.type === "CallExpression" && nameOf(a.callee?.property) === "push" &&
        nameOf(a.callee?.object) === "versions");
    if (node.type === "ObjectProperty" && !node.computed && UI_PROPS.has(nameOf(node.key)) && !pushedVersionLabel) {
      const value = node.value;
      if (value?.type === "StringLiteral") {
        const source = normalize(value.value);
        if (human(source, true)) {
          if (topLevel(ancestors)) {
            const key = code.slice(node.key.start, node.key.end);
            const replacement = "get " + key + "() { return __moriTr(" + JSON.stringify(source) + "); }";
            literal(value, "object-getter:" + nameOf(node.key), node, null);
            edits.pop(); // Replace the complete property rather than its string value.
            edits.push({ start: node.start, end: node.end, replacement, source, kind: "object-getter" });
          } else {
            literal(value, "object-property:" + nameOf(node.key), node);
          }
          return;
        }
      } else if (value?.type === "TemplateLiteral") {
        literal(value, "object-property:" + nameOf(node.key), node);
        return;
      }
    }
    if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      const callee = node.callee?.type === "MemberExpression" || node.callee?.type === "OptionalMemberExpression"
        ? nameOf(node.callee.property) : nameOf(node.callee);
      if (TRANSLATION_FUNCTIONS.has(callee)) {
        recordExistingTranslation(node.arguments?.[0], "explicit-translation");
        return;
      }
      if (UI_CALLS.has(callee)) {
        textExpression(node.arguments?.[0], "ui-call:" + callee);
      }
    }
    if (node.type === "NewExpression" && nameOf(node.callee) === "Error") {
      textExpression(node.arguments?.[0], "user-error");
    }
    if (node.type === "VariableDeclarator") {
      const name = nameOf(node.id);
      if (/^(?:.*(?:label|title|message|feedback|notice|description|caption|hint|statusText|errorText))$/i.test(name ?? "")) {
        textExpression(node.init, "ui-variable:" + name);
      }
    }
    if (pushedVersionLabel) recordExistingTranslation(node.value, "version-label");
    if (node.type === "ReturnStatement") {
      textExpression(node.argument, "ui-return");
    }
    if (node.type === "ConditionalExpression" || node.type === "LogicalExpression") {
      // Event callbacks also contain domain values (not display labels). UI
      // calls such as toast() are handled separately inside that callback.
      const eventHandler = ancestors.some(parent => parent.type === "JSXAttribute" &&
        /^on[A-Z]/.test(nameOf(parent.name) ?? ""));
      if (!eventHandler) textExpression(node, "ui-branch");
    }
    // Only the display half of a [machineValue, visibleLabel] tuple may be
    // translated. Never translate a grouping key or select option value.
    if (node.type === "ArrayExpression" && node.elements.length === 2 &&
        node.elements[0]?.type === "StringLiteral" && node.elements[1]?.type === "StringLiteral" &&
        /^[a-z][a-zA-Z0-9_-]*$/.test(node.elements[0].value) &&
        human(node.elements[1].value)) {
      literal(node.elements[1], "ui-option");
    }
    // Do not follow non-display literals blindly: includes CSS, IDs, URLs,
    // user content, browser JavaScript and the translation transport protocol.
    for (const [key, child] of Object.entries(node)) {
      if (ignore.has(key)) continue;
      if (Array.isArray(child)) {
        for (const item of child) if (item?.type) walk(item, node, [...ancestors, node]);
      } else if (child?.type) walk(child, node, [...ancestors, node]);
    }
  }
  walk(ast, null, []);
  // An interpolated status may contain a separately localizable fallback
  // (e.g. ${cause.message ?? "Unexpected error"}). Keep the inner tr()
  // expression when generating the outer translated format string.
  const suppressed = new Set();
  for (const outer of edits.filter(edit => edit.templateNode).sort((a,b) =>
    (a.end - a.start) - (b.end - b.start))) {
    const expressions = outer.templateNode.expressions.map(expr => {
      let raw = code.slice(expr.start, expr.end);
      const nested = edits.filter(edit => edit !== outer && !suppressed.has(edit) &&
        edit.start >= expr.start && edit.end <= expr.end).sort((a,b)=>b.start-a.start);
      for (const inner of nested) {
        raw = raw.slice(0, inner.start-expr.start) + inner.replacement + raw.slice(inner.end-expr.start);
        suppressed.add(inner);
      }
      return raw;
    });
    outer.replacement = "__moriFmt(" + JSON.stringify(outer.source) + ", [" + expressions.join(", ") + "])";
  }
  const sorted = edits.filter(edit => !suppressed.has(edit)).sort((a,b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      // A containing semantic expression and its child must not both rewrite.
      throw new Error("Overlapping translation edits in " + file + " at " + sorted[i].start);
    }
  }
  return { entries, edits: sorted, fragments: fragmentNotes };
}

function applyEdits(code, edits) {
  if (!edits.length) return null;
  let output = code;
  for (const edit of [...edits].reverse()) {
    output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
  }
  return 'import { tr as __moriTr, formatUi as __moriFmt } from "./ui-localization.ts";\n' + output;
}

module.exports = { extractUi, applyEdits, human, normalize };
