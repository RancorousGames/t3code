// @effect-diagnostics nodeBuiltinImport:off -- Local fixture matches the OMCPT-owned filesystem handoff.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { readLocalChatGPTBootstrapTitle } from "./chatGPTBootstrapTitle.ts";

const id = "6d50bdf7-bc79-4a94-a938-657f65ee390e";

describe("Bootstrap title registry handoff", () => {
  it("reads the exact ID/title record from OMCPT's shared path, without guessing browser IDs", () => {
    const temp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bootstrap-title-"));
    try {
      const dir = NodePath.join(temp, "OmniHub", "BootstrapTitles");
      NodeFS.mkdirSync(dir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, `${id}.json`), JSON.stringify({ id, title: "Persisted task title" }));
      expect(readLocalChatGPTBootstrapTitle(id, temp)).toBe("Persisted task title");
      expect(readLocalChatGPTBootstrapTitle("not-a-uuid", temp)).toBeNull();
      expect(readLocalChatGPTBootstrapTitle("11111111-1111-4111-8111-111111111111", temp)).toBeNull();
    } finally {
      NodeFS.rmSync(temp, { recursive: true, force: true });
    }
  });
});
