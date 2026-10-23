import assert from "node:assert/strict";
import { test } from "node:test";
import { assignBinding, defaultBindings, keyLabel, keyString, matchAction } from "./shortcuts.ts";

const press = (key: string, modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) => ({
  key,
  ctrlKey: !!modifiers.ctrl,
  metaKey: false,
  altKey: !!modifiers.alt,
  shiftKey: !!modifiers.shift,
});

test("builds the stored form of a key press and ignores lone modifiers", () => {
  assert.equal(keyString(press("a", { ctrl: true, shift: true })), "Ctrl+Shift+A");
  assert.equal(keyString(press("ArrowDown", { alt: true })), "Alt+ArrowDown");
  assert.equal(keyString(press(" ")), "Space");
  assert.equal(keyString(press("Shift", { shift: true })), null);
});

test("labels arrows and escape in the same way the key caps show them", () => {
  assert.equal(keyLabel("Alt+ArrowDown"), "Alt+↓");
  assert.equal(keyLabel("Escape"), "Esc");
});

test("matches a key press to its action through the current bindings", () => {
  const bindings = defaultBindings();
  assert.equal(matchAction(bindings, "Ctrl+K"), "palette");
  assert.equal(matchAction(bindings, "Ctrl+J"), undefined);
});

test("rebinding a key already used swaps the two actions", () => {
  const bindings = defaultBindings();
  const result = assignBinding(bindings, "lock", "Ctrl+K");
  assert.equal(result.bindings.lock, "Ctrl+K");
  assert.equal(result.bindings.palette, "Ctrl+L");
  assert.equal(result.swappedWith?.id, "palette");
});

test("only Ctrl or Alt chords and F-keys can be bound, so typing is never intercepted", () => {
  const bindings = defaultBindings();
  assert.match(assignBinding(bindings, "next", "J").error ?? "", /Ctrl or Alt/);
  assert.equal(assignBinding(bindings, "next", "F5").error, undefined);
  assert.equal(assignBinding(bindings, "next", "Shift+F5").error, undefined);
});
