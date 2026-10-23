"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { createProjectStore, validateProject } = require("./project-store.cjs");
const { createPublicSheetReader } = require("./public-sheet.cjs");
const { createGoogleWorkspace } = require("./google-workspace.cjs");
const { createCodexTranslator } = require("./codex-translation.cjs");

// Entirely separate profile, project library and OS application identity from T3.
// Non-packaged QA may run in an isolated disposable profile without touching
// the real Monku library or interfering with an already open preview window.
const smokeProfile = !app.isPackaged && process.env.MORI_TEST_USER_DATA;
app.setPath("userData", smokeProfile ? path.resolve(smokeProfile) : path.join(app.getPath("appData"), "MonkuNoMori"));
app.setAppUserModelId("games.rancorous.monkunomori");
const projectStore = createProjectStore(app.getPath("userData"));
const codexTranslator = createCodexTranslator({ userDataDir: app.getPath("userData") });
const googleWorkspace = createGoogleWorkspace({ userDataDir: app.getPath("userData"), safeStorage, openExternal: url => shell.openExternal(url) });

const acquiredLock = app.requestSingleInstanceLock();
if (!acquiredLock) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    // The old Mori Desktop OAuth client is bundled as non-repository build
    // resource. Only its client registration is copied; never an account token.
    const status = await googleWorkspace.clientStatus();
    if (!status.configured) {
      const bundled = app.isPackaged
        ? path.join(process.resourcesPath, "google-oauth-client.json")
        : path.join(__dirname, "private", "google-oauth-client.json");
      try { await googleWorkspace.configure(bundled); }
      catch (error) { console.warn("[Mori] Google OAuth client unavailable:", error.message); }
    }
    const mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 850,
      minHeight: 550,
      title: "Monku no Mori",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: true,
      },
    });

    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    mainWindow.webContents.on("will-attach-webview", (event, preferences, params) => {
      delete preferences.preload;
      preferences.nodeIntegration = false;
      preferences.sandbox = true;
      let permitted = false;
      try {
        const target = new URL(params.src);
        permitted = target.protocol === "https:" &&
          (target.hostname === "chatgpt.com" || target.hostname === "chat.openai.com");
      } catch { /* Invalid guest URL */ }
      if (params.partition !== "persist:mori-chatgpt" || !permitted) event.preventDefault();
    });
    mainWindow.webContents.on("will-navigate", (event, url) => {
      if (url !== mainWindow.webContents.getURL()) event.preventDefault();
    });

    function secure(method, handler) {
      ipcMain.handle("mori:" + method, async (event, ...args) => {
        if (event.sender !== mainWindow.webContents ||
            event.senderFrame !== mainWindow.webContents.mainFrame) {
          throw new Error("Monku backend calls must come from the application window.");
        }
        return handler(...args);
      });
    }

    secure("ai:codex-configuration", () => codexTranslator.getConfig());
    secure("ai:codex-translate", request => codexTranslator.translate(request));
    secure("projects:list", () => projectStore.list());
    secure("projects:load", id => projectStore.load(id));
    secure("projects:save", project => projectStore.save(project));
    secure("projects:delete", id => projectStore.remove(id));
    secure("projects:revisions", id => projectStore.revisions(id));
    secure("projects:restore", (id, revision) => projectStore.restore(id, revision));

    const fetchPublicSheet = createPublicSheetReader();
    secure("google:public-sheet", (id, gid) => fetchPublicSheet(id, gid));
    secure("google:status", () => googleWorkspace.clientStatus());
    secure("google:configure", async () => {
      const selected = await dialog.showOpenDialog(mainWindow, { properties: ["openFile"], filters: [{ name: "OAuth JSON", extensions: ["json"] }] });
      return selected.canceled || !selected.filePaths[0] ? null : googleWorkspace.configure(selected.filePaths[0]);
    });
    secure("google:sheet-info", id => googleWorkspace.sheetInfo(id));
    secure("google:values", (id, range) => googleWorkspace.readSheetValues(id, range));
    secure("google:export", (id, kind) => googleWorkspace.exportFile(id, kind));
    secure("google:sync-checked", (id, changes) => googleWorkspace.writeCheckedCopy(id, changes));
    secure("google:copy", async (id, name) => {
      const copied = await googleWorkspace.createCopy(id, name);
      await googleWorkspace.registerCopy(copied.id);
      return copied;
    });
    secure("google:login", () => googleWorkspace.signIn());
    secure("google:logout", () => googleWorkspace.logout());
    secure("google:list", pageToken => googleWorkspace.listFiles(pageToken));

    secure("file:open-project", async () => {
      const chosen = await dialog.showOpenDialog(mainWindow, {
        title: "Open Monku project backup",
        properties: ["openFile"],
        filters: [{ name: "Monku project", extensions: ["mori", "json"] }],
      });
      if (chosen.canceled || !chosen.filePaths[0]) return null;
      const file = chosen.filePaths[0];
      const stat = await fs.stat(file);
      if (stat.size > 64 * 1024 * 1024) throw Error("File exceeds the 64 MiB project safety limit.");
      const data = validateProject(JSON.parse(await fs.readFile(file, "utf8")));
      return { project: data, filename: path.basename(file) };
    });

    secure("file:save-project", async project => {
      validateProject(project);
      const preferred = String(project.name).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 100) || "project";
      const chosen = await dialog.showSaveDialog(mainWindow, {
        title: "Export Monku project backup",
        defaultPath: preferred + ".mori",
        filters: [{ name: "Monku project", extensions: ["mori"] }],
      });
      if (chosen.canceled || !chosen.filePath) return null;
      const output = chosen.filePath;
      const data = JSON.stringify(project, null, 2);
      const tmp = output + "." + crypto.randomUUID() + ".tmp";
      try {
        await fs.writeFile(tmp, data, { encoding: "utf8", flag: "wx" });
        await fs.rename(tmp, output);
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => {});
      }
      return { filename: path.basename(output) };
    });

    secure("file:export-interchange", async request => {
      if (!request || !["json", "csv", "po"].includes(request.format) ||
          typeof request.data !== "string" || Buffer.byteLength(request.data) > 64 * 1024 * 1024 ||
          typeof request.filename !== "string") {
        throw Error("Invalid localized interchange export.");
      }
      const filename = path.basename(request.filename)
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
        .slice(0, 110);
      const chosen = await dialog.showSaveDialog(mainWindow, {
        title: "Export localized interchange",
        defaultPath: filename,
        filters: [{ name: request.format.toUpperCase(), extensions: [request.format] }],
      });
      if (chosen.canceled || !chosen.filePath) return null;
      const output = chosen.filePath;
      const tmp = output + "." + crypto.randomUUID() + ".tmp";
      try {
        await fs.writeFile(tmp, request.data, { encoding: "utf8", flag: "wx" });
        await fs.rename(tmp, output);
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => {});
      }
      return { filename: path.basename(output) };
    });

    const devUrl = process.env.MORI_DEV_URL;
    if (devUrl) {
      const url = new URL(devUrl);
      if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.protocol !== "http:") {
        throw new Error("MORI_DEV_URL must be a local HTTP server");
      }
      await mainWindow.loadURL(url.href);
    } else {
      const renderer = app.isPackaged
        ? path.join(process.resourcesPath, "renderer", "index.html")
        : path.join(__dirname, "..", "mori-web", "dist", "index.html");
      await mainWindow.loadFile(renderer);
    }
  });

  app.on("second-instance", () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isMinimized()) window.restore();
      window.focus();
      break;
    }
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
