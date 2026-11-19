#!/usr/bin/env node
import { runSwarm } from "../apps/server/src/swarm/index.mjs";
import { swarmCliTransports } from "../apps/server/src/swarm/cliTransport.mjs";

const enabled = process.argv.includes("--enable") || process.env.T3_SWARM_ENABLED === "1";
if (
  process.argv.some(
    (arg) => !["--enable"].includes(arg) && arg !== process.argv[0] && arg !== process.argv[1],
  )
) {
  console.error("Usage: <request.json | node scripts/swarm.mjs [--enable]");
  process.exitCode = 1;
} else {
  try {
    let payload = "";
    for await (const chunk of process.stdin) {
      payload += chunk;
      if (payload.length > 64 * 1024) throw new Error("Swarm request exceeds 64 KiB");
    }
    if (!payload.trim())
      throw new Error("Send one JSON request over stdin; see apps/server/src/swarm/README.md");
    process.stdout.write(
      JSON.stringify(
        await runSwarm(JSON.parse(payload.replace(/^\uFEFF/, "")), {
          enabled,
          transports: swarmCliTransports,
        }),
      ) + "\n",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
