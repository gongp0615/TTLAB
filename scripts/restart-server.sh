#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[ttlab-restart] %s\n' "$*"; }

[[ "$(uname -s)" == Linux ]] || fail 'run this script inside Linux or WSL'

SERVER_MODULE="$PROJECT_ROOT/dist/apps/server/src/index.js"
GRACE_SECONDS="${TTLAB_RESTART_GRACE_SECONDS:-10}"

# sudo is used when running as a normal user because the port binding and a
# sudo-started Server need elevated privileges. Kill is attempted directly
# first (works for a same-user Server); sudo is a fallback only.
if [[ "$(id -u)" -eq 0 ]]; then
  IS_ROOT=1
  RUN=(env)
else
  IS_ROOT=0
  command -v sudo >/dev/null 2>&1 || fail 'sudo is required to stop and restart the Server'
  RUN=(sudo env)
fi

server_pids() {
  # Match node processes whose command line references the Server entry
  # module. Using ps + awk (instead of pgrep -x) avoids matching the Client
  # process or intermediate bash wrappers.
  ps -eo pid=,comm=,args= | awk -v module="dist/apps/server/src/index.js" '
    $2 == "node" && index($0, module) > 0 { print $1 }'
}

kill_pids() {
  local signal="$1"
  shift
  local pids="$*"
  [[ -n "$pids" ]] || return 0
  # A normal user can signal its own processes without sudo; fall back to sudo
  # for a Server that was started via sudo.
  if [[ "$IS_ROOT" -eq 1 ]] || kill "-$signal" $pids 2>/dev/null; then
    return 0
  fi
  "${RUN[@]}" kill "-$signal" $pids 2>/dev/null || true
}

stop_server() {
  local pids
  pids="$(server_pids)"
  if [[ -z "$pids" ]]; then
    log 'no running Server process found; skipping stop'
    return 0
  fi
  log "stopping Server process(es): $pids"
  # SIGTERM for graceful shutdown; wait briefly, then escalate to SIGKILL.
  kill_pids TERM "$pids"
  local waited=0
  while [[ "$waited" -lt "$GRACE_SECONDS" ]]; do
    if [[ -z "$(server_pids)" ]]; then
      log 'Server stopped'
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  log "Server did not exit within ${GRACE_SECONDS}s; forcing SIGKILL"
  kill_pids KILL "$(server_pids)"
}

stop_server
log 'restarting Server'
exec bash "$SCRIPT_DIR/start-server.sh"
