// Opt-in, independent Chromium owner. Its pages outlive T3 client connections.
// Existing Electron webview guests require a separate migration to this host.
import * as Crypto from "node:crypto";
import * as Http from "node:http";
import * as Os from "node:os";
import * as Path from "node:path";
import { mkdir, readdir, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireDesktop = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const { chromium } = requireDesktop("playwright-core");
const absoluteFile = fileURLToPath(import.meta.url);

export const defaultDataDirectory = () =>
  Path.join(process.env.APPDATA ?? Path.join(Os.homedir(), ".config"), "t3code-custom", "persistent-browser-host");

/** Same named pipe across T3 restarts, without a listening TCP port. */
export const socketFor = (dataDirectory) => {
  const key = Crypto.createHash("sha256").update(Path.resolve(dataDirectory).toLowerCase()).digest("hex").slice(0, 16);
  return process.platform === "win32"
    ? "\\\\.\\pipe\\t3code-browser-host-" + key
    : Path.join(Os.tmpdir(), "t3code-browser-host-" + key + ".sock");
};

const errorText = (error) => error instanceof Error ? error.message : String(error);

/** Hold pages in memory until explicitly closed, not until a caller disconnects. */
export function createBrowserHost({
  dataDirectory = defaultDataDirectory(),
  accessToken = process.env.T3_BROWSER_HOST_TOKEN,
  launch = async (directory) => {
    const options = {
      headless: process.env.T3_BROWSER_HOST_HEADLESS !== "0",
      viewport: { width: 1280, height: 800 },
    };
    // Prefer the Playwright-compatible Chromium revision. A cached older
    // Chromium works too; never silently switch this host to Google Chrome.
    const preferred = chromium.executablePath();
    let executablePath = preferred;
    try {
      await access(preferred);
    } catch {
      if (process.env.T3_BROWSER_HOST_CHROMIUM_EXECUTABLE) {
        executablePath = process.env.T3_BROWSER_HOST_CHROMIUM_EXECUTABLE;
        await access(executablePath);
      } else if (process.platform === "win32") {
        const cache = Path.join(process.env.LOCALAPPDATA ?? Path.join(Os.homedir(), "AppData", "Local"), "ms-playwright");
        const versions = (await readdir(cache)).filter((name) => /^chromium-\d+$/.test(name))
          .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
        const installed = versions.map((version) => Path.join(cache, version, "chrome-win64", "chrome.exe"));
        executablePath = undefined;
        for (const candidate of installed) {
          try { await access(candidate); executablePath = candidate; break; } catch { /* try next installed Chromium */ }
        }
      }
    }
    if (!executablePath) throw new Error("No installed Chromium binary available for persistent browser host");
    return chromium.launchPersistentContext(directory, { ...options, executablePath });
  },
} = {}) {
  const sessions = new Map();
  const pendingAttaches = new Map();
  const instanceId = Crypto.randomUUID();
  const socketPath = socketFor(dataDirectory);
  let contextPromise;
  let closing = false;
  let server;

  const context = () => {
    if (closing) throw new Error("Browser host is shutting down");
    if (!contextPromise) {
      const directory = Path.join(dataDirectory, "profile");
      contextPromise = mkdir(directory, { recursive: true }).then(() => launch(directory))
        .catch((error) => { contextPromise = undefined; throw error; });
    }
    return contextPromise;
  };
  const snapshot = (sessionId, page) => ({ sessionId, url: page.url(), closed: page.isClosed() });

  async function attach(sessionId, initialUrl) {
    if (typeof sessionId !== "string" || !/^[\w-]{1,128}$/.test(sessionId))
      throw new Error("Invalid session ID");
    // Reattach is read-only. Never navigate an existing ChatGPT page.
    const existing = sessions.get(sessionId);
    if (existing && !existing.isClosed()) return { ...snapshot(sessionId, existing), reused: true };
    if (existing) sessions.delete(sessionId);
    const pending = pendingAttaches.get(sessionId);
    if (pending) return { ...await pending, reused: true };
    const created = createPage(sessionId, initialUrl);
    pendingAttaches.set(sessionId, created);
    try { return await created; } finally {
      if (pendingAttaches.get(sessionId) === created) pendingAttaches.delete(sessionId);
    }
  }

  async function createPage(sessionId, initialUrl) {
    const ctx = await context();
    const page = await ctx.newPage();
    sessions.set(sessionId, page);
    page.on("close", () => { if (sessions.get(sessionId) === page) sessions.delete(sessionId); });
    try {
      if (initialUrl && initialUrl !== "about:blank")
        await page.goto(initialUrl, { waitUntil: "domcontentloaded" });
      return { ...snapshot(sessionId, page), reused: false };
    } catch (error) {
      sessions.delete(sessionId);
      await page.close().catch(() => {});
      throw error;
    }
  }

  // Per-page JavaScript heap (not whole-process RSS). Chromium can share a
  // renderer across pages, so never call this an exclusive RAM measurement.
  async function pageMemory(sessionId, page) {
    try {
      const session = await page.context().newCDPSession(page);
      try {
        await session.send("Performance.enable");
        const result = await session.send("Performance.getMetrics");
        const values = new Map(result.metrics.map((entry) => [entry.name, entry.value]));
        return {
          sessionId,
          jsHeapUsedMB: Math.round((values.get("JSHeapUsedSize") ?? 0) / 1048576 * 10) / 10,
          jsHeapTotalMB: Math.round((values.get("JSHeapTotalSize") ?? 0) / 1048576 * 10) / 10,
          kind: "per-target-v8-heap-not-exclusive-process-memory",
        };
      } finally {
        await session.detach().catch(() => {});
      }
    } catch {
      return { sessionId, jsHeapUsedMB: null, jsHeapTotalMB: null,
        kind: "per-target-v8-heap-unavailable" };
    }
  }

  const locate = (sessionId) => {
    if (typeof sessionId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId))
      throw new Error("Invalid exact ChatGPT session ID");
    const page = sessions.get(sessionId);
    if (!page || page.isClosed()) throw new Error("Persistent ChatGPT page is not attached");
    return page;
  };
  const enforceChatGPTOrigin = (page) => {
    const u = new URL(page.url());
    if (u.protocol !== "https:" || !["chatgpt.com", "chat.openai.com"].includes(u.hostname))
      throw new Error("Persistent browser page has left the ChatGPT origin");
  };
  const frame = async ({ sessionId, width, height }) => {
    if (!Number.isInteger(width) || width < 1 || width > 2560 ||
        !Number.isInteger(height) || height < 1 || height > 1600)
      throw new Error("Invalid frame dimensions");
    const page = locate(sessionId);
    enforceChatGPTOrigin(page);
    const requested = { width, height };
    const current = page.viewportSize();
    if (!current || current.width !== width || current.height !== height)
      await page.setViewportSize(requested);
    return { sessionId, url: page.url(), width, height,
      jpeg: (await page.screenshot({ type: "jpeg", quality: 72, timeout: 12_000 })).toString("base64") };
  };
  const inputPage = async ({ sessionId, input }) => {
    const page = locate(sessionId);
    enforceChatGPTOrigin(page);
    if (!input || typeof input !== "object") throw new Error("Invalid input event");
    const { type } = input;
    const x = Number(input.x), y = Number(input.y);
    if (["move", "down", "up", "wheel"].includes(type)) {
      if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x > 2560 || y > 1600)
        throw new Error("Invalid pointer coordinates");
      if (type === "move") await page.mouse.move(x, y);
      else if (type === "wheel") {
        const deltaX = Number(input.deltaX), deltaY = Number(input.deltaY);
        if (![deltaX, deltaY].every(Number.isFinite) || Math.abs(deltaX) > 2000 || Math.abs(deltaY) > 2000)
          throw new Error("Invalid wheel delta");
        await page.mouse.move(x, y);
        await page.mouse.wheel(deltaX, deltaY);
      } else {
        const button = ["left", "right", "middle"].includes(input.button) ? input.button : "left";
        await page.mouse.move(x, y);
        if (type === "down") await page.mouse.down({ button });
        else await page.mouse.up({ button });
      }
    } else if (type === "key") {
      if (typeof input.key !== "string" || input.key.length > 48)
        throw new Error("Invalid keyboard key");
      if (input.action === "down") await page.keyboard.down(input.key);
      else if (input.action === "up") await page.keyboard.up(input.key);
      else if (input.action === "press") await page.keyboard.press(input.key);
      else throw new Error("Invalid key action");
    } else if (type === "text") {
      if (typeof input.text !== "string" || input.text.length > 2048)
        throw new Error("Invalid input text");
      await page.keyboard.insertText(input.text);
    } else {
      throw new Error("Unsupported input event");
    }
    return { accepted: true };
  };
  const evalPage = async ({ sessionId, expression }) => {
    const page = locate(sessionId);
    enforceChatGPTOrigin(page);
    if (typeof expression !== "string" || expression.length > 200_000)
      throw new Error("Invalid page expression");
    // Exactly matches the existing Electron webview evaluate-in-guest API.
    // The Electron IPC caller must be the trusted T3 renderer, not site content.
    const result = await page.evaluate((source) => (0, eval)(source), expression);
    return { result, url: page.url() };
  };
  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const readJson = async (req) => {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 250_000) throw new Error("Request too large");
    }
    return body ? JSON.parse(body) : {};
  };

  const handler = async (req, res) => {
    if (accessToken && req.headers.authorization !== "Bearer " + accessToken) {
      send(res, 403, { error: "Browser host authorization required" });
      return;
    }
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "GET" && path === "/health") {
        send(res, 200, { instanceId, pid: process.pid, liveSessions: sessions.size, closing });
      } else if (req.method === "GET" && path === "/sessions") {
        send(res, 200, { instanceId, sessions: [...sessions].map(([id, page]) => snapshot(id, page)) });
      } else if (req.method === "GET" && path === "/sessions/memory") {
        const measurements = await Promise.all([...sessions]
          .filter(([, page]) => !page.isClosed())
          .map(([id, page]) => pageMemory(id, page)));
        send(res, 200, { instanceId, measurements });
      } else if (req.method === "POST" && path === "/sessions/frame") {
        send(res, 200, await frame(await readJson(req)));
      } else if (req.method === "POST" && path === "/sessions/input") {
        send(res, 200, await inputPage(await readJson(req)));
      } else if (req.method === "POST" && path === "/sessions/evaluate") {
        send(res, 200, await evalPage(await readJson(req)));
      } else if (req.method === "POST" && path === "/sessions/status") {
        const { sessionId } = await readJson(req);
        const page = locate(sessionId);
        send(res, 200, { sessionId, url: page.url(), loading: false, closed: false });
      } else if (req.method === "POST" && path === "/sessions/attach") {
        const input = await readJson(req);
        send(res, 200, await attach(input.sessionId, input.initialUrl));
      } else if (req.method === "POST" && path.startsWith("/sessions/") && path.endsWith("/close")) {
        const id = decodeURIComponent(path.slice("/sessions/".length, -"/close".length));
        const page = sessions.get(id);
        if (page) await page.close();
        send(res, 200, { closed: Boolean(page) });
      } else if (req.method === "POST" && path === "/shutdown") {
        send(res, 200, { stopping: true });
        setImmediate(() => { void stop(); });
      } else {
        send(res, 404, { error: "Unknown browser host operation" });
      }
    } catch (error) {
      send(res, 400, { error: errorText(error) });
    }
  };

  async function start() {
    if (server) throw new Error("Browser host already started");
    server = Http.createServer((req, res) => { void handler(req, res); });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.off("error", reject); resolve(); });
    });
    return { socketPath, instanceId };
  }

  async function stop() {
    if (closing) return;
    closing = true;
    const pending = contextPromise;
    if (pending) await (await pending.catch(() => undefined))?.close().catch(() => {});
    if (server) await new Promise((resolve) => server.close(resolve));
  }
  return { start, stop, attach, socketPath, instanceId };
}

/** A new T3 process can discover the same host without touching its pages. */
export function requestBrowserHost(socketPath, method, path, body, accessToken) {
  return new Promise((resolve, reject) => {
    const req = Http.request({
      socketPath, method, path,
      headers: { ...(body ? { "content-type": "application/json" } : {}),
        ...(accessToken ? { authorization: "Bearer " + accessToken } : {}) },
    }, (res) => {
      let response = "";
      res.setEncoding("utf8");
      res.on("data", (part) => { response += part; });
      res.on("end", () => {
        try {
          const value = JSON.parse(response);
          if (res.statusCode !== 200) reject(new Error(value.error ?? ("Browser host returned " + res.statusCode)));
          else resolve(value);
        } catch (error) { reject(error); }
      });
    });
    req.once("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

if (process.argv[1] && Path.resolve(process.argv[1]) === absoluteFile) {
  if (!process.env.T3_BROWSER_HOST_TOKEN || process.env.T3_BROWSER_HOST_TOKEN.length < 32) {
    throw new Error("Persistent browser host requires an authenticated owner token.");
  }
  const host = createBrowserHost({ dataDirectory: process.argv[2] ?? defaultDataDirectory() });
  host.start().then(({ socketPath, instanceId }) => {
    process.stdout.write(JSON.stringify({ socketPath, instanceId, pid: process.pid }) + "\n");
  }).catch((error) => {
    process.stderr.write("Browser host startup failed: " + errorText(error) + "\n");
    process.exitCode = 1;
  });
}
