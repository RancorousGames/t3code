"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createExportFiles } = require("./export-files.cjs");

test("exports remember each project/format destination; quick export updates the same file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mori-export-"));
  try {
    const choices = [];
    const save = createExportFiles(root, async options => {
      choices.push(options);
      return path.join(root, options.defaultPath);
    });
    const first = await save({ projectId: "one", format: "csv", filename: "test.csv", data: "hello" });
    assert.equal(first.filename, "test.csv");
    assert.equal(choices.length, 1);
    const quick = await save({ projectId: "one", format: "csv", filename: "later.csv", data: "updated", quick: true });
    assert.equal(quick.quick, true);
    assert.equal(choices.length, 1);
    assert.equal(await fs.readFile(path.join(root, "test.csv"), "utf8"), "updated");
    await save({ projectId: "two", format: "original", filename: "a.bin", data: Uint8Array.from([0, 255, 42]), quick: true });
    assert.equal(choices.length, 2);
    assert.deepEqual(await fs.readFile(path.join(root, "a.bin")), Buffer.from([0, 255, 42]));
    const reopened = createExportFiles(root, async () => { throw Error("Unexpected Save As dialog"); });
    const retained = await reopened({ projectId: "one", format: "csv", filename: "other.csv", data: "after restart", quick: true });
    assert.equal(retained.filename, "test.csv");
    assert.equal(await fs.readFile(path.join(root, "test.csv"), "utf8"), "after restart");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
