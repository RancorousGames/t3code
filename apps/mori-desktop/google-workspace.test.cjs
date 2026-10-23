"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createGoogleWorkspace, normalizeClient, googleRange } = require("./google-workspace.cjs");

const fakeClient = {
  installed: { client_id: "mori-test-id.apps.googleusercontent.com", client_secret: "not-a-real-secret" },
};
const fakeVault = {
  isEncryptionAvailable: () => true,
  encryptString: text => Buffer.from(text, "utf8"),
  decryptString: bytes => Buffer.from(bytes).toString("utf8"),
};
async function fixture(t, extras = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mori-google-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fixture.json");
  await fs.writeFile(file, JSON.stringify(fakeClient));
  return { dir, file, create: args => createGoogleWorkspace({
    userDataDir: dir, safeStorage: fakeVault, openExternal: async () => {},
    ...extras, ...args,
  }) };
}

test("desktop client format is validated and ranges cannot inject unsafe URLs", () => {
  assert.equal(normalizeClient(fakeClient).client_id, fakeClient.installed.client_id);
  assert.throws(() => normalizeClient({ web: fakeClient.installed }), /Desktop/);
  assert.equal(googleRange("'Dialogue'!C14"), "'Dialogue'!C14");
  assert.throws(() => googleRange("Sheet1!A1%0A"), /Invalid/);
});
test("OAuth browser flow uses random-loopback state + PKCE and stores tokens per-user", async t => {
  let authUrl;
  const { create, file } = await fixture(t, {
    fetchImpl: async (url, options) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        const body = new URLSearchParams(options.body);
        assert.equal(body.get("grant_type"), "authorization_code");
        assert.ok(body.get("code_verifier").length >= 40);
        return new Response(JSON.stringify({ access_token: "ephemeral", refresh_token: "private", expires_in: 3600 }), { status: 200 });
      }
      throw Error("Unexpected request: " + String(url));
    },
    openExternal: async url => {
      authUrl = new URL(url);
      assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
      assert.ok(authUrl.searchParams.get("state"));
      const redirect = new URL(authUrl.searchParams.get("redirect_uri"));
      assert.equal(redirect.hostname, "127.0.0.1");
      redirect.searchParams.set("code", "fake-local-test-code");
      redirect.searchParams.set("state", authUrl.searchParams.get("state"));
      const callback = await fetch(redirect);
      assert.equal(callback.status, 200);
    },
  });
  const google = create();
  await google.configure(file);
  assert.deepEqual(await google.signIn(), { connected: true });
  assert.equal((await google.clientStatus()).connected, true);
  assert.ok(authUrl);
  await google.logout();
  assert.equal((await google.clientStatus()).connected, false);
});

test("Google writes fail closed unless a Monku-owned copy is registered", async t => {
  const { create, file } = await fixture(t);
  const google = create();
  await google.configure(file);
  await assert.rejects(google.writeCheckedCopy("abcdABCD_0987654321", [{range:"Sheet1!C2", expected:"", next:"修正"}]), /only Monku|Only Monku/i);
});
test("changes to Google copy block checked write; matching values permit a single batch", async t => {
  const copied = "abcdABCD_0987654321";
  const log = [];
  let observed = "Old text";
  const { create, file } = await fixture(t, {
    fetchImpl: async (url, options = {}) => {
      const u = new URL(url);
      log.push(u.pathname);
      if (u.hostname === "oauth2.googleapis.com") {
        return new Response(JSON.stringify({ access_token: "fresh", refresh_token: "private", expires_in: 3600 }), {status: 200});
      }
      if (u.pathname.endsWith("/values:batchGet")) {
        return Response.json({valueRanges:[{values:[[observed]]}]});
      }
      if (u.pathname.endsWith("/values:batchUpdate")) {
        return Response.json({totalUpdatedCells:1});
      }
      throw Error("Unexpected URL");
    },
  });
  const google = create();
  await google.configure(file);
  // Simulate an independently authorized local Google session for API-only tests.
  await fs.writeFile(path.join(path.dirname(file), "google-oauth-token.bin"), fakeVault.encryptString(JSON.stringify({access_token:"test",refresh_token:"refresh",expires_at:Date.now()+999999})));
  await google.registerCopy(copied);
  const request = [{range:"'Sheet1'!C2",expected:"Original text",next:"修正"}];
  const conflict = await google.writeCheckedCopy(copied, request);
  assert.equal(conflict.updatedCells, 0);
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(log.filter(x=>x.endsWith("/values:batchUpdate")).length, 0);
  observed = "Original text";
  const success = await google.writeCheckedCopy(copied, request);
  assert.equal(success.updatedCells, 1);
  assert.deepEqual(success.conflicts, []);
  assert.equal(log.filter(x=>x.endsWith("/values:batchUpdate")).length, 1);
});
