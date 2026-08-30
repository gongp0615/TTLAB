#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_ROOT="${TTLAB_CLIENT_INSTALL_ROOT:-/opt/ttlab/client}"
UPDATER_ROOT="${TTLAB_UPDATER_INSTALL_ROOT:-/opt/ttlab/updater}"
VERSION="${TTLAB_VERSION:-$(date -u +%Y%m%d%H%M%S)}"
CLIENT_CONFIG_FILE="${TTLAB_CLIENT_CONFIG_FILE:-/var/lib/ttlab-client/client.json}"
UPDATER_CONFIG_FILE="${TTLAB_UPDATER_CONFIG_FILE:-/var/lib/ttlab-client/updater.json}"
UPDATE_PUBLIC_KEY_FILE="${TTLAB_UPDATE_PUBLIC_KEY_FILE:-/etc/ttlab/update-public.pem}"
SERVER_URL="${TTLAB_SERVER_URL:-}"
CLIENT_ID="${TTLAB_CLIENT_ID:-}"
CLIENT_TOKEN="${TTLAB_CLIENT_TOKEN:-}"
CLIENT_AUTH_ENABLED="${TTLAB_CLIENT_AUTH_ENABLED:-0}"
TVBOX_CONTROL_PORT="${TTLAB_TVBOX_CONTROL_PORT:-}"
TVBOX_LOG_PORT="${TTLAB_TVBOX_LOG_PORT:-}"
NODE_BIN="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[ttlab-client] %s\n' "$*"; }
cleanup() {
  [[ -z "${CLIENT_STAGING:-}" || ! -d "$CLIENT_STAGING" ]] || rm -rf -- "$CLIENT_STAGING"
  [[ -z "${UPDATER_STAGING:-}" || ! -d "$UPDATER_STAGING" ]] || rm -rf -- "$UPDATER_STAGING"
  [[ -z "${CONFIG_BACKUP_DIR:-}" || ! -d "$CONFIG_BACKUP_DIR" ]] || rm -rf -- "$CONFIG_BACKUP_DIR"
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
[[ -f "$UPDATE_PUBLIC_KEY_FILE" ]] || fail "update public key file does not exist: $UPDATE_PUBLIC_KEY_FILE"

NODE_MAJOR="$($NODE_BIN -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 22 )) || fail "Node.js 22 or newer is required, found $($NODE_BIN --version)"

# Serial access: prefer the TTLAB udev rules (no group membership needed);
# otherwise require the dialout group for the Client service user.
UDEV_RULES_INSTALLED=0
if [[ -f "${TTLAB_UDEV_RULES_FILE:-/etc/udev/rules.d/99-ttlab-serial.rules}" ]]; then
  UDEV_RULES_INSTALLED=1
  log 'serial access via TTLAB udev rules; dialout group not required'
else
  getent group dialout >/dev/null 2>&1 || fail 'the dialout group is required for serial access (or install TTLAB udev rules with scripts/install-udev-rules.sh)'
fi
if ! id ttlab >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/ttlab-client --create-home --shell /usr/sbin/nologin ttlab
fi
if [[ "$UDEV_RULES_INSTALLED" -eq 0 ]]; then
  usermod -aG dialout ttlab
fi
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
exec "$NODE_BIN" "\$base/dist/apps/client/src/index.js" "\$@"
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

# Backup existing config and service files so a failed start can be rolled back,
# including across the env-file -> JSON config migration boundary.
CONFIG_BACKUP_DIR="$(mktemp -d /var/lib/ttlab-client/.deploy-backup.XXXXXX)"
backup_file() {
  local src="$1" dest="$2"
  [[ -e "$src" ]] || return 0
  cp -a -- "$src" "$dest"
}
backup_file "$CLIENT_CONFIG_FILE" "$CONFIG_BACKUP_DIR/client.json"
backup_file "$UPDATER_CONFIG_FILE" "$CONFIG_BACKUP_DIR/updater.json"
backup_file /etc/ttlab/client.env "$CONFIG_BACKUP_DIR/client.env"
backup_file /etc/ttlab/updater.env "$CONFIG_BACKUP_DIR/updater.env"
backup_file /etc/systemd/system/ttlab-client.service "$CONFIG_BACKUP_DIR/ttlab-client.service"
backup_file /etc/systemd/system/ttlab-updater.service "$CONFIG_BACKUP_DIR/ttlab-updater.service"

CLIENT_CONFIG_TMP="$(mktemp /var/lib/ttlab-client/client.json.XXXXXX)"
"$NODE_BIN" -e '
  const fs = require("node:fs");
  const file = process.argv[1];
  const data = {
    serverUrl: process.argv[2],
    ...(process.argv[3] ? { clientId: process.argv[3] } : {}),
    ...(process.argv[4] ? { token: process.argv[4] } : {}),
    authEnabled: process.argv[5] === "1",
    stateDirectory: "/var/lib/ttlab-client",
    updaterSocket: "/run/ttlab-updater/update.sock",
    ...(process.argv[6] ? { controlSelector: process.argv[6] } : {}),
    ...(process.argv[7] ? { logSelector: process.argv[7] } : {}),
  };
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
' "$CLIENT_CONFIG_TMP" "$SERVER_URL" "$CLIENT_ID" "$CLIENT_TOKEN" "$CLIENT_AUTH_ENABLED" "$TVBOX_CONTROL_PORT" "$TVBOX_LOG_PORT"
chown ttlab:ttlab "$CLIENT_CONFIG_TMP"
chmod 0600 "$CLIENT_CONFIG_TMP"
mv -- "$CLIENT_CONFIG_TMP" "$CLIENT_CONFIG_FILE"

UPDATER_CONFIG_TMP="$(mktemp /var/lib/ttlab-client/updater.json.XXXXXX)"
"$NODE_BIN" -e '
  const fs = require("node:fs");
  const file = process.argv[1];
  const data = {
    stateDirectory: "/var/lib/ttlab-client",
    installRoot: process.argv[2],
    publicKeyFile: "/etc/ttlab/update-public.pem",
    socketPath: "/run/ttlab-updater/update.sock",
  };
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
' "$UPDATER_CONFIG_TMP" "$CLIENT_ROOT"
chown root:ttlab "$UPDATER_CONFIG_TMP"
chmod 0600 "$UPDATER_CONFIG_TMP"
mv -- "$UPDATER_CONFIG_TMP" "$UPDATER_CONFIG_FILE"

install -o root -g root -m 0644 "$SOURCE_ROOT/systemd/ttlab-client.service" /etc/systemd/system/ttlab-client.service
install -o root -g root -m 0644 "$SOURCE_ROOT/systemd/ttlab-updater.service" /etc/systemd/system/ttlab-updater.service
systemctl daemon-reload
systemctl enable --now ttlab-updater.service
if ! systemctl enable --now ttlab-client.service || ! systemctl is-active --quiet ttlab-client.service; then
  log 'new Client failed to start; restoring the previous configuration and release'
  if [[ -n "${CLIENT_PREVIOUS_TARGET:-}" ]]; then
    ln -s -- "$CLIENT_PREVIOUS_TARGET" "$CLIENT_ROOT/current.rollback.$$"
    mv -Tf -- "$CLIENT_ROOT/current.rollback.$$" "$CLIENT_ROOT/current"
  fi
  if [[ -d "$CONFIG_BACKUP_DIR" ]]; then
    [[ -f "$CONFIG_BACKUP_DIR/client.json" ]] && { chown ttlab:ttlab "$CONFIG_BACKUP_DIR/client.json"; install -o ttlab -g ttlab -m 0600 "$CONFIG_BACKUP_DIR/client.json" /var/lib/ttlab-client/client.json; }
    [[ -f "$CONFIG_BACKUP_DIR/updater.json" ]] && install -o root -g root -m 0600 "$CONFIG_BACKUP_DIR/updater.json" /var/lib/ttlab-client/updater.json
    [[ -f "$CONFIG_BACKUP_DIR/client.env" ]] && install -o root -g root -m 0600 "$CONFIG_BACKUP_DIR/client.env" /etc/ttlab/client.env
    [[ -f "$CONFIG_BACKUP_DIR/updater.env" ]] && install -o root -g root -m 0600 "$CONFIG_BACKUP_DIR/updater.env" /etc/ttlab/updater.env
    [[ -f "$CONFIG_BACKUP_DIR/ttlab-client.service" ]] && install -o root -g root -m 0644 "$CONFIG_BACKUP_DIR/ttlab-client.service" /etc/systemd/system/ttlab-client.service
    [[ -f "$CONFIG_BACKUP_DIR/ttlab-updater.service" ]] && install -o root -g root -m 0644 "$CONFIG_BACKUP_DIR/ttlab-updater.service" /etc/systemd/system/ttlab-updater.service
  fi
  rm -rf -- "$CONFIG_BACKUP_DIR"
  systemctl daemon-reload
  systemctl restart ttlab-client.service || true
  exit 1
fi
rm -rf -- "$CONFIG_BACKUP_DIR"

log "deployed Client release $VERSION"
log "client config: $CLIENT_CONFIG_FILE"
log 'inspect logs with: journalctl -u ttlab-client.service -f'
