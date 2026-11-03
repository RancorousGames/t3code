#!/usr/bin/env node
/** Resolve the caller via a marker visible in its ChatGPT browser, never by focused tab. */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newSelfMarker, findSelfMarkerSessions } from "./chatgpt-self-marker.mjs";
import { findToolResultMarkerSessions } from "./chatgpt-react-marker.mjs";

import { controlAddress, sendAppControlRequest } from "./spawn-chatgpt-session.mjs";
import { rebootExistingT3Session } from "./reboot-chatgpt-session.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function identifySelfSession(
  marker,
  { home = path.join(ROOT, ".t3"), exchange = sendAppControlRequest } = {},
) {
  const requestId = randomUUID();
  const response = await exchange(
    controlAddress(home),
    {
      version: 1,
      requestId,
      type: "chatgpt.sessions",
      action: "list",
      which: "all",
      includeHidden: false,
    },
    100000,
  );
  if (
    response?.requestId !== requestId ||
    response.ok !== true ||
    !Array.isArray(response.data?.sessions)
  )
    throw new Error("T3 session list unavailable.");
  // The marker is usually in the PREVIOUS assistant turn: a fresh user turn
  // triggers the tool call, so lastRole/lastText alone cannot identify its sender.
  // Inspect recent assistant turns in existing, mounted guests only.
  const listed = response.data.sessions.filter((s) => s.hidden !== true);
  const inspected = [...listed];
  const candidates = listed.filter(
    (s) =>
      Number(s.totalTurns) > 0 &&
      !["hibernated", "unavailable", "loading", "unloaded"].includes(s.status),
  );
  for (let i = 0; i < candidates.length; i += 4) {
    const batch = await Promise.all(
      candidates.slice(i, i + 4).map(async (s) => {
        const readId = randomUUID();
        try {
          const read = await exchange(
            controlAddress(home),
            {
              version: 1,
              requestId: readId,
              type: "chatgpt.sessions",
              action: "read",
              sessionId: s.id,
              from: "end",
              count: 8,
            },
            30_000,
          );
          if (
            read?.ok === true &&
            read.requestId === readId &&
            Array.isArray(read.data?.session?.messages)
          )
            return { ...s, messages: read.data.session.messages };
        } catch {
          /* An unreadable guest is not the sender. */
        }
        return s;
      }),
    );
    inspected.push(...batch);
  }
  const matches = [...new Set(findSelfMarkerSessions(inspected, marker))];
  if (matches.length > 1) throw new Error("Self marker is ambiguous across T3 browsers.");
  if (matches.length === 1) return matches[0];
  const reactMatches = await findToolResultMarkerSessions(candidates, marker, { home, exchange });
  if (reactMatches.length > 1) throw new Error("Self marker is ambiguous across T3 browsers.");
  if (reactMatches.length === 1) return reactMatches[0];
  throw new Error("Self marker not found in recent assistant turns or React tool state.");
}

/** Two-phase self resolution: marker creation has no side effects on ChatGPT. */
export async function controlSelf(input, ports = {}) {
  if (input?.action === "identify_self")
    return {
      action: "identify_self",
      marker: newSelfMarker(),
      instruction:
        "Show the exact marker in your next assistant reply. Call reboot_self with it in a subsequent turn. Tool-only identification is experimental. Never guess a T3 session ID.",
    };
  if (!["resolve_self", "reboot_self"].includes(input?.action))
    throw new Error("Expected identify_self, resolve_self, or reboot_self.");
  const sessionId = await identifySelfSession(input.marker, ports);
  if (input.action === "resolve_self") return { action: "resolve_self", sessionId };
  if (typeof input.message !== "string" || !input.message.trim())
    throw new Error("reboot_self requires a continuation message.");
  const home = ports.home ?? path.join(ROOT, ".t3");
  const exchange = ports.exchange ?? sendAppControlRequest;
  const requestId = input.requestId ?? randomUUID();
  try {
    const response = await rebootExistingT3Session(
      {
        home,
        sessionId,
        phase: "begin",
        requestId,
        message: input.message,
      },
      { exchange },
    );
    return { ...response, action: "reboot_self", identifiedBy: "guest-marker" };
  } catch (error) {
    // A lost begin acknowledgement is not evidence of failure. Query the SAME
    // request read-only; never submit another reboot or continuation prompt.
    try {
      const status = await rebootExistingT3Session(
        {
          home,
          sessionId,
          phase: "status",
          requestId,
        },
        { exchange },
      );
      return { ...status, action: "reboot_self", identifiedBy: "guest-marker" };
    } catch (statusError) {
      return {
        action: "reboot_self",
        sessionId,
        requestId,
        status: "unknown",
        reason: String(error?.message ?? error),
        statusReason: String(statusError?.message ?? statusError),
      };
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== "--json-stdin") throw new Error("Use --json-stdin.");
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    process.stdout.write(
      JSON.stringify(
        await controlSelf(
          JSON.parse(
            Buffer.concat(chunks)
              .toString("utf8")
              .replace(/^\uFEFF/, ""),
          ),
        ),
      ) + "\n",
    );
  } catch (error) {
    process.stderr.write(String(error?.message ?? error) + "\n");
    process.exitCode = 1;
  }
}
