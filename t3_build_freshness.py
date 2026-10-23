"""Check whether required T3 compiled outputs exist, without source fingerprinting."""
from pathlib import Path

BUILD_OUTPUTS = (
    Path("apps/web/dist/index.html"),
    Path("apps/server/dist/client/index.html"),
    Path("apps/server/dist/bin.mjs"),
    Path("apps/desktop/dist-electron/boot.cjs"),
    Path("apps/desktop/dist-electron/main.cjs"),
    Path(".electron-runtime/windows-custom/T3 Code (Custom).exe"),
    Path(".electron-runtime/windows-custom/resources/app/index.cjs"),
)

def build_is_current(root: Path) -> bool:
    return all((root / output).is_file() for output in BUILD_OUTPUTS)
