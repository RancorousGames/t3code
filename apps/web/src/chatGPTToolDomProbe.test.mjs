import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { probeChatGPTToolDom } from "./chatGPTToolDomProbe.ts";

const marker = "T3_SELF_0123456789ABCDEF0123456789ABCDEF";
const original = {
  document: globalThis.document,
  location: globalThis.location,
  Node: globalThis.Node,
};
afterEach(() => {
  for (const [k, v] of Object.entries(original))
    if (v === undefined) delete globalThis[k];
    else globalThis[k] = v;
});
function guest(state, host = "chatgpt.com") {
  const el = { ["__reactFiber$test"]: state };
  globalThis.document = { querySelectorAll: () => [el] };
  globalThis.location = { hostname: host };
  globalThis.Node = class {};
}
test("detects a marker in tool-only React data without returning the marker", () => {
  guest({ memoizedState: { result: { content: [{ text: marker }] } } });
  const found = probeChatGPTToolDom(marker);
  assert.equal(found.markerFound, true);
  assert.equal(JSON.stringify(found).includes(marker), false);
});

test("ignores unrelated markers and untrusted origins", () => {
  guest({ memoizedState: { tool: { content: "T3_SELF_FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF" } } });
  assert.equal(probeChatGPTToolDom(marker).markerFound, false);
  guest({ memoizedState: { tool: { content: marker } } }, "unrelated.example");
  assert.equal(probeChatGPTToolDom(marker).supported, false);
});
test("does not return marker text to the host", () => {
  guest({ memoizedProps: { toolResult: marker } });
  const result = probeChatGPTToolDom();
  assert.equal(result.markerFound, true);
  assert.ok(!JSON.stringify(result).includes(marker));
});

test("rejects markers already present in rendered conversation text", () => {
  guest({ memoizedProps: { toolResult: marker } });
  globalThis.document.body = { textContent: "User quoted " + marker };
  const result = probeChatGPTToolDom(marker);
  assert.equal(result.markerFound, false);
  assert.equal(result.reason, "rendered_marker");
});
