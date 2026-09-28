from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "helpers" / "wave-capture" / "wave_capture.py"
BUILD = ROOT / "helpers" / "wave-capture" / ".build"
OUTPUT_DIR = ROOT / "helpers" / "wave-capture" / "build"
DEPENDENCIES = ROOT / "virtualdj-skin" / ".deps"
OUTPUT = OUTPUT_DIR / "WaveCapture.exe"


def pip_install(target: Path, *packages: str) -> None:
    target.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--target", str(target), *packages],
        check=True,
    )


def main() -> None:
    if sys.platform != "win32" or sys.maxsize <= 2**32:
        raise SystemExit("WaveCapture must be built with 64-bit Python on Windows.")
    if sys.version_info < (3, 14):
        raise SystemExit("Python 3.14 or newer is required to build the pinned Windows Graphics Capture dependency.")
    if not SOURCE.is_file():
        raise SystemExit(f"Capture source is missing: {SOURCE}")

    BUILD.mkdir(parents=True, exist_ok=True)
    build_tools = BUILD / "tools"
    if importlib.util.find_spec("PyInstaller") is None:
        if (build_tools / "PyInstaller").is_dir():
            sys.path.insert(0, str(build_tools))
        else:
            pip_install(build_tools, "PyInstaller==6.22.3")
            sys.path.insert(0, str(build_tools))

    dependencies = DEPENDENCIES
    try:
        sys.path.insert(0, str(dependencies))
        import cv2  # noqa: F401
        import numpy  # noqa: F401
        import windows_capture  # noqa: F401
    except ImportError:
        dependencies = BUILD / "dependencies"
        if not (dependencies / "windows_capture").is_dir():
            pip_install(dependencies, "-r", str(ROOT / "requirements-waveform.txt"))
        sys.path.insert(0, str(dependencies))

    from PyInstaller.__main__ import run

    if OUTPUT.exists():
        OUTPUT.unlink()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    work = BUILD / "pyinstaller-work"
    spec = BUILD / "spec"
    run([
        str(SOURCE),
        "--noconfirm",
        "--clean",
        "--onefile",
        "--console",
        "--name", "WaveCapture",
        "--distpath", str(OUTPUT_DIR),
        "--workpath", str(work),
        "--specpath", str(spec),
        "--paths", str(dependencies),
        "--hidden-import", "windows_capture.windows_capture",
        "--collect-binaries", "windows_capture",
    ])
    if not OUTPUT.is_file() or OUTPUT.stat().st_size < 1_000_000:
        raise SystemExit("PyInstaller did not produce a valid WaveCapture.exe")
    print(f"Built {OUTPUT} ({OUTPUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
