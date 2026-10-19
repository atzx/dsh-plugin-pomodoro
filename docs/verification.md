# Verification evidence

Everything below was produced on this machine (macOS, DSH desktop **0.2.1-rc.2**) without touching
the running app. The running app stayed on port 55022; every live check used a throw-away
`DSH_HOME` with a fresh profile.

## 1. Unit + bundle tests — 29/29

```bash
cd pomodoro-plugin && node --test tests/*.test.js
```

| Suite | Covers |
|---|---|
| `tests/timer-core.test.js` (17) | phases, deadline math, pause/resume, skip/reset, long-break cadence, catch-up budget, settings clamping, serialization round-trip, corrupt-state fallback, formatting, progress |
| `tests/client-bundle.test.js` (12) | the real `lib/client.js` executed against the `window.__ModuleLoader__.load` contract: registration id, `{apply, inject}` face, locale dictionaries, `shell.overlay` **and** `plugins.row.config` registration options, CSS injection (backdrop blur + switch rules), server-rendered pill/card/settings markup, the Plugins configuration page and its summary line, the widget-disabled preference, configured defaults, corrupt storage |

The bundle tests load the built file with a stubbed DOM and real React 18 from the harness install,
so a stale or malformed `lib/client.js` fails the suite. `node scripts/build.mjs --check` gates
staleness separately.

## 2. Isolated install + boot check — PASS

```bash
./scripts/verify-plugin.sh
```

Runs against the app's bundled CLI and a temporary `DSH_HOME`:

- static manifest/patch checks;
- `dsh plugin add link:… --offline` into a fresh `web` profile;
- boot on an OS-assigned loopback port with a real auth token;
- boot graph contains the `dsh-plugin-pomodoro` entry with its inject edges;
- `GET /plugins/??dsh-plugin-pomodoro/client.js&rev=…` returns the served bundle;
- a wrong `rev` returns 404.

Observed: `PASS`, served bundle 55,387 bytes, graph rev per boot, 70-entry graph.

## 3. End-to-end UI — 49/49

```bash
# isolated instance started by verify-plugin.sh --keep, printed URL captured
node scripts/verify-ui.mjs --url "http://127.0.0.1:<port>/?token=<token>" \
  --cdp http://127.0.0.1:9333 --out /tmp/shots
```

Headless Chrome (CDP) drives the real web app and asserts, in order:

| Area | Checks |
|---|---|
| mount | boot-graph entry present, widget mounted in `shell.overlay`, stylesheet tag injected, starts collapsed, bottom-right position, `position:absolute`, `pointer-events:auto` |
| look | full 25:00 focus block, `data-phase=focus`, card uses the translucent menu surface plus `backdrop-filter: blur(40px) saturate(1.5)`, ring renders with token colors |
| clock | start persists `status:"running"` + epoch deadline, countdown decreased, status word present, collapsed pill keeps the pulse and live time |
| controls | pause freezes, paused clock does not move, skip lands on short break without crediting focus, reset restores a stopped 05:00 break |
| settings | four duration rows, four switches, stepper edits focus length, back/collapse glyphs differ, switch on = accent track / off = neutral track, settings survive reload, open panel survives reload |
| Plugins page | bundle switch present, Component (unload) switch present, Configure control present for the row, Configure page shows the *Floating timer* switch and four settings groups, hiding the widget keeps the plugin loaded and persists the preference, re-enabling restores the widget, editing a duration here updates the shared record, the Component switch unloads the plugin (widget + page gone, switch off), then re-enables it |

Screenshots (widget crops plus the Plugins configuration page) live in
[docs/screenshots](screenshots/) and are embedded in the README. The Plugins phase is the last
`screenshot` set: `08-plugins-config*` and `09-plugins-back-on` (WebP).

## 4. Real desktop profile install

Installed with the app's bundled CLI:

```
PLUGIN="$PWD"   # run from the plugin repository root
"$APP_CLI" plugin --profile desktop add "link:$PLUGIN" --offline
```

Resulting `~/.dsh/profiles/desktop/package.json`: dependency `dsh-plugin-pomodoro` (link) and
`dsh.profile.bundles` ending with `dsh-plugin-pomodoro`; `node_modules/dsh-plugin-pomodoro` is a
symlink to the package; `pnpm-lock.yaml` records the link import. Timestamped backups:
`package.json.bak-pomodoro-20261019-042332`, `cordis.patch.yml.bak-pomodoro-20261019-042332`.

The app was **not** restarted (the editing session runs inside it). Restart DeepSeek Harness to
have the desktop window pick up the plugin; a window/page refresh is not sufficient because the
Electron shell freezes the host boot injections at Host start (see `docs/install.md` §5).

### Enabling and disabling after the restart

Verified on the isolated 0.2.1 instance: the sidebar **Plugins** page lists
`dsh-plugin-pomodoro` with both DSH switches (bundle and Component) and a **Configure** control.
Switching the Component off writes `- id: pomodoro / disabled: true` into that profile's
`cordis.patch.yml`, the widget and the Configure page disappear while the browser stays open, and
switching it on again reloads the plugin. The plugin's Configure page adds its own *Floating timer*
switch plus the timer settings; those persist per browser and do not unload the plugin.

## 5. What is still unverified

- Rendering **inside the real desktop window** — needs the restart above; verified on an isolated
  0.2.1-rc.2 instance instead.
- Windows/Linux — not tested; all paths here are macOS.
- A future DSH release could change client-side APIs; the version-sensitive facts are collected in
  [client-api.md](client-api.md) and the plugin pins no internal packages beyond `react`.
