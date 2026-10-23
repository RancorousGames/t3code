"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_PROJECT_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 200_000;
const BACKUP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_REVISIONS = 12;

function validateProject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.id !== "string" || !value.id.trim() || value.id.length > 256 ||
      typeof value.name !== "string" || !value.name.trim() || value.name.length > 1024 ||
      !Array.isArray(value.rows) || value.rows.length > MAX_ROWS ||
      !Array.isArray(value.characters) || !Array.isArray(value.glossary) ||
      !value.context || typeof value.context !== "object") {
    throw new Error("Invalid Monku project structure. Nothing was saved.");
  }
  if (!value.rows.every(row => row && typeof row.id === "string" && typeof row.source === "string" &&
      typeof row.final === "string" && ["pending", "draft", "translated"].includes(row.status))) {
    throw new Error("Invalid translation rows. Nothing was saved.");
  }
  if (!value.characters.every(character => character && typeof character.id === "string" &&
      typeof character.name === "string" && typeof character.role === "string" &&
      typeof character.tone === "string" && typeof character.description === "string")) {
    throw new Error("Invalid character definitions. Nothing was saved.");
  }
  if (!value.glossary.every(term => term && typeof term.id === "string" &&
      typeof term.en === "string" && typeof term.jp === "string" && typeof term.explanation === "string")) {
    throw new Error("Invalid glossary entries. Nothing was saved.");
  }
  return value;
}

function fileKey(id) {
  if (typeof id !== "string" || !id.trim() || id.length > 256) {
    throw new Error("Invalid project ID.");
  }
  return crypto.createHash("sha256").update(id, "utf8").digest("hex");
}

function createProjectStore(userDataDir, options = {}) {
  const projectDir = path.join(userDataDir, "projects");
  const backupDir = path.join(userDataDir, "revisions");
  const now = options.now ?? (() => Date.now());
  // Serializes saves, deletes, and restoration to ensure a stale write cannot
  // finish after a newer one. Window/project autosave may issue concurrent calls.
  let operation = Promise.resolve();
  const enqueue = callback => {
    const result = operation.then(callback);
    operation = result.catch(() => {});
    return result;
  };

  const projectPath = id => path.join(projectDir, fileKey(id) + ".json");
  const backupPrefix = id => fileKey(id) + ".";
  const ensureDirs = () => Promise.all([
    fs.mkdir(projectDir, { recursive: true }),
    fs.mkdir(backupDir, { recursive: true }),
  ]);

  async function readProject(id) {
    const bytes = await fs.readFile(projectPath(id), "utf8");
    if (Buffer.byteLength(bytes, "utf8") > MAX_PROJECT_BYTES) throw new Error("Project exceeds 64 MiB safety limit.");
    const data = validateProject(JSON.parse(bytes));
    if (data.id !== id) throw new Error("Project ID does not match its storage record.");
    return data;
  }

  async function atomicWrite(filename, bytes) {
    const tmp = filename + "." + crypto.randomUUID() + ".tmp";
    let handle;
    try {
      handle = await fs.open(tmp, "wx", 0o600);
      await handle.writeFile(bytes, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(tmp, filename);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  async function revisionFiles(id) {
    await ensureDirs();
    const prefix = backupPrefix(id);
    return (await fs.readdir(backupDir)).filter(name =>
      name.startsWith(prefix) && /^\d{13}\.json$/.test(name.slice(prefix.length))
    ).sort().reverse();
  }

  async function snapshotOldVersion(id, filename, force = false) {
    try {
      const previous = await fs.readFile(filename, "utf8");
      validateProject(JSON.parse(previous));
      const latest = (await revisionFiles(id))[0];
      if (latest) {
        const stamp = Number(latest.slice(backupPrefix(id).length, -5));
        if (!force && now() - stamp < BACKUP_INTERVAL_MS) return;
      }
      let stamp = now();
      let revision = path.join(backupDir, backupPrefix(id) + stamp + ".json");
      while (await fs.stat(revision).then(() => true, () => false)) {
        stamp += 1; revision = path.join(backupDir, backupPrefix(id) + stamp + ".json");
      }
      // Preserve last saved file before replacing it. Use atomic write so
      // incomplete snapshots never appear to be valid revisions.
      await atomicWrite(revision, previous);
      const old = await revisionFiles(id);
      for (const stale of old.slice(MAX_REVISIONS)) await fs.rm(path.join(backupDir, stale));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }

  async function save(project) {
    return enqueue(async () => {
      validateProject(project);
      const bytes = JSON.stringify(project, null, 2);
      if (Buffer.byteLength(bytes, "utf8") > MAX_PROJECT_BYTES) {
        throw new Error("Project exceeds 64 MiB safety limit.");
      }
      await ensureDirs();
      const file = projectPath(project.id);
      await snapshotOldVersion(project.id, file);
      await atomicWrite(file, bytes);
      return { id: project.id, bytes: Buffer.byteLength(bytes, "utf8") };
    });
  }

  async function load(id) {
    await operation;
    try { return await readProject(id); }
    catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function list() {
    await operation;
    await ensureDirs();
    const entries = [];
    const problems = [];
    for (const filename of (await fs.readdir(projectDir)).filter(x => /^[a-f0-9]{64}\.json$/.test(x))) {
      try {
        const body = await fs.readFile(path.join(projectDir, filename), "utf8");
        const p = validateProject(JSON.parse(body));
        if (filename !== fileKey(p.id) + ".json") throw Error("Project identity mismatch");
        entries.push({
          id: p.id,
          name: p.name,
          lines: p.rows.length,
          translated: p.rows.filter(row => row.status === "translated").length,
          lastModified: typeof p.lastModified === "string" ? p.lastModified : "",
        });
      } catch (error) {
        problems.push({ filename, reason: error.message });
      }
    }
    entries.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
    return { entries, problems };
  }

  async function remove(id) {
    return enqueue(async () => {
      await ensureDirs();
      const file = projectPath(id);
      await snapshotOldVersion(id, file, true);
      await fs.rm(file, { force: true });
      return { id };
    });
  }

  async function revisions(id) {
    await operation;
    const names = await revisionFiles(id);
    return names.map(name => ({
      id: name.slice(backupPrefix(id).length, -5),
      at: Number(name.slice(backupPrefix(id).length, -5)),
    }));
  }

  async function restore(id, revisionId) {
    return enqueue(async () => {
      if (typeof revisionId !== "string" || !/^\d{13}$/.test(revisionId)) {
        throw Error("Invalid revision.");
      }
      const name = backupPrefix(id) + revisionId + ".json";
      const bytes = await fs.readFile(path.join(backupDir, name), "utf8");
      const project = validateProject(JSON.parse(bytes));
      if (project.id !== id) throw Error("Revision/project identity mismatch.");
      await snapshotOldVersion(id, projectPath(id), true);
      await atomicWrite(projectPath(id), bytes);
      return project;
    });
  }

  return { save, load, list, remove, revisions, restore, projectDir, backupDir };
}

module.exports = { createProjectStore, validateProject, fileKey };
