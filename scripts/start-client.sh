#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
NODE_VERSION="${TTLAB_NODE_VERSION:-22}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[ttlab-client-start] %s\n' "$*"; }

[[ "$(uname -s)" == Linux ]] || fail 'run this script inside Linux or WSL'
if [[ "$(id -u)" -eq 0 ]]; then
  IS_ROOT=1
else
  IS_ROOT=0
fi
if [[ ! -f "$PROJECT_ROOT/server.env" ]]; then
  if [[ -f "$PROJECT_ROOT/server.env.example" ]]; then
    cp "$PROJECT_ROOT/server.env.example" "$PROJECT_ROOT/server.env"
    log 'created server.env from server.env.example; edit it to set the port and host'
  else
    fail "server.env does not exist: $PROJECT_ROOT/server.env"
  fi
fi

cd "$PROJECT_ROOT"
bash "$SCRIPT_DIR/init-environment.sh"
if [[ "$IS_ROOT" -eq 0 ]]; then
  export NVM_DIR
  # shellcheck disable=SC1090
  source "$NVM_DIR/nvm.sh"
  nvm use "$NODE_VERSION" >/dev/null
  hash -r
fi

NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"
[[ "$NODE_BIN" != *.exe && "$NPM_BIN" != *.cmd ]] || fail 'Windows node/npm was selected; check the WSL PATH configuration'

log "using Node.js at $NODE_BIN"
log 'installing Linux dependencies from package-lock.json'
"$NPM_BIN" ci
log 'building current Client source'
"$NPM_BIN" run build

export TTLAB_SERVER_URL="${TTLAB_SERVER_URL:-ws://127.0.0.1:9000/agent/v1/session}"
export TTLAB_STATE_DIR="${TTLAB_STATE_DIR:-$HOME/.local/state/ttlab-client}"
export TTLAB_CLIENT_AUTH_ENABLED="${TTLAB_CLIENT_AUTH_ENABLED:-0}"
export TTLAB_SERIAL_DEVICE_TYPE="${TTLAB_SERIAL_DEVICE_TYPE:-generic-serial}"

if [[ -f /proc/version ]] && grep -qi microsoft /proc/version; then
  log 'WSL detected; checking USB serial devices for this environment'
  bash "$SCRIPT_DIR/serial-attach.sh" status || true
  if [[ "${TTLAB_WSL_SERIAL_AUTO_ATTACH:-1}" != 0 ]]; then
    if bash "$SCRIPT_DIR/serial-attach.sh" attach; then
      log 'USB serial devices attached'
    else
      log 'WARNING: USB serial attach did not complete; the Client will still start but may report no serial devices'
      log 'attach manually from a Windows admin PowerShell: usbipd attach --wsl --busid=<BUSID>'
      log 'or run: bash scripts/serial-attach.sh attach'
    fi
  fi
fi

log "connecting to $TTLAB_SERVER_URL"
log "state directory: $TTLAB_STATE_DIR"
exec "$NODE_BIN" "$PROJECT_ROOT/dist/apps/client/src/index.js"
