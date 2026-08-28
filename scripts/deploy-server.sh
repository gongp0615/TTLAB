#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_ROOT="${TTLAB_SERVER_INSTALL_ROOT:-/opt/ttlab/server}"
VERSION="${TTLAB_VERSION:-$(date -u +%Y%m%d%H%M%S)}"
SERVICE_NAME="${TTLAB_SERVER_SERVICE_NAME:-ttlab-server}"
ENV_FILE="${TTLAB_SERVER_ENV_FILE:-/etc/ttlab/server.env}"
PORT="${TTLAB_SERVER_PORT:-8080}"
PUBLIC_BASE_URL="${TTLAB_PUBLIC_BASE_URL:-http://127.0.0.1:${PORT}}"
RELEASE_DIRECTORY="${TTLAB_RELEASE_DIR:-/srv/ttlab/releases}"
CLIENT_TOKENS="${TTLAB_CLIENT_TOKENS:-}"
NODE_BIN="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[ttlab-server] %s\n' "$*"; }
cleanup() { if [[ -n "${STAGING_DIR:-}" && -d "$STAGING_DIR" ]]; then rm -rf -- "$STAGING_DIR"; fi; }
trap cleanup EXIT

[[ "$(id -u)" -eq 0 ]] || fail 'run this script as root, for example: sudo -E ./scripts/deploy-server.sh'
[[ -n "$NODE_BIN" ]] || fail 'node is required'
[[ -n "$NPM_BIN" ]] || fail 'npm is required'
[[ "$VERSION" =~ ^[A-Za-z0-9._-]+$ ]] || fail 'TTLAB_VERSION contains unsafe characters'
[[ -n "$CLIENT_TOKENS" ]] || fail 'TTLAB_CLIENT_TOKENS is required; do not deploy with a default token'
[[ "$CLIENT_TOKENS" != *$'\n'* && "$CLIENT_TOKENS" != *$'\r'* ]] || fail 'TTLAB_CLIENT_TOKENS must not contain newlines'
[[ "$CLIENT_TOKENS" =~ ^[A-Za-z0-9._~+=,-]+$ ]] || fail 'TTLAB_CLIENT_TOKENS contains characters that are unsafe in a systemd EnvironmentFile'

NODE_MAJOR="$($NODE_BIN -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 22 )) || fail "Node.js 22 or newer is required, found $($NODE_BIN --version)"

install -d -m 0755 "$INSTALL_ROOT/releases" "$RELEASE_DIRECTORY" /etc/ttlab
if ! id ttlab-server >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/ttlab-server --create-home --shell /usr/sbin/nologin ttlab-server
fi
log 'installing dependencies and building the release'
cd "$SOURCE_ROOT"
"$NPM_BIN" ci
"$NPM_BIN" run build

STAGING_DIR="$INSTALL_ROOT/releases/.staging-${VERSION}-$$"
RELEASE_DIR="$INSTALL_ROOT/releases/$VERSION"
[[ ! -e "$RELEASE_DIR" ]] || fail "release already exists: $RELEASE_DIR"
install -d -m 0755 "$STAGING_DIR"
cp -a "$SOURCE_ROOT/dist" "$STAGING_DIR/dist"
cp -a "$SOURCE_ROOT/node_modules" "$STAGING_DIR/node_modules"
install -m 0644 "$SOURCE_ROOT/index.html" "$STAGING_DIR/index.html"
install -m 0644 "$SOURCE_ROOT/app.js" "$STAGING_DIR/app.js"
install -m 0644 "$SOURCE_ROOT/styles.css" "$STAGING_DIR/styles.css"
mv -- "$STAGING_DIR" "$RELEASE_DIR"
STAGING_DIR=''

PREVIOUS_TARGET=''
if [[ -e "$INSTALL_ROOT/current" || -L "$INSTALL_ROOT/current" ]]; then
  PREVIOUS_TARGET="$(readlink -f "$INSTALL_ROOT/current")"
fi
ln -s -- "$RELEASE_DIR" "$INSTALL_ROOT/current.next.$$"
mv -Tf -- "$INSTALL_ROOT/current.next.$$" "$INSTALL_ROOT/current"

ENV_TMP="$(mktemp /etc/ttlab/server.env.XXXXXX)"
umask 077
printf '%s\n' \
  "TTLAB_SERVER_PORT=$PORT" \
  "TTLAB_WEB_ROOT=$INSTALL_ROOT/current" \
  "TTLAB_RELEASE_DIR=$RELEASE_DIRECTORY" \
  "TTLAB_PUBLIC_BASE_URL=$PUBLIC_BASE_URL" \
  "TTLAB_CLIENT_TOKENS=$CLIENT_TOKENS" > "$ENV_TMP"
install -o root -g ttlab-server -m 0640 "$ENV_TMP" "$ENV_FILE"
rm -f -- "$ENV_TMP"

SERVICE_TMP="$(mktemp /etc/systemd/system/${SERVICE_NAME}.service.XXXXXX)"
cat > "$SERVICE_TMP" <<EOF
[Unit]
Description=TTLAB Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_ROOT/current
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $INSTALL_ROOT/current/dist/apps/server/src/index.js
User=ttlab-server
Group=ttlab-server
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
install -o root -g root -m 0644 "$SERVICE_TMP" "/etc/systemd/system/${SERVICE_NAME}.service"
rm -f -- "$SERVICE_TMP"

systemctl daemon-reload
if ! systemctl enable --now "$SERVICE_NAME.service" || ! systemctl is-active --quiet "$SERVICE_NAME.service"; then
  log 'new Server failed to start; restoring the previous release'
  if [[ -n "$PREVIOUS_TARGET" ]]; then
    ln -s -- "$PREVIOUS_TARGET" "$INSTALL_ROOT/current.rollback.$$"
    mv -Tf -- "$INSTALL_ROOT/current.rollback.$$" "$INSTALL_ROOT/current"
    systemctl restart "$SERVICE_NAME.service" || true
  fi
  exit 1
fi

log "deployed Server release $VERSION"
log "health endpoint: http://127.0.0.1:$PORT/healthz"
