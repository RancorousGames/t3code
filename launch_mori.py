"""Launch Monku no Mori from this checkout (apps/mori-desktop, separate profile from T3).

Starts the Electron shell in apps/mori-desktop with the renderer built from apps/mori-web/dist.
Pass --build to rebuild the renderer first. A second launch focuses the running window, because
the shell takes a single-instance lock. Monku keeps its own userData folder (%APPDATA%/MonkuNoMori).
"""

import argparse
import ctypes
import os
from pathlib import Path
import subprocess
import sys


def build_renderer(root: Path) -> None:
    web = root / "apps" / "mori-web"
    vp = root / "node_modules" / ".bin" / "vp.CMD"
    result = subprocess.run([str(vp), "build"], cwd=web, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Building apps/mori-web failed:\n\n{result.stdout}\n{result.stderr}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--build", action="store_true", help="rebuild apps/mori-web/dist before launching")
    args = parser.parse_args()

    root = Path(__file__).resolve().parent
    desktop = root / "apps" / "mori-desktop"
    exe = desktop / "node_modules" / "electron" / "dist" / "electron.exe"
    renderer = root / "apps" / "mori-web" / "dist" / "index.html"

    if args.build:
        build_renderer(root)

    required = [exe, desktop / "main.cjs", renderer]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        hint = "" if args.build else "\n\nRun launch_mori.py --build, or install dependencies with pnpm install if electron.exe is missing."
        raise RuntimeError("Missing:\n\n" + "\n".join(missing) + hint)

    env = os.environ.copy()
    env.pop("ELECTRON_RUN_AS_NODE", None)
    subprocess.Popen(
        [str(exe), str(desktop)],
        cwd=desktop,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
    )


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError) as error:
        message = f"Could not start Monku no Mori:\n\n{error}"
        ctypes.windll.user32.MessageBoxW(0, message, "Monku no Mori", 0x10)
        print(message, file=sys.stderr)
        sys.exit(1)
