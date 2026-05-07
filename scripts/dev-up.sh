#!/usr/bin/env bash
# Boot the agentos dev stack: every release worker binary connects to the
# local iii engine on ws://localhost:49134. Run this in a second terminal
# after `iii --config config.yaml` is up.
#
# Usage:
#   bash scripts/dev-up.sh           # spawn all release workers in background
#   bash scripts/dev-up.sh --build   # cargo build --workspace --release first
#   bash scripts/dev-up.sh stop      # kill anything launched here
#
# Env:
#   III_WS_URL                       (default: ws://localhost:49134)
#   ANTHROPIC_API_KEY                required for llm-router

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="$ROOT/.agentos-dev.pids"
RELEASE_DIR="$ROOT/target/release"

export III_WS_URL="${III_WS_URL:-ws://localhost:49134}"

stop_workers() {
    if [[ ! -f "$PIDFILE" ]]; then
        echo "no PID file at $PIDFILE — nothing to stop"
        return 0
    fi
    while read -r pid; do
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
        fi
    done < "$PIDFILE"
    rm -f "$PIDFILE"
    echo "stopped."
}

if [[ "${1:-}" == "stop" ]]; then
    stop_workers
    exit 0
fi

if [[ "${1:-}" == "--build" ]]; then
    echo "▸ cargo build --workspace --release"
    (cd "$ROOT" && cargo build --workspace --release)
fi

if [[ ! -d "$RELEASE_DIR" ]]; then
    echo "no release binaries at $RELEASE_DIR"
    echo "  run: bash scripts/dev-up.sh --build"
    exit 1
fi

if [[ -f "$PIDFILE" ]]; then
    live=0
    while read -r pid; do
        kill -0 "$pid" 2>/dev/null && live=$((live + 1)) || true
    done < "$PIDFILE"
    if [[ $live -gt 0 ]]; then
        echo "$live workers already running from a prior dev-up. Stop first:"
        echo "  bash scripts/dev-up.sh stop"
        exit 1
    fi
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    echo "warning: ANTHROPIC_API_KEY not set — llm-router will fall through to mocks"
fi

current_fd=$(ulimit -n 2>/dev/null || echo 256)
if [[ "$current_fd" -lt 4096 ]]; then
    echo "warning: file-descriptor limit is $current_fd. 62 workers need ~1500."
    echo "  bump it before spawning:  ulimit -n 8192"
fi

> "$PIDFILE"
spawned=0
for bin in "$RELEASE_DIR"/agentos-*; do
    name="$(basename "$bin")"
    case "$name" in
        agentos-tui|agentos-cli|*.d|*.dSYM) continue ;;
    esac
    [[ -x "$bin" ]] || continue
    "$bin" >> "$ROOT/.agentos-${name#agentos-}.log" 2>&1 &
    echo $! >> "$PIDFILE"
    spawned=$((spawned + 1))
done

echo "▸ spawned $spawned workers · pids in $PIDFILE"
echo "  logs:  $ROOT/.agentos-*.log"
echo "  stop:  bash scripts/dev-up.sh stop"
