import { describe, expect, it } from "vite-plus/test";
import { parseTaskBoardProjectMetadata } from "./taskBoardProjectCatalog.ts";

describe("TaskBoard project identity extraction", () => {
  it("detects Wartribes WT- and WTE- identifiers without task_prefix configuration", () => {
    const project = parseTaskBoardProjectMetadata(
      "---\nschema: 1\nname: Wartribes\ncolumns:\n- id: draft\n",
      "Wartribes",
      ["WT-0001.md", "WT-0002.md", "WTE-0003.md", "WTE-0004.md", "text.md"],
    );
    expect(project).toEqual({ title: "Wartribes", prefixes: ["WT-", "WTE-"] });
  });

  it("uses the declared task and epic prefixes even if no active tasks exist", () => {
    expect(parseTaskBoardProjectMetadata(
      "---\nname: Order of the Fallen\ntask_prefix: OTF\nepic_prefix: OTFE\n",
      "OrderOfTheFallen",
      [],
    )).toEqual({ title: "Order of the Fallen", prefixes: ["OTF-", "OTFE-"] });
  });

  it("does not attach imported foreign task prefixes to a declared board", () => {
    const names = [
      ...Array.from({ length: 24 }, (_, i) => `OMNI-${String(i).padStart(4, "0")}.md`),
      ...Array.from({ length: 7 }, (_, i) => `WT-${String(i).padStart(4, "0")}.md`),
      "WTE-0004.md", "WTE-0005.md",
    ];
    expect(parseTaskBoardProjectMetadata(
      "---\nname: Omni\ntask_prefix: OMNI\nepic_prefix: OMNIE\n",
      "OmniHub", names,
    ).prefixes).toEqual(["OMNI-", "OMNIE-"]);
  });

  it("does not mistake a generic starter-board name or stray foreign task for a project identity", () => {
    expect(parseTaskBoardProjectMetadata(
      "---\nname: TaskBoard\n",
      "Omnish",
      ["FOO-0001.md", "FOO-0002.md", "WT-0001.md"],
    )).toEqual({ title: "Omnish", prefixes: ["FOO-"] });
  });
});
