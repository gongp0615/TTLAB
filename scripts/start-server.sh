#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
NODE_VERSION="${TTLAB_NODE_VERSION:-22}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[ttlab-start] %s\n' "$*"; }

[[ "$(uname -s)" == Linux ]] || fail 'run this script inside Linux or WSL'
[[ "$(id -u)" -ne 0 ]] || fail 'run this script as a normal user; the script uses sudo only for Server startup'
command -v sudo >/dev/null 2>&1 || fail 'sudo is required to bind Server to port 80'
[[ -f "$PROJECT_ROOT/server.env" ]] || fail "server.env does not exist: $PROJECT_ROOT/server.env"

cd "$PROJECT_ROOT"

# This installs nvm/Node for the current user when the machine is not initialized yet.
bash "$SCRIPT_DIR/init-environment.sh"
export NVM_DIR
# shellcheck disable=SC1090
source "$NVM_DIR/nvm.sh"
nvm use "$NODE_VERSION" >/dev/null
hash -r

NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"
[[ "$NODE_BIN" != *.exe && "$NPM_BIN" != *.cmd ]] || fail 'Windows node/npm was selected; check the WSL PATH configuration'

log "using Node.js at $NODE_BIN"
log 'installing Linux dependencies from package-lock.json'
"$NPM_BIN" ci
log 'building Server'
"$NPM_BIN" run build
log 'starting Server from server.env on port configured by the repository'
exec sudo "$NODE_BIN" "$PROJECT_ROOT/dist/apps/server/src/index.js"
