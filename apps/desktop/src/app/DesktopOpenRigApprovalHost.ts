// @effect-diagnostics nodeBuiltinImport:off -- anonymous OS child IPC, MAIN only.
// @effect-diagnostics globalTimers:off -- bounded private IPC request deadlines.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import {
  DesktopNativeSpawnApproval,
  type NativeApprovalView,
} from "./DesktopNativeSpawnApproval.ts";

/** No listening socket, no bearer/key, and no renderer/CLI decision channel.
 * OpenRig independently attests this child's actual OS parent executable/PID. */
class PrivateApprovalHost {
  readonly #pending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly #child: NodeChildProcess.ChildProcess;
  constructor() {
    const root = String.raw`D:\SSDProjects\Tools\OpenRig`;
    this.#child = NodeChildProcess.spawn(
      "node",
      ["--import", "tsx", NodePath.resolve(root, "scripts/omni/serve-t3-approval-host.mts")],
      {
        cwd: root,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        // The IPC handle is authority. Do not configure this process using the
        // generic integration bearer, renderer tokens or caller-selected paths.
        env: {
          SystemRoot: process.env.SystemRoot,
          PATH: process.env.PATH,
          USERPROFILE: process.env.USERPROFILE,
          APPDATA: process.env.APPDATA,
          LOCALAPPDATA: process.env.LOCALAPPDATA,
        },
      },
    );
    this.#child.on("message", (raw) => {
      if (!raw || typeof raw !== "object") return;
      const reply = raw as { requestId?: string; ok?: boolean; data?: unknown };
      const pending = reply.requestId ? this.#pending.get(reply.requestId) : undefined;
      if (!pending || !reply.requestId) return;
      this.#pending.delete(reply.requestId);
      clearTimeout(pending.timer);
      if (reply.ok === true) pending.resolve(reply.data);
      else pending.reject(new Error("Canonical approval unavailable or stale; no automatic retry"));
    });
    const close = () => {
      for (const p of this.#pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Private approval host disconnected"));
      }
      this.#pending.clear();
    };
    this.#child.on("exit", close);
    this.#child.on("error", close);
  }
  request(body: Record<string, unknown>): Promise<unknown> {
    const requestId = NodeCrypto.randomUUID();
    return new Promise((resolveReply, reject) => {
      const timer = setTimeout(
        () => {
          this.#pending.delete(requestId);
          reject(new Error("Approval outcome unconfirmed; do not retry automatically"));
        },
        body.method === "operator.verify" ? 130_000 : 15_000,
      );
      this.#pending.set(requestId, { resolve: resolveReply, reject, timer });
      this.#child.send({ ...body, requestId }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.#pending.delete(requestId);
          reject(error);
        }
      });
    });
  }
  close(): void {
    if (this.#child.connected) this.#child.disconnect();
  }
}

/** A renderer may request a canonical read, but it cannot supply a decision or credentials.
 * Each call runs only inside MAIN and spawns a short-lived OS-parent-attested
 * child with an anonymous IPC channel. No process is started at import. */
export async function listPendingNativeSpawnApprovals(): Promise<{ items: NativeApprovalView[] }> {
  const host = new PrivateApprovalHost();
  try {
    return (await host.request({ method: "operator.pending" })) as { items: NativeApprovalView[] };
  } finally {
    host.close();
  }
}

export async function getNativeSpawnApproval(operationId: string): Promise<NativeApprovalView> {
  if (!operationId.trim() || operationId.length > 512) throw new Error("Invalid approval operation ID");
  const host = new PrivateApprovalHost();
  try {
    return (await host.request({ method: "operator.get", operationId })) as NativeApprovalView;
  } finally {
    host.close();
  }
}

let reviewInProgress = false;
/** A renderer may request ONLY an operation lookup key. MAIN retrieves and
 * snapshots the canonical authority row; human choice occurs in a native dialog,
 * followed by Windows Hello in the canonical authority. */
export async function reviewNativeSpawnOperation(
  operationId: string,
  confirm: ConstructorParameters<typeof DesktopNativeSpawnApproval>[0]["confirm"],
): Promise<{ outcome: "recorded" | "cancelled" | "verification-unavailable"; item: NativeApprovalView | null }> {
  if (!operationId.trim() || operationId.length > 512) throw new Error("Invalid approval operation ID");
  if (reviewInProgress) throw new Error("A native approval review is already active");
  reviewInProgress = true;
  const host = new PrivateApprovalHost();
  try {
    return await reviewViaHost(host, operationId, confirm);
  } finally {
    host.close();
    reviewInProgress = false;
  }
}

async function reviewViaHost(
  host: PrivateApprovalHost,
  operationId: string,
  confirm: ConstructorParameters<typeof DesktopNativeSpawnApproval>[0]["confirm"],
): Promise<{ outcome: "recorded" | "cancelled" | "verification-unavailable"; item: NativeApprovalView | null }> {
  let verifiedActionId: string | null = null;
  const controller = new DesktopNativeSpawnApproval({
    authority: {
      get: async (id) =>
        (await host.request({ method: "operator.get", operationId: id })) as NativeApprovalView,
      decide: async (input) =>
        (await host.request({ method: "operator.decide", ...input })) as NativeApprovalView,
    },
    confirm,
    verifyWindowsUser: async (binding) => {
      const [decision, id, descriptorSha256, version] = binding.split("\n");
      const verified = (await host.request({
        method: "operator.verify",
        decision,
        operationId: id,
        descriptorSha256,
        expectedVersion: Number(version),
      })) as { actionId?: string };
      verifiedActionId = verified.actionId ?? null;
      return verifiedActionId !== null;
    },
    newActionId: () => {
      if (!verifiedActionId) throw new Error("No native verification receipt");
      const id = verifiedActionId;
      verifiedActionId = null;
      return id;
    },
    now: Date.now,
  });
  const outcome = await controller.review(operationId);
  // A lost canonical acknowledgement remains an error: never claim recorded.
  const item = (await host.request({ method: "operator.get", operationId })) as NativeApprovalView;
  return { outcome, item };
}

/** Existing MAIN application-menu review, using the same locked native path. */
export async function reviewPendingNativeSpawn(
  confirm: ConstructorParameters<typeof DesktopNativeSpawnApproval>[0]["confirm"],
): Promise<void> {
  try {
    const page = await listPendingNativeSpawnApprovals();
    const first = page.items?.[0];
    if (!first) {
      await confirm({
        message: "No pending native session requests",
        detail: "OpenRig canonical approval inbox is empty.",
        buttons: ["Close"],
        defaultId: 0,
        cancelId: 0,
      });
      return;
    }
    /* The menu can select only the first canonical pending item; it cannot issue
     * an approval directly or bypass the shared MAIN review lock. */
    const result = await reviewNativeSpawnOperation(first.operationId, confirm);
    if (result.outcome === "verification-unavailable")
      await confirm({
        message: "Human verification unavailable",
        detail: "No decision was written. Windows Hello verification is required.",
        buttons: ["Close"],
        defaultId: 0,
        cancelId: 0,
      });
    return;
  } catch {
    await confirm({
      message: "Approval unavailable or outcome unconfirmed",
      detail: "No automatic retry was sent. Check the canonical operation before trying again.",
      buttons: ["Close"],
      defaultId: 0,
      cancelId: 0,
    });
  }
}
