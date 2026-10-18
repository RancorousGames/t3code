"""Launch the compiled T3 Code source checkout (never the installed release).

compile_t3.py prepares .electron-runtime/windows-custom/T3 Code (Custom).exe with a
stub that boots this checkout, so the exe works on its own and can be pinned to the
taskbar. A second launch focuses the running window. Run compile_t3.py after
source changes.
"""

import ctypes
import os
from pathlib import Path
import subprocess
import sys


def main() -> None:
    root = Path(__file__).resolve().parent
    exe = root / ".electron-runtime" / "windows-custom" / "T3 Code (Custom).exe"
    required = [
        exe,
        exe.parent / "resources" / "app" / "index.cjs",
        root / "apps" / "desktop" / "dist-electron" / "boot.cjs",
        root / "apps" / "desktop" / "dist-electron" / "main.cjs",
        root / "apps" / "server" / "dist" / "bin.mjs",
        root / "apps" / "server" / "dist" / "client" / "index.html",
    ]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise RuntimeError("Run compile_t3.py first. Missing:\n\n" + "\n".join(missing))

    env = os.environ.copy()
    env.pop("ELECTRON_RUN_AS_NODE", None)
    subprocess.Popen(
        [str(exe)],
        cwd=exe.parent,
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
        message = f"Could not start T3 Code (Custom):\n\n{error}"
        ctypes.windll.user32.MessageBoxW(0, message, "T3 Code (Custom)", 0x10)
        print(message, file=sys.stderr)
        sys.exit(1)
