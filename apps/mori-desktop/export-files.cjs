"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

/** Remembers output paths for each project/format in this user's separate Mori profile. */
function createExportFiles(userDataDir, chooseSave) {
  const configPath = path.join(userDataDir, "export-destinations.json");
  let operation = Promise.resolve();
  const validId = id => typeof id === "string" && id.length > 0 && id.length < 256;
  const read = async () => {
    try {
      const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  };
  const save = async (request) => {
    if (!validId(request.projectId) || !["json", "csv", "po", "original"].includes(request.format)
      || typeof request.filename !== "string") throw Error("Invalid export destination.");
    const name = path.basename(request.filename).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 110);
    if (!name || name === "." || name === "..") throw Error("Invalid export filename.");
    const payload = typeof request.data === "string" ? Buffer.from(request.data, "utf8")
      : request.data instanceof Uint8Array ? Buffer.from(request.data) : null;
    if (!payload || payload.byteLength > 64 * 1024 * 1024) throw Error("Invalid export data.");
    const all = await read();
    const key = request.projectId + ":" + request.format;
    const previous = typeof all[key] === "string" && path.isAbsolute(all[key]) ? all[key] : null;
    const quick = request.quick === true && !!previous;
    const output = quick ? previous : await chooseSave({
      title: request.format === "original" ? "Export translated original files" : "Export localized interchange",
      defaultPath: previous ?? name,
      filters: request.format === "original" ? [] : [{ name: request.format.toUpperCase(), extensions: [request.format] }],
    });
    if (!output) return null;
    const tmp = output + "." + crypto.randomUUID() + ".tmp";
    try {
      await fs.writeFile(tmp, payload, { flag: "wx" });
      await fs.rename(tmp, output);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
    if (previous !== output) {
      const next = { ...all, [key]: output };
      const configTmp = configPath + "." + crypto.randomUUID() + ".tmp";
      try {
        await fs.writeFile(configTmp, JSON.stringify(next), { flag: "wx" });
        await fs.rename(configTmp, configPath);
      } finally {
        await fs.rm(configTmp, { force: true }).catch(() => {});
      }
    }
    return { filename: path.basename(output), quick };
  };
  return request => {
    const result = operation.then(() => save(request));
    operation = result.catch(() => {});
    return result;
  };
}

module.exports = { createExportFiles };
