#!/usr/bin/env bash
# Generic outer restart loop for dev servers with proper process-group cleanup.
#
# Why this exists: a naive `while :; do npm run X; done` loop is fragile
# because `npm`/`tsx` do NOT forward SIGTERM to their child node processes.
# If the npm wrapper is killed (Ctrl-C against the wrong PID, tmux kill-pane,
# manual `kill <pid>`, etc.) the real server is left orphaned, still holding
# its TCP port, and the loop spins forever on EADDRINUSE.
#
# Pairs naturally with `tsx watch` for the api: the inner `tsx watch` handles
# in-process restart on every file change; the outer dev-loop only kicks in
# if `tsx watch` itself crashes (rare, e.g. on a SyntaxError in the watched
# entrypoint).
#
# This script:
#   - Runs the child in its OWN process group (setsid) so we can SIGKILL the
#     whole group on exit / restart.
#   - Traps EXIT/INT/TERM and kills the group, so nothing survives this script.
#   - If a TCP port is declared, frees it before each iteration as a belt-and-
#     suspenders cleanup against leftover orphans from previous runs.
#
# Usage:
#   scripts/dev-loop.sh <name> <port-or-empty> -- <command...>
#
# Examples:
#   scripts/dev-loop.sh api 8787 -- npm run dev:api
#   scripts/dev-loop.sh web ""   -- npm run dev -- --host 0.0.0.0
#
# Env:
#   RESTART_DELAY  seconds between restarts (default: 2)
#   LOG_PREFIX     prefix for log lines (default: $name)

set -u

if [[ $# -lt 3 ]]; then
  echo "usage: $0 <name> <port-or-empty> -- <command...>" >&2
  exit 64
fi

name="$1"; shift
port="$1"; shift
if [[ "$1" != "--" ]]; then
  echo "expected '--' before command, got: $1" >&2
  exit 64
fi
shift

RESTART_DELAY="${RESTART_DELAY:-2}"
LOG_PREFIX="${LOG_PREFIX:-$name}"

log() { printf '[%s %s] %s\n' "$LOG_PREFIX" "$(date '+%F %T')" "$*"; }

child_pgid=""

kill_group() {
  local pgid="$1"
  [[ -n "$pgid" ]] || return 0
  # Polite first.
  kill -TERM -"$pgid" 2>/dev/null || true
  # Give children up to 3s to detach cleanly.
  for _ in 1 2 3 4 5 6; do
    kill -0 -"$pgid" 2>/dev/null || return 0
    sleep 0.5
  done
  kill -KILL -"$pgid" 2>/dev/null || true
}

# Find LISTEN holders for a TCP port. Tries lsof, then ss, then /proc.
listeners_for_port() {
  local p="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti tcp:"$p" -sTCP:LISTEN 2>/dev/null
    return
  fi
  if command -v ss >/dev/null 2>&1; then
    # Example users field: users:(("node",pid=1234,fd=37))
    ss -tlnpH "sport = :$p" 2>/dev/null \
      | grep -oE 'pid=[0-9]+' \
      | cut -d= -f2 \
      | sort -u
    return
  fi
  # Fallback: scan /proc — slow but portable.
  local hex_port
  hex_port=$(printf '%04X' "$p")
  awk -v port=":$hex_port" '$2 ~ port"$" && $4=="0A" {print $10}' /proc/net/tcp /proc/net/tcp6 2>/dev/null \
    | sort -u \
    | while read -r inode; do
        for pid_dir in /proc/[0-9]*; do
          for fd in "$pid_dir"/fd/*; do
            [[ -L "$fd" ]] || continue
            target=$(readlink "$fd" 2>/dev/null) || continue
            if [[ "$target" == "socket:[$inode]" ]]; then
              basename "$pid_dir"
            fi
          done
        done
      done | sort -u
}

free_port() {
  local p="$1"
  [[ -n "$p" ]] || return 0
  local pids
  pids="$(listeners_for_port "$p" | tr '\n' ' ')"
  pids="${pids% }"
  if [[ -n "$pids" ]]; then
    log "port $p still held by pid(s): $pids — sending SIGKILL"
    # shellcheck disable=SC2086
    kill -KILL $pids 2>/dev/null || true
    sleep 0.5
  fi
}

cleanup() {
  log "shutting down (pgid=$child_pgid)"
  kill_group "$child_pgid"
  free_port "$port"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Ensure setsid is available; fall back to plain exec if not.
if ! command -v setsid >/dev/null 2>&1; then
  log "warning: setsid not found; process-group cleanup will be best-effort"
fi

while :; do
  free_port "$port"
  log "starting: $*"

  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" &
  else
    "$@" &
  fi
  child_pid=$!
  # The child is the leader of its own group, so pgid == pid.
  child_pgid=$child_pid

  wait "$child_pid"
  code=$?

  # Whether the child exited cleanly or was signalled, make sure no grandchildren
  # are left behind holding the port.
  kill_group "$child_pgid"
  child_pgid=""

  log "exited with code $code; restarting in ${RESTART_DELAY}s"
  sleep "$RESTART_DELAY"
done
