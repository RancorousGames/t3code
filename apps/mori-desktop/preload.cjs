"use strict";
const { contextBridge, ipcRenderer } = require("electron");

// An intentionally narrow, typed capability boundary. No Node objects or
// arbitrary filesystem paths are exposed to translation content.
const call = (name, ...args) => ipcRenderer.invoke("mori:" + name, ...args);
contextBridge.exposeInMainWorld("moriBackend", Object.freeze({
  version: 1,
  codexTranslationConfig: () => call("ai:codex-configuration"),
  codexTranslate: request => call("ai:codex-translate", request),
  listProjects: () => call("projects:list"),
  loadProject: id => call("projects:load", id),
  saveProject: project => call("projects:save", project),
  deleteProject: id => call("projects:delete", id),
  listRevisions: id => call("projects:revisions", id),
  restoreRevision: (id, revision) => call("projects:restore", id, revision),
  openProjectBackup: () => call("file:open-project"),
  saveProjectBackup: project => call("file:save-project", project),
  exportInterchange: request => call("file:export-interchange", request),
  readPublicSheet: (id, gid) => call("google:public-sheet", id, gid),
  googleStatus: () => call("google:status"),
  googleConfigure: () => call("google:configure"),
  googleLogin: () => call("google:login"),
  googleLogout: () => call("google:logout"),
  googleListFiles: page => call("google:list", page),
  googleCopy: (id, name) => call("google:copy", id, name),
  googleExport: (id, kind) => call("google:export", id, kind),
  googleSheetInfo: id => call("google:sheet-info", id),
  googleReadValues: (id, range) => call("google:values", id, range),
  googleSyncChecked: (id, changes) => call("google:sync-checked", id, changes),
}));
