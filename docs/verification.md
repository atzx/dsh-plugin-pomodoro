# Verification evidence

Everything below was produced on this machine (macOS, DSH desktop **0.2.1-rc.2**) without touching
the running app. Live checks use throw-away `DSH_HOME` directories and a headless Chrome driven over
the DevTools protocol.

## 1. Unit and integration tests — 104/104

```bash
cd pomodoro-plugin && node --test tests/*.test.js
```

| Suite | Count | Covers |
|---|---|---|
| `tests/timer-core.test.js` | 23 | phases, deadlines, pause/resume, cycle cadence, catch-up, task focus segments and credits, serialization |
| `tests/tasks-core.test.js` | 14 | smart sections, dates, metrics (both estimate scopes), accent-insensitive search, ordering, formatting |
| `tests/board-store.test.js` | 19 | host bridge, polling, BroadcastChannel, error mapping, presentation store, time-credit queue and idempotency, active task, export/import |
| `tests/host-db.test.js` | 18 | schema/migrations, commands, completion invariant, cascades, limits, export/import validation, backups, reopen |
| `tests/host-api.test.js` | 9 | route table, JSON contracts, method/limit errors, import/export over HTTP, idempotent addTime |
| `tests/board-ui.test.js` | 6 | server-render every board surface (label manager, label picker, drawer, composer, board menu, subtasks) so an undeclared value fails a test instead of a slot crash |
| `tests/source-hygiene.test.js` | 3 | no foreign `React.*` in the board module, every focus-trap/element ref declared, every literal locale key present |
| `tests/client-bundle.test.js` | 12 | the built `lib/client.js` against `window.__ModuleLoader__`, registration, locale, CSS integrity, server-rendered markup, prefs |

`node scripts/build.mjs --check` gates a stale bundle.

## 2. Isolated install, boot and host checks — PASS

```bash
./scripts/verify-plugin.sh
```

Temporary `DSH_HOME` + bundled app CLI + offline `link:` install + OS-assigned loopback port:

- plugin resolves and `dsh plugin add` records the dependency and bundle;
- boot graph contains `dsh-plugin-pomodoro`; its bundle is served and registers the expected id;
- a wrong bundle `rev` returns 404;
- **`GET /api/pomodoro-board/state` returns 200** with the seeded lists (`To Do`, `Doing`, `Done`);
- **`$DSH_HOME/pomodoro/board.sqlite` is created** by the host half.

## 3. Timer widget and Plugins page E2E — 49/49

```bash
node scripts/verify-ui.mjs --url "<authenticated-url>" --cdp http://127.0.0.1:9333 --out /tmp/shots
```

Headless browser checks for the widget (mount, position/pointer events, material blur, start, pause
freeze, skip, reset, settings, switch colors, reload persistence), the **Plugins page** (bundle and
Component switches, Configure control, configuration page, widget hide/show, settings) and the
**Component switch unloading and re-enabling the plugin**. Screenshots are written as WebP.

## 4. Task board E2E — 38/38

```bash
# in one terminal
./scripts/verify-plugin.sh --keep     # prints the authenticated URL; fresh board database
# in another
node scripts/verify-board.mjs --url "<authenticated-url>" --out docs/screenshots
```

The script seeds a demo board through the host API and then drives the real UI:

| Area | Assertions |
|---|---|
| Board | seeded tasks/labels reach the client, three default columns, estimate total (185m → `3h 5m`), completed count |
| Sections/search | Today filters the board; label search narrows to one card |
| Composer | full task (title, priority, estimate, subtask) persists through the host |
| Drawer | notes persist, subtask toggles |
| Labels | the label picker opens as an **inline panel inside the drawer** (fully contained, horizontally centred, full width); assigning and removing a label persists on the host; the manager modal is centred in the board panel and opens both from the panel and from the header; creating and deleting a label round-trips through SQLite; the board survives the manager round-trip |
| Drag & drop | card dropped into Done is completed on the host; dragging a list handle reorders columns |
| Keyboard | `Alt+→` moves a card to the next list |
| Timer | Focus marks the card active; a ~2s pause credits ~2–3s of measured time; a replayed focus phase credits exactly 25 min and 1 pomodoro after reload |
| Export/import | export envelope; import from a file with confirmation replaces the board; imported board survives reload |
| Accessibility | `role=list`/`listitem`, polite live region, composer focus trap |
| Errors | no page exceptions, no console errors, widget and overlay still mounted at the end |

Screenshots: `docs/screenshots/board-*.webp`, `task-*.webp`, `labels-manager.webp`, `timer-focus.webp`.

## 5. Real desktop profile install

Installed with the app's bundled CLI:

```bash
APP_CLI="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$APP_CLI" plugin --profile desktop add "link:<repo>" --offline
```

`~/.dsh/profiles/desktop/package.json` gained the dependency and the bundle entry, and
`node_modules/dsh-plugin-pomodoro` links to this repository. Timestamped backups of
`package.json`/`cordis.patch.yml` were taken first. The board lives at
`~/.dsh/pomodoro/board.sqlite` in the real profile (created on the next host start).

Restart DeepSeek Harness to load this branch in the desktop window (the Electron shell captures host
boot injections once at Host start). The timer/Plugins page from the previous milestone is already
installed; the board and focus integration arrive with that restart.

## 6. Still unverified

- Rendering inside the real desktop window of this branch requires the restart above; all
  UI evidence comes from isolated 0.2.1-rc.2 instances.
- Windows/Linux were not exercised.
- Two simultaneous browser windows on the same host are covered by unit tests (polling +
  BroadcastChannel) but not by a multi-page E2E.
