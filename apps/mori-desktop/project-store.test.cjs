"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createProjectStore, validateProject, fileKey } = require("./project-store.cjs");

const project = (id = "A../B") => ({
  id, name: "A game", rows: [
    { id: "row-1", source: "Hello", final: "", status: "pending" },
  ], characters: [], glossary: [], context: { global: "", project: "" },
  lastModified: "2026-10-19T10:00:00Z",
});

async function withFixture(t, fn, options) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mori-backend-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return fn(createProjectStore(dir, options), dir);
}

test("project writes are durable and survive a new store instance", async t => {
  await withFixture(t, async (store, dir) => {
    await store.save(project());
    assert.deepEqual(await store.load("A../B"), project());
    assert.equal((await store.list()).entries.length, 1);
    assert.deepEqual(await createProjectStore(dir).load("A../B"), project());
    assert.equal((await store.load("missing")), null);
    assert.match(fileKey("A../B"), /^[a-f0-9]{64}$/);
  });
});

test("concurrent saves serialize; last write wins and previous data is recoverable", async t => {
  let clock = 1_790_000_000_000;
  await withFixture(t, async store => {
    const first = project("revision");
    await store.save(first);
    clock += 10 * 60_000;
    const second = { ...first, name: "Revision 2" };
    const third = { ...first, name: "Revision 3" };
    await Promise.all([store.save(second), store.save(third)]);
    assert.equal((await store.load("revision")).name, "Revision 3");
    const backups = await store.revisions("revision");
    assert.equal(backups.length, 1);
    assert.equal((await store.restore("revision", backups[0].id)).name, "A game");
    assert.equal((await store.load("revision")).name, "A game");
  }, { now: () => clock });
});

test("delete preserves revision and does not touch neighboring projects", async t => {
  let clock = 1_790_000_000_000;
  await withFixture(t, async store => {
    await store.save(project("first"));
    await store.save(project("second"));
    clock += 600_000;
    await store.remove("first");
    assert.equal(await store.load("first"), null);
    assert.equal((await store.list()).entries.length, 1);
    const versions = await store.revisions("first");
    assert.equal(versions.length, 1);
    await store.restore("first", versions[0].id);
    assert.equal((await store.list()).entries.length, 2);
  }, { now: () => clock });
});

test("malformed payloads fail closed without deleting existing work", async t => {
  await withFixture(t, async store => {
    const saved = project();
    await store.save(saved);
    await assert.rejects(store.save({ ...saved, rows: [{ id: "x", source: false }] }));
    await assert.rejects(store.restore(saved.id, "../wrong-id"));
    assert.deepEqual(await store.load(saved.id), saved);
    assert.throws(() => validateProject({ ...saved, rows: "bad" }));
  });
});

test("storage hash prevents path traversal and keeps independent files", async t => {
  await withFixture(t, async (store, dir) => {
    await store.save(project("../escape"));
    await store.save(project("normal"));
    assert.equal((await fs.readdir(path.join(dir, "projects"))).length, 2);
    assert.equal((await fs.readdir(dir)).some(name => name === "escape.json"), false);
  });
});
