#!/usr/bin/env bash
# verify-plugin.sh — safe, isolated verification of a DSH profile plugin package.
#
# What it does
#   1. Static checks of the package shape DSH 0.2.1 requires (package.json
#      fields, host half, client half, bundle patch) and of the client bundle's
#      registration (id must equal the package name).
#   2. Live check against a THROW-AWAY DSH instance: a temporary DSH_HOME under
#      $TMPDIR, a fresh `web` profile, the plugin installed with `link:`, booted
#      on an OS-assigned loopback port, then the boot graph and the
#      /plugins/... client bundle are fetched and asserted.
#
# Safety
#   - Never reads or writes the real ~/.dsh (every child gets DSH_HOME=$tmp).
#   - Never binds 55022 (the running app's port): --port 0 is OS-assigned.
#   - Writes only under one mktemp directory, removed on exit unless --keep.
#   - Does not restart, quit, or otherwise touch the running desktop app.
#
# Usage
#   scripts/verify-plugin.sh [--plugin <dir>] [--static-only] [--keep]
#
# Options
#   --plugin <dir>   Plugin package directory (default: the repo root above this script).
#   --static-only    Run only the manifest/patch checks; no DSH instance is started.
#   --keep           Keep the temporary DSH_HOME and the running instance, print the
#                    authenticated URL for a manual browser check, and do not clean up.
#   -h, --help       This text.
#
# Environment overrides
#   DSH_CLI   Path to the DSH CLI (default: the desktop app's bundled CLI).
#   NODE      Path to a Node.js >= 18 binary (default: `node` on PATH).
#
# Exit status: 0 = every check passed; 1 = a check failed; 2 = environment problem.

set -euo pipefail

APP_CLI_DEFAULT="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
APP_NODE_DEFAULT="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_PLUGIN="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

PLUGIN_DIR="$DEFAULT_PLUGIN"
STATIC_ONLY=0
KEEP=0
DSH_CLI="${DSH_CLI:-$APP_CLI_DEFAULT}"
NODE="${NODE:-}"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ok   %s\n' "$*"; }
bad()  { printf '  FAIL %s\n' "$*" >&2; }
note() { printf '  --   %s\n' "$*"; }
die()  { printf 'verify-plugin: %s\n' "$*" >&2; exit 2; }

usage() {
  sed -n '2,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --plugin)
      [ $# -ge 2 ] || die "--plugin needs a directory"
      PLUGIN_DIR="$2"; shift 2 ;;
    --static-only|--no-live) STATIC_ONLY=1; shift ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

# ---------------------------------------------------------------- environment

[ -d "$PLUGIN_DIR" ] || die "plugin directory not found: $PLUGIN_DIR"
PLUGIN_DIR="$(cd -- "$PLUGIN_DIR" && pwd -P)"
[ -f "$PLUGIN_DIR/package.json" ] || die "no package.json in $PLUGIN_DIR"

if [ -z "$NODE" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE="$(command -v node)"
  elif [ -x "$APP_NODE_DEFAULT" ]; then
    NODE="$APP_NODE_DEFAULT"
  else
    die "no node binary found; set NODE=/path/to/node"
  fi
fi
"$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' \
  || die "Node.js >= 18 required (found $("$NODE" --version 2>/dev/null || echo '?'))"

# ---------------------------------------------------------------- static checks

say "Plugin: $PLUGIN_DIR"
say ""
say "Static checks"

# One JSON blob describing the manifest; field queries below read it.
INFO_JSON="$(PLUGIN_DIR="$PLUGIN_DIR" "$NODE" <<'NODE'
const fs = require('fs')
const path = require('path')
const dir = process.env.PLUGIN_DIR
const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
const dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {}
const client = dsh.client
const bundle = dsh.bundle
const exp = pkg.exports && typeof pkg.exports === 'object' ? pkg.exports : {}
const rel = (v) => typeof v === 'string' ? v : (v && typeof v.default === 'string' ? v.default : '')
const info = {
  name: typeof pkg.name === 'string' ? pkg.name : '',
  version: typeof pkg.version === 'string' ? pkg.version : '',
  type: typeof pkg.type === 'string' ? pkg.type : '',
  main: typeof pkg.main === 'string' ? pkg.main : '',
  rootExport: rel(exp['.']),
  clientExport: rel(exp['./client']),
  hasClientDecl: client !== undefined,
  platform: client && typeof client.platform === 'string' ? client.platform : '',
  inject: client && Array.isArray(client.inject) ? client.inject : [],
  immediately: client && client.immediately === true,
  hasBundleDecl: bundle !== undefined,
  bundlePatch: bundle && typeof bundle.patch === 'string' ? [bundle.patch]
    : bundle && Array.isArray(bundle.patch) ? bundle.patch : [],
  enginesDsh: pkg.engines && typeof pkg.engines.dsh === 'string' ? pkg.engines.dsh : '',
  peerDsh: Object.entries(pkg.peerDependencies || {})
    .filter(([n]) => n === '@deepseek-ai/dsh' || n.startsWith('@deepseek-ai/dsh-'))
    .map(([n, v]) => `${n}@${v}`),
}
process.stdout.write(JSON.stringify(info))
NODE
)" || die "cannot read/parse $PLUGIN_DIR/package.json"

# Query one field of INFO_JSON (empty string when absent). Never fails the script.
field() {
  INFO_JSON="$INFO_JSON" "$NODE" -e '
const info = JSON.parse(process.env.INFO_JSON)
const v = info[process.argv[1]]
process.stdout.write(Array.isArray(v) ? v.join(",") : String(v ?? ""))
' "$1" 2>/dev/null || true
}

NAME="$(field name)"
VERSION="$(field version)"
TYPE="$(field type)"
MAIN="$(field main)"
ROOT_EXPORT="$(field rootExport)"
CLIENT_EXPORT="$(field clientExport)"
HAS_CLIENT="$(field hasClientDecl)"
PLATFORM="$(field platform)"
INJECT="$(field inject)"
IMMEDIATELY="$(field immediately)"
HAS_BUNDLE="$(field hasBundleDecl)"
BUNDLE_PATCH="$(field bundlePatch)"
ENGINES_DSH="$(field enginesDsh)"
PEER_DSH="$(field peerDsh)"

say "Package: ${NAME:-<missing name>}@${VERSION:-<missing version>}"

failures=0
pass() { ok "$1"; }
fail() { bad "$1"; failures=$((failures + 1)); }

[ -n "$NAME" ] && pass 'package.json has "name"' || fail 'package.json has no "name"'
[ -n "$VERSION" ] && pass 'package.json has "version"' || fail 'package.json has no "version"'
[ "$TYPE" = module ] && pass 'package.json "type" is "module" (host half is ESM)' \
  || fail 'package.json "type" is not "module" (required for the ESM host half)'

HOST_REL="${MAIN:-$ROOT_EXPORT}"
if [ -n "$HOST_REL" ]; then
  HOST_FILE="$PLUGIN_DIR/${HOST_REL#./}"
  if [ -f "$HOST_FILE" ]; then
    pass "host half exists: $HOST_REL"
    if "$NODE" --check "$HOST_FILE" 2>/dev/null; then pass "host half parses: $HOST_REL"
    else fail "host half has a syntax error: $HOST_REL"; fi
  else
    fail "host half missing: $HOST_REL"
  fi
else
  fail 'package.json has neither "main" nor exports["."] (the loader imports the package root)'
fi

if [ "$HAS_CLIENT" = true ]; then
  [ "$PLATFORM" = web ] && pass 'dsh.client.platform is "web"' \
    || fail "dsh.client.platform is \"$PLATFORM\" (must be \"web\")"
  if [ -n "$CLIENT_EXPORT" ]; then
    CLIENT_FILE="$PLUGIN_DIR/${CLIENT_EXPORT#./}"
    if [ -f "$CLIENT_FILE" ]; then
      pass "client bundle exists: $CLIENT_EXPORT"
      if "$NODE" --check "$CLIENT_FILE" 2>/dev/null; then pass 'client bundle parses as JavaScript'
      else fail 'client bundle has a syntax error'; fi
      if grep -q '__ModuleLoader__\.load' "$CLIENT_FILE"; then
        pass 'client bundle calls window.__ModuleLoader__.load'
      else
        fail 'client bundle does not call window.__ModuleLoader__.load'
      fi
      if grep -qE "id:[[:space:]]*[\"']${NAME//./\\.}[\"']" "$CLIENT_FILE"; then
        pass "client bundle registers id \"$NAME\" (matches package name)"
      else
        fail "client bundle registration id does not match package name \"$NAME\""
      fi
    else
      fail "client bundle missing: $CLIENT_EXPORT (DSH fails startup for this)"
    fi
  else
    fail 'dsh.client is declared but exports["./client"] is missing'
  fi
  [ -n "$INJECT" ] && note "dsh.client.inject: $INJECT"
  note "dsh.client.immediately: $IMMEDIATELY"
else
  note 'no dsh.client declaration: host-only plugin (no browser bundle)'
fi

if [ "$HAS_BUNDLE" = true ]; then
  IFS=',' read -r -a PATCH_FILES <<< "$BUNDLE_PATCH"
  if [ "${#PATCH_FILES[@]}" -gt 0 ] && [ -n "${PATCH_FILES[0]}" ]; then
    pass 'dsh.bundle.patch is declared'
    for pf in "${PATCH_FILES[@]}"; do
      [ -f "$PLUGIN_DIR/${pf#./}" ] && pass "bundle patch exists: $pf" \
        || fail "bundle patch missing: $pf"
    done
    PATCH_MAIN="${PATCH_FILES[0]}"
    if [ -f "$PLUGIN_DIR/${PATCH_MAIN#./}" ]; then
      if grep -q 'insert:' "$PLUGIN_DIR/${PATCH_MAIN#./}" \
         && grep -q "$NAME" "$PLUGIN_DIR/${PATCH_MAIN#./}"; then
        pass 'bundle patch contains an insert row naming the package'
      else
        fail 'bundle patch has no insert row naming the package (the row would never mount)'
      fi
    fi
  else
    fail 'dsh.bundle.patch is empty'
  fi
else
  note 'no dsh.bundle declaration: install as a plain dependency and add a direct insert row'
fi

if [ -n "$ENGINES_DSH" ] || [ -n "$PEER_DSH" ]; then
  note "compatibility requirements: engines.dsh=${ENGINES_DSH:-<none>} peers=${PEER_DSH:-<none>}"
  note 'DSH 0.2.1-rc.2 enforces these; the live check reports a rejection if they mismatch.'
fi

if [ "$failures" -gt 0 ]; then
  say ""
  bad "static checks failed: $failures problem(s)"
  exit 1
fi

say ""
if [ "$STATIC_ONLY" -eq 1 ]; then
  say 'PASS (static checks only; live check skipped)'
  exit 0
fi

# ---------------------------------------------------------------- live check

[ -x "$DSH_CLI" ] || [ -f "$DSH_CLI" ] || die "DSH CLI not found: $DSH_CLI (set DSH_CLI)"
command -v curl >/dev/null 2>&1 || die 'curl is required for the live check'

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dsh-plugin-verify.XXXXXX")"
TMP_HOME="$TMP_ROOT/home"
mkdir -p "$TMP_HOME/pnpm-store" "$TMP_ROOT/xdg-cache" "$TMP_ROOT/xdg-config" \
         "$TMP_ROOT/xdg-data" "$TMP_ROOT/pnpm-home" "$TMP_ROOT/npm-cache"

INSTANCE_PID=""
cleanup() {
  local status=$?
  if [ -n "$INSTANCE_PID" ] && kill -0 "$INSTANCE_PID" 2>/dev/null; then
    kill "$INSTANCE_PID" 2>/dev/null || true
    wait "$INSTANCE_PID" 2>/dev/null || true
  fi
  if [ "$KEEP" -eq 0 ] && [ -d "$TMP_ROOT" ]; then
    rm -rf "$TMP_ROOT"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

# Children only see the throw-away home and local caches.
CHILD_ENV=(
  "DSH_HOME=$TMP_HOME"
  "DSH_TELEMETRY_DISABLED=1"
  "XDG_CACHE_HOME=$TMP_ROOT/xdg-cache"
  "XDG_CONFIG_HOME=$TMP_ROOT/xdg-config"
  "XDG_DATA_HOME=$TMP_ROOT/xdg-data"
  "PNPM_HOME=$TMP_ROOT/pnpm-home"
  "npm_config_cache=$TMP_ROOT/npm-cache"
)

say "Isolated install (temporary DSH_HOME)"
if ! env "${CHILD_ENV[@]}" "$DSH_CLI" plugin --profile web add "link:$PLUGIN_DIR" \
      --offline --store-dir "$TMP_HOME/pnpm-store" >"$TMP_ROOT/install.log" 2>&1; then
  bad 'isolated `dsh plugin add` failed:'
  sed 's/^/       /' "$TMP_ROOT/install.log" >&2
  exit 1
fi
ok 'dsh plugin add completed (offline, link:)'

MANIFEST="$TMP_HOME/profiles/web/package.json"
[ -f "$MANIFEST" ] || { bad "profile manifest missing after install: $MANIFEST"; exit 1; }
grep -q "\"$NAME\"" "$MANIFEST" && ok "profile dependencies contain $NAME" \
  || { bad "profile dependencies do not contain $NAME"; exit 1; }

IN_BUNDLES="$(MANIFEST="$MANIFEST" PLUGIN_NAME="$NAME" "$NODE" <<'NODE'
const fs = require('fs')
const m = JSON.parse(fs.readFileSync(process.env.MANIFEST, 'utf8'))
const bundles = (m.dsh && m.dsh.profile && m.dsh.profile.bundles) || []
process.stdout.write(bundles.includes(process.env.PLUGIN_NAME) ? 'yes' : 'no')
NODE
)"

if [ "$HAS_BUNDLE" = true ]; then
  [ "$IN_BUNDLES" = yes ] && ok "dsh.profile.bundles contains $NAME (auto-reconciled)" \
    || { bad 'dsh.profile.bundles was NOT updated for a bundle package'; exit 1; }
elif [ "$IN_BUNDLES" = yes ]; then
  ok "dsh.profile.bundles contains $NAME"
else
  # Plain dependency: add the row by hand to the throw-away profile's user layer.
  PATCH="$TMP_HOME/profiles/web/cordis.patch.yml"
  {
    printf '# generated by verify-plugin.sh (throw-away profile)\n'
    printf -- '- insert:\n    - id: %s\n      name: %s\n      config: {}\n' "$NAME" "$NAME"
  } > "$PATCH"
  ok 'added a direct insert row to the throw-away profile cordis.patch.yml'
fi

say ""
say "Isolated boot (loopback, OS-assigned port)"
env "${CHILD_ENV[@]}" "$DSH_CLI" --profile web --no-open --host 127.0.0.1 --port 0 \
  >"$TMP_ROOT/instance.log" 2>&1 &
INSTANCE_PID=$!

ready=0
for _ in $(seq 1 90); do
  if grep -q 'dsh web: http' "$TMP_ROOT/instance.log" 2>/dev/null; then ready=1; break; fi
  if ! kill -0 "$INSTANCE_PID" 2>/dev/null; then break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  bad 'isolated instance did not become ready; host output:'
  sed 's/^/       /' "$TMP_ROOT/instance.log" >&2
  STARTUP_LOG="$(find "$TMP_HOME/logs" -name 'startup-*.log' 2>/dev/null | head -1 || true)"
  if [ -n "$STARTUP_LOG" ]; then
    bad "startup diagnostics: $STARTUP_LOG"
    head -40 "$STARTUP_LOG" | sed 's/^/       /' >&2 || true
  fi
  exit 1
fi
URL="$(grep -o 'http://127.0.0.1:[0-9]*/?token=[A-Za-z0-9_-]*' "$TMP_ROOT/instance.log" | head -1 || true)"
ROOT="${URL%%/?token=*}"
if [ -z "$URL" ] || [ -z "$ROOT" ]; then
  bad 'could not parse the authenticated URL from the instance log'
  exit 1
fi
ok "instance ready on $ROOT (token captured)"

COOKIE_JAR="$TMP_ROOT/cookies.txt"
EXCHANGE_STATUS="$(curl -sS -c "$COOKIE_JAR" -o /dev/null -w '%{http_code}' "$URL")"
[ "$EXCHANGE_STATUS" = 303 ] && ok 'token exchange returned 303 + browser cookie' \
  || { bad "token exchange returned $EXCHANGE_STATUS (expected 303)"; exit 1; }

INDEX="$TMP_ROOT/index.html"
INDEX_STATUS="$(curl -sS -b "$COOKIE_JAR" -o "$INDEX" -w '%{http_code}' "$ROOT/")"
[ "$INDEX_STATUS" = 200 ] && ok 'authenticated GET / returned 200' \
  || { bad "authenticated GET / returned $INDEX_STATUS"; exit 1; }

say ""
say "Boot graph"
if ! ENTRY_URL="$(INDEX_FILE="$INDEX" PLUGIN_NAME="$NAME" "$NODE" <<'NODE'
const fs = require('fs')
const html = fs.readFileSync(process.env.INDEX_FILE, 'utf8')
const name = process.env.PLUGIN_NAME
for (const marker of ['globalThis["__DSH_BOOT__"] = ', 'window.__DSH_BOOT__ = ']) {
  const i = html.indexOf(marker)
  if (i < 0) continue
  const graph = JSON.parse(html.slice(i + marker.length, html.indexOf('</script>', i)))
  const entry = graph.entries.find((e) => e.id === name)
  if (!entry) {
    console.error(`entry "${name}" is NOT in the boot graph (${graph.entries.length} entries, rev ${graph.rev})`)
    process.exit(1)
  }
  console.error(`entry found (graph rev ${graph.rev}, ${graph.entries.length} entries)`)
  console.error(`url=${entry.url} rev=${entry.rev} inject=${JSON.stringify(entry.inject || [])}`)
  process.stdout.write(entry.url)
  process.exit(0)
}
console.error('no __DSH_BOOT__ manifest found in the served index')
process.exit(1)
NODE
)"; then
  bad 'boot graph check failed'
  exit 1
fi
ok 'client entry present in __DSH_BOOT__'
note "entry url: $ENTRY_URL"

REQUEST_PATH="$ENTRY_URL"
case "$REQUEST_PATH" in
  /*) : ;;
  *) REQUEST_PATH="/$REQUEST_PATH" ;;
esac

say ""
say "Client bundle"
BUNDLE_STATUS="$(curl -sS -b "$COOKIE_JAR" -o "$TMP_ROOT/client.js" -w '%{http_code}' "$ROOT$REQUEST_PATH")"
[ "$BUNDLE_STATUS" = 200 ] && ok "GET $REQUEST_PATH returned 200" \
  || { bad "GET $REQUEST_PATH returned $BUNDLE_STATUS (expected 200)"; exit 1; }
grep -q '__ModuleLoader__' "$TMP_ROOT/client.js" && ok 'served body contains the __ModuleLoader__ registration' \
  || { bad 'served body does not look like a DSH client bundle'; exit 1; }
grep -qE "id:[[:space:]]*[\"']${NAME//./\\.}[\"']" "$TMP_ROOT/client.js" \
  && ok "served body registers id \"$NAME\"" \
  || { bad "served body does not register id \"$NAME\""; exit 1; }
ok "served bundle size: $(wc -c < "$TMP_ROOT/client.js" | tr -d ' ') bytes"

WRONG_REV_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' "$ROOT/plugins/??$NAME/client.js&rev=000000000000")"
[ "$WRONG_REV_STATUS" = 404 ] && ok 'wrong rev returns 404 (the revision is enforced)' \
  || { bad "wrong rev returned $WRONG_REV_STATUS (expected 404)"; exit 1; }

say ""
say "Board host (SQLite)"
BOARD_STATUS="$(curl -sS -b "$COOKIE_JAR" -o "$TMP_ROOT/board.json" -w '%{http_code}' "$ROOT/api/pomodoro-board/state")"
[ "$BOARD_STATUS" = 200 ] && ok 'GET /api/pomodoro-board/state returned 200' \
  || { bad "GET /api/pomodoro-board/state returned $BOARD_STATUS"; exit 1; }
BOARD_LISTS="$(BOARD_FILE="$TMP_ROOT/board.json" "$NODE" -e '
const fs = require("fs")
const body = JSON.parse(fs.readFileSync(process.env.BOARD_FILE, "utf8"))
const lists = body.board && Array.isArray(body.board.lists) ? body.board.lists.map((list) => list.title) : []
process.stdout.write(JSON.stringify({ revision: body.revision, lists }))
')"
ok "board state: $BOARD_LISTS"
BOARD_DB="$TMP_HOME/pomodoro/board.sqlite"
[ -f "$BOARD_DB" ] && ok 'SQLite database created under the temporary DSH home' \
  || { bad "SQLite database missing at $BOARD_DB"; exit 1; }

say ""
if [ "$KEEP" -eq 1 ]; then
  say 'PASS — checks passed. Instance kept running for a manual browser check:'
  say "  URL:     $URL"
  say "  Profile: $TMP_HOME/profiles/web"
  say "  Stop:    kill $INSTANCE_PID && rm -rf \"$TMP_ROOT\""
  INSTANCE_PID=""
  trap - EXIT INT TERM
  exit 0
fi

say 'PASS — the plugin mounts and its client bundle is served by the isolated DSH instance.'
say '(This proves the host/graph/bundle path; rendered UI still needs the real app after restart.)'
exit 0
