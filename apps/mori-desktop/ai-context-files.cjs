"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const ALLOWED = new Set([
  "INSTRUCTIONS.md", "PROJECT_CONTEXT.md", "CHARACTERS.md",
  "GLOSSARY.md", "BATCH_REQUEST.json",
]);

/** Materialize an immutable task snapshot for inspection/debugging.
 * Never accept a path or a filename outside the app's allowlist.
 * The ChatGPT browser still receives the actual file contents inline. */
function createChatBatchFileStore(userDataDir) {
  const root = path.join(userDataDir, "ai-translation");
  return async function saveChatBatchFiles(request) {
    if (!request || typeof request !== "object" ||
        typeof request.projectId !== "string" || request.projectId.length > 256 ||
        !request.projectId.trim() ||
        typeof request.requestId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f-]{27,50}$/i.test(request.requestId) ||
        !Array.isArray(request.files) || request.files.length < 3 || request.files.length > 5 ||
        !Array.isArray(request.ids) || !request.ids.length || request.ids.length > 5) {
      throw Error("Invalid AI batch file request.");
    }
    const names = new Set();
    let total = 0;
    for (const file of request.files) {
      if (!file || !ALLOWED.has(file.name) || names.has(file.name) ||
          typeof file.content !== "string") throw Error("Invalid AI batch file.");
      total += Buffer.byteLength(file.content, "utf8");
      names.add(file.name);
    }
    if (!names.has("INSTRUCTIONS.md") || !names.has("PROJECT_CONTEXT.md") ||
        !names.has("BATCH_REQUEST.json") || total > 96 * 1024) {
      throw Error("AI batch files are missing or too large.");
    }
    if (request.ids.some(id => typeof id !== "string" || !id || id.length > 256) ||
        new Set(request.ids).size !== request.ids.length) {
      throw Error("Invalid AI batch IDs.");
    }
    const payload = JSON.parse(request.files.find(x => x.name === "BATCH_REQUEST.json").content);
    if (payload.projectId !== request.projectId || payload.requestId !== request.requestId ||
        !Array.isArray(payload.lines) || payload.lines.length !== request.ids.length ||
        payload.lines.some((line, index) => line?.id !== request.ids[index] || typeof line.english !== "string")) {
      throw Error("AI batch JSON identity does not match the request.");
    }
    const projectKey = crypto.createHash("sha256").update(request.projectId).digest("hex");
    const folder = path.join(root, projectKey, request.requestId);
    await fs.mkdir(folder, { recursive: true });
    const manifest = {
      requestId: request.requestId,
      projectId: request.projectId,
      createdAt: new Date().toISOString(),
      files: request.files.map(file => ({
        name: file.name,
        sha256: crypto.createHash("sha256").update(file.content).digest("hex"),
      })),
    };
    for (const file of [...request.files, { name: "MANIFEST.json", content: JSON.stringify(manifest, null, 2) }]) {
      const filename = path.join(folder, file.name);
      const tmp = filename + "." + crypto.randomUUID() + ".tmp";
      try {
        await fs.writeFile(tmp, file.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await fs.rename(tmp, filename);
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => {});
      }
    }
    return { folder, files: manifest.files.map(x => x.name), requestId: request.requestId };
  };
}

module.exports = { createChatBatchFileStore };
