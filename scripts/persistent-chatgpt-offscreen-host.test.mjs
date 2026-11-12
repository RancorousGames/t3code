import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("./persistent-chatgpt-offscreen-host.cjs", import.meta.url), "utf8");

function setup() {
  let loading = false;
  let executions = 0;
  const throttling = [];
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isLoadingMainFrame: () => loading,
    getURL: () => "https://chatgpt.com/c/example",
    setBackgroundThrottling: (value) => throttling.push(value),
    mainFrame: { executeJavaScript: async () => { executions++; return 42; } },
    executeJavaScript: async () => { executions++; return 42; },
  });
  class Window extends EventEmitter {
    visible = false;
    contentView = { addChildView() {} };
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
  }
  const electron = {
    app: Object.assign(new EventEmitter(), {
      setPath() {}, requestSingleInstanceLock: () => true,
      whenReady: () => new Promise(() => {}),
    }),
    Menu: { setApplicationMenu() {} },
    BaseWindow: Window,
    WebContentsView: class {
      webContents = contents;
      setBounds() {}
    },
  };
  const context = {
    URL,
    require: (id) => id === "electron" ? electron : id === "node:fs" ? { mkdirSync() {} } : require(id),
    process: { argv: ["electron", "host", "test-v3"], env: { T3_BROWSER_HOST_TOKEN: "a".repeat(64) }, platform: "win32" },
    module: { exports: {} },
  };
  runInNewContext(source + "\nmodule.exports = { createDurableNativePage, evaluatePage, sessions };", context);
  const host = context.module.exports;
  const id = "11111111-1111-1111-1111-111111111111";
  const window = host.createDurableNativePage(id, "test");
  host.sessions.set(id, { window });
  return { host, window, id, throttling, setLoading: (value) => { loading = value; }, executions: () => executions };
}

test("native carrier visibility preserves Chromium background scheduling", () => {
  const { window, throttling } = setup();
  for (let i = 0; i < 20; i++) {
    window.setCarrierVisible(true);
    window.setCarrierVisible(false);
  }
  assert.deepEqual(throttling, []);
});

test("probes during main-frame navigation fail without queuing page-load listeners", async () => {
  const { host, id, setLoading, executions } = setup();
  setLoading(true);
  for (let i = 0; i < 20; i++) {
    await assert.rejects(host.evaluatePage({ sessionId: id, expression: "42" }), /loading/);
  }
  assert.equal(executions(), 0);
  setLoading(false);
  assert.equal((await host.evaluatePage({ sessionId: id, expression: "42" })).result, 42);
});
