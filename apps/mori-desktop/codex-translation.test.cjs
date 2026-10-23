"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createCodexTranslator, validateRequest, TRANSLATION_MODEL, REASONING_EFFORT } = require("./codex-translation.cjs");

test("translation model is hard-pinned to Codex Luna 6 low without fallback", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mori-codex-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let captured;
  function spawnMock(executable, args, options) {
    captured = { executable, args, options };
    const p = new EventEmitter();
    p.stdin = new PassThrough();
    p.stdout = new PassThrough();
    p.stderr = new PassThrough();
    p.kill = () => { p.emit("exit", 1, "SIGTERM"); };
    let prompt = "";
    p.stdin.on("data", bytes => { prompt += bytes.toString("utf8"); });
    p.stdin.on("end", () => {
      assert.ok(prompt.includes("Translate"));
      p.stdout.write('{"translations":[{"id":"a","japanese":"こんにちは"}]}');
      p.emit("exit", 0, null);
    });
    return p;
  }
  const adapter = createCodexTranslator({userDataDir:directory,spawnProcess:spawnMock});
  const output = await adapter.translate({mode:"single",ids:["a"],prompt:"Translate Hello"});
  assert.equal(output.model,TRANSLATION_MODEL);
  assert.equal(output.reasoningEffort,REASONING_EFFORT);
  assert.ok(captured.args.includes("gpt-6-luna"));
  assert.ok(captured.args.includes("model_reasoning_effort=low"));
  assert.equal(captured.args[captured.args.indexOf("--sandbox")+1],"read-only");
  assert.ok(captured.args.includes("--ephemeral"));
  assert.ok(captured.args.includes("--ignore-user-config"));
  assert.equal(captured.options.shell,false);
  assert.equal(captured.executable,"codex.exe");
  assert.match(output.text, /こんにちは/);
});

test("invalid requests refuse dispatch", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mori-codex-test-"));
  t.after(() => fs.rm(directory, { recursive:true, force:true }));
  const adapter = createCodexTranslator({userDataDir:directory,spawnProcess:() => { throw Error("Must not spawn"); }});
  await assert.rejects(adapter.translate({mode:"batch",ids:["id","id"],prompt:"hi"}), /Invalid/);
  await assert.rejects(adapter.translate({mode:"single",ids:["id","second"],prompt:"hi"}), /Invalid/);
  await assert.rejects(adapter.translate({mode:"single",ids:["id"],prompt:"X".repeat(31_000)}), /Invalid/);
  assert.throws(() => validateRequest({mode:"single",ids:["a"],prompt:""}), /Invalid/);
});
