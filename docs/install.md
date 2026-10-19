# Installing `dsh-plugin-pomodoro` into the DSH desktop profile

Status: **executed on this machine on 2026-10-19.** The package was installed into
`~/.dsh/profiles/desktop` with the app's bundled CLI (backups:
`package.json.bak-pomodoro-20261019-042332`, `cordis.patch.yml.bak-pomodoro-20261019-042332`).
The running app was not restarted during the editing session, so the desktop window still shows
the pre-install state; a relaunch is required for it to load the plugin. v0.2.0 also adds the task
board: on the next host start it creates `$DSH_HOME/pomodoro/board.sqlite` and serves the five
`/api/pomodoro-board/*` routes through the connection carrier. Every live check below
was performed against throw-away, isolated DSH instances under `/tmp`.

Target package: [`pomodoro-plugin`](../README.md) — name **`dsh-plugin-pomodoro`** (v0.1.0),
a browser-only DSH client plugin with an empty host half and its own bundle patch file.

Verified against:

| Fact | Value | How it was read |
|---|---|---|
| Desktop app | `/Applications/DeepSeek Harness.app` — `@deepseek-ai/dsh-desktop` **0.2.1-rc.2** | `runtime/primary-runtime/runtime.json`, app.asar `package.json` |
| Bundled runtime | DSH **0.2.1-rc.2**, Node **24.21.0**, pnpm **11.28.5** | `runtime/primary-runtime/runtime.json` |
| Bundled CLI | `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` (`--version` → `0.2.1-rc.2`) | ran it |
| App binary | `/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness` | `ls` |
| Desktop profile | `$HOME/.dsh/profiles/desktop` (`DSH_PROFILE_DIR`) | session env, app.asar host spawn |
| Running web surface | `http://127.0.0.1:55022` (PID 64562, `DeepSeek ... TCP 127.0.0.1:55022 (LISTEN)`) | `lsof -nP -iTCP:55022` |
| Session env | `DSH_HOME=$HOME/.dsh`, `DSH_PROFILE=desktop`, `DSH_PROFILE_DIR=$HOME/.dsh/profiles/desktop` | `env` |

> **Version trap.** The packages extracted at `~/.dsh/profiles/node_modules/@deepseek-ai/` are
> **0.1.0-rc.7** copies symlinked into `<dsh-checkout>/apps/cli`
> (that repo's `apps/cli` is 0.1.0-rc.7). They are a *legacy* module fallback from an older
> launcher. The 0.2.1 desktop runtime resolves its own in-box packages from
> `app.asar/dsh/node_modules/**` and **does not use** that fallback for boot (0.2.1 replaced the
> fallback-heal with an in-process runtime resolution; its own Host stack traces name
> `app.asar/.../node_modules/@deepseek-ai/...`). Do not install into, delete, or "fix"
> `~/.dsh/profiles/node_modules`.

---

## 0. TL;DR — copy-paste for the Lead

The plugin is a **bundle package** (it declares `dsh.bundle.patch`), so one `dsh plugin add`
both adds the dependency and appends it to `dsh.profile.bundles`. The bundle's own
`cordis.patch.yml` inserts the loader row — no manual `cordis.patch.yml` edit is required.

```bash
# 1. Paths
APP_CLI="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
PLUGIN="$PWD"   # run from the plugin repository root
PROFILE="$HOME/.dsh/profiles/desktop"
STAMP="$(date +%Y%m%d-%H%M%S)"

# 2. Fully quit the running desktop app (Cmd+Q) BEFORE this step. Do not run while it is open.
#    Optional but recommended backups (restore = rollback):
cp "$PROFILE/package.json"       "$PROFILE/package.json.bak-pomodoro-$STAMP"
cp "$PROFILE/cordis.patch.yml"   "$PROFILE/cordis.patch.yml.bak-pomodoro-$STAMP"

# 3. Install (offline; link: dependency needs no registry access — verified)
"$APP_CLI" plugin --profile desktop add "link:$PLUGIN" --offline

# 4. Check the result (expect the dependency + the appended bundle entry)
cat "$PROFILE/package.json"
ls -la "$PROFILE/node_modules/dsh-plugin-pomodoro"   # symlink -> $PLUGIN
ls       "$PROFILE/pnpm-lock.yaml"                   # created by the install

# 5. Relaunch DeepSeek Harness. Verify: open the app, a tomato timer is in the shell overlay.
#    (Restart, not just a page refresh — see §6.)
#    Plugins (sidebar) -> Installed plugins -> dsh-plugin-pomodoro then offers:
#      - the bundle switch on the card and the Component (unload) switch on the page;
#      - Configure, opening the plugin's own page (Floating timer switch + timer settings).
#    Board: press B (or the board button on the timer) to open it. Its data is the host's
#    $DSH_HOME/pomodoro/board.sqlite; the daily backup lives beside it as board.sqlite.bak.
```

If the app ever fails to start after a bad install, use the in-app recovery dialog
("disable plugins") or restore the two backups from step 2 — see §9.3.

Clean uninstall:

```bash
# Quit the app first.
"$APP_CLI" plugin --profile desktop remove dsh-plugin-pomodoro
# (no --offline: `pnpm remove` rejects that option — verified)
```

The dependency and the `dsh.profile.bundles` entry are both removed automatically (verified on a
copied profile). Restart the app afterwards.

---

## 1. Package shape required by DSH 0.2.1

A plugin is an ordinary npm package. A package can be **only** a host plugin, or a dual-face
"bundle" with a browser half. This plugin is the dual-face bundle form.

### 1.1 Required fields (dual-face bundle)

```jsonc
{
  "name": "dsh-plugin-pomodoro",          // MUST equal the loader row id used in the graph
  "version": "0.1.0",
  "private": true,                        // fine for link: installs
  "type": "module",                       // host half is ESM
  "main": "./lib/index.js",               // OR exports["."]
  "exports": {
    ".":        { "default": "./lib/index.js" },   // host half entry (empty apply is fine)
    "./client": { "default": "./lib/client.js" }   // browser bundle: REQUIRED when dsh.client is set
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // makes it a profile layer; string or string[]
    "client": {                                    // browser half declaration
      "platform": "web",                           // required; exactly "web" or it is ignored
      "inject": [                                  // optional; client-module dependency edges
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-ui-primitives"
      ],
      "immediately": true                          // optional: prefetch at page boot
    }
  }
}
```

Facts verified in the 0.2.1 sources (`app.asar/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js`,
`dsh-app-boot/lib/index.js`):

* `dsh.client.platform` is validated as a string; only `"web"` produces a graph row.
  A non-web platform is silently *not* a client package (negative verdict cached per package).
* If `dsh.client` is present, `exports["./client"]` must exist. Otherwise startup fails with
  `client-modules: <pkg> declares dsh.client but exports no "./client" bundle`.
* `dsh.client.inject` / `dsh.client.external` must be string arrays when present. `inject` is
  informational graph metadata in 0.2.1 (edges for ordering/diagnostics); it does not create rows.
* `exports["./package.json"]` is **not** required by 0.2.1 (the client scan resolves the package
  manifest through the loader's resolved module URL). It was required by 0.1.x; adding it is
  harmless.
* The package root (`main` / `exports["."]`) is imported by the Cordis loader as the **host
  half**. It must export at least an `apply()` function; `apply(){}` (empty) is valid — that is
  exactly what this plugin does (`lib/index.js`).
* `dsh.bundle.patch` may be a string or an ordered array of strings (0.2.1).
* A package may declare both `dsh.bundle` and `dsh.client` (this one does).

### 1.2 Compatibility gate (important for a plugin written against old packages)

On install **and** on boot, the manifest is checked against the running DSH version
(**0.2.1-rc.2** here):

* If the manifest has its own `engines.dsh` range, that range decides alone.
* Otherwise every `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` **peerDependency** must match
  `0.2.1-rc.2`. `workspace:^`, `workspace:~`, `workspace:*` in a *peer* are treated as the current
  runtime.
* This plugin declares **neither**, so it passes. Do not "helpfully" add peers keyed to the
  stale 0.1.0-rc.7 checkout; that would be rejected with:
  `dsh: installation rejected: Plugin <pkg>@<ver> is incompatible with dsh 0.2.1-rc.2: requirements {...}`

Escape hatch (only if a future version genuinely needs it):
`"$APP_CLI" plugin --profile desktop allow-version <pkg>@<ver> --dsh-version 0.2.1-rc.2 --accept-risk`.

### 1.3 What this package currently is (checked on disk)

`pomodoro-plugin/package.json` matches the shape above: `name: "dsh-plugin-pomodoro"`,
`main: "./lib/index.js"`, `exports["./client"] → ./lib/client.js`, `dsh.bundle.patch →
./cordis.patch.yml`, `dsh.client.platform: "web"`, `inject` = locale/runtime/ui-primitives,
`immediately: true`. Both `lib/index.js` and `lib/client.js` exist and are committed artifacts.
`lib/client.js` registers itself with `window.__ModuleLoader__.load({ id: "dsh-plugin-pomodoro", … })`
(its id **must** match the package name; the host graph row is keyed by the package name).

---

## 2. Package install mechanics

### 2.1 Dependency form: `link:` (absolute path) — recommended

Verified on an isolated copy of the desktop profile:

```bash
"$APP_CLI" plugin --profile desktop add "link:$PLUGIN" --offline
```

Resulting `profiles/desktop/package.json`:

```json
"dependencies": {
  "dsh-plugin-pomodoro": "link:/absolute/path/to/pomodoro-plugin"
}
```

* pnpm records the **absolute** `link:` path, and creates
  `<profile>/node_modules/dsh-plugin-pomodoro` as a **symlink** to the plugin directory (checked:
  `dsh-plugin-pomodoro -> <repo-dir>`).
* Edits to the plugin's files are therefore live for the next boot; there is no copy step.
* `file:` (also accepted, absolute path) *copies* the package into the pnpm store/lockfile
  instead of linking. For an in-repo plugin you are still editing, use `link:`.
* The profile's `pnpm-workspace.yaml` already declares `nodeLinker: hoisted` and
  `autoInstallPeers: false`; pnpm ≥10 reads those from this file, not `.npmrc`. Do not change it.
* The command initialises `node_modules/` and `pnpm-lock.yaml` in the profile (the desktop
  profile currently has neither; it had `dependencies: {}` before install).

Manual equivalent, if the CLI is unavailable: edit `dependencies` in
`profiles/desktop/package.json` (add the `"link:/abs/path"` entry), **add the package name to
`dsh.profile.bundles` by hand**, then run the app's own pnpm from the profile directory:

```bash
cd "$HOME/.dsh/profiles/desktop"
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  --expose-internals \
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" \
  install --offline --store-dir "$TMPDIR/pnpm-store-pomodoro"
```

Caveat: `dsh plugin install` **reconciles only newly added dependencies**. If you hand-add the
dependency *before* running `plugin install`, the bundle is **not** appended to
`dsh.profile.bundles` automatically (verified) — hence the manual bundles edit above.

### 2.2 The CLI must be the **app's bundled** CLI

```bash
APP_CLI="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"   # 0.2.1-rc.2
```

Verified facts:

* `~/.local/bin/dsh` is a symlink to the *older source checkout*
  `<dsh-checkout>/apps/cli/lib/bin.js` (**0.1.0-rc.7**).
  It uses a different app-boot, a different pnpm lookup and different profile rules. **Do not
  use it for the desktop profile.**
* The bundled CLI `--version` prints `0.2.1-rc.2`.
* The desktop profile is reserved: the launcher code rejects booting it from a plain CLI
  (`error: profile "desktop" is managed exclusively by the Electron application`), and
  `dsh plugin --profile desktop` is allowed only for the bundled desktop CLI (it passes an
  internal `manageDesktopProfile` flag). **Only the bundled CLI can manage the desktop profile.**
* If the profile were missing, the bundled CLI refuses with:
  `dsh: Error: Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before running dsh plugin --profile desktop.`
* The bundled CLI drives the **bundled pnpm 11.28.5** (via Electron-as-Node + the pnpm entry under
  `runtime/primary-runtime/dependencies/pnpm/`); Node on `PATH` is irrelevant (the CLI spawns its
  own). `--offline` is accepted by `add`/`install`; `pnpm remove` rejects it
  (`[ERROR] Unknown option: 'offline'`).

### 2.3 What `plugin add` changes (and does not)

Changes to `~/.dsh/profiles/desktop`:

1. `package.json` — `dependencies` gets the `link:` entry; because the package declares
   `dsh.bundle.patch`, its name is appended to `dsh.profile.bundles` (verified on a copy of the
   real desktop manifest: `… "@dsh-external/dsh-plugin-pomodoro"` appeared at the end).
2. `node_modules/` + `pnpm-lock.yaml` — pnpm materialises the link (verified).
3. `.plugin-manager/logs/operation-*/pnpm.log` — the operation log (created on both success and
   failure).

It does **not** touch `cordis.yml` (the app rewrites that on every boot), it does not parse or
rewrite the plugin's own patch file beyond validating it, and it does not start the app.

Exit codes/diagnostics:

* Success: exit 0, pnpm output on the terminal.
* Compat/preflight rejection: exit 1, `dsh: installation rejected: …`, `dsh: nothing was installed.`
* pnpm failure: exit 1, `dsh: plugin command failed; diagnostics: <profile>/.plugin-manager/logs/operation-*/pnpm.log`.

---

## 3. `cordis.patch.yml` entry syntax

Two equivalent routes produce the same loader row. This plugin uses route **A**.

### A. Bundle-provided row (this plugin — nothing to edit by hand)

`pomodoro-plugin/cordis.patch.yml` (already in the repo):

```yaml
- insert:
    - id: pomodoro                     # loader row id (unique in the tree)
      name: dsh-plugin-pomodoro        # package specifier resolved from the profile
      config: {}                       # optional; replaces (does not merge) the row config
```

The bundle is applied automatically because `dsh-plugin-pomodoro` is in
`dsh.profile.bundles`; the same file can be a `string[]` via `dsh.bundle.patch`.

### B. Direct row in the profile's user layer (`~/.dsh/profiles/desktop/cordis.patch.yml`)

Only needed if a package is installed **without** `dsh.bundle`. Append exactly:

```yaml
- insert:
    - id: pomodoro
      name: dsh-plugin-pomodoro
      config: {}
```

Verified end-to-end with a stub package in an isolated profile: the row mounts the host half,
and the `dsh.client` half is discovered and added to the boot graph from that single row.

Hard-won syntax rules:

* **`insert:` is required to create a row.** A top-level patch row such as
  `- id: pomodoro` + `name: …` is an *id-targeted override* (config/disabled) for an existing
  row. If the id is not already in the tree, the loader only emits a warning and mounts nothing.
* `config` is **replaced**, not deep-merged, by a later id-targeted patch. Row order carries no
  load semantics (activation is service-driven).
* `!!js` expressions are allowed (`config: { key: !!js ctx.someService.value }`), evaluated
  against the row's injection-ready context.
* The same syntax works for a `group` of rows (see `dsh-base`'s patch for examples).
* The file is a **top-level YAML array**. Do not append a list to the template's `[]`
  placeholder; replace `[]` or start the file with the header comment + list items.

The client half needs **no** separate row: the `name` row's package is scanned for
`dsh.client`; the browser bundle is served from the graph automatically (see §4).

---

## 4. How the host discovers and serves the client bundle (0.2.1-rc.2)

1. The profile composition mounts the loader row `{ id, name }` (from the bundle patch or the
   user layer). The Cordis loader imports the package root (`main` / `exports["."]`) — the empty
   host half — from `<profile>/node_modules/dsh-plugin-pomodoro`.
2. `@deepseek-ai/dsh-client-modules` scans every live loader entry whose package declares
   `dsh.client` with `platform === "web"`. It resolves the package manifest, then
   `exports["./client"]`, and computes a revision from the **file stat** (`mtimeMs`, `ctimeMs`,
   `size` → framed sha1, first 12 hex chars).
3. It composes `globalThis["__DSH_BOOT__"]` and injects it into the served `index.html`
   (the Electron desktop window gets the same injection list over IPC from the Host; see §6).
   The real graph observed from an isolated 0.2.1 instance, for this plugin (sample — `rev` is
   derived from the bundle file's stat metadata, so it changes whenever the bundle is rebuilt):

   ```json
   {"id":"dsh-plugin-pomodoro",
    "url":"plugins/??dsh-plugin-pomodoro/client.js&rev=3dd74f16a861",
    "rev":"3dd74f16a861",
    "inject":["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-runtime","@deepseek-ai/dsh-client-ui-primitives"],
    "immediately":true}
   ```

   The graph also carries a whole-graph `rev` and `release: {"version":"0.2.1-rc.2","commit":"332895e"}`.
4. The browser bundle endpoint is `/plugins/...`, registered by client-modules on the host
   webserver and **public** (no auth needed once you know the URL; the index document itself is
   auth-gated).

### Exact URL semantics (differs from older 0.1.x docs!)

* **Current (0.2.1) single-plugin URL:** `GET /plugins/??<id>/client.js&rev=<rev>` — note the
  `??` combo prefix and `&rev=` (the graph row's `url` is this string *without* the leading
  slash; resolve it against the page root). Source map:
  `/plugins/??<id>/client.js.map&rev=<rev>`.
  Batch form (what the page preloads): `/plugins/??id1/client.js,id2/client.js&rev=<comboRev>`.
* **The old form `/plugins/<id>/client.js?rev=<rev>` returns 404 on 0.2.1** (verified). Do not
  write checks against it.
* The `rev` must match the **current** rev exactly. Wrong/unknown rev → **404** (verified).
  Successful responses carry `cache-control: public, max-age=31536000, immutable` and
  `content-type: text/javascript; charset=utf-8`.
* Unknown package id → 404. Wrong method → 405.
* The host does **not** parse or validate the bundle body; it serves bytes. Malformed
  `__ModuleLoader__.load(...)` or a missing `id` fails in the **browser**, not on the host.

The served bundle starts with:

```js
window.__ModuleLoader__.load({
  id: "dsh-plugin-pomodoro",
  factory: (require) => { /* … returns exports with apply/inject … */ },
});
```

For the browser-side contract (slots, `apply`, CSS injection, locale) see
[client-api.md](./client-api.md). Note that `client-api.md` was written from the 0.1.0-rc.7
checkout; the **installer-relevant** facts above were re-verified against the running app's
0.2.1-rc.2 runtime.

---

## 5. Reload semantics — restart is required for the desktop window

**Verdict: restart the whole app after installing. A page refresh is not sufficient for the
desktop window.** Details, with the evidence that settles it:

### 5.1 Host level: profile changes are hot-reloaded

The 0.2.1 runtime mounts `@deepseek-ai/dsh-hmr` (`dsh-base` row `hmr`, enabled whenever
`profileContext` exists — true in the desktop Host). It watches:

* `~/.dsh/profiles/desktop/cordis.patch.yml`
* `~/.dsh/cordis.patch.yml` (home-level user layer)
* `~/.dsh/profiles/desktop/package.json`

…and on change recomposes the profile, recomputes the runtime package resolution and starts/
stops loader entries. This was verified empirically on an isolated 0.2.1 instance (CLI-booted,
same composition machinery):

| Action while running | Result | Time to appear in a fresh `GET /` |
|---|---|---|
| Append a direct `insert` row (already-installed package) | new client entry appears in `__DSH_BOOT__`, bundle serves 200 | ~3–4 s |
| Remove that row (valid YAML `[]`) | entry disappears | ~3 s |
| `dsh plugin add link:` a **new** bundle while the instance runs | dependency + `dsh.profile.bundles` updated; new entry appears; bundle serves 200 | ~4 s |
| `dsh plugin remove` that bundle while running | dependency + bundle entry drop; entry disappears | ~4 s |

No “restart required” warning was printed. The HMR only demands a restart for cases it reports as
`restart required: <reason>` (e.g. a package directory moved, or `module-comparison` when a loaded
module file changed in a way it cannot hot-swap). A brand-new plugin does not hit those.

### 5.2 Desktop (Electron) window: boot injections are frozen at Host start

The desktop app does not load the Host's `index.html`. The Electron shell serves the frontend
from `dsh-app://app`, and the renderer obtains the boot injections (including
`globalThis["__DSH_BOOT__"]`, the `__ModuleLoader__` queue, and the plugin preload/batch rows)
once, over IPC, from the Host's `ready` message:

* `app.asar/lib/main.js`: `injections = ready.injections` at Host start; `DESKTOP_IPC.boot`
  returns that captured `injections` array; `serveWebDocument` injects only a
  `__DSH_BOOT_READY__` promise into the HTML.
* Therefore a renderer reload (`Cmd+R`) reuses the **stale snapshot** of injections. A plugin
  added to the Host graph while the app is running would be visible to the Host (and to a plain
  browser tab opened at the authenticated URL), but **not** in the app window until the Host is
  restarted — i.e. until the app is relaunched.

**Practical rule:** quit the app → install → relaunch. This is also the only race-free way to
combine the CLI with the app's profile locks. The verified hot path above is documented for
recovery/curiosity, not as the install procedure.

If, after an install, the app boots but the timer does not appear, check the errors in §7 before
changing anything; a missing/invalid client bundle fails startup loudly, it does not silently
degrade.

---

## 6. Error surfaces and logs

| Surface | Location / shape | What it means |
|---|---|---|
| CLI install failure | stderr + exit 1 (string examples in §2.3); full pnpm log at `<profile>/.plugin-manager/logs/operation-*/pnpm.log` | Install did not complete; profile manifest restored on compatibility rejection |
| Host startup failure | stderr one-liner `dsh: startup failed: N required plugin did not activate …` plus a structured diagnostics file at **`$DSH_HOME/logs/startup-<ISO timestamp>-<uuid>.log`** (verified with a deliberately broken client bundle) | A plugin row failed to import/activate; includes the failing plugin, package, missing file and stack |
| Desktop app startup failure | native recovery dialog; crash report **`~/Library/Logs/DeepSeek Harness/crash-<ISO>-<host|web-boot|renderer|main>.log`** (last 10 kept) | Electron shell captures the Host's stderr tail + Host diagnostic and writes the report before the dialog |
| Desktop recovery action | “disable plugins” calls `sanitizeProfile`: backs up `cordis.patch.yml` → `cordis.patch.yml.bak-<timestamp>` and rewrites `dsh.profile.bundles` to `[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app]` (dependencies kept) | Fastest in-app rollback after a fatal startup |
| Live HMR failure | Host logger (`ctx.logger.warn`), e.g. `config reload at <path> failed` / `restart required: <reason>` | A live profile edit could not be applied; restart |
| Browser-side bundle errors | DevTools console of the page (`__ModuleLoader__`, missing `apply`, duplicate id, slot errors) | The host never parses the bundle; these are runtime browser failures |
| Session logs | `~/.dsh/sessions/<workspace-key>/session-*/session*.jsonl.zstd` | Conversation/session data, **not** installer diagnostics |
| Normal-operation desktop logs | **No persistent file.** The Host's stdout/stderr go to the Electron shell (stdout inherited, stderr kept in a 64 KiB in-memory tail). `~/Library/Logs/DeepSeek Harness/` is empty until a crash report is written | To see live Host warnings, launch the Host from a terminal (§8.3) or reproduce in an isolated instance |

Concrete failure texts observed:

* Missing `./client` bundle (client package declared but file absent) — startup fails because
  the `modules` row is required:

  ```
  dsh: startup failed: 1 required plugin did not activate
  Failed plugins (1):
    modules (required)
      Package: @deepseek-ai/dsh-client-modules
      AggregateError: client-modules: 1 client package failed to compose:
        client bundles not found; run `pnpm run build` before launch:
          - package: dsh-plugin-pomodoro
            path: /…/pomodoro-plugin/lib/client.js
  Full diagnostics: /tmp/…/logs/startup-2026-10-19T….log
  ```

* `dsh.client` declared but `exports["./client"]` missing:
  `client-modules: <pkg> declares dsh.client but exports no "./client" bundle`
  (fails the same `modules` row at startup).
* Incompatible plugin on install:

  ```
  dsh: installation rejected: Plugin <pkg>@9.9.9 is incompatible with dsh 0.2.1-rc.2:
  requirements {"engines.dsh":"=0.1.0-rc.7"}. …
  dsh: nothing was installed.
  ```

* Plugin is a package but not a bundle (no `dsh.bundle`): install succeeds with
  `dsh: warning: <pkg> declares no dsh.bundle — installed as a plain dependency, not a profile layer`;
  add a direct `insert` row (§3B) and restart, or the host half never mounts.

---

## 7. Safe verification (no restart, no `~/.dsh` writes)

The running app's HTTP surface requires its per-launch token, so it cannot be used for automated
checks: `curl http://127.0.0.1:55022/` returns

```
HTTP/1.1 401 Unauthorized
cache-control: no-store
content-type: text/plain; charset=utf-8

dsh web authentication required; reopen the URL printed by dsh web.
```

(the token lives only in the URL printed by the Host/Electron IPC; `DSH_WEB_URL` has no token).
Do not try to bypass that gate; use an **isolated throw-away instance** instead.

### 7.1 Isolated instance recipe (uses a temp `DSH_HOME`; writes only under `$TMPDIR`)

A CLI cannot boot the reserved `desktop` profile (`error: profile "desktop" is managed
exclusively by the Electron application`). Two supported shapes:

* **`web` profile** — enough to prove the plugin's host half + client bundle + graph row.
* **desktop-equivalent copy** — copy `~/.dsh/profiles/desktop` into a temp `DSH_HOME` under a
  non-reserved name (e.g. `pomoverify`) and boot that; verified working (75 entries, the pomodoro
  entry included). Use it when you need the desktop bundle stack for fidelity.

```bash
APP_CLI="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
PLUGIN="$PWD"   # run from the plugin repository root
TMP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/dsh-verify.XXXXXX")"
mkdir -p "$TMP_HOME/pnpm-store"

# 1. Throw-away profile + install (offline; the only writes are under $TMP_HOME)
DSH_HOME="$TMP_HOME" DSH_TELEMETRY_DISABLED=1 \
  "$APP_CLI" plugin --profile web add "link:$PLUGIN" --offline --store-dir "$TMP_HOME/pnpm-store"

# 2. Boot it on an OS-assigned loopback port and capture the authenticated URL
DSH_HOME="$TMP_HOME" DSH_TELEMETRY_DISABLED=1 \
  "$APP_CLI" --profile web --no-open --host 127.0.0.1 --port 0 >"$TMP_HOME/instance.log" 2>&1 &
PID=$!
for i in $(seq 1 90); do grep -q 'dsh web: http' "$TMP_HOME/instance.log" && break; sleep 1; done
URL=$(grep -o 'http://127.0.0.1:[0-9]*/?token=[A-Za-z0-9_-]*' "$TMP_HOME/instance.log" | head -1)
ROOT=${URL%%/?token=*}; JAR="$TMP_HOME/cookies.txt"

# 3. Exchange the launch token for the browser cookie (303 + Set-Cookie)
curl -sS -c "$JAR" -o /dev/null -w 'token exchange: %{http_code}\n' "$URL"

# 4. Fetch the page and extract the live boot graph
curl -sS -b "$JAR" -o "$TMP_HOME/index.html" "$ROOT/"
node - "$TMP_HOME/index.html" <<'NODE'
const fs = require('fs')
const html = fs.readFileSync(process.argv[2], 'utf8')
const marker = 'globalThis["__DSH_BOOT__"] = '
const i = html.indexOf(marker)
if (i < 0) { console.error('no __DSH_BOOT__ in page'); process.exit(1) }
const graph = JSON.parse(html.slice(i + marker.length, html.indexOf('</script>', i)))
const entry = graph.entries.find(e => e.id === 'dsh-plugin-pomodoro')
console.log('graph rev:', graph.rev, '| entries:', graph.entries.length)
console.log('entry:', JSON.stringify(entry))
if (!entry) process.exit(1)
fs.writeFileSync(process.argv[2] + '.entry-url', entry.url)
NODE
ENTRY=$(cat "$TMP_HOME/index.html.entry-url")

# 5. Fetch the browser bundle exactly as the page does (needs the leading slash)
curl -sS -b "$JAR" -o /dev/null -w 'client bundle: %{http_code} %{size_download} bytes %{content_type}\n' "$ROOT/$ENTRY"
# wrong rev must 404
curl -sS -o /dev/null -w 'wrong rev: %{http_code}\n' "$ROOT/plugins/??dsh-plugin-pomodoro/client.js&rev=000000000000"

kill "$PID"; wait "$PID" 2>/dev/null
rm -rf "$TMP_HOME"
```

Observed with this plugin (isolated 0.2.1 instance, at the time of writing): 70 entries in the
graph, the entry quoted in §4, client bundle `200` with
`content-type: text/javascript; charset=utf-8` (~52.8 KB as served — the served body is the file
plus a source-map trailer); wrong rev `404`. A desktop-equivalent copy (copied desktop profile,
non-reserved profile name) booted with 75 entries and the same entry, client bundle `200`.
`rev`/graph `rev` change whenever the bundle file changes; never hardcode them.

### 7.2 Exists: `scripts/verify-plugin.sh`

> A second, rendering-level check lives beside it: `scripts/verify-ui.mjs` drives the isolated
> instance with headless Chrome over CDP and asserts the widget mounts into `shell.overlay`, starts,
> pauses, skips, resets, opens settings and survives a reload, plus the Plugins page controls. A third,
> `scripts/verify-board.mjs`, exercises the task board end to end (seeded SQLite board, sections,
> composer, drawer, drag & drop, keyboard moves, measured focus credits, JSON import/export, ARIA).
> See [verification.md](verification.md) for the observed runs.

`scripts/verify-plugin.sh` automates the recipe above (static manifest/patch checks + isolated
install/boot/graph/URL checks), writes only into a temp directory, never touches `~/.dsh`, and
exits non-zero on the first failure. See the script header for options.

```bash
./scripts/verify-plugin.sh                    # verify this repo's plugin
./scripts/verify-plugin.sh --keep            # keep the instance dir + URL for manual browser check
./scripts/verify-plugin.sh --static-only     # manifest/patch checks only (no boot)
./scripts/verify-plugin.sh --plugin /path/to/other-dsh-plugin
```

Last run in this workspace (2026-10-19): PASS — 70-entry isolated graph containing
`dsh-plugin-pomodoro`, bundle served with `200`, wrong-rev `404`.

### 7.3 Composition check without booting

`--dump-config` parses and composes the layers without mounting plugins, starting a server or
binding a port. It is blocked for the reserved `desktop` profile name — use a copy or the `web`
profile in an isolated `DSH_HOME`:

```bash
DSH_HOME="$TMP_HOME" "$APP_CLI" --profile web --dump-config | grep -A3 -B1 pomodoro
```

Verified output rows for a copied desktop profile containing the plugin:

```
# == dsh-plugin-pomodoro                                ← bundle layer header
- id: pomodoro
  name: dsh-plugin-pomodoro
  config: {}
# == /tmp/…/profiles/pomoverify/cordis.patch.yml       ← user layer header
- id: pomodoro-plain                                   ← direct insert row
  name: dsh-plugin-pomodoro-plain
  config: {}
```

---

## 8. Install / uninstall / reset procedure (for the Lead)

### 8.1 Install

1. **Quit** DeepSeek Harness completely (Cmd+Q; wait until the process is gone —
   `lsof -nP -iTCP:55022 -sTCP:LISTEN` prints nothing). The desktop profile is reserved and the
   CLI installs with the app's own bundled pnpm; quitting removes lock/race questions.
2. Back up the profile's user-editable state:
   ```bash
   PROFILE="$HOME/.dsh/profiles/desktop"; STAMP="$(date +%Y%m%d-%H%M%S)"
   cp "$PROFILE/package.json"     "$PROFILE/package.json.bak-pomodoro-$STAMP"
   cp "$PROFILE/cordis.patch.yml" "$PROFILE/cordis.patch.yml.bak-pomodoro-$STAMP"
   ```
3. Install with the bundled CLI:
   ```bash
   "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
     plugin --profile desktop add \
     "link:$PLUGIN" --offline
   ```
   Expect exit 0, a pnpm line adding `dsh-plugin-pomodoro 0.1.0 <- ../../…/pomodoro-plugin`
   (via link), a new `dependencies` entry and an appended
   `"dsh-plugin-pomodoro"` in `dsh.profile.bundles`.
4. (Optional, strong preflight) Run `./scripts/verify-plugin.sh` before relaunching: it proves the
   package shape and that a 0.2.1 instance mounts the row and serves the bundle.
5. **Relaunch** the app. The Host composes the profile, mounts the row, scans `dsh.client`, and
   injects the boot graph into the app window. Visual check: the pomodoro overlay/pill appears.
6. If it does not appear, see §6/§9.3 before editing anything else.

### 8.2 Uninstall

```bash
# Quit the app first.
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop remove dsh-plugin-pomodoro          # no --offline (unsupported by remove)
```

* Removes the dependency, the `dsh.profile.bundles` entry and the `node_modules` link; verified
  on a copy of the real desktop profile (the bundles list returns to its pre-install contents).
* No manual `cordis.patch.yml` edit is needed for the bundle route (the row came from the
  bundle's own patch).
* If the direct-insert route (§3B) was used, delete that `insert:` block from
  `~/.dsh/profiles/desktop/cordis.patch.yml` too.
* Restart the app.

### 8.3 Reset / recovery

* **Preferred in-app:** if startup fails after a bad install, the native recovery dialog offers
  “disable plugins”. It backs up the profile patch to
  `cordis.patch.yml.bak-<timestamp>` and rewrites `dsh.profile.bundles` to
  `[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app]` (dependencies are kept).
* **Manual (app fully quit):** restore the backups from step 8.1, then relaunch:
  ```bash
  cp "$PROFILE/package.json.bak-pomodoro-$STAMP"   "$PROFILE/package.json"
  cp "$PROFILE/cordis.patch.yml.bak-pomodoro-$STAMP" "$PROFILE/cordis.patch.yml"
  # optional tidy: rm -rf "$PROFILE/node_modules" "$PROFILE/pnpm-lock.yaml"
  ```
  (The app boots fine without the profile's `node_modules`; it is only needed for out-of-tree
  plugins.)
* **Diagnosing a start failure:** open the newest
  `~/.dsh/logs/startup-*.log` and/or
  `~/Library/Logs/DeepSeek Harness/crash-*.log`. Do not delete them before reading.
* **Live Host warnings:** launch the Host manually against a copy — never change the running
  app's profile to debug it:
  ```bash
  DSH_HOME="$TMP_HOME" DSH_TELEMETRY_DISABLED=1 "$APP_CLI" --profile web --no-open --port 0
  ```
  (stdout/stderr of the Host are visible in that terminal).

---

## 9. What was **not** verified (mark these as unknowns)

* **Browser execution of this plugin inside the real desktop window.** We verified the host-side
  facts (row mount, graph entry, `200` bundle bytes) and the client bundle's own Node tests, but
  not the rendered timer in the live app — that needs the approved restart and a human look
  (or a DevTools console check).
* **Live hot-apply against the *running desktop* app.** The host-level hot-reload was verified on
  an isolated 0.2.1 instance (same HMR row, same code). For the desktop window the code path in
  Electron's main process (captured `injections`) says a page reload is not enough; we did not
  empirically toggle plugins on the running app because that would disturb it.
* **Windows/Linux** were not exercised (macOS arm64 only).
* **Non-bundle (plain dependency + direct insert) installation of *this* package**: the direct
  insert route was verified with a stub package in an isolated profile (§3B), not with this
  package (this package always takes the bundle route).
* **Exact `rev` algorithm stability across future releases.** Treat `rev` as opaque: read it from
  `__DSH_BOOT__` instead of computing it.

---

## Appendix A — reading files inside `app.asar` (read-only, for evidence)

The 0.2.1 implementation ships inside `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`
(an archive). This one-liner extracts a single file to `/tmp` without touching the app:

```bash
REL="dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js"   # any path inside the archive
node - "$REL" <<'NODE'
const fs = require('fs')
const p = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const rel = (process.argv[2] && process.argv[2] !== '-')
  ? process.argv[2]
  : 'dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js'
const fd = fs.openSync(p, 'r')
const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0)
const jsonLen = b.readUInt32LE(12)
let dataStart = (16 + jsonLen + 3) & ~3
const jb = Buffer.alloc(jsonLen); fs.readSync(fd, jb, 0, jsonLen, 16)
const header = JSON.parse(jb.toString('utf8'))
let node = header
for (const seg of rel.split('/')) { node = node.files?.[seg]; if (!node) throw new Error('not found: ' + rel) }
if (node.files) throw new Error('is a directory: ' + rel)
const out = Buffer.alloc(node.size)
fs.readSync(fd, out, 0, node.size, dataStart + Number(node.offset))
process.stdout.write(out)
NODE
```

Useful paths inside the archive (0.2.1-rc.2):

* `dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js` — `dsh.client` scan, graph,
  `/plugins` route, `__DSH_BOOT__` injection
* `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js` — profile loading, bundle patches,
  compatibility gate, runtime resolution
* `dsh/node_modules/@deepseek-ai/dsh-hmr/lib/index.js` — live profile reload
* `dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js` — pnpm forwarding,
  install preflight, reconciliation, `.plugin-manager/logs`
* `dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js` — desktop Host boot (`--port 0`,
  `ready` IPC with `injections`)
* `lib/main.js` — Electron shell: captured boot injections, crash reports, recovery/disable-plugins

## Appendix B — the exact commands behind the claims

```bash
# Which CLI is which
readlink ~/.local/bin/dsh                                    # …/deepseek-harness/apps/cli/lib/bin.js (0.1.0-rc.7)
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --version   # 0.2.1-rc.2
node -e 'console.log(require("<dsh-checkout>/apps/cli/package.json").version)'

# Runtime payload
node -e 'console.log(require("/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/runtime.json"))'

# Running app/profiles
lsof -nP -iTCP:55022 -sTCP:LISTEN | head
curl -sS -D - -o /dev/null http://127.0.0.1:55022/           # 401 + auth message

# Isolated install / boot / graph / bundle checks: see §7.1 and scripts/verify-plugin.sh

# Cross-check the installed profile (after the Lead's approved install)
cat ~/.dsh/profiles/desktop/package.json
ls -la ~/.dsh/profiles/desktop/node_modules/
ls ~/.dsh/profiles/desktop/.plugin-manager/logs/operation-*/pnpm.log
```
