#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null || { echo "Install Node.js 20+"; exit 1; }
command -v ffmpeg >/dev/null || echo "WARNING: ffmpeg not on PATH"
exec npm start
