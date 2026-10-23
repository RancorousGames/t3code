import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv, parseJsTable, parseJsonTable, parsePoTable, parseTxtTable, tableFromRows } from "./importers.ts";

test("CSV keeps quoted commas, doubled quotes and line breaks inside cells", () => {
  const grid = parseCsv('id,text\r\nui.1,"Save, then ""quit"""\r\nui.2,"two\nlines"\r\n');
  assert.deepEqual(grid, [["id", "text"], ["ui.1", 'Save, then "quit"'], ["ui.2", "two\nlines"]]);
});

test("tables drop blank rows, name duplicate headers and reject rows with unlabelled extra cells", () => {
  const table = tableFromRows([["id", "id", "text"], ["", "", ""], ["a", "b", "c"]]);
  assert.deepEqual(table.headers, ["id", "id (2)", "text"]);
  assert.deepEqual(table.rows, [["a", "b", "c"]]);
  assert.throws(() => tableFromRows([["id"], ["a", "b", "stray"]]), /more cells than the header row/);
});

test("JSON arrays of objects keep their own columns", () => {
  const table = parseJsonTable(JSON.stringify([{ id: "a", en: "Hi" }, { id: "b", en: "Bye", note: "soft" }]));
  assert.deepEqual(table.headers, ["id", "en", "note"]);
  assert.deepEqual(table.rows, [["a", "Hi", ""], ["b", "Bye", "soft"]]);
});

test("nested JSON objects are flattened to dotted keys", () => {
  const table = parseJsonTable(JSON.stringify({ menu: { save: "Save", items: ["Load"] }, quit: "Quit" }));
  assert.deepEqual(table.headers, ["key", "text"]);
  assert.deepEqual(table.rows, [["menu.save", "Save"], ["menu.items[0]", "Load"], ["quit", "Quit"]]);
});

test("PO entries read msgctxt, msgid and msgstr, including continuation lines, and skip the header", () => {
  const po = [
    'msgid ""',
    'msgstr ""',
    '"Content-Type: text/plain\\n"',
    "",
    'msgctxt "ui.save"',
    'msgid "Save game"',
    'msgstr "セーブ"',
    "",
    'msgid "Long "',
    '"line"',
    'msgstr ""',
  ].join("\n");
  const table = parsePoTable(po);
  assert.deepEqual(table.headers, ["msgctxt", "msgid", "msgstr"]);
  assert.deepEqual(table.rows, [["ui.save", "Save game", "セーブ"], ["", "Long line", ""]]);
});

test("TXT keeps line numbers as IDs and skips blank lines", () => {
  const table = parseTxtTable("first\n\nthird\n");
  assert.deepEqual(table.rows, [["1", "first"], ["3", "third"]]);
});

test("scripts are read only for key/text string pairs, and refused when there are none", () => {
  const table = parseJsTable('const strings = { "ui.start": "Start", title: \'Mori\' };\nfunction f() { return 1 }');
  assert.deepEqual(table.rows, [["ui.start", "Start"], ["title", "Mori"]]);
  assert.throws(() => parseJsTable("console.log(1)"), /No simple/);
});
