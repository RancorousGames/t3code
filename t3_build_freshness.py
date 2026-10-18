"""Conservative source/build fingerprint for the custom Windows T3 launcher.

The fast restart path is permitted only if every relevant source file still
matches the snapshot recorded before a successful full desktop build.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Iterable

STAMP_RELATIVE = Path(".t3") / "compiled-source-inputs.json"

# Frontend, backend and Electron are built together for the pinned custom app.
SOURCE_DIRS = (
    Path("apps/web/src"),
    Path("apps/web/public"),
    Path("apps/server/src"),
    Path("apps/desktop/src"),
    Path("packages"),
    Path("scripts"),
    Path("assets/dev"),
)
ROOT_INPUTS = (
    "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
    "vite.config.ts", "vp.config.ts", "third-party-licenses.config.json",
)
SKIPPED_DIRS = {
    ".git", ".t3", ".vite", ".vite-plus", "node_modules", "dist",
    "dist-electron", "build", "coverage", "__pycache__", "__tests__",
    ".electron-runtime", "test", "tests",
}
SOURCE_SUFFIXES = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc",
    ".css", ".scss", ".html", ".wasm", ".svg", ".png", ".ico",
    ".py", ".toml", ".yaml", ".yml", ".md", ".lock",
}
BUILD_OUTPUTS = (
    Path("apps/web/dist/index.html"),
    Path("apps/server/dist/client/index.html"),
    Path("apps/server/dist/bin.mjs"),
    Path("apps/desktop/dist-electron/boot.cjs"),
    Path("apps/desktop/dist-electron/main.cjs"),
    Path(".electron-runtime/windows-custom/T3 Code (Custom).exe"),
    Path(".electron-runtime/windows-custom/resources/app/index.cjs"),
)


def _is_input(relative: Path) -> bool:
    name = relative.name.lower()
    if name.endswith((".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx",
                      ".node.test.mjs", ".test.mjs", ".generated.ts")):
        return False
    if relative.parts[0] == "scripts" and relative.suffix == ".py":
        # Python launcher logic changes do not affect the compiled app.
        return False
    return relative.suffix.lower() in SOURCE_SUFFIXES or name in ROOT_INPUTS


def _source_files(root: Path) -> Iterable[Path]:
    for target in SOURCE_DIRS:
        location = root / target
        if not location.is_dir():
            continue
        for directory, dirs, filenames in os.walk(location):
            dirs[:] = [name for name in dirs if name not in SKIPPED_DIRS]
            for filename in filenames:
                path = Path(directory) / filename
                if _is_input(path.relative_to(root)):
                    yield path
    for filename in ROOT_INPUTS:
        path = root / filename
        if path.is_file():
            yield path
    for subdir in ("apps/web", "apps/server", "apps/desktop"):
        for filename in ("package.json", "vite.config.ts", "tsconfig.json"):
            path = root / subdir / filename
            if path.is_file():
                yield path


def source_fingerprint(root: Path) -> str:
    digest = hashlib.sha256()
    files = sorted(_source_files(root), key=lambda path: str(path).lower())
    for path in files:
        stat = path.stat()
        name = path.relative_to(root).as_posix()
        digest.update(f"{name}\0{stat.st_size}\0{stat.st_mtime_ns}\n".encode("utf-8"))
    return digest.hexdigest()


def remember_build(root: Path, fingerprint: str) -> None:
    location = root / STAMP_RELATIVE
    location.parent.mkdir(parents=True, exist_ok=True)
    location.write_text(json.dumps({"source_fingerprint": fingerprint}, indent=2) + "\n",
                        encoding="utf-8")


def build_is_current(root: Path) -> bool:
    if any(not (root / output).is_file() for output in BUILD_OUTPUTS):
        return False
    try:
        stamp = json.loads((root / STAMP_RELATIVE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    recorded = stamp.get("source_fingerprint")
    return isinstance(recorded, str) and recorded == source_fingerprint(root)
