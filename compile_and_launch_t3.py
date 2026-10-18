"""Gracefully restart this checkout's T3 Code app, rebuild, and relaunch.

Only targets the custom executable under this checkout. Other T3 Code installs
and unrelated Electron apps are never touched.
"""

import argparse
import ctypes
from ctypes import wintypes
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

from t3_build_freshness import build_is_current

EXE_NAME = "T3 Code (Custom).exe"
GRACE_SECONDS = 20
WM_CLOSE = 0x0010


def custom_executable(root: Path) -> Path:
    return root / ".electron-runtime" / "windows-custom" / EXE_NAME


def running_custom_processes(root: Path) -> list[dict]:
    """Read executable paths as well as PIDs; process names alone are not safe."""
    script = (
        "Get-CimInstance Win32_Process -Filter "
        "\"Name = 'T3 Code (Custom).exe'\" | "
        "Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine | "
        "ConvertTo-Json -Compress"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        check=True,
    )
    data = json.loads(result.stdout) if result.stdout.strip() else []
    if isinstance(data, dict):
        data = [data]
    target = os.path.normcase(os.path.abspath(custom_executable(root)))
    return [
        item for item in data
        if item.get("ExecutablePath")
        and os.path.normcase(os.path.abspath(item["ExecutablePath"])) == target
    ]


def close_app_windows(pids: set[int]) -> int:
    """Ask every top-level window owned by the custom app to close normally."""
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    enum_windows = user32.EnumWindows
    enum_windows.argtypes = [ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM),
                             wintypes.LPARAM]
    enum_windows.restype = wintypes.BOOL
    get_pid = user32.GetWindowThreadProcessId
    get_pid.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    get_pid.restype = wintypes.DWORD
    post_message = user32.PostMessageW
    post_message.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    post_message.restype = wintypes.BOOL
    visible = user32.IsWindowVisible
    visible.argtypes = [wintypes.HWND]
    visible.restype = wintypes.BOOL

    count = 0
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    @callback_type
    def visit(hwnd, _):
        nonlocal count
        owner = wintypes.DWORD()
        get_pid(hwnd, ctypes.byref(owner))
        if owner.value in pids and visible(hwnd) and post_message(hwnd, WM_CLOSE, 0, 0):
            count += 1
        return True

    if not enum_windows(visit, 0):
        raise ctypes.WinError(ctypes.get_last_error())
    return count


def stop_custom_app(root: Path) -> bool:
    processes = running_custom_processes(root)
    if not processes:
        print("T3 Code (Custom) is not running.", flush=True)
        return False

    pids = {int(item["ProcessId"]) for item in processes}
    # Only root Electron instances own application windows; renderer/GPU
    # children will exit along with their parent.
    roots = {
        int(item["ProcessId"])
        for item in processes
        if int(item["ParentProcessId"]) not in pids
        and "--type=" not in (item.get("CommandLine") or "")
        and "--bootstrap-fd" not in (item.get("CommandLine") or "")
    }
    print(f"Closing custom T3 Code app (root PIDs: {sorted(roots)})...", flush=True)
    signaled = close_app_windows(roots)
    if signaled:
        print(f"Requested graceful close of {signaled} window(s).", flush=True)

    deadline = time.monotonic() + GRACE_SECONDS
    while time.monotonic() < deadline:
        if not running_custom_processes(root):
            print("T3 Code closed gracefully.", flush=True)
            return True
        time.sleep(0.5)

    # Graceful shutdown may hang (e.g., a stuck Electron renderer).
    # Re-query immediately before each taskkill to avoid terminating a
    # recycled PID or another app with a similar process name.
    print("Graceful shutdown timed out; stopping remaining custom processes.", flush=True)
    for item in running_custom_processes(root):
        pid = int(item["ProcessId"])
        if pid in roots:
            subprocess.run(["taskkill.exe", "/PID", str(pid), "/T", "/F"],
                           capture_output=True, text=True, check=False)

    # An orphaned renderer may outlive the Electron root.
    for item in running_custom_processes(root):
        pid = int(item["ProcessId"])
        subprocess.run(["taskkill.exe", "/PID", str(pid), "/F"],
                       capture_output=True, text=True, check=False)

    if running_custom_processes(root):
        raise RuntimeError("Could not close the custom T3 Code app; not rebuilding over a live executable.")
    return True



def session_backup(root: Path) -> Path:
    """Back up the browser's saved ChatGPT session names and URLs *after* shutdown.

    Browser session metadata lives in Chromium Local Storage, not the T3
    project database. Never wipe or migrate the live profile during a build.
    """
    profile = Path(os.environ["APPDATA"]) / "t3code-custom"
    source = profile / "Local Storage"
    if not (source / "leveldb" / "CURRENT").is_file():
        raise RuntimeError(
            "Cannot find T3 Code's ChatGPT session storage; refusing to rebuild."
        )
    backup = root.parent / "T3CodeSessionBackups" / (
        "before-restart-" + datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    )
    backup.mkdir(parents=True, exist_ok=False)
    destination = backup / "Local Storage"
    shutil.copytree(source, destination)
    files = [p for p in source.rglob("*") if p.is_file()]
    if not files:
        raise RuntimeError("ChatGPT localStorage contains no files; refusing to rebuild.")
    for original in files:
        copied = destination / original.relative_to(source)
        if not copied.is_file() or copied.stat().st_size != original.stat().st_size:
            raise RuntimeError(f"ChatGPT session backup incomplete: {original}")
        # Hash the small LevelDB files, including the metadata containing
        # session titles and last-known conversation URLs.
        if original.suffix in {".ldb", ".log"} or original.name == "CURRENT":
            if hashlib.sha256(original.read_bytes()).digest() != hashlib.sha256(
                copied.read_bytes()
            ).digest():
                raise RuntimeError(f"ChatGPT session backup does not match: {original}")
    for filename in ("Local State", "Preferences"):
        item = profile / filename
        if item.is_file():
            shutil.copy2(item, backup / filename)
    print(f"ChatGPT session-name/URL storage backed up: {backup}", flush=True)
    return backup


def main(*, force_build: bool = False, restart_only: bool = False) -> None:
    if os.name != "nt":
        raise RuntimeError("This helper runs on Windows only.")
    root = Path(__file__).resolve().parent
    current = build_is_current(root)
    if restart_only and not current:
        raise RuntimeError("Compiled T3 is stale or missing. Build before restart.")
    needs_build = force_build or not current
    print("Rebuilding changed source." if needs_build else "Build unchanged; fast restart without compilation.", flush=True)
    was_running = stop_custom_app(root)
    try:
        backup = session_backup(root)
        print(f"Verified session backup before rebuilding: {backup}", flush=True)
        if needs_build:
            subprocess.run(
                [sys.executable, str(root / "compile_t3.py"), "--build-only"],
                cwd=root,
                check=True,
            )
    except (OSError, RuntimeError, subprocess.CalledProcessError):
        # If backup or compilation fails, keep the session profile and bring
        # back the previous launcher rather than leaving the user without T3.
        if was_running:
            print(
                "Build failed; attempting to reopen the previous T3 Code executable.",
                file=sys.stderr, flush=True,
            )
            subprocess.run(
                [sys.executable, str(root / "launch_t3.py")],
                cwd=root, check=False,
            )
        raise
    subprocess.run([sys.executable, str(root / "launch_t3.py")], cwd=root, check=True)
    print("T3 Code (Custom) launched with verified compiled artifacts; session profile untouched.", flush=True)


def spawn_independent_worker(root: Path, *, force_build: bool = False, restart_only: bool = False) -> None:
    """Detach before closing T3; this survives the calling browser's shutdown."""
    if os.name != "nt":
        raise RuntimeError("This helper runs on Windows only.")
    folder = root.parent / "T3CodeSessionBackups"
    folder.mkdir(parents=True, exist_ok=True)
    log_path = folder / ("build-and-restart-" + datetime.now().strftime(
        "%Y%m%d-%H%M%S-%f"
    ) + ".log")
    flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    flags |= getattr(subprocess, "CREATE_NO_WINDOW", 0)
    with log_path.open("w", encoding="utf-8") as output:
        child = subprocess.Popen(
            [sys.executable, str(root / "compile_and_launch_t3.py"), "--worker",
             *(["--force-build"] if force_build else []),
             *(["--restart-only"] if restart_only else [])],
            cwd=root,
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.STDOUT,
            creationflags=flags,
            close_fds=True,
        )
    print(
        f"Independent T3 build-and-restart worker started (PID {child.pid}).\n"
        f"Build status log: {log_path}\n"
        "The worker automatically closes T3, backs up ChatGPT session metadata, "
        "builds and relaunches it.",
        flush=True,
    )


if __name__ == "__main__":
    try:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument("--worker", action="store_true",
                            help="Internal detached restart/build worker")
        parser.add_argument("--dry-run", action="store_true",
                            help="Validate paths without closing the application")
        modes = parser.add_mutually_exclusive_group()
        modes.add_argument("--force-build", action="store_true",
                           help="Rebuild all bundles before restarting")
        modes.add_argument("--restart-only", action="store_true",
                           help="Restart only if all compiled outputs match current source")
        args = parser.parse_args()
        root = Path(__file__).resolve().parent
        if args.dry_run:
            profile = Path(os.environ["APPDATA"]) / "t3code-custom"
            if not (profile / "Local Storage" / "leveldb" / "CURRENT").is_file():
                raise RuntimeError("ChatGPT session storage missing.")
            if not (root / "node_modules" / ".bin" / "vp.cmd").is_file():
                raise RuntimeError("Vite+ build runner missing.")
            print("Preflight OK: session storage, build runner, restart script.")
        elif args.worker:
            main(force_build=args.force_build, restart_only=args.restart_only)
        else:
            if args.restart_only and not build_is_current(root):
                raise RuntimeError("Compiled T3 is stale or missing. Run the default command to rebuild first.")
            spawn_independent_worker(root, force_build=args.force_build,
                                     restart_only=args.restart_only)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Restart/build failed: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
