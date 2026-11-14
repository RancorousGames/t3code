// Read-only loopback alternative for Windows MIC EPERM to an elevated T3 pipe.
// No mutation, guest wake, or queue send may use this endpoint.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

export function isPipeUnavailable(error) {
  return ["EPERM", "EACCES", "ENOENT", "ECONNREFUSED"].includes(error?.code);
}

export function descriptorPath(home, localAppData = process.env.LOCALAPPDATA) {
  if (!localAppData || !NodePath.isAbsolute(localAppData))
    throw new Error("LOCALAPPDATA unavailable");
  const stateDir = NodePath.resolve(home, "userdata");
  const hash = NodeCrypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 24);
  return NodePath.join(localAppData, "t3code-readonly-bridge", hash, "endpoint.json");
}

/** Returns the ordinary T3 correlation envelope, but from a non-mutating endpoint. */
export async function readSnapshotAcrossIntegrity(home, request, timeoutMs = 4_000) {
  if (request?.type !== "chatgpt.sessions" || request.action !== "list")
    throw new Error("Cross-integrity fallback supports only a read-only session list");
  const descriptor = JSON.parse(NodeFS.readFileSync(descriptorPath(home), "utf8"));
  if (descriptor.version !== 1 || !Number.isInteger(descriptor.port) ||
      descriptor.port < 1 || descriptor.port > 65535 ||
      typeof descriptor.token !== "string" || !/^[a-f0-9]{64}$/.test(descriptor.token))
    throw new Error("T3 read-only bridge descriptor is invalid");
  return new Promise((resolve, reject) => {
    const client = NodeHttp.request({
      hostname: "127.0.0.1", port: descriptor.port, path: "/snapshot", method: "POST",
      headers: {
        Authorization: `Bearer ${descriptor.token}`,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      agent: false,
      timeout: timeoutMs,
    }, (res) => {
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.length > 2_000_000) client.destroy(new Error("T3 snapshot exceeded limit"));
      });
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`T3 snapshot refused (HTTP ${res.statusCode})`));
        let payload;
        try { payload = JSON.parse(buffer); } catch { return reject(new Error("Invalid T3 snapshot JSON")); }
        if (payload?.version !== 1 || payload.requestId !== request.requestId)
          return reject(new Error("T3 snapshot correlation mismatch"));
        resolve(payload);
      });
    });
    client.once("error", reject);
    client.once("timeout", () => client.destroy(new Error("T3 read-only snapshot timed out")));
    client.end(JSON.stringify(request));
  });
}
