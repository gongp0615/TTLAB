#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[ttlab-restart-client] %s\n' "$*"; }

[[ "$(uname -s)" == Linux ]] || fail 'run this script inside Linux or WSL'

SERVICE_NAME="${TTLAB_CLIENT_SERVICE_NAME:-ttlab-client}"
GRACE_SECONDS="${TTLAB_RESTART_GRACE_SECONDS:-10}"

if [[ "$(id -u)" -eq 0 ]]; then
  IS_ROOT=1
else
  IS_ROOT=0
fi

# The deployed Client is managed by systemd with Restart=always, so killing the
# process by hand would fight systemd. Prefer the service when it is active and
# fall back to the foreground debug process started by start-client.sh.
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$SERVICE_NAME.service" 2>/dev/null; then
  if [[ "$IS_ROOT" -eq 1 ]]; then
    systemctl restart "$SERVICE_NAME.service"
  elif systemctl restart "$SERVICE_NAME.service"; then
    :
  else
    command -v sudo >/dev/null 2>&1 || fail "restarting $SERVICE_NAME.service requires root or sudo"
    log 'restarting with sudo'
    sudo systemctl restart "$SERVICE_NAME.service"
  fi
  if systemctl is-active --quiet "$SERVICE_NAME.service" 2>/dev/null; then
    log "$SERVICE_NAME.service restarted"
  else
    fail "$SERVICE_NAME.service did not come back up; inspect with: journalctl -u $SERVICE_NAME.service -e"
  fi
  exit 0
fi

client_pids() {
  # Match node processes whose command line references the Client entry module.
  # Using ps + awk (instead of pgrep -x) avoids matching the Server process or
  # the intermediate sh/sg wrappers that launch the Client. Matching the
  # relative path also covers an absolute path, which contains it as a suffix.
  ps -eo pid=,comm=,args= | awk -v module="dist/apps/client/src/index.js" '
    $2 == "node" && index($0, module) > 0 { print $1 }'
}

kill_client() {
  local signal="$1"
  local pids="$2"
  [[ -n "$pids" ]] || return 0
  local signalled=0
  if [[ "$IS_ROOT" -eq 1 ]]; then
    kill "-$signal" $pids 2>/dev/null && signalled=1
  elif kill "-$signal" $pids 2>/dev/null; then
    signalled=1
  fi
  if [[ "$signalled" -eq 0 ]]; then
    # A normal user can signal its own processes directly; sudo is only a
    # fallback for a Client that was started via sudo or another user.
    local remaining
    remaining="$(client_pids)"
    [[ -n "$remaining" ]] || return 0
    command -v sudo >/dev/null 2>&1 || fail "signalling the Client process requires root or sudo"
    sudo kill "-$signal" $remaining 2>/dev/null || true
  fi
}

stop_client() {
  local pids
  pids="$(client_pids)"
  if [[ -z "$pids" ]]; then
    log 'no running Client process found; skipping stop'
    return 0
  fi
  log "stopping Client process(es): $pids"
  kill_client TERM "$pids"
  local waited=0
  while [[ "$waited" -lt "$GRACE_SECONDS" ]]; do
    if [[ -z "$(client_pids)" ]]; then
      log 'Client stopped'
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  log "Client did not exit within ${GRACE_SECONDS}s; forcing SIGKILL"
  kill_client KILL "$(client_pids)"
}

stop_client
log 'restarting Client'
exec bash "$SCRIPT_DIR/start-client.sh"
