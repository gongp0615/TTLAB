#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[ttlab-dsh-start] %s\n' "$*"; }

[[ "$(uname -s)" == Linux ]] || fail 'run this script inside Linux or WSL'
if [[ ! -f "$PROJECT_ROOT/server.env" ]]; then
  if [[ -f "$PROJECT_ROOT/server.env.example" ]]; then
    cp "$PROJECT_ROOT/server.env.example" "$PROJECT_ROOT/server.env"
    log 'created server.env from server.env.example; edit it to set the engine and API key'
  else
    fail "server.env does not exist: $PROJECT_ROOT/server.env"
  fi
fi

# Read a key from server.env. Strip comments, surrounding whitespace and
# quotes; the first matching line wins. Returns the default when absent.
env_get() {
  local key="$1" default="${2:-}"
  local line k v
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    k="${line%%=*}"
    k="${k//[[:space:]]/}"
    [[ "$k" == "$key" ]] || continue
    v="${line#*=}"
    v="${v#"${v%%[![:space:]]*}"}"
    v="${v%"${v##*[![:space:]]}"}"
    if [[ "$v" == \"*\" && "$v" == *\" ]]; then v="${v:1:${#v}-2}"; fi
    if [[ "$v" == \'*\' && "$v" == *\' ]]; then v="${v:1:${#v}-2}"; fi
    printf '%s' "$v"
    return 0
  done < "$PROJECT_ROOT/server.env"
  printf '%s' "$default"
}

# Configuration precedence: environment variable > server.env > default.
ENGINE="${TTLAB_AGENT_ENGINE:-$(env_get TTLAB_AGENT_ENGINE server-native)}"
if [[ "$ENGINE" != 'dsh' ]]; then
  log "TTLAB_AGENT_ENGINE=$ENGINE（非 dsh），无需启动 dsh web"
  exit 0
fi

DSH_BASE_URL="${TTLAB_DSH_BASE_URL:-$(env_get TTLAB_DSH_BASE_URL http://127.0.0.1:9333)}"
if [[ "$DSH_BASE_URL" =~ :([0-9]+)/?$ ]]; then
  DSH_PORT="${BASH_REMATCH[1]}"
else
  DSH_PORT=9333
fi
[[ "$DSH_PORT" =~ ^[0-9]+$ ]] || fail "invalid dsh port parsed from TTLAB_DSH_BASE_URL: $DSH_PORT"

DSH_WORKDIR="${TTLAB_DSH_WORKDIR:-$(env_get TTLAB_DSH_WORKDIR ./data/agent-work)}"
DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-${TTLAB_DEEPSEEK_API_KEY:-$(env_get TTLAB_DEEPSEEK_API_KEY)}}"
DEEPSEEK_BASE_URL="${DEEPSEEK_BASE_URL:-${TTLAB_AGENT_LLM_URL:-$(env_get TTLAB_AGENT_LLM_URL)}}"

command -v dsh >/dev/null 2>&1 || fail 'dsh is not installed; install it with: npm install -g @deepseek-ai/dsh'
[[ -n "$DEEPSEEK_API_KEY" ]] || fail 'DEEPSEEK_API_KEY is empty; set TTLAB_DEEPSEEK_API_KEY in server.env (or export DEEPSEEK_API_KEY)'

if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$DSH_PORT" 2>/dev/null | grep -q LISTEN; then
  fail "port $DSH_PORT is already in use; is dsh web already running? (stop it first or change TTLAB_DSH_BASE_URL)"
fi

log "TTLAB_AGENT_ENGINE=dsh; starting dsh web on $DSH_BASE_URL"
log "dsh session workdir: $DSH_WORKDIR"
if [[ -n "$(env_get TTLAB_DSH_TOKEN)" ]]; then
  log 'TTLAB_DSH_TOKEN is set; make sure the dsh local API accepts the same Bearer token'
fi

export DEEPSEEK_API_KEY
if [[ -n "$DEEPSEEK_BASE_URL" ]]; then
  export DEEPSEEK_BASE_URL
fi
cd "$PROJECT_ROOT"
mkdir -p "$DSH_WORKDIR"
exec dsh web --port "$DSH_PORT" --no-open
