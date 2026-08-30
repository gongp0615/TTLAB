#!/usr/bin/env bash
set -Eeuo pipefail

# install-udev-rules.sh - install TTLAB udev rules so serial devices can be
# opened by ordinary users without the dialout group.
#
# Serial devices (GD32, CP2105) are owned by root:dialout by default. This
# script installs a udev rule that grants read/write (0666) to the TTLAB
# device types only, so the Client runs fully unprivileged afterwards.
# Installing rules writes /etc/udev/rules.d and requires root once; remove
# the rules to go back to the dialout-group behaviour.
#
# Subcommands:
#   install   Copy the rules to /etc/udev/rules.d, reload and trigger.
#   remove    Delete the rules and reload.
#   status    Report whether the rules are installed and the current /dev
#             serial node permissions.
#
# Configuration (environment):
#   TTLAB_UDEV_RULES_SOURCE   rules file to install (default: <repo>/udev/99-ttlab-serial.rules)
#   TTLAB_UDEV_RULES_TARGET   destination path (default: /etc/udev/rules.d/99-ttlab-serial.rules)

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

RULES_SOURCE="${TTLAB_UDEV_RULES_SOURCE:-$PROJECT_ROOT/udev/99-ttlab-serial.rules}"
RULES_TARGET="${TTLAB_UDEV_RULES_TARGET:-/etc/udev/rules.d/99-ttlab-serial.rules}"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[ttlab-udev] %s\n' "$*"; }

need_root() {
  [[ "$(id -u)" -eq 0 ]] || fail 'this action writes /etc/udev/rules.d and requires root, for example: sudo -E ./scripts/install-udev-rules.sh install'
}

rules_installed() {
  [[ -f "$RULES_TARGET" ]]
}

cmd_install() {
  need_root
  [[ -f "$RULES_SOURCE" ]] || fail "rules file not found: $RULES_SOURCE"
  install -d -m 0755 "$(dirname "$RULES_TARGET")"
  install -o root -g root -m 0644 "$RULES_SOURCE" "$RULES_TARGET"
  log "installed $RULES_TARGET"
  udevadm control --reload-rules
  udevadm trigger
  log 'udev rules reloaded; serial devices now grant read/write to all users'
}

cmd_remove() {
  need_root
  if ! rules_installed; then
    log 'rules are not installed; nothing to remove'
    return 0
  fi
  rm -f -- "$RULES_TARGET"
  log "removed $RULES_TARGET"
  udevadm control --reload-rules
  log 'udev rules reloaded; dialout group is required again for serial access'
}

cmd_status() {
  if rules_installed; then
    log "TTLAB udev rules are installed: $RULES_TARGET"
  else
    log 'TTLAB udev rules are NOT installed; serial access requires the dialout group'
  fi
  log 'serial nodes:'
  ls -l /dev/ttyUSB[0-9]* /dev/ttyACM[0-9]* 2>/dev/null | sed 's/^/  /' || true
  log 'hint: run ./scripts/install-udev-rules.sh install (as root) to grant serial access without dialout'
}

main() {
  local command="${1:-}"
  case "$command" in
    install) cmd_install ;;
    remove) cmd_remove ;;
    status) cmd_status ;;
    ''|-h|--help)
      printf '%s\n' \
        'Usage: install-udev-rules.sh <install|remove|status>' \
        '' \
        '  install   copy TTLAB udev rules to /etc/udev/rules.d and reload (needs root once)' \
        '  remove    delete the rules and reload (back to dialout-group behaviour)' \
        '  status    show whether the rules are installed and /dev serial permissions' \
        '' \
        'After install, the TTLAB Client can open serial devices as a normal user' \
        'without joining the dialout group.' \
      ;;
    *) fail "unknown command: $command" ;;
  esac
}

main "$@"
