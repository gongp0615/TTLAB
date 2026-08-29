#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_ROOT="${TTLAB_CLIENT_INSTALL_ROOT:-/opt/ttlab/client}"
UPDATER_ROOT="${TTLAB_UPDATER_INSTALL_ROOT:-/opt/ttlab/updater}"
VERSION="${TTLAB_VERSION:-$(date -u +%Y%m%d%H%M%S)}"
CLIENT_ENV_FILE="${TTLAB_CLIENT_ENV_FILE:-/etc/ttlab/client.env}"
UPDATER_ENV_FILE="${TTLAB_UPDATER_ENV_FILE:-/etc/ttlab/updater.env}"
UPDATE_PUBLIC_KEY_FILE="${TTLAB_UPDATE_PUBLIC_KEY_FILE:-/etc/ttlab/update-public.pem}"
SERVER_URL="${TTLAB_SERVER_URL:-}"
CLIENT_ID="${TTLAB_CLIENT_ID:-}"
CLIENT_TOKEN="${TTLAB_CLIENT_TOKEN:-}"
CLIENT_AUTH_ENABLED="${TTLAB_CLIENT_AUTH_ENABLED:-0}"
SERIAL_DEVICE_TYPE="${TTLAB_SERIAL_DEVICE_TYPE:-generic-serial}"
TVBOX_CONTROL_PORT="${TTLAB_TVBOX_CONTROL_PORT:-}"
TVBOX_LOG_PORT="${TTLAB_TVBOX_LOG_PORT:-}"
NODE_BIN="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[ttlab-client] %s\n' "$*"; }
cleanup() {
  [[ -z "${CLIENT_STAGING:-}" || ! -d "$CLIENT_STAGING" ]] || rm -rf -- "$CLIENT_STAGING"
  [[ -z "${UPDATER_STAGING:-}" || ! -d "$UPDATER_STAGING" ]] || rm -rf -- "$UPDATER_STAGING"
}
trap cleanup EXIT

[[ "$(id -u)" -eq 0 ]] || fail 'run this script as root, for example: sudo -E ./scripts/deploy-client.sh'
[[ -n "$NODE_BIN" ]] || fail 'node is required'
[[ -n "$NPM_BIN" ]] || fail 'npm is required'
[[ "$VERSION" =~ ^[A-Za-z0-9._-]+$ ]] || fail 'TTLAB_VERSION contains unsafe characters'
[[ -n "$SERVER_URL" ]] || fail 'TTLAB_SERVER_URL is required'
[[ "$SERVER_URL" == ws://* || "$SERVER_URL" == wss://* ]] || fail 'TTLAB_SERVER_URL must use ws:// or wss://'
[[ "$CLIENT_AUTH_ENABLED" == 0 || "$CLIENT_AUTH_ENABLED" == 1 ]] || fail 'TTLAB_CLIENT_AUTH_ENABLED must be 0 or 1'
if [[ "$CLIENT_AUTH_ENABLED" == 1 ]]; then
  [[ -n "$CLIENT_ID" ]] || fail 'TTLAB_CLIENT_ID is required when client authentication is enabled'
  [[ -n "$CLIENT_TOKEN" ]] || fail 'TTLAB_CLIENT_TOKEN is required when client authentication is enabled'
fi
if [[ -n "$CLIENT_TOKEN" ]]; then
  [[ "$CLIENT_TOKEN" != *$'\n'* && "$CLIENT_TOKEN" != *$'\r'* ]] || fail 'TTLAB_CLIENT_TOKEN must not contain newlines'
  [[ "$CLIENT_TOKEN" =~ ^[A-Za-z0-9._~+=-]+$ ]] || fail 'TTLAB_CLIENT_TOKEN contains characters that are unsafe in a systemd EnvironmentFile'
fi
if [[ -n "$CLIENT_ID" ]]; then
  [[ "$CLIENT_ID" != *$'\n'* && "$CLIENT_ID" != *$'\r'* ]] || fail 'TTLAB_CLIENT_ID must not contain newlines'
  [[ "$CLIENT_ID" =~ ^[A-Za-z0-9._-]+$ ]] || fail 'TTLAB_CLIENT_ID contains unsafe characters'
fi
for port_selector in "$TVBOX_CONTROL_PORT" "$TVBOX_LOG_PORT"; do
  if [[ -n "$port_selector" ]]; then
    [[ "$port_selector" != *$'\n'* && "$port_selector" != *$'\r'* ]] || fail 'TV Box port selectors must not contain newlines'
    [[ "$port_selector" =~ ^[A-Za-z0-9._:/-]+$ ]] || fail 'TV Box port selectors contain unsafe characters'
  fi
done
[[ "$SERIAL_DEVICE_TYPE" =~ ^[A-Za-z0-9._-]+$ ]] || fail 'TTLAB_SERIAL_DEVICE_TYPE contains unsafe characters'
[[ -f "$UPDATE_PUBLIC_KEY_FILE" ]] || fail "update public key file does not exist: $UPDATE_PUBLIC_KEY_FILE"

NODE_MAJOR="$($NODE_BIN -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 22 )) || fail "Node.js 22 or newer is required, found $($NODE_BIN --version)"

getent group dialout >/dev/null 2>&1 || fail 'the dialout group is required for serial access'
if ! id ttlab >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/ttlab-client --create-home --shell /usr/sbin/nologin ttlab
fi
usermod -aG dialout ttlab
install -d -o ttlab -g ttlab -m 0750 /var/lib/ttlab-client
install -d -m 0755 "$CLIENT_ROOT/releases" "$UPDATER_ROOT/releases" /etc/ttlab

log 'installing dependencies and building the release'
cd "$SOURCE_ROOT"
"$NPM_BIN" ci
"$NPM_BIN" run build

CLIENT_STAGING="$CLIENT_ROOT/releases/.staging-${VERSION}-$$"
UPDATER_STAGING="$UPDATER_ROOT/releases/.staging-${VERSION}-$$"
CLIENT_RELEASE="$CLIENT_ROOT/releases/$VERSION"
UPDATER_RELEASE="$UPDATER_ROOT/releases/$VERSION"
[[ ! -e "$CLIENT_RELEASE" ]] || fail "client release already exists: $CLIENT_RELEASE"
[[ ! -e "$UPDATER_RELEASE" ]] || fail "updater release already exists: $UPDATER_RELEASE"
install -d -m 0755 "$CLIENT_STAGING/bin" "$UPDATER_STAGING/bin"
cp -a "$SOURCE_ROOT/dist" "$CLIENT_STAGING/dist"
cp -a "$SOURCE_ROOT/dist" "$UPDATER_STAGING/dist"
cp -a "$SOURCE_ROOT/node_modules" "$CLIENT_STAGING/node_modules"
cp -a "$SOURCE_ROOT/device-types" "$CLIENT_STAGING/device-types"
cp -a "$SOURCE_ROOT/node_modules" "$UPDATER_STAGING/node_modules"
cat > "$CLIENT_STAGING/bin/ttlab-client" <<EOF
#!/usr/bin/env sh
set -eu
base=\$(CDPATH= cd -- "\$(dirname -- "\$0")/.." && pwd)
exec "$NODE_BIN" "\$base/dist/apps/client/src/index.js"
EOF
cat > "$UPDATER_STAGING/bin/ttlab-updater" <<EOF
#!/usr/bin/env sh
set -eu
base=\$(CDPATH= cd -- "\$(dirname -- "\$0")/.." && pwd)
exec "$NODE_BIN" "\$base/dist/apps/updater/src/index.js" "\$@"
EOF
chmod 0755 "$CLIENT_STAGING/bin/ttlab-client" "$UPDATER_STAGING/bin/ttlab-updater"
mv -- "$CLIENT_STAGING" "$CLIENT_RELEASE"
mv -- "$UPDATER_STAGING" "$UPDATER_RELEASE"
CLIENT_STAGING=''
UPDATER_STAGING=''

if [[ -e "$CLIENT_ROOT/current" || -L "$CLIENT_ROOT/current" ]]; then
  CLIENT_PREVIOUS_TARGET="$(readlink -f "$CLIENT_ROOT/current")"
else
  CLIENT_PREVIOUS_TARGET=''
fi
ln -s -- "$CLIENT_RELEASE" "$CLIENT_ROOT/current.next.$$"
mv -Tf -- "$CLIENT_ROOT/current.next.$$" "$CLIENT_ROOT/current"
ln -sfn -- "$UPDATER_RELEASE" "$UPDATER_ROOT/current"
chown -R root:ttlab "$CLIENT_ROOT" "$UPDATER_ROOT"
chmod 0755 "$CLIENT_ROOT/current/bin/ttlab-client" "$UPDATER_ROOT/current/bin/ttlab-updater"

if [[ "$UPDATE_PUBLIC_KEY_FILE" != /etc/ttlab/update-public.pem ]]; then
  install -o root -g root -m 0644 "$UPDATE_PUBLIC_KEY_FILE" /etc/ttlab/update-public.pem
fi
ENV_TMP="$(mktemp /etc/ttlab/client.env.XXXXXX)"
umask 077
printf '%s\n' \
  "TTLAB_SERVER_URL=$SERVER_URL" \
  "TTLAB_CLIENT_ID=$CLIENT_ID" \
  "TTLAB_CLIENT_TOKEN=$CLIENT_TOKEN" \
  "TTLAB_CLIENT_AUTH_ENABLED=$CLIENT_AUTH_ENABLED" \
  "TTLAB_STATE_DIR=/var/lib/ttlab-client" \
  "TTLAB_UPDATER_SOCKET=/run/ttlab-updater/update.sock" \
  "TTLAB_SERIAL_DEVICE_TYPE=$SERIAL_DEVICE_TYPE" \
  "TTLAB_TVBOX_CONTROL_PORT=$TVBOX_CONTROL_PORT" \
  "TTLAB_TVBOX_LOG_PORT=$TVBOX_LOG_PORT" > "$ENV_TMP"
install -o root -g root -m 0600 "$ENV_TMP" "$CLIENT_ENV_FILE"
rm -f -- "$ENV_TMP"

ENV_TMP="$(mktemp /etc/ttlab/updater.env.XXXXXX)"
printf '%s\n' \
  "TTLAB_STATE_DIR=/var/lib/ttlab-client" \
  "TTLAB_INSTALL_ROOT=$CLIENT_ROOT" \
  "TTLAB_UPDATE_PUBLIC_KEY_FILE=/etc/ttlab/update-public.pem" \
  "TTLAB_UPDATER_SOCKET=/run/ttlab-updater/update.sock" > "$ENV_TMP"
install -o root -g root -m 0600 "$ENV_TMP" "$UPDATER_ENV_FILE"
rm -f -- "$ENV_TMP"

install -o root -g root -m 0644 "$SOURCE_ROOT/systemd/ttlab-client.service" /etc/systemd/system/ttlab-client.service
install -o root -g root -m 0644 "$SOURCE_ROOT/systemd/ttlab-updater.service" /etc/systemd/system/ttlab-updater.service
systemctl daemon-reload
systemctl enable --now ttlab-updater.service
if ! systemctl enable --now ttlab-client.service || ! systemctl is-active --quiet ttlab-client.service; then
  log 'new Client failed to start; restoring the previous release'
  if [[ -n "${CLIENT_PREVIOUS_TARGET:-}" ]]; then
    ln -s -- "$CLIENT_PREVIOUS_TARGET" "$CLIENT_ROOT/current.rollback.$$"
    mv -Tf -- "$CLIENT_ROOT/current.rollback.$$" "$CLIENT_ROOT/current"
    systemctl restart ttlab-client.service || true
  fi
  exit 1
fi

log "deployed Client release $VERSION"
log 'inspect logs with: journalctl -u ttlab-client.service -f'
