#!/usr/bin/env python3
"""Push committed main to GitHub, then update linked T3 + Monku Windows PCs.

Run: python "Update remotes.py"
Optional: --target <name-or-environment-id>, --no-wait, --base-dir <T3 data directory>.
The linked PC needs the remote update MCP tool deployed once before this works.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
CLI = ROOT / "apps" / "server" / "src" / "bin.ts"


def call(args, *, capture=False, env=None):
    result = subprocess.run(
        args, cwd=ROOT, env=env, text=True, encoding="utf-8", errors="replace",
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        check=False,
    )
    if result.returncode:
        if capture:
            print(result.stdout or "", file=sys.stderr)
            print(result.stderr or "", file=sys.stderr)
        raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(str(x) for x in args)}")
    return result.stdout if capture else ""


def decode(output):
    # The CLI's --json prints one JSON value; tolerate Node's startup messages.
    for line in reversed(output.splitlines()):
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    raise RuntimeError(f"No JSON reply from T3 environment CLI:\n{output}")


def node_executable():
    managed = Path.home() / "AppData" / "Local" / "pi-node" / "current" / "node.exe"
    candidates = [
        os.getenv("T3_UPDATE_NODE"),
        str(managed) if managed.exists() else None,
        shutil.which("node"),
    ]
    for candidate in filter(None, candidates):
        check = subprocess.run(
            [candidate, "-e", "process.exit(typeof require('node:sqlite').backup === 'function' ? 0 : 1)"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        )
        if check.returncode == 0:
            return candidate
    raise RuntimeError(
        "Need a Node runtime with node:sqlite.backup (e.g. the T3-managed Node runtime). "
        "Set T3_UPDATE_NODE to that node.exe."
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", help="Update only this linked environment (name or ID)")
    parser.add_argument("--no-wait", action="store_true", help="Trigger updates and exit")
    parser.add_argument("--base-dir", help="Override T3 server data directory (default: T3CODE_HOME / ~/.t3)")
    args = parser.parse_args()

    if call(["git", "branch", "--show-current"], capture=True).strip() != "main":
        raise RuntimeError("Switch to main first; refusing to push another branch.")
    print("1. Pushing committed main to GitHub before any remote update...", flush=True)
    call(["git", "push", "origin", "main:refs/heads/main"])
    print("   Push complete. Uncommitted work is not included.", flush=True)

    environment = os.environ.copy()
    environment["NODE_NO_WARNINGS"] = "1"
    node = node_executable()
    cli = [node, "--experimental-strip-types", str(CLI), "environment"]
    if args.base_dir:
        environment["T3CODE_HOME"] = args.base_dir

    def remote(*parts):
        return decode(call([*cli, *parts, "--json"], capture=True, env=environment))

    print("2. Finding linked environments...", flush=True)
    links = remote("list")
    if not isinstance(links, list):
        raise RuntimeError(f"Unexpected linked-environment list: {links!r}")
    selected = [
        link for link in links
        if link.get("access") == "full-access"
        and (not args.target or args.target.casefold() in
             (str(link.get("label", "")).casefold(), str(link.get("environmentId", "")).casefold()))
    ]
    if not selected:
        raise RuntimeError(
            "No matching full-access linked environments. Check T3 Settings > Linked environments "
            "and use --target to select one."
        )

    pending = {}
    failures = False
    for link in selected:
        target = str(link["environmentId"])
        name = str(link.get("label") or target)
        print(f"3. Triggering update on {name} ({target})...", flush=True)
        try:
            result = remote("update-wife", target)
            print(f"   {result['state']}: {result['message']}", flush=True)
            if result["state"] in ("running", "queued"):
                pending[target] = name
            elif result["state"] == "failed":
                failures = True
                print(f"   Failed: {result['message']} (log: {result['logPath']})", file=sys.stderr)
        except (RuntimeError, KeyError) as error:
            failures = True
            print(f"   {name}: {error}", file=sys.stderr)

    if args.no_wait or not pending:
        if pending:
            print("Updates started. Run this script with --no-wait only to dispatch; logs are on each PC.")
        return 1 if failures or not pending else 0

    print("4. Following update status (temporary disconnections during T3 restart are expected)...", flush=True)
    deadline = time.monotonic() + 30 * 60
    last = {}
    while pending and time.monotonic() < deadline:
        time.sleep(12)
        for target, name in list(pending.items()):
            try:
                result = remote("update-wife-status", target)
            except RuntimeError:
                continue  # The peer's T3 server can be restarting.
            state = result.get("state")
            message = result.get("message", "")
            if (state, message) != last.get(target):
                print(f"   {name}: {state} — {message}", flush=True)
                last[target] = (state, message)
            if state in ("succeeded", "failed"):
                if state == "failed":
                    failures = True
                    print(f"   {name} log: {result.get('logPath')}", file=sys.stderr)
                pending.pop(target)
    if pending:
        failures = True
        print("Timed out waiting for: " + ", ".join(pending.values()), file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError) as exc:
        print(f"Update remotes failed: {exc}", file=sys.stderr)
        sys.exit(1)
