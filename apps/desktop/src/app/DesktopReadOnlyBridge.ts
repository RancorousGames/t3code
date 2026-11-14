// @effect-diagnostics nodeBuiltinImport:off -- Windows-only, independently authenticated local transport.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import { execFileSync } from "node:child_process";

import type { DesktopAppActivationRequest, DesktopAppActivationResponse } from "@t3tools/contracts";

/**
 * Read-only alternative to the elevated desktop's named pipe. Windows MIC
 * rejects a normal-integrity OpenRig client writing to a high-integrity pipe.
 * This endpoint does NOT change that pipe's DACL/integrity label, and never
 * brokers sends, creation, focus, mutations, or operator approvals.
 *
 * Its random credential is kept under a per-user Windows ACL, not in a URL,
 * command line, environment variable, or open port discovery response.
 */
const aclScript = `
$ErrorActionPreference = 'Stop'
$path = $env:T3_READONLY_BRIDGE_DIR
$acl = Get-Acl -LiteralPath $path
$acl.SetAccessRuleProtection($true, $false)
foreach ($entry in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($entry) }
$identities = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
foreach ($id in $identities) {
  $sid = New-Object Security.Principal.SecurityIdentifier($id)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
  [void]$acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $path -AclObject $acl
$after = Get-Acl -LiteralPath $path
if (-not $after.AreAccessRulesProtected) { throw 'Bridge ACL still inherits permissions' }
foreach ($entry in $after.Access) {
  if ($entry.AccessControlType -ne 'Allow' -or $entry.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $identities) {
    throw 'Unexpected account in bridge ACL'
  }
}
`;

function privateDirectory(stateDir: string, localAppData: string): string {
  const hash = NodeCrypto.createHash("sha256").update(NodePath.resolve(stateDir)).digest("hex").slice(0, 24);
  return NodePath.join(localAppData, "t3code-readonly-bridge", hash);
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(token, "utf8");
  return provided.length === expected.length && NodeCrypto.timingSafeEqual(provided, expected);
}

export async function startDesktopReadOnlyBridge(input: {
  stateDir: string;
  handle: (request: DesktopAppActivationRequest) => Promise<DesktopAppActivationResponse>;
  /** Allows tests to use an isolated profile, not the real user's app data. */
  localAppData?: string;
}): Promise<{ close(): Promise<void> }> {
  if (process.platform !== "win32") return { close: async () => undefined };
  const localAppData = input.localAppData ?? process.env.LOCALAPPDATA;
  if (!localAppData || !NodePath.isAbsolute(localAppData))
    throw new Error("LOCALAPPDATA unavailable; read-only cross-integrity transport disabled.");
  const directory = privateDirectory(input.stateDir, localAppData);
  await NodeFSP.mkdir(directory, { recursive: true });
  const stat = await NodeFSP.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Bridge directory is not a real directory.");
  // Fail closed on ACL failure rather than silently exposing ChatGPT inventory.
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", aclScript], {
    env: { ...process.env, T3_READONLY_BRIDGE_DIR: directory },
    windowsHide: true, timeout: 10_000, stdio: "pipe",
  });

  const token = NodeCrypto.randomBytes(32).toString("hex");
  const server = NodeHttp.createServer((req, res) => {
    const reject = (code: number) => { res.writeHead(code); res.end(); };
    if (req.method !== "POST" || req.url !== "/snapshot" || req.headers.origin ||
        req.headers["sec-fetch-site"] || !authorized(req.headers.authorization, token))
      return reject(403);
    // Never accept a command body: the only permitted request is a bounded
    // read-only ChatGPT inventory. No socket client's role claim is trusted.
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (part: string) => {
      body += part;
      if (body.length > 512) req.destroy();
    });
    req.on("end", () => {
      let request: unknown;
      try { request = JSON.parse(body); } catch { return reject(400); }
      const item = request as Partial<DesktopAppActivationRequest> | null;
      if (!item || typeof item !== "object" || Object.keys(item).some(key =>
          !["version", "requestId", "type", "action", "which", "includeHidden"].includes(key)) ||
          item.version !== 1 || item.type !== "chatgpt.sessions" ||
          item.action !== "list" || typeof item.requestId !== "string" ||
          !/^[a-f0-9-]{36}$/i.test(item.requestId) ||
          !["all", "visible", "recent", "working", "blocked"].includes(item.which ?? "") ||
          typeof item.includeHidden !== "boolean")
        return reject(400);
      void input.handle(item as DesktopAppActivationRequest).then((result) => {
        if (res.destroyed) return;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify(result));
      }, () => reject(503));
    });
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No TCP port for read-only bridge.");
    const descriptor = NodePath.join(directory, "endpoint.json");
    const staging = NodePath.join(directory, `endpoint.${process.pid}.${NodeCrypto.randomUUID()}.tmp`);
    // The directory is ACL-protected BEFORE a bearer credential exists in it.
    NodeFS.writeFileSync(staging, JSON.stringify({ version: 1, port: address.port, token }), { flag: "wx" });
    try { NodeFS.renameSync(staging, descriptor); }
    finally { if (NodeFS.existsSync(staging)) NodeFS.unlinkSync(staging); }
    return { close: async () => {
      // Do not remove a newer instance's discovery record on a late shutdown.
      try {
        const stored = JSON.parse(NodeFS.readFileSync(descriptor, "utf8")) as { token?: string };
        if (stored.token === token) NodeFS.unlinkSync(descriptor);
      } catch { /* no descriptor to remove */ }
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    } };
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  }
}
