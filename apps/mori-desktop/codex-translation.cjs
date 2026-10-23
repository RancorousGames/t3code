"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const TRANSLATION_MODEL = "gpt-6-luna";
const REASONING_EFFORT = "low";
const MAX_PROMPT = 30_000;
const MAX_RESPONSE = 75_000;
const MAX_STDERR = 3_000;
const TIMEOUT = 150_000;
const MAX_LINES = 5;

function validateRequest(request) {
  if (!request || typeof request !== "object" || !["single", "batch"].includes(request.mode) ||
      typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.length > MAX_PROMPT ||
      !Array.isArray(request.ids) || !request.ids.length || request.ids.length > MAX_LINES ||
      !request.ids.every(id => typeof id === "string" && !!id && id.length < 300) ||
      new Set(request.ids).size !== request.ids.length ||
      (request.mode === "single" && request.ids.length !== 1)) {
    throw Error("Invalid Codex translation request. Nothing sent.");
  }
}

function createCodexTranslator({ userDataDir, spawnProcess = spawn, timeoutMs = TIMEOUT, executable = "codex.exe" }) {
  let running = false;
  return {
    getConfig: () => ({ provider: "codex-subscription", model: TRANSLATION_MODEL, reasoningEffort: REASONING_EFFORT, available: true }),
    async translate(request) {
      validateRequest(request);
      if (running) throw Error("A Codex translation is already running. Wait for it to finish.");
      running = true;
      const workdir = path.join(userDataDir, "translation-sandbox");
      // A dedicated empty cwd, never the T3 repo or user translation files.
      const output = path.join(workdir, randomUUID() + ".txt");
      const args = [
        "exec", "-m", TRANSLATION_MODEL, "-c", "model_reasoning_effort=low",
        "--sandbox", "read-only", "--ephemeral", "--ignore-user-config",
        "--skip-git-repo-check", "--color", "never", "-C", workdir,
        "-o", output, "-",
      ];
      let timer, child, outputBuffer = "", errorBuffer = "";
      try {
        await fs.mkdir(workdir, { recursive: true });
        const code = await new Promise((resolve, reject) => {
          child = spawnProcess(executable, args, {
            cwd: workdir, windowsHide: true, shell: false,
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, NO_COLOR: "1" },
          });
          child.once("error", reject);
          child.stdin?.on("error", () => { /* The CLI may exit before stdin closes. */ });
          child.stdout?.on("data", buffer => {
            outputBuffer += buffer.toString("utf8");
            if (Buffer.byteLength(outputBuffer) > MAX_RESPONSE) {
              child.kill();
              reject(Error("Codex output exceeded safety limit."));
            }
          });
          child.stderr?.on("data", buffer => {
            // Never surface logs that could include the prompt or auth diagnostics.
            errorBuffer = (errorBuffer + buffer.toString("utf8")).slice(-MAX_STDERR);
          });
          child.once("exit", (code, signal) => {
            if (code === 0) resolve(code);
            else reject(Error(signal ? "Codex translation stopped unexpectedly." :
              /429 Too Many Requests|rate limit|exceeded retry limit/i.test(errorBuffer)
                ? "Codex Luna 6 (low) subscription is rate-limited (HTTP 429). No fallback or automatic retry was attempted."
                : "Codex translation failed. Ensure Codex is installed and logged into the translator's subscription."));
          });
          timer = setTimeout(() => {
            child.kill();
            reject(Error("Codex translation timed out. No drafts were changed."));
          }, timeoutMs);
          child.stdin?.end(request.prompt + "\n");
        });
        if (code !== 0) throw Error("Codex did not complete translation.");
        const text = await fs.readFile(output, "utf8").catch(() => outputBuffer);
        if (!text.trim() || text.length > MAX_RESPONSE) throw Error("Codex returned no usable reply.");
        return { text, model: TRANSLATION_MODEL, reasoningEffort: REASONING_EFFORT, ids: request.ids, mode: request.mode };
      } finally {
        clearTimeout(timer);
        await fs.rm(output, { force: true }).catch(() => {});
        running = false;
      }
    },
  };
}

module.exports = { createCodexTranslator, validateRequest, TRANSLATION_MODEL, REASONING_EFFORT };
