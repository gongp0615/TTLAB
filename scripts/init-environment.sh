#!/usr/bin/env bash
set -Eeuo pipefail

NVM_VERSION="${TTLAB_NVM_VERSION:-v0.40.3}"
NODE_VERSION="${TTLAB_NODE_VERSION:-22}"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
NVM_INSTALL_URL="https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh"
DIST_BASE="${TTLAB_NODE_DIST_BASE:-https://nodejs.org/dist}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[ttlab-init] %s\n' "$*"; }

[[ "$(uname -s)" == Linux ]] || fail 'this script must run inside Linux or WSL, not Windows shell'
[[ -n "${HOME:-}" ]] || fail 'HOME is not set'
command -v bash >/dev/null 2>&1 || fail 'bash is required'

if ! command -v curl >/dev/null 2>&1; then
  fail 'curl is required; install it with: sudo apt-get update && sudo apt-get install -y curl ca-certificates'
fi

# Serial devices on Linux are owned by root:dialout. The current user must be
# a member of dialout for the Client to open /dev/ttyUSB* and /dev/ttyACM*.
# Group membership only takes effect after a new login, so a missing dialout
# here cannot be fixed by this script alone (it would need sudo + re-login).
# Server-only runs (start-server.sh) skip this check by setting TTLAB_SKIP_DIALOUT=1.
ensure_dialout_membership() {
  if [[ "${TTLAB_SKIP_DIALOUT:-0}" == "1" ]]; then
    log 'skipping dialout group check (TTLAB_SKIP_DIALOUT=1)'
    return 0
  fi
  getent group dialout >/dev/null 2>&1 || fail 'the dialout group is required for serial access; create it with: sudo groupadd dialout'

  if [[ "$(id -u)" -eq 0 ]]; then
    # Root can access serial devices directly. When the systemd Client user
    # exists (deployment), make sure it can too.
    if id ttlab >/dev/null 2>&1; then
      if id -nG ttlab | grep -qw dialout; then
        log 'ttlab user already in dialout group'
      else
        log 'adding ttlab user to the dialout group'
        usermod -aG dialout ttlab
      fi
    fi
    return 0
  fi

  local effective_groups
  effective_groups="${TTLAB_TEST_GROUPS:-$(id -nG)}"
  if [[ "$effective_groups" != *"dialout"* ]]; then
    fail "the current user is not in the dialout group, which is required for serial access. Run: sudo usermod -aG dialout $USER  then log out and back in (or run: newgrp dialout)"
  fi
  log 'current user is in the dialout group'
}

ensure_dialout_membership

# Resolve the requested Node.js version: a bare major number (default "22")
# resolves to the latest matching release; an explicit x.y.z is used verbatim.
resolve_node_version() {
  local requested="${1#v}"
  if [[ "$requested" =~ ^[0-9]+$ ]]; then
    local index_json
    if ! index_json="$(curl --fail --silent --show-error --location "$DIST_BASE/index.json")"; then
      fail "unable to fetch Node.js release index from $DIST_BASE"
    fi
    local version
    version="$(printf '%s' "$index_json" | grep -oE "\"version\":\"v${requested}\.[0-9]+\.[0-9]+\"" | head -n 1 | sed -E 's/^"version":"v([^"]+)"$/\1/' || true)"
    if [[ -z "$version" ]]; then
      fail "no Node.js v${requested} release found on $DIST_BASE"
    fi
    printf '%s\n' "$version"
  else
    printf '%s\n' "$requested"
  fi
}

map_node_arch() {
  local machine="$1"
  case "$machine" in
    x86_64) printf 'x64' ;;
    aarch64|arm64) printf 'arm64' ;;
    armv7l) printf 'armv7l' ;;
    *) fail "unsupported architecture for a system-wide Node.js install: $machine (override with TTLAB_NODE_ARCH)" ;;
  esac
}

# System-wide Node.js install for dedicated root servers. Uses the official
# prebuilt binary tarball so that no per-user nvm is needed; deploy-server.sh
# then only requires node/npm on PATH.
install_system_node() {
  local arch
  arch="${TTLAB_NODE_ARCH:-$(map_node_arch "$(uname -m)")}"
  case "$arch" in
    x64|arm64|armv7l) ;;
    *) fail "unsupported Node.js architecture: $arch (expected x64, arm64 or armv7l)" ;;
  esac

  local node_bin
  node_bin="$(command -v node || true)"
  local npm_bin
  npm_bin="$(command -v npm || true)"
  if [[ -n "$node_bin" && -n "$npm_bin" ]]; then
    local current_major
    current_major="$("$node_bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
    local target_major
    target_major="${NODE_VERSION%%[!0-9]*}"
    if [[ -n "$current_major" && "$current_major" =~ ^[0-9]+$ && "$current_major" -ge "${target_major:-22}" ]]; then
      log "Node.js ${current_major} is already installed system-wide at $node_bin; skipping installation"
      log "node: $(command -v node)"
      log "npm:  $(command -v npm)"
      node --version
      npm --version
      exit 0
    fi
  fi

  local version
  version="$(resolve_node_version "$NODE_VERSION")"

  local prefix
  prefix="${TTLAB_NODE_PREFIX:-/usr/local}"
  local tarball_url="$DIST_BASE/v${version}/node-v${version}-linux-${arch}.tar.xz"
  local tarball
  tarball="$(mktemp --suffix=.tar.xz)"
  trap 'rm -f -- "$tarball"' RETURN

  log "installing Node.js ${version} (${arch}) system-wide under $prefix"
  curl --fail --silent --show-error --location "$tarball_url" --output "$tarball"

  local install_dir="$prefix/lib/nodejs"
  mkdir -p "$install_dir"
  tar -xJf "$tarball" -C "$install_dir"
  rm -f -- "$tarball"
  trap - RETURN

  local staged_dir="$install_dir/node-v${version}-linux-${arch}"
  [[ -d "$staged_dir" ]] || fail "Node.js tarball did not contain expected directory: $staged_dir"

  mkdir -p "$prefix/bin"
  ln -sf -- "$staged_dir/bin/node" "$prefix/bin/node"
  ln -sf -- "$staged_dir/bin/npm" "$prefix/bin/npm"
  ln -sf -- "$staged_dir/bin/npx" "$prefix/bin/npx"
  hash -r

  log "node: $prefix/bin/node"
  log "npm:  $prefix/bin/npm"
  "$prefix/bin/node" --version
  "$prefix/bin/npm" --version
}

if [[ "$(id -u)" -eq 0 || "${TTLAB_SYSTEM_NODE:-0}" == "1" ]]; then
  install_system_node
  exit 0
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
