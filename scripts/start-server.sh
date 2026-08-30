#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
NODE_VERSION="${TTLAB_NODE_VERSION:-22}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[ttlab-start] %s\n' "$*"; }

[[ "$(uname -s)" == Linux ]] || fail 'run this script inside Linux or WSL'
if [[ "$(id -u)" -eq 0 ]]; then
  IS_ROOT=1
else
  IS_ROOT=0
  command -v sudo >/dev/null 2>&1 || fail 'sudo is required to bind Server to port 80'
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

# This installs nvm/Node for the current user when the machine is not initialized yet.
# As root it installs Node.js system-wide instead, so the nvm steps are skipped.
# The Server does not access serial devices, so the dialout check is skipped.
TTLAB_SKIP_DIALOUT=1 bash "$SCRIPT_DIR/init-environment.sh"
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
log 'building Server'
"$NPM_BIN" run build
log 'starting Server from server.env on port configured by the repository'
if [[ "$IS_ROOT" -eq 0 ]]; then
  exec sudo "$NODE_BIN" "$PROJECT_ROOT/dist/apps/server/src/index.js"
else
  exec "$NODE_BIN" "$PROJECT_ROOT/dist/apps/server/src/index.js"
fi
