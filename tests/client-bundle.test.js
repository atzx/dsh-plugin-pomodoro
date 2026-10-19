/**
 * Integration smoke tests for the built browser bundle.
 *
 * These execute the real `lib/client.js` against the same wrapper contract the
 * DSH web shell provides (`window.__ModuleLoader__.load`), then render the
 * registered component with React's server renderer. That catches the failure
 * modes a syntax check cannot: a broken registration shape, a missing locale
 * namespace, a component that crashes on first paint, or a stale build.
 *
 * Run with: node --test tests/*.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = readFileSync(resolve(ROOT, 'lib/client.js'), 'utf8')

/**
 * Resolve React the way the harness supplies it: first a local dev install
 * (`npm install` / `pnpm install` in this repo), then a running DSH
 * installation under the user's DSH home when this checkout lives outside one.
 * No machine-specific absolute path is baked into the repository.
 */
function resolveHarnessRequire() {
  const candidates = []
  // A local dev install always wins, but require only from this package's own
  // node_modules: walking up from the test file could pick an unrelated React in
  // an ancestor directory.
  const local = join(ROOT, 'node_modules', 'react', 'index.js')
  if (existsSync(local)) candidates.push(local)
  if (process.env.DSH_NODE_MODULES !== undefined) {
    const override = join(process.env.DSH_NODE_MODULES, 'react', 'index.js')
    if (existsSync(override)) candidates.push(override)
  }
  const harness = join(homedir(), '.dsh', 'profiles', 'node_modules', 'react', 'index.js')
  if (existsSync(harness)) candidates.push(harness)

  for (const entry of candidates) {
    try {
      const requireFrom = createRequire(entry)
      requireFrom.resolve('react-dom/server')
      return requireFrom
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('react/react-dom not found: run `npm install` in this repo or set DSH_NODE_MODULES')
}

const harnessRequire = resolveHarnessRequire()
const React = harnessRequire('react')
const { renderToStaticMarkup } = harnessRequire('react-dom/server')

const ICON_STUB = () => null
const primitivesStub = {
  IconChevronDownOutline14: ICON_STUB,
  IconRefreshOutline16: ICON_STUB,
  IconSettingsOutline16: ICON_STUB,
}

/** A minimal localStorage that also lets a test seed values. */
function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
    entries: () => [...map.entries()],
  }
}

/** Load the bundle the way the page does, returning the registration it made. */
function loadBundle() {
  const registrations = []
  const windowStub = {
    __ModuleLoader__: {
      load: entry => { registrations.push(entry) },
    },
  }
  const appended = []
  const documentStub = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: tag => { appended.push(tag) } },
  }
  // The bundle is an IIFE-like registration script, not a module: it reads
  // `window` and `document` as globals, exactly as in the browser.
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', BUNDLE)(windowStub, documentStub)
  assert.equal(registrations.length, 1, 'bundle registered exactly one factory')
  const entry = registrations[0]
  assert.equal(entry.id, 'dsh-plugin-pomodoro')
  const factoryRequire = specifier => {
    if (specifier === 'react') return React
    if (specifier === 'react/jsx-runtime') return harnessRequire('react/jsx-runtime')
    throw new Error(`bundle required an unexpected module: ${specifier}`)
  }
  return { entry, exports: entry.factory(factoryRequire), appended }
}

/** Apply the plugin against a recording mock context. */
function activate(exportsObject, config) {
  const recorded = { locale: null, slots: [], registrations: [], effects: [] }
  const ctx = {
    effect: (fn, label) => {
      const disposer = fn()
      recorded.effects.push({ label, disposer })
      return () => { disposer?.() }
    },
    locale: {
      register: (namespace, dictionaries) => {
        recorded.locale = { namespace, dictionaries }
        return () => {}
      },
    },
    slots: {
      inject: (slotName, factory) => {
        recorded.slots.push(slotName)
        factory()
      },
      register: (options, Component) => {
        recorded.registrations.push({ options, Component })
        return () => {}
      },
    },
  }
  exportsObject.apply(ctx, config)
  return recorded
}

/** A `t` implementation matching the registry's `{name}` substitution. */
function makeTranslator(dictionaries) {
  const dict = dictionaries.en
  return (key, params) => {
    const template = dict[key]
    if (template === undefined) return key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (_match, name) => String(params[name] ?? `{${name}}`))
  }
}

const { exports: plugin } = loadBundle()

test('the bundle exports a cordis client plugin shape', () => {
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
})

test('apply registers the dictionaries, the overlay widget and the Plugins page', () => {
  const recorded = activate(plugin, {})
  assert.equal(recorded.locale.namespace, 'pomodoro')
  assert.deepEqual(Object.keys(recorded.locale.dictionaries).sort(), ['en', 'zh'])
  assert.deepEqual(recorded.slots, ['shell.overlay', 'plugins.row.config'])
  assert.equal(recorded.registrations.length, 2)

  const widget = recorded.registrations[0].options
  assert.equal(widget.name, 'shell.overlay')
  assert.equal(widget.id, 'pomodoro-timer')
  assert.equal(widget.locale, 'pomodoro')
  assert.equal(widget.order, 40)
  assert.equal(typeof widget.label, 'function')

  const config = recorded.registrations[1].options
  assert.equal(config.name, 'plugins.row.config')
  assert.equal(config.key, 'dsh-plugin-pomodoro#pomodoro')
  assert.equal(config.locale, 'pomodoro')
})

test('the collapsed pill renders a live-looking clock', () => {
  const recorded = activate(plugin, {})
  const { Component } = recorded.registrations[0]
  const t = makeTranslator(recorded.locale.dictionaries)
  const html = renderToStaticMarkup(React.createElement(Component, { t }))
  assert.match(html, /class="pomo-root"/)
  assert.match(html, /class="pomo-pill"/)
  assert.match(html, /25:00/)
  assert.match(html, /pomodoro-timer|pomo-pill/) // guard against a bare null render
})

test('a persisted running timer renders its remaining time', () => {
  const now = Date.now()
  const storage = makeStorage({
    'dsh-plugin-pomodoro:ui:v1': JSON.stringify({ expanded: true }),
    'dsh-plugin-pomodoro:state:v1': JSON.stringify({
      v: 1,
      phase: 'focus',
      status: 'running',
      remainingMs: 25 * 60_000,
      deadline: now + 10 * 60_000,
      completedFocus: 2,
      settings: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longBreakEvery: 4 },
    }),
  })
  globalThis.localStorage = storage
  try {
    const recorded = activate(plugin, {})
    const { Component } = recorded.registrations[0]
    const t = makeTranslator(recorded.locale.dictionaries)
    const html = renderToStaticMarkup(React.createElement(Component, { t }))
    // 10 minutes left (allow a second of jitter around the render boundary).
    assert.match(html, /(10:00|09:59)/)
    assert.match(html, /2 focus blocks completed/)
  } finally {
    delete globalThis.localStorage
  }
})

test('the stylesheet stays structurally valid', () => {
  const bundle = loadBundle()
  activate(bundle.exports, {})
  const css = bundle.appended[0].textContent
  assert.match(css, /\.pomo-switch\[aria-checked='true'\] \.pomo-switchTrack \{ background: var\(--dsw-alias-state-business-primary\); \}/)
  // Exactly one base track rule: a stray duplicate would silently win the cascade.
  assert.equal(css.match(/^\.pomo-switchTrack \{/gm)?.length, 1, 'one base .pomo-switchTrack rule')
  assert.doesNotMatch(css, /\.pomo-switchTrack \{ background: var\(--pomo-accent\); \}/)
  assert.match(css, /backdrop-filter: blur\(40px\) saturate\(1\.5\)/, 'material blur on the floating surfaces')
  // Icon-driven controls must not collapse onto the same selector shape.
  assert.doesNotMatch(css, /\[aria-checked='true'\][^{]*:focus-visible[^{]*\{ outline/)
})

test('the settings panel renders every control', () => {
  globalThis.localStorage = makeStorage({ 'dsh-plugin-pomodoro:ui:v1': JSON.stringify({ expanded: true, panel: 'settings' }) })
  try {
    const recorded = activate(plugin, { defaults: { focusMin: 30 } })
    const { Component } = recorded.registrations[0]
    const t = makeTranslator(recorded.locale.dictionaries)
    const html = renderToStaticMarkup(React.createElement(Component, { t }))
    assert.match(html, /Focus length/)
    assert.match(html, /30 min/)
    assert.match(html, /Auto-start breaks/)
    assert.match(html, /Desktop notifications/)
    assert.match(html, /role="switch"/)
  } finally {
    delete globalThis.localStorage
  }
})

test('apply honours the configured defaults', () => {
  const recorded = activate(plugin, { defaults: { focusMin: 45, longBreakEvery: 3 } })
  assert.equal(recorded.registrations.length, 2)
  // The widget is re-exported per activation; render a fresh one to inspect defaults.
  globalThis.localStorage = makeStorage()
  try {
    const t = makeTranslator(recorded.locale.dictionaries)
    const html = renderToStaticMarkup(React.createElement(recorded.registrations[0].Component, { t }))
    assert.match(html, /45:00/)
  } finally {
    delete globalThis.localStorage
  }
})

test('corrupt persisted state falls back instead of crashing', () => {
  globalThis.localStorage = makeStorage({ 'dsh-plugin-pomodoro:state:v1': '{not json' })
  try {
    const recorded = activate(plugin, {})
    const t = makeTranslator(recorded.locale.dictionaries)
    const html = renderToStaticMarkup(React.createElement(recorded.registrations[0].Component, { t }))
    assert.match(html, /25:00/)
  } finally {
    delete globalThis.localStorage
  }
})

test('the Plugins configuration page renders the enable switch and the timer settings', () => {
  globalThis.localStorage = makeStorage()
  try {
    const recorded = activate(plugin, {})
    const config = recorded.registrations[1].Component
    const t = makeTranslator(recorded.locale.dictionaries)
    const html = renderToStaticMarkup(React.createElement(config, { t, view: 'page' }))
    assert.match(html, /data-pomo-config="page"/)
    assert.match(html, /Floating timer/)
    assert.match(html, /data-pomo-setting="widget"/)
    assert.match(html, /aria-checked="true"/)
    assert.match(html, /Focus and break lengths/)
    assert.match(html, /data-pomo-setting="focus"/)
    assert.match(html, /25 min/)
    assert.match(html, /data-pomo-setting="sound"/)
    assert.match(html, /unload the plugin entirely/)
  } finally {
    delete globalThis.localStorage
  }
})

test('the Plugins page summary line reports the widget state', () => {
  globalThis.localStorage = makeStorage()
  try {
    const recorded = activate(plugin, {})
    const config = recorded.registrations[1].Component
    const t = makeTranslator(recorded.locale.dictionaries)
    assert.equal(renderToStaticMarkup(React.createElement(config, { t, view: 'summary' })), 'Timer widget is shown.')
  } finally {
    delete globalThis.localStorage
  }
})

test('a persisted "widget disabled" preference renders nothing and survives reload', () => {
  const bundle = loadBundle()
  globalThis.localStorage = makeStorage({
    'dsh-plugin-pomodoro:prefs:v1': JSON.stringify({ widgetEnabled: false }),
  })
  try {
    const recorded = activate(bundle.exports, {})
    const t = makeTranslator(recorded.locale.dictionaries)
    const html = renderToStaticMarkup(React.createElement(recorded.registrations[0].Component, { t }))
    assert.equal(html, '')
    // The configuration page must stay reachable, and must report the hidden state.
    const summary = renderToStaticMarkup(React.createElement(recorded.registrations[1].Component, { t, view: 'summary' }))
    assert.equal(summary, 'Timer widget is hidden.')
  } finally {
    delete globalThis.localStorage
  }
})

test('the configuration page reflects timer settings changed elsewhere', () => {
  globalThis.localStorage = makeStorage({
    'dsh-plugin-pomodoro:state:v1': JSON.stringify({
      v: 1,
      phase: 'focus',
      status: 'idle',
      remainingMs: 50 * 60_000,
      deadline: null,
      completedFocus: 0,
      settings: { focusMin: 50, shortBreakMin: 12, longBreakMin: 20, longBreakEvery: 3, sound: false },
    }),
  })
  try {
    const recorded = activate(plugin, {})
    const config = recorded.registrations[1].Component
    const t = makeTranslator(recorded.locale.dictionaries)
    const html = renderToStaticMarkup(React.createElement(config, { t, view: 'page' }))
    assert.match(html, /50 min/)
    assert.match(html, /12 min/)
    assert.match(html, /20 min/)
    assert.match(html, /3 blocks/)
    // sound:false must render as an unchecked switch
    assert.match(html, /data-pomo-setting="sound"[^>]*aria-checked="false"/)
  } finally {
    delete globalThis.localStorage
  }
})
