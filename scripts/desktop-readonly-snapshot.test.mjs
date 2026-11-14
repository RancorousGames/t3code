import { test } from "node:test";
import assert from "node:assert/strict";
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Http from "node:http";
import * as Os from "node:os";
import * as Path from "node:path";
import { controlSessions } from "./chatgpt-sessions.mjs";
import { descriptorPath, readSnapshotAcrossIntegrity } from "./desktop-readonly-snapshot.mjs";

test("EPERM list uses only authenticated read-only fallback; writes never cross it", async () => {
  const localAppData = Fs.mkdtempSync(Path.join(Os.tmpdir(), "t3-snapshot-test-"));
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = localAppData;
  const home = Path.join(localAppData, "isolated-home");
  const token = Crypto.randomBytes(32).toString("hex");
  const requests = [];
  const server = Http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    let body = "";
    req.on("data", part => body += part.toString());
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(403);
        return res.end();
      }
      const data = JSON.parse(body);
      if (data.action !== "list") {
        res.writeHead(403);
        return res.end();
      }
      res.end(JSON.stringify({ version: 1, requestId: data.requestId, ok: true,
        data: { sessions: [{ id: "browser", url: "https://chatgpt.com/c/test" }] } }));
    });
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const file = descriptorPath(home);
    Fs.mkdirSync(Path.dirname(file), { recursive: true });
    Fs.writeFileSync(file, JSON.stringify({ version: 1, port: server.address().port, token }));
    const deniedPipe = async () => { const error = new Error("connect EPERM"); error.code = "EPERM"; throw error; };
    const listed = await controlSessions({ action: "list", which: "all", includeHidden: true },
      { home, exchange: deniedPipe });
    assert.equal(listed.sessions[0].id, "browser");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/snapshot");
    await assert.rejects(() => controlSessions({ action: "complete", sessionId: "browser" },
      { home, exchange: deniedPipe }), /no cross-integrity write fallback/);
    assert.equal(requests.length, 1);
    await assert.rejects(() => readSnapshotAcrossIntegrity(home, { type: "chatgpt.sessions", action: "send" }),
      /only a read-only session list/);
    Fs.unlinkSync(file);
    await assert.rejects(() => controlSessions({ action: "list" },
      { home, exchange: deniedPipe }), /No identity observation or seat change/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
    Fs.rmSync(localAppData, { recursive: true, force: true });
  }
});

test("Windows read-only bridge hardens its endpoint and refuses mutations", { skip: process.platform !== "win32" }, async () => {
  const { startDesktopReadOnlyBridge } = await import("../apps/desktop/src/app/DesktopReadOnlyBridge.ts");
  const localAppData = Fs.mkdtempSync(Path.join(Os.tmpdir(), "t3-readonly-actual-"));
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = localAppData;
  const home = Path.join(localAppData, "home");
  const tokenRequest = { version: 1, requestId: Crypto.randomUUID(),
    type: "chatgpt.sessions", action: "list", which: "all", includeHidden: true };
  let calls = 0;
  let server;
  try {
    server = await startDesktopReadOnlyBridge({
      stateDir: Path.resolve(home, "userdata"), localAppData,
      handle: async (request) => {
        calls++;
        return { version: 1, requestId: request.requestId, ok: true,
          data: { sessions: [{ id: "actual-window" }] } };
      },
    });
    const { token, port } = JSON.parse(Fs.readFileSync(descriptorPath(home), "utf8"));
    const denied = await new Promise((resolve, reject) => {
      const client = Http.request({ hostname: "127.0.0.1", port, path: "/snapshot",
        method: "POST" }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      client.once("error", reject);
      client.end(JSON.stringify(tokenRequest));
    });
    assert.equal(denied, 403);
    const mutation = await new Promise((resolve, reject) => {
      const client = Http.request({ hostname: "127.0.0.1", port, path: "/snapshot",
        method: "POST", headers: { Authorization: `Bearer ${token}` } },
        res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      client.once("error", reject);
      client.end(JSON.stringify({...tokenRequest, action:"complete", sessionId:"browser"}));
    });
    assert.equal(mutation, 400);
    const actual = await readSnapshotAcrossIntegrity(home, tokenRequest);
    assert.equal(actual.data.sessions[0].id, "actual-window");
    assert.equal(calls, 1);
  } finally {
    await server?.close();
    assert.equal(Fs.existsSync(descriptorPath(home)), false);
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
    Fs.rmSync(localAppData, { recursive: true, force: true });
  }
});
