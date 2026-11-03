"use strict";
// Independent Chromium owner. Each page lives in a real top-level window that
// T3 adopts as a Win32 *owned* window, so the page outlives T3 and Windows
// delivers mouse, keyboard, IME and drag-and-drop to it directly.
const { app, BaseWindow, Menu, WebContentsView } = require("electron");
const Crypto = require("node:crypto");
const Http = require("node:http");
const Fs = require("node:fs");
const Os = require("node:os");
const Path = require("node:path");

const directory = process.argv[2];
const ownerToken = process.env.T3_BROWSER_HOST_TOKEN;
if (!directory || !ownerToken || !/^[a-f0-9]{64}$/i.test(ownerToken))
  throw new Error(
    "Offscreen browser host requires an authenticated owner token and data directory",
  );
Fs.mkdirSync(directory, { recursive: true });
const key = Crypto.createHash("sha256")
  .update(Path.resolve(directory).toLowerCase())
  .digest("hex")
  .slice(0, 16);
const socketPath =
  process.platform === "win32"
    ? "\\\\.\\pipe\\t3code-browser-host-" + key
    : Path.join(Os.tmpdir(), "t3code-browser-host-" + key + ".sock");

if (process.platform !== "win32" || !directory.endsWith("-v3"))
  throw new Error("Persistent native Chromium requires the v3 Windows owner");
app.setPath("userData", Path.join(directory, "electron-profile"));
// Bump with any change T3 and this host must make together. T3 replaces a host
// that reports a different value, so a host can never outlive its protocol.
const HOST_PROTOCOL = 5;
// Pages now receive real keystrokes. Without this, Electron's default menu
// would turn Ctrl+R and Ctrl+W into reloads and window closes inside the page.
Menu.setApplicationMenu(null);
// Repeated launches must not contend for the same Chromium profile/cache.
// A surviving host already owns the pipe and its live ChatGPT pages.
if (!app.requestSingleInstanceLock()) app.exit(0);
// Respect Chromium's normal background scheduling. The previous global
// disable-* switches kept ALL retained ChatGPT tabs running as foreground
// renderers (dozens of sessions together could saturate the CPU). Only the
// currently presented page opts out of background throttling below.
// An empty detached owner must stay alive to accept future attaches. Electron
// otherwise quits when the final (hidden) BrowserWindow is closed.
app.on("window-all-closed", () => {});
const sessions = new Map();
const attaching = new Map();
const inputPipelines = new Map();
const instanceId = Crypto.randomUUID();
// Open /events responses, one per live T3 desktop process.
const subscribers = new Set();
let server;
let quitting = false;
app.on("before-quit", () => {
  quitting = true;
});
const emit = (event) => {
  const line = JSON.stringify(event) + "\n";
  for (const res of subscribers) res.write(line);
};

const send = (res, code, body) => {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
};
const readJson = async (req, maxSize = 250_000) => {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > maxSize) throw new Error("Request exceeds control protocol limit");
  }
  return body ? JSON.parse(body) : {};
};
const safeId = (id) =>
  typeof id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
const allowedInitialUrl = (url) => {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      ["chatgpt.com", "chat.openai.com"].includes(u.hostname)
    );
  } catch {
    return false;
  }
};
const page = (id) => {
  if (!safeId(id)) throw new Error("Invalid ChatGPT session UUID");
  const entry = sessions.get(id);
  if (!entry || entry.window.isDestroyed() || entry.window.webContents.isDestroyed())
    throw new Error("Persistent Chromium page is not attached");
  return entry.window;
};
const pageUrl = (window) => window.webContents.getURL();
// Tell T3 about input it can no longer see now that Windows sends it straight
// to the page: its shortcuts, plus a throttled "the user is here" signal.
function relayPageInput(sessionId, contents) {
  let lastInteraction = 0;
  const interacted = () => {
    const now = Date.now();
    if (now - lastInteraction < 2_000) return;
    lastInteraction = now;
    emit({ type: "interaction", sessionId });
  };
  contents.on("before-mouse-event", interacted);
  contents.on("before-input-event", (event, input) => {
    interacted();
    if (input.type !== "keyDown" || input.isComposing) return;
    if (["Control", "Shift", "Alt", "Meta"].includes(input.key)) return;
    const modifier = input.control || input.meta;
    const functionKey = /^F\d+$/.test(input.key);
    if (!modifier && !input.alt && !functionKey) return;
    // AltGr reports as Ctrl+Alt plus the typed character: that is text.
    if (input.control && input.alt && /^(?:[^a-zA-Z0-9]|Dead)$/u.test(input.key)) return;
    const key = input.key.toLowerCase();
    const plain = !input.shift && !input.alt;
    // T3 owns these three outright. Every other chord also reaches the page,
    // so ChatGPT's own shortcuts and editing keys keep working.
    if (
      (modifier && plain && (key === "w" || key === "f")) ||
      (input.key === "F2" && plain && !modifier)
    )
      event.preventDefault();
    emit({
      type: "key",
      sessionId,
      input: {
        type: "keyDown",
        key: input.key,
        code: input.code,
        control: input.control,
        meta: input.meta,
        shift: input.shift,
        alt: input.alt,
        isAutoRepeat: input.isAutoRepeat,
      },
    });
  });
}

// One page: a WebContentsView in a chrome-less carrier window. T3 sets the
// carrier's owner and position over its pane; size stays here because Chromium
// pins a non-resizable window's size against changes from outside.
function createDurableNativePage(sessionId, partition) {
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
      partition,
    },
  });
  relayPageInput(sessionId, view.webContents);
  let disposed = false;
  const width = 1280,
    height = 800;
  // Locked down because it now takes real mouse input: a resizable frameless
  // window would grow resize handles along the edges of the ChatGPT page.
  const carrier = new BaseWindow({
    width,
    height,
    frame: false,
    show: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    thickFrame: false,
    roundedCorners: false,
    hasShadow: false,
    backgroundColor: "#ffffff",
  });
  carrier.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width, height });
  // Alt+F4 lands here while the page has focus. It means "close T3".
  carrier.on("close", (event) => {
    if (disposed || quitting) return;
    event.preventDefault();
    emit({ type: "close-requested", sessionId });
  });
  return {
    webContents: view.webContents,
    isDestroyed: () => disposed || view.webContents.isDestroyed(),
    getNativeWindowHandle: () => carrier.getNativeWindowHandle(),
    getBounds: () => carrier.getBounds(),
    // Takes desktop DIP. Twice, because Chromium converts using the monitor the
    // window is on before the move, so a move across scales lands wrong the first time.
    setBounds: (bounds) => {
      carrier.setBounds(bounds);
      carrier.setBounds(bounds);
      view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
    },
    // Showing must go through Electron: a window shown from outside stays
    // "hidden" to Chromium, so the page would not paint. T3 positions the
    // carrier first. Hidden pages keep their DOM and network but return to
    // Chromium's normal background throttling to save CPU.
    setCarrierVisible: (visible) => {
      view.webContents.setBackgroundThrottling(!visible);
      if (visible === carrier.isVisible()) return;
      if (visible) carrier.showInactive();
      else carrier.hide();
    },
    loadURL: (url) => view.webContents.loadURL(url),
    on: (event, listener) => {
      if (event === "closed") view.webContents.on("destroyed", listener);
    },
    destroy: () => {
      if (disposed) return;
      disposed = true;
      if (!view.webContents.isDestroyed()) view.webContents.close();
      if (!carrier.isDestroyed()) carrier.destroy();
    },
  };
}
const presentationInfo = (window) => ({
  hostPid: process.pid,
  display: "native",
  nativeHwnd: window.getNativeWindowHandle().readBigUInt64LE(0).toString(),
});
const pageSnapshot = (id) => {
  const window = page(id);
  const contents = window.webContents;
  return {
    sessionId: id,
    url: pageUrl(window),
    title: contents.getTitle(),
    loading: contents.isLoading(),
    closed: false,
    destroyed: false,
    processId: contents.getOSProcessId(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    ...presentationInfo(window),
  };
};
const onChatGPT = (window) => {
  const url = new URL(pageUrl(window));
  if (url.protocol !== "https:" || !["chatgpt.com", "chat.openai.com"].includes(url.hostname))
    throw new Error("Browser script execution is restricted to ChatGPT pages");
};

const profileScope = (environmentId = "local", profileId = "default") => {
  if (
    typeof environmentId !== "string" ||
    environmentId.length < 1 ||
    environmentId.length > 128 ||
    /[\x00-\x1f\x7f]/.test(environmentId)
  )
    throw new Error("Invalid T3 environment scope");
  if (
    typeof profileId !== "string" ||
    profileId.length < 1 ||
    profileId.length > 64 ||
    /[\x00-\x1f\x7f]/.test(profileId)
  )
    throw new Error("Invalid T3 browser profile scope");
  const id = Crypto.createHash("sha256")
    .update(JSON.stringify([environmentId, profileId]))
    .digest("hex")
    .slice(0, 24);
  return {
    key: id,
    // Persist each environment/account partition independently so either
    // ChatGPT login survives a full detached-host restart, not just T3 rebuilds.
    partition: "persist:t3code-chatgpt-account-" + id,
  };
};

const migratedCookieDomain = (domain) => {
  const host = String(domain || "")
    .replace(/^\./, "")
    .toLowerCase();
  return (
    host === "chatgpt.com" ||
    host.endsWith(".chatgpt.com") ||
    host === "openai.com" ||
    host.endsWith(".openai.com")
  );
};

// Values only cross the authenticated local pipe; no cookies in logs or UI.
// Import before first navigation to prevent an unauthenticated load race.
async function importSignInCookies(window, cookies) {
  if (cookies === undefined) return;
  if (!Array.isArray(cookies) || cookies.length > 300)
    throw new Error("Invalid scoped ChatGPT cookie transfer");
  try {
    for (const [index, cookie] of cookies.entries()) {
      if (
        !cookie ||
        !migratedCookieDomain(cookie.domain) ||
        typeof cookie.name !== "string" ||
        typeof cookie.value !== "string" ||
        cookie.name.length > 256 ||
        cookie.value.length > 8192
      )
        continue;
      const host = cookie.domain.replace(/^\./, "").toLowerCase();
      const path =
        typeof cookie.path === "string" && cookie.path.startsWith("/") ? cookie.path : "/";
      // Electron's cookies.get returns hostOnly for host-scoped cookies.
      // Supplying a Domain attribute changes their semantics and is forbidden
      // for __Host-* authentication cookies (and can abort ALL session attaches).
      const hostOnly = cookie.hostOnly === true || cookie.name.startsWith("__Host-");
      try {
        await window.webContents.session.cookies.set({
          url: "https://" + host + path,
          name: cookie.name,
          value: cookie.value,
          ...(hostOnly ? {} : { domain: cookie.domain }),
          path,
          secure: cookie.secure === true,
          httpOnly: cookie.httpOnly === true,
          ...(typeof cookie.expirationDate === "number"
            ? { expirationDate: cookie.expirationDate }
            : {}),
          ...(["unspecified", "no_restriction", "lax", "strict"].includes(cookie.sameSite)
            ? { sameSite: cookie.sameSite }
            : {}),
        });
      } catch (error) {
        // Preserve useful diagnostics without logging cookie names or values.
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Cookie ${index + 1}/${cookies.length} for ${host} (hostOnly=${hostOnly}) was rejected: ${reason}`,
        );
      }
    }
  } catch (error) {
    throw new Error(
      "Scoped ChatGPT sign-in transfer failed: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

// Every account owns a persistent Chromium partition (cookies, IndexedDB and
// local storage). Legacy T3 cookies are imported only when creating a page;
// existing live pages are never navigated or rebound across accounts.

async function attach(id, initialUrl, environmentId, profileId, authCookies) {
  const scope = profileScope(environmentId, profileId);
  if (!safeId(id) || !allowedInitialUrl(initialUrl))
    throw new Error("Only an exact T3 ChatGPT UUID and ChatGPT HTTPS URL are permitted");
  const existing = sessions.get(id);
  if (existing && !existing.window.isDestroyed()) {
    if (existing.profileKey !== scope.key)
      throw new Error("Persistent session belongs to a different browser profile");
    return {
      sessionId: id,
      url: pageUrl(existing.window),
      closed: false,
      reused: true,
      ...presentationInfo(existing.window),
    };
  }
  if (attaching.has(id)) return { ...(await attaching.get(id)), reused: true };
  const created = (async () => {
    const window = createDurableNativePage(id, scope.partition);
    window.webContents.setWindowOpenHandler(({ url }) => {
      // Popups must never escape into a visible Windows window.
      // OAuth popups require a separate guarded inline flow before rollout.
      return { action: "deny" };
    });
    const entry = { window, profileKey: scope.key };
    sessions.set(id, entry);
    window.on("closed", () => {
      if (sessions.get(id)?.window === window) sessions.delete(id);
    });
    try {
      await importSignInCookies(window, authCookies);
      // Pages stay hidden until T3 adopts and positions their carrier.
      await window.loadURL(initialUrl);
      return {
        sessionId: id,
        url: pageUrl(window),
        closed: false,
        reused: false,
        ...presentationInfo(window),
      };
    } catch (error) {
      sessions.delete(id);
      window.destroy();
      throw error;
    }
  })();
  attaching.set(id, created);
  try {
    return await created;
  } finally {
    if (attaching.get(id) === created) attaching.delete(id);
  }
}

async function inputPage({ sessionId, input }) {
  const window = page(sessionId);
  if (!input || typeof input !== "object") throw new Error("Malformed input");
  const contents = window.webContents;
  const { type } = input;
  if (["move", "down", "up", "wheel"].includes(type)) {
    const x = Number(input.x),
      y = Number(input.y);
    // Match the high-resolution viewport allowance in /sessions/resize.
    // The former 2560x1600 clamp rejected valid clicks/moves on 4K displays.
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 8192 || y < 0 || y > 4320)
      throw new Error("Invalid pointer coordinates");
    const button = ["left", "right", "middle"].includes(input.button) ? input.button : "left";
    const electronType = {
      move: "mouseMove",
      down: "mouseDown",
      up: "mouseUp",
      wheel: "mouseWheel",
    }[type];
    if (type === "wheel") {
      const deltaX = Number(input.deltaX),
        deltaY = Number(input.deltaY);
      if (
        ![deltaX, deltaY].every(Number.isFinite) ||
        Math.abs(deltaX) > 2000 ||
        Math.abs(deltaY) > 2000
      )
        throw new Error("Invalid wheel delta");
      contents.sendInputEvent({ type: electronType, x, y, deltaX, deltaY });
    } else {
      contents.sendInputEvent({ type: electronType, x, y, button, clickCount: 1 });
    }
  } else if (type === "key") {
    if (typeof input.key !== "string" || input.key.length > 48)
      throw new Error("Invalid keyboard key");
    const action = input.action;
    const parts = input.key.split("+");
    const raw = parts.pop();
    const aliases = {
      Enter: "Return",
      Escape: "Esc",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      " ": "Space",
    };
    const keyCode = aliases[raw] ?? raw;
    const modifiers = parts
      .map(
        (part) =>
          ({
            Control: "control",
            Ctrl: "control",
            Alt: "alt",
            Shift: "shift",
            Meta: "meta",
          })[part],
      )
      .filter(Boolean);
    if (action === "press") {
      contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    } else if (action === "down" || action === "up") {
      contents.sendInputEvent({
        type: action === "down" ? "keyDown" : "keyUp",
        keyCode,
        modifiers,
      });
    } else throw new Error("Invalid keyboard action");
  } else if (type === "text") {
    if (typeof input.text !== "string" || input.text.length > 200_000)
      throw new Error("Invalid inserted text");
    await contents.insertText(input.text);
  } else throw new Error("Unsupported input event");
  return { accepted: true };
}

/** Process keyboard and pointer input in arrival order for each live page.
 * Concurrent IPC calls must never reorder characters in ChatGPT's composer. */
async function orderedInput(payload) {
  const id = payload.sessionId;
  if (!safeId(id)) throw new Error("Invalid ChatGPT session UUID");
  const previous = inputPipelines.get(id) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => inputPage(payload));
  inputPipelines.set(id, next);
  try {
    return await next;
  } finally {
    if (inputPipelines.get(id) === next) inputPipelines.delete(id);
  }
}
async function evaluatePage({ sessionId, expression }) {
  const window = page(sessionId);
  onChatGPT(window);
  if (typeof expression !== "string" || expression.length > 200_000)
    throw new Error("Invalid page expression");
  const result = await window.webContents.executeJavaScript(expression, true);
  return { result, url: pageUrl(window) };
}

async function findPage({ sessionId, text, findNext = false, forward = true }) {
  const contents = page(sessionId).webContents;
  if (typeof text !== "string" || !text.trim() || text.length > 500)
    throw new Error("Find text must be 1..500 characters");
  return new Promise((resolve, reject) => {
    let requestId = -1;
    const cleanup = () => {
      clearTimeout(timer);
      contents.off("found-in-page", onFound);
    };
    const onFound = (_event, result) => {
      if (requestId !== -1 && result.requestId !== requestId) return;
      if (!result.finalUpdate) return;
      cleanup();
      resolve({
        matches: result.matches,
        activeMatchOrdinal: result.activeMatchOrdinal,
      });
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Persistent Chromium find did not confirm its result"));
    }, 2_000);
    contents.on("found-in-page", onFound);
    try {
      requestId = contents.findInPage(text, { findNext, forward });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function memory() {
  const metrics = new Map(app.getAppMetrics().map((metric) => [metric.pid, metric]));
  return {
    instanceId,
    measurements: [...sessions]
      .filter(([, entry]) => !entry.window.isDestroyed())
      .map(([id, entry]) => {
        const pid = entry.window.webContents.getOSProcessId();
        const metric = metrics.get(pid);
        return {
          sessionId: id,
          rendererPid: pid,
          processWorkingSetMB: metric
            ? Math.round((metric.memory.workingSetSize / 1024) * 10) / 10
            : null,
          kind: "electron-renderer-process-working-set-not-exclusive-page-memory",
        };
      }),
  };
}

async function handle(req, res) {
  if (req.headers.authorization !== "Bearer " + ownerToken) {
    send(res, 403, { error: "Persistent browser owner token required" });
    return;
  }
  try {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (req.method === "GET" && pathname === "/health")
      return send(res, 200, {
        instanceId,
        pid: process.pid,
        liveSessions: sessions.size,
        protocol: HOST_PROTOCOL,
        closing: false,
      });
    // A long-lived stream per T3 process. It is also how we learn T3 died: the
    // pipe closes even on a forced kill, and Windows would otherwise leave the
    // on-screen page floating on the desktop once its owner is gone.
    if (req.method === "GET" && pathname === "/events") {
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
      res.flushHeaders();
      subscribers.add(res);
      res.once("close", () => {
        subscribers.delete(res);
        if (subscribers.size > 0) return;
        for (const { window } of sessions.values())
          if (!window.isDestroyed()) window.setCarrierVisible(false);
      });
      return;
    }
    if (req.method === "GET" && pathname === "/sessions")
      return send(res, 200, {
        instanceId,
        sessions: [...sessions].map(([id, entry]) => ({
          sessionId: id,
          url: pageUrl(entry.window),
          closed: entry.window.isDestroyed(),
        })),
      });
    if (req.method === "GET" && pathname === "/sessions/memory") return send(res, 200, memory());
    if (req.method === "POST" && pathname === "/sessions/attach") {
      // Up to 300 authentication cookies, each potentially several KiB.
      // Keep other command/input requests on the smaller size limit.
      const input = await readJson(req, 3_000_000);
      return send(
        res,
        200,
        await attach(
          input.sessionId,
          input.initialUrl,
          input.environmentId,
          input.profileId,
          input.authCookies,
        ),
      );
    }
    if (req.method === "POST" && pathname === "/sessions/visibility") {
      const { sessionId, visible } = await readJson(req);
      if (typeof visible !== "boolean") throw new Error("Invalid native carrier visibility");
      const window = page(sessionId);
      window.setCarrierVisible(visible);
      return send(res, 200, { visible, ...presentationInfo(window) });
    }
    if (req.method === "POST" && pathname === "/sessions/resize") {
      const { sessionId, x, y, width, height } = await readJson(req);
      if (
        !Number.isSafeInteger(x) ||
        !Number.isSafeInteger(y) ||
        !Number.isSafeInteger(width) ||
        width < 1 ||
        width > 8192 ||
        !Number.isSafeInteger(height) ||
        height < 1 ||
        height > 4320
      )
        throw new Error("Invalid native Chromium viewport dimensions");
      page(sessionId).setBounds({ x, y, width, height });
      return send(res, 200, { resized: true, width, height });
    }
    if (req.method === "POST" && pathname === "/sessions/input")
      return send(res, 200, await orderedInput(await readJson(req)));
    if (req.method === "POST" && pathname === "/sessions/evaluate")
      return send(res, 200, await evaluatePage(await readJson(req)));
    if (req.method === "POST" && pathname === "/sessions/status") {
      const { sessionId } = await readJson(req);
      return send(res, 200, pageSnapshot(sessionId));
    }
    if (req.method === "POST" && pathname === "/sessions/snapshot") {
      const { sessionId, environmentId, profileId } = await readJson(req);
      const entry = sessions.get(sessionId);
      if (!entry || entry.window.isDestroyed() || entry.window.webContents.isDestroyed())
        return send(res, 200, {
          sessionId,
          url: "",
          title: "",
          loading: false,
          destroyed: true,
          residency: "missing",
        });
      const expected = profileScope(environmentId, profileId).key;
      if (entry.profileKey !== expected)
        throw new Error("ChatGPT session environment/profile identity mismatch");
      return send(res, 200, pageSnapshot(sessionId));
    }
    if (req.method === "POST" && pathname === "/sessions/probe") {
      const { sessionId, environmentId, profileId } = await readJson(req);
      const entry = sessions.get(sessionId);
      if (!entry || entry.window.isDestroyed() || entry.window.webContents.isDestroyed())
        return send(res, 200, { sessionId, residency: "missing" });
      const expected = profileScope(environmentId, profileId).key;
      if (entry.profileKey !== expected)
        return send(res, 200, { sessionId, residency: "mismatch" });
      return send(res, 200, { residency: "resident", ...pageSnapshot(sessionId) });
    }
    if (req.method === "POST" && pathname === "/sessions/navigate") {
      const input = await readJson(req);
      if (!allowedInitialUrl(input.url)) throw new Error("Only HTTPS ChatGPT pages may be opened");
      const window = page(input.sessionId);
      await window.loadURL(input.url);
      return send(res, 200, pageSnapshot(input.sessionId));
    }
    if (req.method === "POST" && pathname === "/sessions/reload") {
      const { sessionId } = await readJson(req);
      const window = page(sessionId);
      window.webContents.reload();
      return send(res, 200, pageSnapshot(sessionId));
    }
    if (req.method === "POST" && pathname === "/sessions/history") {
      const { sessionId, operation } = await readJson(req);
      const window = page(sessionId);
      const history = window.webContents.navigationHistory;
      if (operation === "back" && history.canGoBack()) history.goBack();
      else if (operation === "forward" && history.canGoForward()) history.goForward();
      else if (operation !== "back" && operation !== "forward")
        throw new Error("Invalid history operation");
      return send(res, 200, pageSnapshot(sessionId));
    }
    if (req.method === "POST" && pathname === "/sessions/find")
      return send(res, 200, await findPage(await readJson(req)));
    if (req.method === "POST" && pathname === "/sessions/stop-find") {
      const { sessionId } = await readJson(req);
      page(sessionId).webContents.stopFindInPage("clearSelection");
      return send(res, 200, { stopped: true });
    }
    if (req.method === "POST" && pathname === "/sessions/close") {
      const { sessionId } = await readJson(req);
      const entry = sessions.get(sessionId);
      if (entry && !entry.window.isDestroyed()) {
        entry.window.destroy();
        sessions.delete(sessionId);
        inputPipelines.delete(sessionId);
      }
      return send(res, 200, { closed: Boolean(entry) });
    }
    if (req.method === "POST" && pathname === "/shutdown") {
      send(res, 200, { stopping: true });
      setImmediate(() => {
        server.close();
        for (const { window } of sessions.values()) if (!window.isDestroyed()) window.destroy();
        app.quit();
      });
      return;
    }
    send(res, 404, { error: "Unknown persistent browser operation" });
  } catch (error) {
    send(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

app
  .whenReady()
  .then(async () => {
    server = Http.createServer((req, res) => {
      void handle(req, res);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
  })
  .catch((error) => {
    Fs.appendFileSync(Path.join(directory, "browser-host-errors.log"), String(error) + "\n");
    app.exit(1);
  });
