"""下载包或源码入口：python3 -B -m fbl，不依赖 Node。"""

from pathlib import Path
import sys

sys.dont_write_bytecode = True
root = Path(__file__).resolve().parent
native = next(
    (
        path
        for path in (root / "native-bridge", root / "fast-browser-link/native_bridge")
        if (path / "fbl_cli.py").is_file()
    ),
    None,
)
if native is None:
    raise SystemExit("FBL runtime payload missing")
sys.path.insert(0, str(native))
from fbl_cli import main

if __name__ == "__main__":
    raise SystemExit(main())
