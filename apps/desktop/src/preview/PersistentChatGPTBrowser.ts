// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Independent OS browser broker boundary.
// Broker for T3-managed ChatGPT pages. All pages are owned by one independent
// v3 process and survive T3 restarts; T3 presents them as owned windows.
import * as Crypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFs from "node:fs";
import { spawn } from "node:child_process";
import { session } from "electron";
import { setTimeout as delay } from "node:timers/promises";

const dataDir = () =>
  NodePath.join(
    process.env.APPDATA ?? NodePath.join(NodeOS.homedir(), ".config"),
    "t3code-custom",
    // Keep the previous host alive until its currently resident pages close.
    // A versioned host lets updated Chromium code start without destroying
    // live ChatGPT documents owned by the earlier detached process.
    "persistent-browser-host-v3",
  );
// Keep in step with HOST_PROTOCOL in scripts/persistent-chatgpt-offscreen-host.cjs.
const HOST_PROTOCOL = 5;
let cachedToken: string | null = null;
const tokenFor = (directory: string): string => {
  if (cachedToken) return cachedToken;
  NodeFs.mkdirSync(directory, { recursive: true });
  const file = NodePath.join(directory, "owner-token");
  try {
    NodeFs.writeFileSync(file, Crypto.randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const token = NodeFs.readFileSync(file, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Persistent Chromium token is invalid");
  cachedToken = token;
  return token;
};
const socketFor = (dir: string) => {
  const hash = Crypto.createHash("sha256")
    .update(NodePath.resolve(dir).toLowerCase())
    .digest("hex")
    .slice(0, 16);
  return process.platform === "win32"
    ? "\\\\.\\pipe\\t3code-browser-host-" + hash
    : NodePath.join(NodeOS.tmpdir(), "t3code-browser-host-" + hash + ".sock");
};
const request = async (
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const req = NodeHttp.request(
      {
        socketPath,
        method,
        path,
        timeout: 15_000,
        headers: {
          authorization: "Bearer " + tokenFor(dataDir()),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
      },
      (res) => {
        let response = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          response += chunk;
          if (response.length > 3_000_000) req.destroy(new Error("Frame too large"));
        });
        res.on("end", () => {
          try {
            const data = JSON.parse(response) as { error?: string };
            if (res.statusCode !== 200)
              reject(new Error(data.error ?? "Browser host request failed"));
            else resolve(data);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.once("error", reject);
    req.once("timeout", () => req.destroy(new Error("Browser host timed out")));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });

/** Things the host tells T3, because Windows delivers input straight to the page. */
export type PersistentChatGPTHostEvent =
  | { type: "close-requested"; sessionId: string }
  | { type: "interaction"; sessionId: string }
  | {
      type: "key";
      sessionId: string;
      input: {
        type: "keyDown";
        key: string;
        code: string;
        control: boolean;
        meta: boolean;
        shift: boolean;
        alt: boolean;
        isAutoRepeat: boolean;
      };
    };
let hostEventListener: ((event: PersistentChatGPTHostEvent) => void) | null = null;
export const onPersistentChatGPTHostEvent = (
  listener: (event: PersistentChatGPTHostEvent) => void,
): void => {
  hostEventListener = listener;
};

// One stream per host. Holding it open also tells the host when T3 has died, so
// it can hide the on-screen page. If it drops, the next request reopens it.
let eventStream: NodeHttp.ClientRequest | null = null;
const subscribeToHostEvents = (socketPath: string): void => {
  if (eventStream) return;
  const req = NodeHttp.request(
    {
      socketPath,
      method: "GET",
      path: "/events",
      headers: { authorization: "Bearer " + tokenFor(dataDir()) },
    },
    (res) => {
      let buffered = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines)
          hostEventListener?.(JSON.parse(line) as PersistentChatGPTHostEvent);
      });
      res.once("close", () => {
        if (eventStream === req) eventStream = null;
      });
    },
  );
  req.once("error", () => {
    if (eventStream === req) eventStream = null;
  });
  req.end();
  eventStream = req;
};

/** Stop a host running older code. Its pages are recreated from their URLs on
 * the next attach. The pid comes from the authenticated pipe, so it is that host. */
const retireOutdatedHost = async (pipe: string, pid: number | undefined): Promise<void> => {
  await request(pipe, "POST", "/shutdown").catch(() => undefined);
  if (!pid) return;
  const running = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let waited = 0; running() && waited < 5_000; waited += 100) await delay(100);
  if (running()) process.kill(pid);
  for (let waited = 0; running() && waited < 2_000; waited += 100) await delay(100);
};

let launching: Promise<string> | null = null;
const ensure = (): Promise<string> => {
  if (launching) return launching;
  launching = (async () => {
    const dir = dataDir();
    const pipe = socketFor(dir);
    try {
      const health = (await request(pipe, "GET", "/health")) as { protocol?: number; pid?: number };
      if (health.protocol === HOST_PROTOCOL) return pipe;
      await retireOutdatedHost(pipe, health.pid);
    } catch (error) {
      if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException)?.code ?? ""))
        throw error;
    }
    const root = NodePath.resolve(__dirname, "../../..");
    const script = NodePath.join(root, "scripts", "persistent-chatgpt-offscreen-host.cjs");
    const electronBinary = NodePath.join(
      root,
      "apps",
      "desktop",
      "node_modules",
      "electron",
      "dist",
      process.platform === "win32" ? "electron.exe" : "electron",
    );
    if (!NodeFs.existsSync(script) || !NodeFs.existsSync(electronBinary))
      throw new Error("Dedicated offscreen Chromium runtime is not installed");
    NodeFs.mkdirSync(dir, { recursive: true });
    const fd = NodeFs.openSync(NodePath.join(dir, "browser-host.log"), "a");
    try {
      const child = spawn(electronBinary, [script, dir], {
        cwd: root,
        detached: true,
        windowsHide: true,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE"),
          ),
          T3_BROWSER_HOST_TOKEN: tokenFor(dir),
        },
        stdio: ["ignore", fd, fd],
      });
      child.unref();
    } finally {
      NodeFs.closeSync(fd);
    }
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      await delay(100);
      try {
        await request(pipe, "GET", "/health");
        return pipe;
      } catch (error) {
        if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException)?.code ?? ""))
          throw error;
      }
    }
    throw new Error("Persistent Chromium process could not start");
  })().catch((error) => {
    launching = null;
    throw error;
  });
  return launching;
};

// Transfer sign-in only from the exact environment/profile partition. Newer native
// ChatGPT pages use t3-stable-chatgpt; the preview partition remains a migration
// fallback for sessions created by the previous webview engine.
async function scopedSignInCookies(environmentId: string, profileId: string) {
  const scope = JSON.stringify([environmentId, profileId]);
  const stableDigest = Crypto.createHash("sha256").update(scope).digest("hex").slice(0, 32);
  const isDefault = profileId === "default";
  const previewScope = isDefault ? environmentId : scope;
  const previewDigest = Crypto.createHash("sha256").update(previewScope).digest("hex").slice(0, 20);
  const previewPrefix =
    profileId === "incognito" ? "t3code-preview-ephemeral-" : "persist:t3code-preview-";
  const previewPartition = previewPrefix + (isDefault ? "" : "profile-") + previewDigest;
  const partitions = [`persist:t3-stable-chatgpt-${stableDigest}`, previewPartition];
  const cookies = (
    await Promise.all(
      partitions.map((partition) => session.fromPartition(partition).cookies.get({})),
    )
  ).flat();
  const allowed = cookies.filter(({ domain }) => {
    if (typeof domain !== "string") return false;
    const host = domain.replace(/^\./, "").toLowerCase();
    return (
      host === "chatgpt.com" ||
      host.endsWith(".chatgpt.com") ||
      host === "openai.com" ||
      host.endsWith(".openai.com")
    );
  });
  const unique = new Map<string, (typeof allowed)[number]>();
  // Stable native cookies precede the legacy preview fallback.
  for (const cookie of allowed) {
    const key = `${cookie.domain}\0${cookie.name}\0${cookie.path}`;
    if (!unique.has(key)) unique.set(key, cookie);
  }
  return [...unique.values()].map(
    ({ domain, name, value, path, secure, httpOnly, hostOnly, sameSite, expirationDate }) => ({
      domain,
      name,
      value,
      path,
      secure,
      httpOnly,
      hostOnly,
      sameSite,
      expirationDate,
    }),
  );
}

const allowedSession = (value: string) =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const allowedUrl = (value: string) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      ["chatgpt.com", "chat.openai.com"].includes(url.hostname)
    );
  } catch {
    return false;
  }
};

export type PersistentChatGPTRequest =
  | {
      operation: "attach";
      sessionId: string;
      url: string;
      environmentId?: string;
      profileId?: string;
    }
  | { operation: "resize"; sessionId: string; x: number; y: number; width: number; height: number }
  | { operation: "visibility"; sessionId: string; visible: boolean }
  | { operation: "input"; sessionId: string; input: Record<string, unknown> }
  | { operation: "evaluate"; sessionId: string; expression: string }
  | {
      operation: "status" | "snapshot" | "probe" | "close" | "reload" | "back" | "forward";
      sessionId: string;
      environmentId?: string;
      profileId?: string;
    }
  | { operation: "navigate"; sessionId: string; url: string }
  | {
      operation: "find";
      sessionId: string;
      text: string;
      findNext?: boolean;
      forward?: boolean;
    }
  | { operation: "stop_find"; sessionId: string };

export interface PersistentChatGPTViewIdentity {
  readonly sessionId: string;
  readonly environmentId: string;
  readonly profileId: string;
}

export type PersistentChatGPTViewRequest =
  | { operation: "attach"; identity: PersistentChatGPTViewIdentity; url: string }
  | {
      operation: "present";
      identity: PersistentChatGPTViewIdentity;
      bounds: { x: number; y: number; width: number; height: number } | null;
    }
  | {
      operation: "tooltip";
      identity: PersistentChatGPTViewIdentity;
      bounds: { x: number; y: number; width: number; height: number } | null;
      html: string | null;
    }
  | { operation: "navigate"; identity: PersistentChatGPTViewIdentity; url: string }
  | { operation: "evaluate"; identity: PersistentChatGPTViewIdentity; expression: string }
  | {
      operation: "find";
      identity: PersistentChatGPTViewIdentity;
      text: string;
      findNext?: boolean;
      forward?: boolean;
    }
  | {
      operation: "stop_find" | "probe" | "snapshot" | "close" | "reload" | "back" | "forward";
      identity: PersistentChatGPTViewIdentity;
    };

export async function persistentChatGPTViewRequest(
  input: PersistentChatGPTViewRequest,
): Promise<unknown> {
  const { identity } = input;
  if (!allowedSession(identity.sessionId))
    throw new Error("Invalid exact ChatGPT browser session ID");
  if (
    !identity.environmentId ||
    identity.environmentId.length > 128 ||
    /[\x00-\x1f\x7f]/.test(identity.environmentId) ||
    !identity.profileId ||
    identity.profileId.length > 64 ||
    /[\x00-\x1f\x7f]/.test(identity.profileId)
  )
    throw new Error("Invalid ChatGPT environment or browser profile identity");
  switch (input.operation) {
    case "present":
      return { visible: input.bounds !== null };
    case "tooltip":
      return { visible: false };
    case "attach":
      return persistentChatGPTRequest({
        operation: "attach",
        sessionId: identity.sessionId,
        environmentId: identity.environmentId,
        profileId: identity.profileId,
        url: input.url,
      });
    case "navigate":
      return persistentChatGPTRequest({
        operation: "navigate",
        sessionId: identity.sessionId,
        url: input.url,
      });
    case "evaluate":
      return persistentChatGPTRequest({
        operation: "evaluate",
        sessionId: identity.sessionId,
        expression: input.expression,
      });
    case "find":
      return persistentChatGPTRequest({
        operation: "find",
        sessionId: identity.sessionId,
        text: input.text,
        ...(input.findNext === undefined ? {} : { findNext: input.findNext }),
        ...(input.forward === undefined ? {} : { forward: input.forward }),
      });
    case "stop_find":
    case "probe":
    case "snapshot":
      return persistentChatGPTRequest({
        operation: input.operation,
        sessionId: identity.sessionId,
        environmentId: identity.environmentId,
        profileId: identity.profileId,
      });
    case "close":
    case "reload":
    case "back":
    case "forward":
      return persistentChatGPTRequest({
        operation: input.operation,
        sessionId: identity.sessionId,
      });
  }
}

export async function persistentChatGPTRequest(input: PersistentChatGPTRequest): Promise<unknown> {
  if (!allowedSession(input.sessionId)) throw new Error("Invalid exact ChatGPT browser session ID");
  if (input.operation === "attach" && !allowedUrl(input.url))
    throw new Error("Only ChatGPT URLs are allowed in the persistent browser host");
  if (input.operation === "navigate" && !allowedUrl(input.url))
    throw new Error("Only ChatGPT URLs are allowed in the persistent browser host");
  if (input.operation === "evaluate" && input.expression.length > 200_000)
    throw new Error("Browser expression too long");
  if (input.operation === "find" && (!input.text.trim() || input.text.length > 500))
    throw new Error("Find text must be 1..500 characters");
  const socket = await ensure();
  subscribeToHostEvents(socket);
  try {
    switch (input.operation) {
      case "attach": {
        // Existing pages already have their authenticated Chromium document.
        // Only new pages require a sign-in handoff. A fresh/empty native
        // profile must use the in-process fallback, which can show login UI.
        const presence = (await request(socket, "POST", "/sessions/probe", {
          sessionId: input.sessionId,
          environmentId: input.environmentId ?? "local",
          profileId: input.profileId ?? "default",
        })) as { residency?: string };
        const authCookies =
          presence.residency === "resident"
            ? undefined
            : await scopedSignInCookies(
                input.environmentId ?? "local",
                input.profileId ?? "default",
              );
        // Cookie transfer is best effort for a NEW page. A single malformed
        // cookie (Chromium prefix/domain policy or expired attributes) must
        // not leave the entire T3 session stuck on an IPC error. The owner
        // guarantees a rejected transfer occurs before first navigation and
        // destroys its failed page, so only these attach failures are safely
        // retryable. Never retry an ambiguous timeout or an existing page.
        const remainingCookies = authCookies ? [...authCookies] : undefined;
        for (let attempt = 0; ; attempt++) {
          try {
            return await request(socket, "POST", "/sessions/attach", {
              sessionId: input.sessionId,
              initialUrl: input.url,
              environmentId: input.environmentId ?? "local",
              profileId: input.profileId ?? "default",
              authCookies: remainingCookies,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (
              !message.includes("Scoped ChatGPT sign-in transfer failed") ||
              !remainingCookies ||
              attempt >= 12
            )
              throw error;
            const rejected = /Cookie (\d+)\/(\d+) for /.exec(message);
            const index = rejected ? Number(rejected[1]) - 1 : -1;
            if (index < 0 || index >= remainingCookies.length) {
              // An unparseable cookie-transfer failure still must not strand
              // the user. Empty transfer permits ChatGPT's normal login page.
              remainingCookies.length = 0;
              if (attempt > 0) throw error;
            } else {
              remainingCookies.splice(index, 1);
            }
          }
        }
      }
      case "resize":
        return await request(socket, "POST", "/sessions/resize", input);
      case "visibility":
        return await request(socket, "POST", "/sessions/visibility", input);
      case "input":
        return await request(socket, "POST", "/sessions/input", input);
      case "evaluate":
        return await request(socket, "POST", "/sessions/evaluate", input);
      case "status":
        return await request(socket, "POST", "/sessions/status", input);
      case "snapshot":
      case "probe": {
        return await request(
          socket,
          "POST",
          input.operation === "snapshot" ? "/sessions/snapshot" : "/sessions/probe",
          input,
        );
      }
      case "navigate":
        return await request(socket, "POST", "/sessions/navigate", input);
      case "reload":
        return await request(socket, "POST", "/sessions/reload", input);
      case "back":
      case "forward":
        return await request(socket, "POST", "/sessions/history", input);
      case "find":
        return await request(socket, "POST", "/sessions/find", input);
      case "stop_find":
        return await request(socket, "POST", "/sessions/stop-find", input);
      case "close":
        return await request(socket, "POST", "/sessions/close", input);
    }
  } catch (error) {
    // A disconnected host is rediscovered on the NEXT request. Never replay
    // this request: keyboard/send/eval may already have executed before loss.
    if (
      ["ENOENT", "ECONNREFUSED", "EPIPE"].includes((error as NodeJS.ErrnoException)?.code ?? "")
    ) {
      launching = null;
    }
    // Never replay an ambiguous failed request, especially keyboard/send/eval.
    throw error;
  }
}
