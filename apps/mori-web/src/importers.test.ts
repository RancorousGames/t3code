import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv, parseJsTable, parseJsonTable, parsePoTable, parseTxtTable, tableFromRows } from "./importers.ts";

test("CSV keeps quoted commas, doubled quotes and line breaks inside cells", () => {
  const grid = parseCsv('id,text\r\nui.1,"Save, then ""quit"""\r\nui.2,"two\nlines"\r\n');
  assert.deepEqual(grid, [["id", "text"], ["ui.1", 'Save, then "quit"'], ["ui.2", "two\nlines"]]);
});

test("tables find the header below title rows, drop blank rows and name blank or repeated headers", () => {
  const table = tableFromRows([["Chapter 1 script"], [], ["id", "id", "text", ""], ["", "", "", ""], ["a", "b", "c", "extra"]]);
  assert.equal(table.headerRow, 2);
  assert.deepEqual(table.headers, ["id", "id (B)", "text", "Column D"]);
  assert.deepEqual(table.rows, [["a", "b", "c", "extra"]]);
  assert.deepEqual(table.locs, [{ r: 4 }]);
});

test("JSON arrays of objects keep their own columns", () => {
  const table = parseJsonTable(JSON.stringify([{ id: "a", en: "Hi" }, { id: "b", en: "Bye", note: "soft" }]));
  assert.deepEqual(table.headers, ["id", "en", "note"]);
  assert.deepEqual(table.rows, [["a", "Hi", ""], ["b", "Bye", "soft"]]);
});

test("nested JSON is flattened to dotted keys, and a sibling context string becomes the note", () => {
  const table = parseJsonTable(JSON.stringify({ menu: { save: "Save", items: ["Load"] }, quit: { text: "Quit", context: "Title screen" } }));
  assert.deepEqual(table.headers, ["key", "text", "note"]);
  assert.deepEqual(table.rows, [["menu.save", "Save", ""], ["menu.items[0]", "Load", ""], ["quit.text", "Quit", "Title screen"]]);
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
    "#. Shown on the title",
    'msgid "[BRAM] Long "',
    '"line"',
    'msgstr ""',
  ].join("\n");
  const table = parsePoTable(po);
  assert.deepEqual(table.headers, ["msgctxt", "msgid", "msgstr", "speaker", "note"]);
  assert.deepEqual(table.rows, [["ui.save", "Save game", "セーブ", "", ""], ["entry_2", "[BRAM] Long line", "", "BRAM", "Shown on the title"]]);
});

test("TXT keeps line numbers as IDs, skips blank lines and reads key = value lines", () => {
  const table = parseTxtTable("first line\n\nui.ok = Fine\n");
  assert.deepEqual(table.rows, [["1", "first line"], ["ui.ok", "Fine"]]);
});

test("scripts are read for key/text string pairs, several per line, and refused when there are none", () => {
  const table = parseJsTable('const strings = { "ui.start": "Start", title: \'Mori\' };\nconst hello = "Hi there"; // Ayla\nfunction f() { return 1 }');
  assert.deepEqual(table.rows, [["ui.start", "Start", ""], ["title", "Mori", ""], ["hello", "Hi there", "Ayla"]]);
  assert.deepEqual(table.locs[1], { line: 0, start: 47, end: 51 });
  assert.throws(() => parseJsTable("console.log(1)"), /No simple/);
});
