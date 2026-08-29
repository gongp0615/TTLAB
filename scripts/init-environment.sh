#!/usr/bin/env bash
set -Eeuo pipefail

NVM_VERSION="${TTLAB_NVM_VERSION:-v0.40.3}"
NODE_VERSION="${TTLAB_NODE_VERSION:-22}"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
NVM_INSTALL_URL="https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[ttlab-init] %s\n' "$*"; }

[[ "$(uname -s)" == Linux ]] || fail 'this script must run inside Linux or WSL, not Windows shell'
[[ "$(id -u)" -ne 0 ]] || fail 'do not run this script with sudo; nvm is installed for the current user'
[[ -n "${HOME:-}" ]] || fail 'HOME is not set'
command -v bash >/dev/null 2>&1 || fail 'bash is required'

if ! command -v curl >/dev/null 2>&1; then
  fail 'curl is required; install it with: sudo apt-get update && sudo apt-get install -y curl ca-certificates'
fi

install_nvm() {
  local installer
  installer="$(mktemp)"
  trap 'rm -f -- "$installer"' RETURN
  log "installing nvm ${NVM_VERSION}"
  curl --fail --silent --show-error --location "$NVM_INSTALL_URL" --output "$installer"
  NVM_DIR="$NVM_DIR" bash "$installer"
  rm -f -- "$installer"
  trap - RETURN
}

if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  install_nvm
fi

# nvm is a shell function, so loading its script is required in this process.
export NVM_DIR
# shellcheck disable=SC1090
source "$NVM_DIR/nvm.sh"

command -v nvm >/dev/null 2>&1 || fail 'nvm was not loaded successfully'
log "installing Node.js ${NODE_VERSION}"
nvm install "$NODE_VERSION"
nvm alias default "$NODE_VERSION"
nvm use "$NODE_VERSION" >/dev/null
hash -r

log "node: $(command -v node)"
log "npm:  $(command -v npm)"
node --version
npm --version

case ":${PATH}:" in
  *":${NVM_DIR}/versions/node/"*) ;;
  *) log 'open a new shell or run: source ~/.bashrc' ;;
esac
