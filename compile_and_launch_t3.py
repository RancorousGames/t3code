"""Rebuild/reopen T3 without killing Chromium by default.

The stable Electron owner and browser views survive; UI assets reload.
Main-process/server changes require an explicitly destructive replacement.
"""

import argparse
import ctypes
from ctypes import wintypes
from datetime import datetime
import hashlib
import json
import os
import math
import secrets
from pathlib import Path
import shutil
import subprocess
import sys
import time

from t3_build_freshness import build_is_current
from compile_t3 import staged_build_is_current, resolve_node

EXE_NAME = "T3 Code (Custom).exe"
GRACE_SECONDS = 20
WM_CLOSE = 0x0010
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def load_private_openrig_human_answer_token() -> None:
    """Give Electron MAIN the existing local OpenRig operator token, never renderer text."""
    path = Path.home() / ".openrig" / "operator-tokens" / "t3-human-answer-token.txt"
    if not path.is_file():
        return
    token = path.read_text(encoding="utf-8").strip()
    if len(token) < 24:
        raise RuntimeError("Existing OpenRig human-answer token is invalid.")
    os.environ["OPENRIG_T3_HUMAN_ANSWER_TOKEN"] = token


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
        creationflags=CREATE_NO_WINDOW,
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
                           capture_output=True, text=True, check=False,
                           creationflags=CREATE_NO_WINDOW)

    # An orphaned renderer may outlive the Electron root.
    for item in running_custom_processes(root):
        pid = int(item["ProcessId"])
        subprocess.run(["taskkill.exe", "/PID", str(pid), "/F"],
                       capture_output=True, text=True, check=False,
                       creationflags=CREATE_NO_WINDOW)

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


class RestartDeadline:
    """Monotonic restart deadline; postponements add 1, 2, 4, 8, then 16 minutes."""

    def __init__(self, seconds: int):
        self.deadline = time.monotonic() + seconds
        self.postpones = 0

    def remaining_seconds(self) -> int:
        return max(0, math.ceil(self.deadline - time.monotonic()))

    def next_postpone_minutes(self) -> int:
        return 2 ** min(self.postpones, 4)

    def postpone(self) -> None:
        self.deadline += self.next_postpone_minutes() * 60
        self.postpones += 1


def restart_countdown(seconds: int = 15) -> bool:
    """Cancelable topmost desktop notification. Closing or Escape means cancel.

    Run after compilation, before signaling ANY application window. If the GUI
    cannot display, fail closed instead of silently restarting someone's T3.
    """
    import tkinter as tk

    window = tk.Tk()
    try:
        window.title("T3 Code restart")
        window.attributes("-topmost", True)
        window.resizable(False, False)
        window.configure(bg="#1c2029")
        width, height = 390, 125
        window.geometry(f"{width}x{height}+"
                        f"{max(0, window.winfo_screenwidth() - width - 25)}+"
                        f"{max(0, window.winfo_screenheight() - height - 65)}")
        label = tk.Label(window, fg="#f7f7f9", bg="#1c2029",
                         font=("Segoe UI", 12, "bold"))
        label.pack(pady=(14, 6))
        description = tk.Label(window, text="New build ready. Current T3 stays open until countdown ends.",
                               fg="#c0c4d0", bg="#1c2029", font=("Segoe UI", 8))
        description.pack()
        confirmed = False
        active = True
        countdown = RestartDeadline(seconds)

        def cancel(_event=None):
            nonlocal active
            active = False
            window.quit()

        def show_remaining(remaining: int):
            duration = (f"{remaining // 60}m {remaining % 60:02d}s"
                        if remaining >= 60 else f"{remaining}s")
            label.configure(text=f"Restarting T3 in {duration}...")

        def tick():
            nonlocal confirmed
            if not active:
                return
            remaining = countdown.remaining_seconds()
            if remaining == 0:
                confirmed = True
                window.quit()
                return
            show_remaining(remaining)
            window.after(100, tick)

        def postpone():
            if not active:
                return
            countdown.postpone()
            postpone_button.configure(text=f"Postpone +{countdown.next_postpone_minutes()} min")
            show_remaining(countdown.remaining_seconds())

        buttons = tk.Frame(window, bg="#1c2029")
        buttons.pack(pady=9)
        postpone_button = tk.Button(buttons, text="Postpone +1 min", command=postpone,
                                    font=("Segoe UI", 9), padx=12)
        postpone_button.pack(side="left", padx=5)
        tk.Button(buttons, text="Cancel restart", command=cancel,
                  font=("Segoe UI", 9), padx=12).pack(side="left", padx=5)
        window.protocol("WM_DELETE_WINDOW", cancel)
        window.bind("<Escape>", cancel)
        window.after(0, tick)
        window.mainloop()
        return confirmed
    finally:
        window.destroy()


def _acquire_worker_lock():
    """A single Windows kernel mutex prevents two detached restart workers."""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    handle = kernel32.CreateMutexW(None, True, "Local\\T3CodeCustomBuildAndRestart")
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
        kernel32.CloseHandle(handle)
        raise RuntimeError("A T3 build-and-restart worker is already running.")
    return handle


def reload_owner_ui(root: Path, owner_pid: int) -> None:
    """Request T3 renderer-only reload; fail closed if host lacks the bridge."""
    ack = root / ".t3" / "native-ui-reload-ack.json"
    nonce = secrets.randbelow(0xffffffff - 1) + 1
    ack.unlink(missing_ok=True)
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user32.GetWindowThreadProcessId.argtypes = [
        wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.PostMessageW.argtypes = [
        wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    found = []

    @callback_type
    def visit(hwnd, _):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value != owner_pid:
            return True
        found.append(hwnd)
        # Only the guarded T3 message; never a keyboard shortcut or WM_CLOSE.
        return False

    if not user32.EnumWindows(visit, 0) and not found:
        raise RuntimeError("Unable to enumerate the T3 main window.")
    if len(found) != 1:
        raise RuntimeError("Expected one native T3 window; refusing ambiguous reload.")
    if not user32.PostMessageW(found[0], 0x8236, 0x5433524c, nonce):
        raise ctypes.WinError(ctypes.get_last_error())
    # After a full Vite rebuild the Electron UI can need longer to load its
    # regenerated chunk graph. Do not mistake slow startup for a dead owner.
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        if ack.is_file():
            try:
                data = json.loads(ack.read_text(encoding="utf-8"))
                if int(data.get("pid", -1)) == owner_pid and int(data.get("nonce", -1)) == nonce:
                    return
            except (ValueError, OSError, TypeError):
                pass
        time.sleep(0.2)
    raise RuntimeError(
        "Running T3 does not support safe native UI reload or did not acknowledge it; "
        "Electron and ChatGPT pages were NOT terminated. A one-time host upgrade "
        "is needed before this rebuild mode can activate UI changes."
    )


def build_and_reload_ui(root: Path, *, rebuild: bool = True) -> bool:
    """Compile bundles and reload only the UI; never terminate or relaunch Electron."""
    processes = running_custom_processes(root)
    if not processes:
        raise RuntimeError("Custom T3 is not running; use --full-restart to launch it.")
    roots = [
        int(item["ProcessId"]) for item in processes
        if "--type=" not in (item.get("CommandLine") or "")
        and "--bootstrap-fd" not in (item.get("CommandLine") or "")
        and int(item["ParentProcessId"]) not in {int(p["ProcessId"]) for p in processes}
    ]
    if len(roots) != 1:
        # A crashed/replaced T3 may leave a windowless, childless root process.
        # Only the real desktop window may receive the native reload message.
        import ctypes.wintypes as win
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        callback_type = ctypes.WINFUNCTYPE(win.BOOL, win.HWND, win.LPARAM)
        owners = set()

        @callback_type
        def find_owner(hwnd, _):
            pid = win.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value in roots and user32.IsWindowVisible(hwnd):
                owners.add(pid.value)
            return True

        user32.EnumWindows(find_owner, 0)
        if len(owners) != 1:
            raise RuntimeError(f"Expected one visible T3 owner, found {len(owners)} among {len(roots)} roots.")
        roots = list(owners)
    pnpm = shutil.which("pnpm.cmd") or shutil.which("pnpm")
    if not pnpm:
        raise RuntimeError("pnpm not installed.")
    node = resolve_node(root, pnpm)
    runner = root / "node_modules" / ".bin" / "vp.cmd"
    if not runner.is_file():
        raise RuntimeError("Vite+ build runner missing.")
    env = os.environ.copy()
    env["PATH"] = str(node.parent) + os.pathsep + env.get("PATH", "")
    env["NODE_OPTIONS"] = "--experimental-strip-types"
    env.pop("ELECTRON_RUN_AS_NODE", None)
    if rebuild:
        subprocess.run(
            [str(runner), "run", "--filter", "@t3tools/desktop", "--filter", "t3", "build"],
            cwd=root, env=env, check=True, creationflags=CREATE_NO_WINDOW,
        )
    elif not build_is_current(root):
        raise RuntimeError("Compiled outputs missing; refusing a no-build reload.")
    # Do not reload a different process if T3 restarted while compiling.
    current_processes = running_custom_processes(root)
    current_pids = {int(p["ProcessId"]) for p in current_processes}
    current_roots = {
        int(p["ProcessId"]) for p in current_processes
        if "--type=" not in (p.get("CommandLine") or "")
        and "--bootstrap-fd" not in (p.get("CommandLine") or "")
        and int(p["ParentProcessId"]) not in current_pids
    }
    if not set(roots).issubset(current_roots):
        raise RuntimeError("T3 window owner changed during build; refusing to target another window.")
    # Never inject Ctrl+R: the focused native ChatGPT guest may receive it,
    # triggering a real ChatGPT navigation and losing live page state.
    # The running Electron main has a dedicated window-message handler which
    # reloads its OWN webContents and writes an authenticated-by-PID ack.
    reload_owner_ui(root, roots[0])
    print("T3 UI reloaded in its existing Electron owner; Chromium pages preserved.", flush=True)
    print("Electron main/backend changes are NOT activated by this reload.", flush=True)
    return True


def main(*, force_build: bool = False, restart_only: bool = False) -> None:
    if os.name != "nt":
        raise RuntimeError("This helper runs on Windows only.")
    root = Path(__file__).resolve().parent
    current = build_is_current(root)
    if restart_only and not current:
        raise RuntimeError("Compiled T3 output missing. Build before restart.")
    needs_build = force_build or not current
    print("Building requested T3 outputs." if needs_build else "Compiled outputs present; fast restart without compilation.", flush=True)
    # The old application and all its windows remain open throughout compilation
    # and runtime preparation. Nothing below may close T3 on an incomplete build.
    if needs_build:
        if force_build or not staged_build_is_current(root):
            subprocess.run(
                [sys.executable, str(root / "compile_t3.py"), "--stage-only"],
                cwd=root, check=True, creationflags=CREATE_NO_WINDOW,
            )
        else:
            print("Previously staged build still matches compiled outputs; reusing it.", flush=True)
        if not staged_build_is_current(root):
            raise RuntimeError("Staged bundle output changed; leaving running T3 untouched.")
    else:
        if not build_is_current(root):
            raise RuntimeError("Compiled outputs changed; leaving running T3 untouched.")

    running = bool(running_custom_processes(root))
    if running:
        print("New build ready. Showing cancelable 15-second restart notification.", flush=True)
        if not restart_countdown():
            print("Restart canceled; current T3 remains open.", flush=True)
            return False

    # Verify staged compiled outputs immediately before any close.
    if needs_build and not staged_build_is_current(root):
        raise RuntimeError("Staged bundle output changed during countdown; leaving T3 running.")
    if not needs_build and not build_is_current(root):
        raise RuntimeError("Compiled build changed during countdown; leaving T3 running.")
    was_running = stop_custom_app(root)
    try:
        backup = session_backup(root)
        print(f"Verified session backup before activating new build: {backup}", flush=True)
        if needs_build:
            subprocess.run(
                [sys.executable, str(root / "compile_t3.py"), "--activate-staged"],
                cwd=root, check=True, creationflags=CREATE_NO_WINDOW,
            )
    except (OSError, RuntimeError, subprocess.CalledProcessError):
        # If backup or compilation fails, keep the session profile and bring
        # back the previous launcher rather than leaving the user without T3.
        if was_running:
            print(
                "Activation/backup failed; attempting to reopen the previous T3 Code executable.",
                file=sys.stderr, flush=True,
            )
            subprocess.run(
                [sys.executable, str(root / "launch_t3.py")],
                cwd=root, check=False, creationflags=CREATE_NO_WINDOW,
            )
        raise
    subprocess.run([sys.executable, str(root / "launch_t3.py")], cwd=root, check=True, creationflags=CREATE_NO_WINDOW)
    print("T3 Code (Custom) launched with verified compiled artifacts; session profile untouched.", flush=True)
    return True


def _taskboard_release_run(root: Path, manifest: Path | None, *, force_build: bool,
                           restart_only: bool, ui_only: bool = False) -> None:
    """Attach source-bound TaskBoard receipts to an authorized T3 build/reload."""
    if manifest is None:
        print("TaskBoard: no integrated manifest; no deployment attempt recorded.", flush=True)
        if ui_only:
            build_and_reload_ui(root, rebuild=not restart_only)
        else:
            main(force_build=force_build, restart_only=restart_only)
        return
    bridge = root.parent / "TaskBoard" / "scripts" / "release_deployment_bridge.py"
    if not bridge.is_file():
        raise RuntimeError(f"TaskBoard release bridge missing: {bridge}")
    manifest = manifest.resolve(strict=True)
    log = Path(os.environ.get("T3_RELEASE_LOG", "") or
               (root.parent / "T3CodeSessionBackups" / "manual-t3-release-diagnostics.log"))
    log.parent.mkdir(parents=True, exist_ok=True)

    def bookkeep(*args: str) -> None:
        subprocess.run([sys.executable, str(bridge), *args], cwd=root, check=True, creationflags=CREATE_NO_WINDOW)

    # The bridge rejects detached revisions and freezes only source-proven members.
    # Neither it nor this option authorizes a restart independently.
    bookkeep("preflight", str(manifest))
    try:
        if ui_only:
            build_and_reload_ui(root, rebuild=not restart_only)
            # Ctrl+R dispatch is not proof that Electron loaded the new web
            # assets. Record the actual build/reload attempt as UNKNOWN, never
            # claim that server/main-process changes are deployed by UI reload.
            bookkeep("preflight", str(manifest))
            log.touch(exist_ok=True)
            bookkeep("outcome", str(manifest), "--status", "unknown", "--log", str(log))
            print("TaskBoard: UI reload recorded UNKNOWN until independently verified.", flush=True)
            return
        activated = main(force_build=force_build, restart_only=restart_only)
        if not activated:
            print("TaskBoard: restart canceled, recording unknown rather than deployment.", flush=True)
            log.touch(exist_ok=True)
            bookkeep("outcome", str(manifest), "--status", "unknown", "--log", str(log))
            return
        # An agent may edit the checkout while compilation runs. Revalidate the
        # manifest bytes/ancestry after activation before claiming these sources.
        # The idempotent bridge returns the frozen attempt without re-preparing.
        bookkeep("preflight", str(manifest))
        processes = running_custom_processes(root)
        if not processes:
            raise RuntimeError("T3 launch returned but no exact custom executable process observed")
        exe = custom_executable(root)
        if not exe.is_file():
            raise RuntimeError(f"Activated T3 executable missing: {exe}")
        receipt = log.with_suffix(".taskboard-activation.json")
        receipt.write_text(json.dumps({
            "manifest": str(manifest), "executable": str(exe),
            "exe_sha256": hashlib.sha256(exe.read_bytes()).hexdigest(),
            "observed_pids": [p["ProcessId"] for p in processes],
            "observed_at": datetime.now().astimezone().isoformat(),
            "verification": "matching executable alive; feature acceptance unverified"
        }, indent=2), encoding="utf-8")
        bookkeep("outcome", str(manifest), "--status", "deployed",
                 "--artifact", str(exe), "--activation-receipt", str(receipt),
                 "--log", str(log))
    except Exception:
        try:
            # After preflight, errors might follow native activation, so they
            # remain UNKNOWN until independently reconciled, never deployed.
            log.touch(exist_ok=True)
            bookkeep("outcome", str(manifest), "--status", "unknown", "--log", str(log))
        except Exception as exc:
            print(f"TaskBoard UNKNOWN recording also failed: {exc}", file=sys.stderr, flush=True)
        raise


def spawn_independent_worker(root: Path, *, force_build: bool = False, restart_only: bool = False,
                             release_manifest: Path | None = None, full_restart: bool = False) -> None:
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
             *(["--restart-only"] if restart_only else []),
             *(["--replace-electron"] if full_restart else []),
             *(["--taskboard-manifest", str(release_manifest)] if release_manifest else [])],
            cwd=root,
            env={**os.environ, "T3_RELEASE_LOG": str(log_path)},
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.STDOUT,
            creationflags=flags,
            close_fds=True,
        )
    print(
        f"Independent T3 deployment worker started (PID {child.pid}).\n"
        f"Build status log: {log_path}\n"
        + ("Destructive Electron replacement explicitly requested."
         if full_restart else
         "Safe rebuild/UI reload: existing Electron and browser processes stay alive."),
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
                           help="Rebuild all bundles, then safely reload only the UI")
        modes.add_argument("--restart-only", action="store_true",
                           help="Safely reload UI from existing compiled assets")
        parser.add_argument("--full-restart", action="store_true",
                            help="Legacy alias for safe rebuild/UI reload (preserves live browser pages)")
        parser.add_argument("--replace-electron", action="store_true",
                            help="EXPLICITLY destroy the Electron owner and its live browser pages to activate native/backend changes")
        parser.add_argument("--taskboard-manifest", type=Path,
                            help="Optional source-integrated TaskBoard release manifest for durable bookkeeping")
        args = parser.parse_args()
        root = Path(__file__).resolve().parent
        load_private_openrig_human_answer_token()
        if args.dry_run:
            profile = Path(os.environ["APPDATA"]) / "t3code-custom"
            if not (profile / "Local Storage" / "leveldb" / "CURRENT").is_file():
                raise RuntimeError("ChatGPT session storage missing.")
            if not (root / "node_modules" / ".bin" / "vp.cmd").is_file():
                raise RuntimeError("Vite+ build runner missing.")
            print("Preflight OK: session storage, build runner, restart script.")
        elif args.worker:
            mutex = _acquire_worker_lock()
            try:
                manifest = args.taskboard_manifest
                if manifest is None:
                    standard = root / ".t3" / "taskboard-release-manifest.json"
                    manifest = standard if standard.is_file() else None
                _taskboard_release_run(root, manifest, force_build=args.force_build,
                                       restart_only=args.restart_only,
                                       ui_only=not args.replace_electron)
            finally:
                ctypes.windll.kernel32.ReleaseMutex(mutex)
                ctypes.windll.kernel32.CloseHandle(mutex)
        else:
            if args.restart_only and not build_is_current(root):
                raise RuntimeError("Compiled T3 output missing. Run the default command to rebuild first.")
            manifest = args.taskboard_manifest
            if manifest is None:
                standard = root / ".t3" / "taskboard-release-manifest.json"
                manifest = standard if standard.is_file() else None
            spawn_independent_worker(root, force_build=args.force_build,
                                     restart_only=args.restart_only, release_manifest=manifest,
                                     full_restart=args.replace_electron)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Restart/build failed: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
