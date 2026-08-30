#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${TTLAB_SERVER_CONFIG_FILE:-$SOURCE_ROOT/server.env}"
if [[ ! -f "$CONFIG_FILE" && -f "$SOURCE_ROOT/server.env.example" ]]; then
  CONFIG_FILE="$SOURCE_ROOT/server.env.example"
fi

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[ttlab-server] %s\n' "$*"; }
cleanup() { if [[ -n "${STAGING_DIR:-}" && -d "$STAGING_DIR" ]]; then rm -rf -- "$STAGING_DIR"; fi; }
trap cleanup EXIT

[[ -f "$CONFIG_FILE" ]] || fail "server config file does not exist: $CONFIG_FILE"
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [[ -z "$line" || "$line" == \#* ]] && continue
  key="${line%%=*}"
  value="${line#*=}"
  key="${key//[[:space:]]/}"
  [[ "$key" =~ ^TTLAB_[A-Z0-9_]+$ ]] || fail "invalid key in server config: $key"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then value="${value:1:${#value}-2}"; fi
  if [[ "$value" == \'*\' && "$value" == *\' ]]; then value="${value:1:${#value}-2}"; fi
  export "$key=$value"
done < "$CONFIG_FILE"

INSTALL_ROOT="${TTLAB_SERVER_INSTALL_ROOT:-/opt/ttlab/server}"
VERSION="${TTLAB_VERSION:-$(date -u +%Y%m%d%H%M%S)}"
SERVICE_NAME="${TTLAB_SERVER_SERVICE_NAME:-ttlab-server}"
SERVER_USER="${TTLAB_SERVER_USER:-ttlab-server}"
ENV_FILE="${TTLAB_SERVER_ENV_FILE:-/etc/ttlab/server.env}"
PORT="${TTLAB_SERVER_PORT:-9000}"
TLS_KEY_FILE="${TTLAB_TLS_KEY_FILE:-}"
TLS_CERT_FILE="${TTLAB_TLS_CERT_FILE:-}"
PUBLIC_BASE_URL="${TTLAB_PUBLIC_BASE_URL:-http://127.0.0.1:${PORT}}"
RELEASE_DIRECTORY="${TTLAB_RELEASE_DIR:-/srv/ttlab/releases}"
CLIENT_TOKENS="${TTLAB_CLIENT_TOKENS:-}"
CLIENT_AUTH_ENABLED="${TTLAB_CLIENT_AUTH_ENABLED:-0}"
NODE_BIN="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"

[[ "$(id -u)" -eq 0 ]] || fail 'run this script as root, for example: sudo -E ./scripts/deploy-server.sh'
[[ -n "$NODE_BIN" ]] || fail 'node is required'
[[ -n "$NPM_BIN" ]] || fail 'npm is required'
[[ "$VERSION" =~ ^[A-Za-z0-9._-]+$ ]] || fail 'TTLAB_VERSION contains unsafe characters'
[[ "$CLIENT_AUTH_ENABLED" == 0 || "$CLIENT_AUTH_ENABLED" == 1 ]] || fail 'TTLAB_CLIENT_AUTH_ENABLED must be 0 or 1'
if [[ "$CLIENT_AUTH_ENABLED" == 1 ]]; then
  [[ -n "$CLIENT_TOKENS" ]] || fail 'TTLAB_CLIENT_TOKENS is required when client authentication is enabled'
fi
if [[ -n "$TLS_KEY_FILE" || -n "$TLS_CERT_FILE" ]]; then
  [[ -n "$TLS_KEY_FILE" && -n "$TLS_CERT_FILE" ]] || fail 'TTLAB_TLS_KEY_FILE and TTLAB_TLS_CERT_FILE must be configured together'
  [[ -f "$TLS_KEY_FILE" && -r "$TLS_KEY_FILE" ]] || fail "TLS private key is not readable: $TLS_KEY_FILE"
  [[ -f "$TLS_CERT_FILE" && -r "$TLS_CERT_FILE" ]] || fail "TLS certificate is not readable: $TLS_CERT_FILE"
  [[ "$PUBLIC_BASE_URL" == https://* ]] || fail 'TTLAB_PUBLIC_BASE_URL must use https:// when TLS is enabled'
  TLS_REQUIRED=1
else
  [[ "$PUBLIC_BASE_URL" == http://* ]] || fail 'TTLAB_PUBLIC_BASE_URL must use http:// when TLS is disabled'
  TLS_REQUIRED=0
fi
[[ "$CLIENT_TOKENS" != *$'\n'* && "$CLIENT_TOKENS" != *$'\r'* ]] || fail 'TTLAB_CLIENT_TOKENS must not contain newlines'
if [[ -n "$CLIENT_TOKENS" ]]; then
  [[ "$CLIENT_TOKENS" =~ ^[A-Za-z0-9._~+=,-]+$ ]] || fail 'TTLAB_CLIENT_TOKENS contains characters that are unsafe in a systemd EnvironmentFile'
fi

NODE_MAJOR="$($NODE_BIN -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 22 )) || fail "Node.js 22 or newer is required, found $($NODE_BIN --version)"

# The Server service runs unprivileged on the configured (non-privileged) port.
# Deploy-time operations (writing /etc/systemd, creating the user) still need root.
if ! id "$SERVER_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "/var/lib/$SERVER_USER" --create-home --shell /usr/sbin/nologin "$SERVER_USER"
fi
install -d -m 0755 "$INSTALL_ROOT/releases"
install -d -m 0750 -o "$SERVER_USER" -g "$SERVER_USER" "$RELEASE_DIRECTORY"
log "installing dependencies and building the release"
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

ENV_TMP="$(mktemp "${ENV_FILE}.XXXXXX")"
umask 077
printf '%s\n' \
  "TTLAB_SERVER_PORT=$PORT" \
  "TTLAB_WEB_ROOT=$INSTALL_ROOT/current" \
  "TTLAB_RELEASE_DIR=$RELEASE_DIRECTORY" \
  "TTLAB_CONFIG_FILE=$ENV_FILE" \
  "TTLAB_LOG_DIR=/var/log/$SERVER_USER" \
  "TTLAB_PUBLIC_BASE_URL=$PUBLIC_BASE_URL" \
  "TTLAB_TLS_KEY_FILE=$TLS_KEY_FILE" \
  "TTLAB_TLS_CERT_FILE=$TLS_CERT_FILE" \
  "TTLAB_TLS_REQUIRED=$TLS_REQUIRED" \
  "TTLAB_CLIENT_AUTH_ENABLED=$CLIENT_AUTH_ENABLED" \
  "TTLAB_CLIENT_TOKENS=$CLIENT_TOKENS" \
  "TTLAB_AGENT_ENABLED=${TTLAB_AGENT_ENABLED:-0}" \
  "TTLAB_AGENT_TOKEN=${TTLAB_AGENT_TOKEN:-}" \
  "TTLAB_AGENT_MODEL=${TTLAB_AGENT_MODEL:-deepseek-chat}" \
  "TTLAB_DEEPSEEK_API_KEY=${TTLAB_DEEPSEEK_API_KEY:-}" \
  "TTLAB_AGENT_LLM_URL=${TTLAB_AGENT_LLM_URL:-https://api.deepseek.com}" \
  "TTLAB_AGENT_MAX_SESSIONS=${TTLAB_AGENT_MAX_SESSIONS:-8}" \
  "TTLAB_AGENT_APPROVAL_TIMEOUT_MS=${TTLAB_AGENT_APPROVAL_TIMEOUT_MS:-60000}" > "$ENV_TMP"
install -d -m 0755 "$(dirname "$ENV_FILE")"
install -o "$SERVER_USER" -g "$SERVER_USER" -m 0600 "$ENV_TMP" "$ENV_FILE"
rm -f -- "$ENV_TMP"

SERVICE_TMP="$(mktemp /etc/systemd/system/${SERVICE_NAME}.service.XXXXXX)"
cat > "$SERVICE_TMP" <<EOF
[Unit]
Description=TTLAB Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $INSTALL_ROOT/current/dist/apps/server/src/index.js
Group=$SERVER_USER
User=$SERVER_USER
StateDirectory=$SERVER_USER
LogsDirectory=$SERVER_USER
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
