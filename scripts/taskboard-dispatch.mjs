#!/usr/bin/env node
// TaskBoard queue dispatch runs inside the T3 desktop process environment.
// Reuse the desktop's configured T3 home rather than assuming the source-tree
// .t3 directory, while keeping all worker creation in the existing T3 bridge.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { controlSessions } from "./chatgpt-sessions.mjs";

export async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, ""));
  const home = typeof input.home === "string" && input.home.trim()
    ? NodePath.resolve(input.home)
    : process.env.T3CODE_HOME
      ? NodePath.resolve(process.env.T3CODE_HOME)
      : NodePath.resolve(process.env.USERPROFILE ?? NodePath.resolve(import.meta.dirname, ".."), ".t3");
  const result = await controlSessions(input, { home });
  process.stdout.write(JSON.stringify(result) + "\n");
}

if (process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
