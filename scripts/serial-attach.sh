#!/usr/bin/env bash
set -Eeuo pipefail

# serial-attach.sh - WSL USB serial device attach helper.
#
# On WSL the USB serial devices connected to the Windows host must first be
# attached to the WSL distribution with usbipd-win before the TTLAB Client can
# discover them under /dev. This script reads the device classification
# directory (device-types/*.json) and attaches only the USB devices whose
# VID:PID matches a configured device type, so unrelated peripherals are never
# touched.
#
# Subcommands:
#   status   Read-only diagnostics: configured device types, usbipd state,
#            current /dev serial nodes, and what still needs attaching.
#   attach   Attach shared devices that match a configured device type to WSL.
#            Idempotent; asks for Windows elevation when required.
#   check    Exit 0 when at least one serial node is present under the device
#            directory, exit 1 otherwise.
#
# Configuration (environment):
#   TTLAB_DEVICE_TYPES_DIR        device classification directory (default: <repo>/device-types)
#   TTLAB_USBIPD_EXE              usbipd.exe path (default: auto-detect)
#   TTLAB_WSL_SERIAL_BUSIDS       explicit busid whitelist; disables auto-detect
#   TTLAB_WSL_SERIAL_ELEVATE      attempt Windows elevation (default: 1)
#   TTLAB_WSL_SERIAL_AUTO_BIND    auto-bind "Not shared" matching devices (default: 0)
#   TTLAB_WSL_SERIAL_TIMEOUT_SECONDS  timeout for Windows calls (default: 30)
#   TTLAB_WSL_SERIAL_WAIT_SECONDS     seconds to wait for /dev nodes after attach (default: 10)
#   TTLAB_WSL_SERIAL_DEV_DIR      directory to inspect for serial nodes (default: /dev)
#   TTLAB_WSL_DETECTED            force WSL mode with 1 (testing)

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

DEVICE_TYPES_DIR="${TTLAB_DEVICE_TYPES_DIR:-$PROJECT_ROOT/device-types}"
USBIPD_EXE="${TTLAB_USBIPD_EXE:-}"
EXPLICIT_BUSIDS="${TTLAB_WSL_SERIAL_BUSIDS:-}"
ELEVATE="${TTLAB_WSL_SERIAL_ELEVATE:-1}"
AUTO_BIND="${TTLAB_WSL_SERIAL_AUTO_BIND:-0}"
TIMEOUT_SECONDS="${TTLAB_WSL_SERIAL_TIMEOUT_SECONDS:-30}"
WAIT_SECONDS="${TTLAB_WSL_SERIAL_WAIT_SECONDS:-10}"
DEV_DIR="${TTLAB_WSL_SERIAL_DEV_DIR:-/dev}"

POWERSHELL_EXE='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
DEFAULT_USBIPD_EXE='/mnt/c/Program Files/usbipd-win/usbipd.exe'
NON_SERIAL_PATTERN='Input|Camera|Bluetooth|Audio|Headset|Speaker|HID|Card Reader|Hub|Touch|Gamepad|Joystick|Microphone|Reader'

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[ttlab-serial-attach] %s\n' "$*"; }
warn() { printf '[ttlab-serial-attach] WARNING: %s\n' "$*" >&2; }
# informational messages that must survive command substitution
notice() { printf '[ttlab-serial-attach] %s\n' "$*" >&2; }

is_wsl() {
  [[ "${TTLAB_WSL_DETECTED:-}" == '1' ]] && return 0
  [[ -f /proc/version ]] && grep -qi microsoft /proc/version
}

find_usbipd() {
  local candidate=''
  if [[ -n "$USBIPD_EXE" ]]; then
    [[ -x "$USBIPD_EXE" ]] || fail "TTLAB_USBIPD_EXE is not executable: $USBIPD_EXE"
    return 0
  fi
  if [[ -x "$DEFAULT_USBIPD_EXE" ]]; then
    USBIPD_EXE="$DEFAULT_USBIPD_EXE"
    return 0
  fi
  candidate="$(command -v usbipd || true)"
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    USBIPD_EXE="$candidate"
    return 0
  fi
  return 1
}

# Loads "vendorId:productId" pairs from device-types/*.json into a newline list.
load_known_device_ids() {
  if [[ ! -d "$DEVICE_TYPES_DIR" ]]; then
    warn "device classification directory does not exist: $DEVICE_TYPES_DIR"
    return 0
  fi
  local profile
  local collected=''
  local file
  for file in "$DEVICE_TYPES_DIR"/*.json; do
    [[ -f "$file" ]] || continue
    if ! profile="$(python3 -c '
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as e:
    print("", end="")
    sys.exit(1)
for rule in (data.get("match") or []):
    vid = str(rule.get("vendorId") or "").lower()
    pid = str(rule.get("productId") or "").lower()
    if vid and pid:
        print(f"{vid}:{pid}")
' "$file" 2>/dev/null)"; then
      warn "ignoring invalid device type profile: $file"
      continue
    fi
    if [[ -z "$profile" ]]; then
      warn "device type profile has no vendorId/productId match rules: $file"
      continue
    fi
    collected+="$profile"$'\n'
  done
  printf '%s' "$collected"
}

# Prints "busid<TAB>vid:pid<TAB>device<TAB>state" lines from `usbipd list`.
list_usbipd_devices() {
  local output
  if ! output="$(timeout "$TIMEOUT_SECONDS" "$USBIPD_EXE" list 2>/dev/null)"; then
    warn "usbipd list failed (exit $?); is the usbipd service running?"
    return 1
  fi
  printf '%s\n' "$output" | awk '
    BEGIN { state_col = 0 }
    NR == 1 { next }
    /^Persisted:/ { exit }
    {
      sub(/\r$/, "")
      if ($0 ~ /^[[:space:]]*$/) { next }
      if (NR == 2) {
        state_col = index($0, "STATE")
        next
      }
      busid = $1
      vidpid = $2
      pos = index($0, $2) + length($2)
      device = substr($0, pos + 1, state_col - pos - 1)
      state = substr($0, state_col)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", device)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", state)
      if (busid ~ /^[0-9]+-[0-9]+$/ && vidpid ~ /^[0-9a-fA-F]{4}:[0-9a-fA-F]{4}$/) {
        print busid "\t" tolower(vidpid) "\t" device "\t" state
      }
    }
  '
}

is_non_serial() {
  [[ "$1" =~ $NON_SERIAL_PATTERN ]]
}

# state(): "shared", "not-shared", "attached" or "unknown"
state_kind() {
  case "$1" in
    *[Nn]ot*[Ss]hared*) printf 'not-shared\n' ;;
    *[Aa]ttached*) printf 'attached\n' ;;
    *[Ss]hared*) printf 'shared\n' ;;
    *) printf 'unknown\n' ;;
  esac
}

serial_nodes_present() {
  [[ -d "$DEV_DIR" ]] || return 1
  local serial_dir="$DEV_DIR/serial/by-id"
  local any=''
  if [[ -d "$serial_dir" ]] && [[ -n "$(ls -A "$serial_dir" 2>/dev/null || true)" ]]; then
    return 0
  fi
  for entry in "$DEV_DIR"/ttyUSB[0-9]* "$DEV_DIR"/ttyACM[0-9]*; do
    if [[ -e "$entry" ]]; then
      any=1
      break
    fi
  done
  [[ -n "$any" ]]
}

wait_for_serial_nodes() {
  local deadline=$(( $(date +%s) + WAIT_SECONDS ))
  while [[ "$(date +%s)" -lt "$deadline" ]]; do
    if serial_nodes_present; then
      return 0
    fi
    sleep 1
  done
  return 1
}

is_windows_elevated() {
  [[ -x "$POWERSHELL_EXE" ]] || return 1
  local result
  result="$("$POWERSHELL_EXE" -NoProfile -NonInteractive -Command \
    '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)' 2>/dev/null | tr -d '\r' | tail -n 1 || true)"
  [[ "$result" == 'True' ]]
}

usbipd_path_for_windows() {
  # Windows path for Start-Process elevation.
  local raw=''
  if command -v wslpath >/dev/null 2>&1; then
    raw="$(wslpath -w "$USBIPD_EXE" 2>/dev/null || true)"
  fi
  [[ -n "$raw" ]] || raw="$USBIPD_EXE"
  printf '%s' "$raw" | sed 's#/#\\#g'
}

run_attach_via_elevation() {
  # Attach all given busids inside a single elevated PowerShell session so the
  # user approves one UAC prompt instead of one per device. The script uses
  # -EncodedCommand to avoid shell quoting issues; failure of any attach stops
  # the session with a non-zero exit code.
  local busids=("$@")
  local usbipd_win script b encoded
  usbipd_win="$(usbipd_path_for_windows)"
  script=''
  for b in "${busids[@]}"; do
    script+="& '$usbipd_win' attach --wsl --busid=$b; if (\$LASTEXITCODE -ne 0) { exit 1 }; "
  done
  log "requesting Windows elevation to attach: ${busids[*]} (approve the UAC prompt)"
  encoded="$(printf '%s' "$script" | iconv -f UTF-8 -t UTF-16LE 2>/dev/null | base64 -w0 2>/dev/null || true)"
  if [[ -n "$encoded" ]]; then
    timeout "$TIMEOUT_SECONDS" "$POWERSHELL_EXE" -NoProfile -NonInteractive -Command \
      "Start-Process -FilePath '$POWERSHELL_EXE' -ArgumentList '-NoProfile','-EncodedCommand','$encoded' -Verb RunAs -Wait" \
      >/dev/null 2>&1
    return $?
  fi
  # Fallback: per-device elevation (iconv/base64 unavailable).
  for b in "${busids[@]}"; do
    log "requesting Windows elevation to attach busid $b (approve the UAC prompt)"
    timeout "$TIMEOUT_SECONDS" "$POWERSHELL_EXE" -NoProfile -NonInteractive -Command \
      "Start-Process -FilePath '$usbipd_win' -ArgumentList 'attach','--wsl','--busid=$b' -Verb RunAs -Wait" \
      >/dev/null 2>&1 || return 1
  done
}

bind_busid() {
  local busid="$1"
  log "binding $busid"
  if [[ "$ELEVATE" == '1' ]] && ! is_windows_elevated; then
    timeout "$TIMEOUT_SECONDS" "$POWERSHELL_EXE" -NoProfile -NonInteractive -Command \
      "Start-Process -FilePath '$(usbipd_path_for_windows)' -ArgumentList 'bind','--busid=$busid' -Verb RunAs -Wait" \
      >/dev/null 2>&1
    return $?
  fi
  timeout "$TIMEOUT_SECONDS" "$USBIPD_EXE" bind --busid="$busid"
}

print_manual_command() {
  local busid="$1"
  printf '  Windows admin PowerShell: usbipd attach --wsl --busid=%s\n' "$busid"
}

cmd_status() {
  log "device classification directory: $DEVICE_TYPES_DIR"
  local known
  known="$(load_known_device_ids)"
  if [[ -z "$known" ]]; then
    log 'no configured device types (no attach targets)'
  else
    log "configured device type VID:PID set: $(printf '%s' "$known" | tr '\n' ' ')"
  fi

  log "serial nodes present: $(serial_nodes_present && echo yes || echo no)"
  if serial_nodes_present; then
    log "serial nodes under $DEV_DIR:"
    ls -1 "$DEV_DIR"/ttyUSB[0-9]* "$DEV_DIR"/ttyACM[0-9]* "$DEV_DIR/serial/by-id/"* 2>/dev/null | sed 's/^/  /' || true
  fi

  if ! is_wsl; then
    log 'not a WSL environment; USB devices are accessed directly and attach is not required'
    return 0
  fi
  if ! find_usbipd >/dev/null; then
    warn 'usbipd.exe not found; install usbipd-win or set TTLAB_USBIPD_EXE'
    return 0
  fi
  local devices
  if ! devices="$(list_usbipd_devices)"; then
    return 0
  fi
  log 'usbipd devices:'
  local line busid vidpid device state kind known_line
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    IFS=$'\t' read -r busid vidpid device state <<< "$line"
    kind="$(state_kind "$state")"
    if is_non_serial "$device"; then
      printf '  %-6s %-10s %-40s %-12s (non-serial, ignored)\n' "$busid" "$vidpid" "$device" "$state"
    elif printf '%s' "$known" | grep -q "^${vidpid}$"; then
      case "$kind" in
        attached) printf '  %-6s %-10s %-40s %-12s (known type, attached)\n' "$busid" "$vidpid" "$device" "$state" ;;
        shared) printf '  %-6s %-10s %-40s %-12s (known type, NEEDS ATTACH)\n' "$busid" "$vidpid" "$device" "$state" ;;
        not-shared) printf '  %-6s %-10s %-40s %-12s (known type, not shared)\n' "$busid" "$vidpid" "$device" "$state" ;;
        *) printf '  %-6s %-10s %-40s %-12s (known type, state unknown)\n' "$busid" "$vidpid" "$device" "$state" ;;
      esac
    else
      printf '  %-6s %-10s %-40s %-12s (unknown type, ignored)\n' "$busid" "$vidpid" "$device" "$state"
    fi
  done <<< "$devices"
}

collect_attach_targets() {
  local known="$1"
  if [[ -n "$EXPLICIT_BUSIDS" ]]; then
    local item
    for item in $(printf '%s' "$EXPLICIT_BUSIDS" | tr ',' ' '); do
      [[ -z "$item" ]] && continue
      [[ "$item" =~ ^[0-9]+-[0-9]+$ ]] || fail "invalid busid in TTLAB_WSL_SERIAL_BUSIDS: $item"
    done
    printf '%s\n' "$EXPLICIT_BUSIDS" | tr ',' ' '
    return 0
  fi
  [[ -n "$known" ]] || return 0
  local devices
  if ! devices="$(list_usbipd_devices)"; then
    return 1
  fi
  local line busid vidpid device state kind
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    IFS=$'\t' read -r busid vidpid device state <<< "$line"
    is_non_serial "$device" && continue
    printf '%s' "$known" | grep -q "^${vidpid}$" || continue
    kind="$(state_kind "$state")"
    case "$kind" in
      shared) printf '%s\t\n' "$busid" ;;
      not-shared)
        if [[ "$AUTO_BIND" == '1' ]]; then
          printf '%s\tbind\n' "$busid"
        else
          warn "device $busid ($device) matches a configured type but is not shared; run as admin: usbipd bind --busid=$busid"
        fi
        ;;
      attached) notice "device $busid ($device) already attached" ;;
      *) notice "device $busid ($device) has unknown state: $state" ;;
    esac
  done <<< "$devices"
}

# Prints the busids from the given list that are still in the "Shared" state
# after an attach attempt (used to detect attach failures that the Windows
# elevation path cannot report through its own exit code).
remaining_shared_busids() {
  local targets=("$@")
  [[ "${#targets[@]}" -eq 0 ]] && return 0
  local devices
  devices="$(list_usbipd_devices)" || return 1
  local line busid vidpid device state kind shared=''
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    IFS=$'\t' read -r busid vidpid device state <<< "$line"
    kind="$(state_kind "$state")"
    [[ "$kind" == 'shared' ]] && shared+="$busid"$'\n'
  done <<< "$devices"
  local t
  for t in "${targets[@]}"; do
    if printf '%s' "$shared" | grep -qx "$t"; then
      printf '%s\n' "$t"
    fi
  done
}

cmd_attach() {
  if ! is_wsl; then
    log 'not a WSL environment; attach is not required'
    return 0
  fi
  if ! find_usbipd >/dev/null; then
    fail 'usbipd.exe not found; install usbipd-win or set TTLAB_USBIPD_EXE'
  fi
  local known
  known="$(load_known_device_ids)"
  if [[ -z "$known" && -z "$EXPLICIT_BUSIDS" ]]; then
    warn 'no configured device types and no TTLAB_WSL_SERIAL_BUSIDS; nothing to attach'
    return 1
  fi
  local targets
  targets="$(collect_attach_targets "$known")"
  if [[ -z "$targets" ]]; then
    log 'no devices require attaching'
    return 0
  fi
  local attach_busids=() bind_busids=() busid bind_flag failed=''
  while IFS=$'\t' read -r busid bind_flag; do
    [[ -z "$busid" ]] && continue
    if [[ "$bind_flag" == 'bind' ]]; then
      bind_busids+=("$busid")
    else
      attach_busids+=("$busid")
    fi
  done <<< "$targets"
  for busid in "${bind_busids[@]}"; do
    if ! bind_busid "$busid"; then
      warn "bind failed for busid $busid"
      failed=1
      printf '  Windows admin PowerShell: usbipd bind --busid=%s\n' "$busid"
    else
      attach_busids+=("$busid")
    fi
  done
  if [[ "${#attach_busids[@]}" -gt 0 ]]; then
    if [[ "$ELEVATE" == '1' ]] && ! is_windows_elevated; then
      if ! run_attach_via_elevation "${attach_busids[@]}"; then
        warn 'elevated attach did not complete; run the following manually:'
        for busid in "${attach_busids[@]}"; do
          print_manual_command "$busid"
        done
        failed=1
      fi
    else
      for busid in "${attach_busids[@]}"; do
        log "attaching $busid"
        if ! timeout "$TIMEOUT_SECONDS" "$USBIPD_EXE" attach --wsl --busid="$busid"; then
          warn "attach failed for busid $busid"
          failed=1
        fi
      done
    fi
  fi
  # The Windows elevation path cannot propagate the inner attach exit code, so
  # re-check that no targeted device is still in the Shared state.
  local remaining
  remaining="$(remaining_shared_busids "${attach_busids[@]}" 2>/dev/null || true)"
  if [[ -n "$remaining" ]]; then
    warn "attach did not complete for: $(printf '%s' "$remaining" | tr '\n' ' ')"
    failed=1
  fi
  if [[ -n "$failed" ]]; then
    warn 'some devices were not attached; the TTLAB Client will still start but may report no serial devices'
    return 1
  fi
  if wait_for_serial_nodes; then
    log 'serial nodes are present'
  else
    warn "no serial nodes appeared under $DEV_DIR within ${WAIT_SECONDS}s; verify the attach manually"
    return 1
  fi
  return 0
}

cmd_check() {
  if serial_nodes_present; then
    log 'serial nodes are present'
    return 0
  fi
  warn "no serial nodes found under $DEV_DIR"
  return 1
}

main() {
  local command="${1:-}"
  case "$command" in
    status) cmd_status ;;
    attach) cmd_attach ;;
    check) cmd_check ;;
    ''|-h|--help)
      printf '%s\n' \
        'Usage: serial-attach.sh <status|attach|check>' \
        '' \
        '  status   show configured device types, usbipd state and /dev serial nodes' \
        '  attach   attach shared devices matching a configured device type to WSL' \
        '  check    exit 0 when a serial node is present, exit 1 otherwise' \
        '' \
        'See the header of this script for configuration variables.' \
      ;;
    *) fail "unknown command: $command" ;;
  esac
}

main "$@"
