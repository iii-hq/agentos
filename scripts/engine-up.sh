#!/usr/bin/env bash
# Boot the iii engine with a sane file-descriptor limit.
#
# 62 narrow workers + agentmemory's ~120 HTTP routes + WS retries
# blow past macOS's 256 default FD ceiling within seconds, after
# which the engine errors with "Too many open files (os error 24)"
# and dies. Always launch the engine through this script.
#
# Usage:
#   bash scripts/engine-up.sh                # foreground
#   bash scripts/engine-up.sh --background   # nohup'd, logs to ./engine.log

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v iii >/dev/null 2>&1; then
    echo "iii binary not found. Install:"
    echo "  curl -fsSL https://install.iii.dev/iii/main/install.sh | sh"
    exit 1
fi

if [[ ! -f config.yaml ]]; then
    echo "config.yaml not found in $ROOT"
    exit 1
fi

current_fd=$(ulimit -n 2>/dev/null || echo 256)
if [[ "$current_fd" -lt 8192 ]]; then
    if ulimit -n 8192 2>/dev/null; then
        echo "▸ raised FD limit: $current_fd → 8192"
    else
        echo "warning: could not raise FD limit (currently $current_fd)."
        echo "  engine will likely die under worker load. Bump system limit:"
        echo "    sudo launchctl limit maxfiles 65536 unlimited"
    fi
fi

if [[ "${1:-}" == "--background" ]]; then
    nohup iii --config config.yaml > "$ROOT/engine.log" 2>&1 &
    echo "▸ engine PID: $!"
    echo "  logs:  $ROOT/engine.log"
    echo "  stop:  kill $!"
else
    exec iii --config config.yaml
fi
