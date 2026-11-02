import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBrowserHost, requestBrowserHost } from "./persistent-chatgpt-browser-host.mjs";

test("a live browser page survives loss and recreation of the caller connection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3-browser-host-test-"));
  let opened = 0;
  let closed = 0;
  const context = {
    async newPage() {
      opened++;
      const page = new EventEmitter();
      let gone = false;
      page.url = () => "about:blank";
      page.isClosed = () => gone;
      page.close = async () => { gone = true; page.emit("close"); };
      page.goto = async () => { throw new Error("unexpected navigation"); };
      return page;
    },
    async close() { closed++; },
  };
  const host = createBrowserHost({ dataDirectory: dir, launch: async () => context });
  try {
    const { socketPath, instanceId } = await host.start();
    // Each API request uses a new independent client connection.
    const first = await requestBrowserHost(socketPath, "POST", "/sessions/attach",
      { sessionId: "chat-1", initialUrl: "about:blank" });
    assert.equal(first.reused, false);
    const health = await requestBrowserHost(socketPath, "GET", "/health");
    assert.equal(health.instanceId, instanceId);
    assert.equal(health.liveSessions, 1);
    const second = await requestBrowserHost(socketPath, "POST", "/sessions/attach",
      { sessionId: "chat-1", initialUrl: "about:blank" });
    assert.equal(second.reused, true);
    assert.equal(opened, 1);
    assert.equal((await requestBrowserHost(socketPath, "GET", "/sessions")).sessions.length, 1);
  } finally {
    await host.stop();
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(closed, 1);
});

test("concurrent attach requests create just one browser page", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3-browser-host-race-"));
  let opened = 0;
  const host = createBrowserHost({ dataDirectory: dir, launch: async () => ({
    async newPage() {
      opened++;
      await new Promise((resolve) => setTimeout(resolve, 15));
      const page = new EventEmitter();
      let closed = false;
      page.url = () => "about:blank";
      page.isClosed = () => closed;
      page.close = async () => { closed = true; page.emit("close"); };
      return page;
    },
    async close() {},
  }) });
  try {
    const { socketPath } = await host.start();
    const results = await Promise.all(Array.from({ length: 6 }, () =>
      requestBrowserHost(socketPath, "POST", "/sessions/attach",
        { sessionId: "same", initialUrl: "about:blank" })));
    assert.equal(opened, 1);
    assert.equal(results.filter((result) => result.reused === false).length, 1);
    assert.equal(results.filter((result) => result.reused === true).length, 5);
  } finally {
    await host.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("headless ChatGPT transport renders frames, accepts input and retains the same page", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3-browser-host-embedded-"));
  const uuid = "f9e86a16-d8c2-4dc3-b911-4ec04ab4c70a";
  const inputs = [];
  let created = 0;
  let dimensions = { width: 1280, height: 800 };
  const page = new EventEmitter();
  page.url = () => "https://chatgpt.com/c/f9e86a16-d8c2-4dc3-b911-4ec04ab4c70a";
  page.isClosed = () => false;
  page.goto = async () => {};
  page.close = async () => {};
  page.viewportSize = () => dimensions;
  page.setViewportSize = async (next) => { dimensions = next; };
  page.screenshot = async () => Buffer.from("mock-jpeg");
  page.context = () => ({
    newCDPSession: async () => ({
      send: async () => ({ metrics: [] }),
      detach: async () => {},
    }),
  });
  page.mouse = {
    move: async (...args) => { inputs.push(["move", ...args]); },
    down: async (...args) => { inputs.push(["down", ...args]); },
    up: async (...args) => { inputs.push(["up", ...args]); },
    wheel: async (...args) => { inputs.push(["wheel", ...args]); },
  };
  page.keyboard = {
    insertText: async (value) => { inputs.push(["text", value]); },
    down: async (value) => { inputs.push(["keyDown", value]); },
    up: async (value) => { inputs.push(["keyUp", value]); },
    press: async (value) => { inputs.push(["press", value]); },
  };
  page.evaluate = async (fn, code) => code === "1 + 1" ? 2 : null;
  const host = createBrowserHost({ dataDirectory: dir, launch: async () => ({
    async newPage() { created++; return page; },
    async close() {},
  }) });
  try {
    const { socketPath } = await host.start();
    await requestBrowserHost(socketPath, "POST", "/sessions/attach", { sessionId: uuid, initialUrl: "https://chatgpt.com/" });
    const frame = await requestBrowserHost(socketPath, "POST", "/sessions/frame", { sessionId: uuid, width: 720, height: 480 });
    assert.equal(frame.jpeg, Buffer.from("mock-jpeg").toString("base64"));
    await requestBrowserHost(socketPath, "POST", "/sessions/input", { sessionId: uuid, input: { type: "text", text: "hello" } });
    const result = await requestBrowserHost(socketPath, "POST", "/sessions/evaluate", { sessionId: uuid, expression: "1 + 1" });
    assert.equal(result.result, 2);
    const attached = await requestBrowserHost(socketPath, "POST", "/sessions/attach", { sessionId: uuid, initialUrl: "https://chatgpt.com/" });
    assert.equal(attached.reused, true);
    assert.equal(created, 1);
    assert.deepEqual(inputs, [["text", "hello"]]);
    assert.deepEqual(dimensions, { width: 720, height: 480 });
  } finally {
    await host.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
