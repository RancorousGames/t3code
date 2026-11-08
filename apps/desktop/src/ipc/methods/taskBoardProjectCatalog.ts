// @effect-diagnostics nodeBuiltinImport:off -- TaskBoard catalog lives on the desktop.
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";
import { boardRoots } from "./taskBoardHumanInboxIpc.ts";

export interface TaskBoardProjectDefinition {
  readonly key: string;
  readonly title: string;
  /** Including trailing dash: WT-, WTE-, OTF-, ... */
  readonly prefixes: readonly string[];
}

const idPrefix = /^[A-Z][A-Z0-9]{1,11}$/;

export function parseTaskBoardProjectMetadata(
  board: string,
  folderName: string,
  activeFilenames: readonly string[],
): { title: string; prefixes: string[] } {
  const field = (name: string) =>
    board.match(new RegExp("^" + name + ":\\s*(.+?)\\s*$", "mi"))?.[1]
      ?.trim().replace(/^["']|["']$/g, "") ?? "";
  const rawTitle = field("name");
  // Generic starter-board titles are not project identities.
  const title = rawTitle && rawTitle.toLowerCase() !== "taskboard"
    ? rawTitle : folderName;
  const declared = [field("task_prefix"), field("epic_prefix")]
    .map((part) => part.toUpperCase().replace(/-$/, ""))
    .filter((part) => idPrefix.test(part));
  const counts = new Map<string, number>();
  for (const filename of activeFilenames) {
    const match = /^([A-Z][A-Z0-9]{1,11})-\d+(?:\b|\.)/i.exec(filename);
    if (!match) continue;
    const prefix = match[1]!.toUpperCase();
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  // An imported task may retain its foreign ID (e.g. WT- files on OmniHub).
  // Prefer authoritative declared prefixes. For legacy boards with no prefix,
  // take only the dominant native family and its optional E/epic variant.
  const dominant = [...counts].sort((a, b) => b[1] - a[1])[0];
  const discovered = declared.length > 0 || !dominant || dominant[1] / total < 0.5
    ? []
    : [dominant[0], ...(counts.has(dominant[0] + "E") ? [dominant[0] + "E"] : [])];
  return {
    title,
    prefixes: [...new Set([...declared, ...discovered])].map((prefix) => prefix + "-"),
  };
}

const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "");
export async function readTaskBoardProjectCatalog(): Promise<TaskBoardProjectDefinition[]> {
  const projects = new Map<string, TaskBoardProjectDefinition>();
  for (const root of await boardRoots()) {
    try {
      const board = await Fs.readFile(Path.join(root, "_board.md"), "utf8");
      const parent = Path.basename(Path.dirname(root));
      const activeFilenames = await Fs.readdir(Path.join(root, "Active")).catch(() => []);
      const metadata = parseTaskBoardProjectMetadata(board, parent, activeFilenames);
      if (!metadata.title.trim()) continue;
      const key = "taskboard:" + slug(metadata.title);
      const previous = projects.get(key);
      projects.set(key, {
        key,
        title: previous?.title ?? metadata.title,
        prefixes: [...new Set([...(previous?.prefixes ?? []), ...metadata.prefixes])],
      });
    } catch { /* A board being temporarily unavailable must not drop all other boards. */ }
  }
  return [...projects.values()];
}

const taskBoardProjectSchema = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  prefixes: Schema.Array(Schema.String),
});

export const readTaskBoardProjectsIpc = DesktopIpc.makeIpcMethod({
  channel: Channels.TASKBOARD_PROJECTS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(taskBoardProjectSchema),
  handler: Effect.fn("desktop.ipc.readTaskBoardProjects")(function* () {
    return yield* Effect.promise(readTaskBoardProjectCatalog);
  }),
});
