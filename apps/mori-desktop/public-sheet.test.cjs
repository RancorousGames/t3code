"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createPublicSheetReader, safeHost } = require("./public-sheet.cjs");

const id = "1ABCDEFGhijklmnop12345";
test("allows only Google export hosts", () => {
  assert.ok(safeHost("docs.google.com"));
  assert.ok(safeHost("lh3.googleusercontent.com"));
  assert.equal(safeHost("google.com.evil.example"), false);
  assert.equal(safeHost("evil.googleusercontent.com.evil.example"), false);
});
test("fetches CSV from the expected Google endpoint", async () => {
  const reader = createPublicSheetReader(async (url, options) => {
    assert.equal(url.hostname, "docs.google.com");
    assert.equal(url.searchParams.get("gid"), "12");
    assert.equal(options.redirect, "manual");
    return new Response('id,en\na,Hello\n', { status: 200 });
  });
  assert.equal(await reader(id, "12"), "id,en\na,Hello\n");
});
test("rejects redirected URLs outside allowed domains", async () => {
  const reader = createPublicSheetReader(async () =>
    new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8080" } })
  );
  await assert.rejects(reader(id), /outside/);
});
test("rejects malformed document/tab identifiers and private sheets", async () => {
  const reader = createPublicSheetReader(async () => new Response("private", { status: 403 }));
  await assert.rejects(reader("../bad"), /Invalid/);
  await assert.rejects(reader(id, "abc"), /Invalid/);
  await assert.rejects(reader(id), /private/);
});
test("rejects oversized data", async () => {
  const reader = createPublicSheetReader(async () =>
    new Response("x", { status: 200, headers: { "content-length": "999999999" } })
  );
  await assert.rejects(reader(id), /too large/);
});
