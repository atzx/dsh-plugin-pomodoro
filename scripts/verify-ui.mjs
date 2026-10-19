#!/usr/bin/env node
/**
 * End-to-end verification for the Pomodoro plugin in a live DSH web page.
 *
 * It drives a headless Chrome over the DevTools protocol against an isolated
 * DSH instance (so the user's app is never touched), proves the plugin mounted
 * in `shell.overlay`, exercises start/skip/reset and the settings panel, and
 * captures screenshots for visual review.
 *
 * Usage:
 *   node scripts/verify-ui.mjs --url http://127.0.0.1:55123/ \
 *     --cdp http://127.0.0.1:9333 --out tmp/shots
 *
 * Prerequisites: a running DSH web instance and a child Chrome started with
 *   --headless=new --remote-debugging-port=9333
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/* ─────────────────────────── args ─────────────────────────── */

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const URL_ARG = arg('url', 'http://127.0.0.1:55123/')
const CDP = arg('cdp', 'http://127.0.0.1:9333').replace(/\/$/, '')
const OUT = resolve(arg('out', 'tmp/shots'))

/* ─────────────────────── DevTools client ───────────────────── */

/** Minimal CDP session bound to one page target. */
class Session {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.events = []
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve: done, reject: fail } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error !== undefined) fail(new Error(`${message.error.message} (${message.error.code})`))
        else done(message.result)
        return
      }
      if (message.method !== undefined) this.events.push(message)
    })
  }

  /** Send one protocol command. */
  send(method, params = {}) {
    const id = this.nextId++
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.socket.send(JSON.stringify({ id, method, params }))
    return promise
  }

  /** Evaluate an expression in the page and return its value. */
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (result.exceptionDetails !== undefined) {
      throw new Error(`page exception: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`)
    }
    return result.result.value
  }

  /** Poll an expression until it is truthy. */
  async waitFor(expression, timeoutMs = 20_000, label = expression) {
    const started = Date.now()
    for (;;) {
      if (await this.eval(`(() => { try { return Boolean(${expression}) } catch { return false } })()`)) return
      if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`)
      await new Promise(done => setTimeout(done, 120))
    }
  }

  /** Capture one element (plus padding) as a PNG, for documentation. */
  async screenshotElement(name, selector, padding = 16) {
    const rect = await this.eval(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)})
      if (node === null) return null
      const box = node.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height }
    })()`)
    if (rect === null) throw new Error(`cannot screenshot missing element ${selector}`)
    const clip = {
      x: Math.max(0, rect.x - padding),
      y: Math.max(0, rect.y - padding),
      width: rect.width + padding * 2,
      height: rect.height + padding * 2,
      scale: 2,
    }
    const { data } = await this.send('Page.captureScreenshot', { format: 'webp', quality: 90, captureBeyondViewport: true, clip })
    const path = resolve(OUT, `${name}.webp`)
    writeFileSync(path, Buffer.from(data, 'base64'))
    return path
  }

  /** Capture the current viewport as a PNG. */
  async screenshot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'webp', quality: 90, captureBeyondViewport: false })
    const path = resolve(OUT, `${name}.webp`)
    writeFileSync(path, Buffer.from(data, 'base64'))
    return path
  }
}

/** Wait for CDP and return a session on an existing page target. */
async function connect() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const list = await fetch(`${CDP}/json/list`).then(response => response.json())
      const page = list.find(target => target.type === 'page')
      if (page !== undefined) {
        const socket = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((done, fail) => {
          socket.addEventListener('open', done, { once: true })
          socket.addEventListener('error', () => fail(new Error('CDP socket failed')), { once: true })
        })
        return new Session(socket)
      }
    } catch {
      /* CDP not listening yet */
    }
    await new Promise(done => setTimeout(done, 200))
  }
  throw new Error(`could not connect to CDP at ${CDP}`)
}

/* ────────────────────────── the checks ────────────────────────── */

const checks = []

/** Record one assertion without throwing, so the run reports everything. */
function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail })
  const mark = condition ? 'ok  ' : 'FAIL'
  console.log(`${mark} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

/** Read the widget snapshot from the page. */
function snapshot() {
  return `(() => {
    const root = document.querySelector('.pomo-root')
    const pill = document.querySelector('.pomo-pill')
    const card = document.querySelector('.pomo-card')
    const time = document.querySelector('.pomo-time') ?? document.querySelector('.pomo-pillTime')
    const phase = document.querySelector('.pomo-phase') ?? document.querySelector('.pomo-pillPhase')
    const style = document.querySelector('style[data-plugin="dsh-plugin-pomodoro"]')
    const stored = (() => { try { return JSON.parse(localStorage.getItem('dsh-plugin-pomodoro:state:v1')) } catch { return null } })()
    const boot = (window.__DSH_BOOT__?.entries ?? []).some(entry => entry.id === 'dsh-plugin-pomodoro')
    const rect = root === null ? null : root.getBoundingClientRect()
    return {
      mounted: root !== null,
      collapsed: pill !== null && card === null,
      expanded: card !== null,
      time: time === null ? null : time.textContent,
      phase: phase === null ? null : phase.textContent,
      phaseKind: root === null ? null : root.dataset.phase,
      statusKind: root === null ? null : root.dataset.status,
      styleTag: style !== null,
      bootEntry: boot,
      stored,
      rect: rect === null ? null : { right: Math.round(window.innerWidth - rect.right), bottom: Math.round(window.innerHeight - rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height) },
      pointerEvents: root === null ? null : getComputedStyle(root).pointerEvents,
      position: root === null ? null : getComputedStyle(root).position,
      background: card === null ? null : getComputedStyle(card).backgroundColor,
      color: root === null ? null : getComputedStyle(root).color,
    }
  })()`
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const session = await connect()
  await session.send('Page.enable')
  await session.send('Runtime.enable')

  await session.send('Page.navigate', { url: URL_ARG })
  await session.waitFor(`document.querySelector('.pomo-root') !== null`, 30_000, 'widget mount')
  // Make the run repeatable: a previous run may have left persisted state.
  await session.eval(`localStorage.clear()`)
  await session.send('Page.reload')
  await session.waitFor(`document.querySelector('.pomo-root') !== null`, 30_000, 'widget mount after reset')
  // Dismiss first-run surfaces if this fresh profile shows them; they are noise
  // for screenshots and irrelevant to the plugin.
  const dismissOverlays = () => session.eval(`(() => {
    const byText = [...document.querySelectorAll('button')].find(node => /^(continue|继续|知道了|开始使用|get started)$/i.test((node.textContent ?? '').trim()))
    if (byText !== undefined) byText.click()
    const dialog = document.querySelector('[role="dialog"]')
    const close = dialog?.querySelector('button[aria-label="Close"]')
    if (close !== undefined && close !== null) close.click()
    return true
  })()`)
  await dismissOverlays()
  // Let the widget paint and any first reconcile settle.
  await new Promise(done => setTimeout(done, 800))

  const initial = await session.eval(snapshot())
  check('plugin is in the boot graph', initial.bootEntry === true)
  check('widget mounted in shell.overlay', initial.mounted === true)
  check('stylesheet injected', initial.styleTag === true)
  check('starts collapsed', initial.collapsed === true, initial.time)
  check('positions in the bottom-right corner', initial.rect !== null && initial.rect.right < 60 && initial.rect.bottom < 60, initial.rect)
  check('layer position is absolute (frame overlay)', initial.position === 'absolute', initial.position)
  check('root opts back into pointer events', initial.pointerEvents === 'auto', initial.pointerEvents)
  check('shows a full focus block', /^25:0\d$/.test(initial.time ?? ''), initial.time)
  check('reports the focus phase', initial.phaseKind === 'focus', { kind: initial.phaseKind, label: initial.phase })
  await session.screenshot('01-collapsed')
  await session.screenshotElement('01-collapsed-widget', '.pomo-pill')

  // ── expand ────────────────────────────────────────────────────
  await session.eval(`document.querySelector('.pomo-pill').click()`)
  await session.waitFor(`document.querySelector('.pomo-card') !== null`, 5_000, 'card open')
  await new Promise(done => setTimeout(done, 300))
  const expanded = await session.eval(snapshot())
  check('pill expands to the card', expanded.expanded === true)
  check('card has a menu surface color', expanded.background !== null && expanded.background !== 'rgba(0, 0, 0, 0)', expanded.background)
  const material = await session.eval(`(() => {
    const card = document.querySelector('.pomo-card')
    const pill = document.querySelector('.pomo-pill')
    const blur = node => node === null ? null : getComputedStyle(node).backdropFilter
    return { card: blur(card), pill: blur(pill) }
  })()`)
  check('card uses the blurred menu material', /blur\(40px\)/.test(material.card ?? ''), material.card)
  const ring = await session.eval(`(() => {
    const svg = document.querySelector('.pomo-ring')
    if (svg === null) return null
    const track = document.querySelector('.pomo-ringTrack')
    const value = document.querySelector('.pomo-ringValue')
    return { size: svg.getBoundingClientRect().width, track: track === null ? null : getComputedStyle(track).stroke, accent: value === null ? null : getComputedStyle(value).stroke }
  })()`)
  check('progress ring renders with token colors', ring !== null && ring.size > 100 && ring.accent !== 'none', ring)
  await session.screenshot('02-expanded')
  await session.screenshotElement('02-expanded-widget', '.pomo-card')

  // ── start and let the clock run ───────────────────────────────
  await session.eval(`document.querySelector('.pomo-primary').click()`)
  await new Promise(done => setTimeout(done, 2600))
  const running = await session.eval(snapshot())
  check('start runs the clock', running.stored !== null && running.stored.status === 'running', running.stored?.status)
  check('deadline is persisted as an epoch', Number.isFinite(running.stored?.deadline), running.stored?.deadline)
  check('countdown decreases', /^24:5[0-8]$/.test(running.time ?? ''), running.time)
  check('running card shows a status word', await session.eval(`(document.querySelector('.pomo-status')?.textContent ?? '').length > 0`))
  await session.screenshot('03-running')
  await session.screenshotElement('03-running-widget', '.pomo-card', 16)

  // Collapse while running: the pill carries the pulse and the live clock.
  await session.eval(`document.querySelector('[data-pomo-action="collapse"]').click()`)
  await new Promise(done => setTimeout(done, 250))
  check('running pill exposes a pulse', await session.eval(`document.querySelector('.pomo-pulse') !== null`) === true)
  check('running pill still shows the countdown', /^24:5\d$/.test(await session.eval(`document.querySelector('.pomo-pillTime').textContent`)))
  await session.screenshot('04-running-collapsed')
  await session.eval(`document.querySelector('[data-pomo-action="toggle"]').click()`)
  await session.waitFor(`document.querySelector('.pomo-card') !== null`, 5_000, 'card reopened')

  // ── pause / resume ────────────────────────────────────────────
  await session.eval(`document.querySelector('.pomo-primary').click()`)
  await new Promise(done => setTimeout(done, 200))
  const paused = await session.eval(snapshot())
  check('pause freezes the phase', paused.stored?.status === 'paused', paused.stored?.status)
  const frozen = paused.time
  await new Promise(done => setTimeout(done, 1600))
  const stillFrozen = await session.eval(`document.querySelector('.pomo-time').textContent`)
  check('paused clock does not move', stillFrozen === frozen, { frozen, stillFrozen })

  // ── skip to the break ────────────────────────────────────────
  await session.eval(`document.querySelector('[data-pomo-action="skip"]').click()`)
  await new Promise(done => setTimeout(done, 300))
  const skipped = await session.eval(snapshot())
  check('skip advances to the short break', skipped.phaseKind === 'shortBreak', { kind: skipped.phaseKind, label: skipped.phase })
  check('skip does not credit a focus block', skipped.stored?.completedFocus === 0, skipped.stored?.completedFocus)
  await session.screenshot('05-break')
  await session.screenshotElement('05-break-widget', '.pomo-card')

  // ── reset ────────────────────────────────────────────────────
  await session.eval(`document.querySelector('[data-pomo-action="reset"]').click()`)
  await new Promise(done => setTimeout(done, 200))
  const reset = await session.eval(snapshot())
  check('reset restores a stopped full break', reset.stored?.status === 'idle' && /^05:0\d$/.test(reset.time ?? ''), { status: reset.stored?.status, time: reset.time })

  // ── settings panel ───────────────────────────────────────────
  await session.eval(`document.querySelector('[data-pomo-action="settings"]').click()`)
  await session.waitFor(`document.querySelector('[data-pomo-panel="settings"]') !== null`, 5_000, 'settings panel')
  const settings = await session.eval(`(() => {
    const rows = [...document.querySelectorAll('.pomo-row')].map(node => node.dataset.pomoSetting)
    const switches = [...document.querySelectorAll('[role="switch"]')].map(node => node.dataset.pomoSetting)
    return { rows, switches, steppers: document.querySelectorAll('.pomo-stepper').length }
  })()`)
  check('settings lists the four durations', JSON.stringify(settings.rows) === JSON.stringify(['focus', 'shortBreak', 'longBreak', 'every']), settings.rows)
  check('settings lists the four switches', JSON.stringify(settings.switches) === JSON.stringify(['autoBreaks', 'autoFocus', 'sound', 'notify']), settings.switches)
  await session.screenshot('06-settings')
  await session.screenshotElement('06-settings-widget', '.pomo-card', 16)

  // ── edit a duration ──────────────────────────────────────────
  await session.eval(`document.querySelector('.pomo-card [data-pomo-setting="focus"] [data-pomo-action="increase"]').click()`)
  await new Promise(done => setTimeout(done, 300))
  const edited = await session.eval(snapshot())
  check('stepper edits the focus length', edited.stored?.settings?.focusMin === 26, edited.stored?.settings?.focusMin)

  // Header glyphs must differ, or "back" and "collapse" look like one control.
  const headerIcons = await session.eval(`(() => {
    const buttons = [...document.querySelectorAll('.pomo-head .pomo-iconBtn')]
    return buttons.map(button => ({ label: button.getAttribute('aria-label'), glyph: button.querySelector('path')?.getAttribute('d') ?? '' }))
  })()`)
  check('back and collapse use different glyphs', headerIcons.length === 2 && headerIcons[0].glyph !== headerIcons[1].glyph, headerIcons.map(entry => entry.label))

  // ── toggle a switch ──────────────────────────────────────────
  const beforeToggle = edited.stored?.settings?.sound
  await session.eval(`document.querySelector('[role="switch"][data-pomo-setting="sound"]').click()`)
  await new Promise(done => setTimeout(done, 300))
  const toggled = await session.eval(snapshot())
  check('switches persist settings', toggled.stored?.settings?.sound === !beforeToggle, { before: beforeToggle, after: toggled.stored?.settings?.sound })

  // The switch must paint its on and off states differently, and off must not
  // borrow the (phase-colored) accent.
  const switchColors = await session.eval(`(() => {
    const read = setting => {
      const node = document.querySelector('[role="switch"][data-pomo-setting="' + setting + '"]')
      const track = node?.querySelector('.pomo-switchTrack')
      return { checked: node?.getAttribute('aria-checked'), color: track === null || track === undefined ? null : getComputedStyle(track).backgroundColor }
    }
    return { on: read('notify'), off: read('sound') }
  })()`)
  check('switch on-state paints the accent track', switchColors.on.checked === 'true' && switchColors.on.color === 'rgb(122, 170, 255)', switchColors.on)
  check('switch off-state paints a neutral track', switchColors.off.checked === 'false' && switchColors.off.color !== switchColors.on.color, switchColors.off)

  // ── reload keeps state ───────────────────────────────────────
  await session.send('Page.reload')
  await session.waitFor(`document.querySelector('.pomo-root') !== null`, 30_000, 'widget after reload')
  await new Promise(done => setTimeout(done, 500))
  const reloaded = await session.eval(snapshot())
  check('settings survive a reload', reloaded.stored?.settings?.focusMin === 26, reloaded.stored?.settings?.focusMin)
  check('open panel survives a reload', reloaded.expanded === true)
  await session.screenshot('07-reloaded')

  // ── Plugins page: profile switches + the plugin's own Configure page ──
  // The Plugins panel is taller than a conversation viewport; give the page room
  // so the configuration sections are not clipped in the documentation shots.
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false })
  await dismissOverlays()
  // Collapse the timer so the page under test is not covered by the widget.
  await session.eval(`(() => { const collapse = document.querySelector('[data-pomo-action="collapse"]'); if (collapse !== null) collapse.click() })()`)
  await new Promise(done => setTimeout(done, 200))
  await session.eval(`document.querySelector('button[aria-label="Plugins"]').click()`)
  await session.waitFor(`document.body.innerText.includes('Installed plugins')`, 20_000, 'Plugins list')
  await session.eval(`(() => {
    const card = [...document.querySelectorAll('button')].find(node => (node.textContent ?? '').includes('dsh-plugin-pomodoro'))
    if (card !== undefined) card.click()
  })()`)
  await session.waitFor(`document.querySelector('[aria-label="Configure dsh-plugin-pomodoro"]') !== null`, 20_000, 'bundle page')
  const bundleSwitches = await session.eval(`(() => {
    const read = label => {
      const node = document.querySelector('[aria-label="' + label + '"]')
      return node === null ? null : node.getAttribute('aria-checked')
    }
    return {
      bundle: read('Enable dsh-plugin-pomodoro'),
      component: read('Enable component dsh-plugin-pomodoro'),
      configure: document.querySelector('[aria-label="Configure dsh-plugin-pomodoro"]') !== null,
    }
  })()`)
  check('Plugins page exposes the bundle switch', bundleSwitches.bundle === 'true', bundleSwitches.bundle)
  check('Plugins page exposes the Component (unload) switch', bundleSwitches.component === 'true', bundleSwitches.component)
  check('Plugins page exposes a Configure control for the row', bundleSwitches.configure === true)

  await session.eval(`document.querySelector('[aria-label="Configure dsh-plugin-pomodoro"]').click()`)
  await session.waitFor(`document.querySelector('[data-pomo-config="page"]') !== null`, 10_000, 'pomodoro config page')
  await dismissOverlays()
  await new Promise(done => setTimeout(done, 250))
  const configPage = await session.eval(`(() => {
    const page = document.querySelector('[data-pomo-config="page"]')
    const widgetSwitch = page.querySelector('[data-pomo-setting="widget"]')
    return {
      text: page.innerText,
      sections: [...page.querySelectorAll('.pomo-configHeading')].map(node => node.textContent),
      rows: [...page.querySelectorAll('.pomo-row')].map(node => node.dataset.pomoSetting),
      widgetChecked: widgetSwitch === null ? null : widgetSwitch.getAttribute('aria-checked'),
      widgetLabel: widgetSwitch === null ? null : widgetSwitch.textContent,
    }
  })()`)
  check('Configure page has the widget enable switch', configPage.widgetChecked === 'true', configPage.widgetChecked)
  check('Configure page labels the switch', /Floating timer/.test(configPage.widgetLabel ?? ''), configPage.widgetLabel)
  check('Configure page groups the settings', configPage.sections.length === 4, configPage.sections)
  check('Configure page lists the four durations', JSON.stringify(configPage.rows) === JSON.stringify(['focus', 'shortBreak', 'longBreak', 'every']), configPage.rows)
  await session.screenshot('08-plugins-config')
  await session.screenshotElement('08-plugins-config-widget', '[data-pomo-config="page"]', 18)

  // Hide the floating timer from the Configure page: the widget goes away, the
  // plugin stays loaded, and the preference is persisted.
  await session.eval(`document.querySelector('[data-pomo-config="page"] [data-pomo-setting="widget"]').click()`)
  await new Promise(done => setTimeout(done, 400))
  const hidden = await session.eval(`(() => ({
    widget: document.querySelector('.pomo-root') !== null,
    config: document.querySelector('[data-pomo-config="page"]') !== null,
    prefs: (() => { try { return JSON.parse(localStorage.getItem('dsh-plugin-pomodoro:prefs:v1')) } catch { return null } })(),
    checked: document.querySelector('[data-pomo-config="page"] [data-pomo-setting="widget"]')?.getAttribute('aria-checked'),
  }))()`)
  check('widget switch hides the floating timer', hidden.widget === false)
  check('the plugin stays loaded while its widget is hidden', hidden.config === true)
  check('hidden state is persisted', hidden.prefs?.widgetEnabled === false, hidden.prefs)
  check('switch reflects the hidden state', hidden.checked === 'false', hidden.checked)

  await session.eval(`document.querySelector('[data-pomo-config="page"] [data-pomo-setting="widget"]').click()`)
  await new Promise(done => setTimeout(done, 400))
  check('widget switch brings the timer back', await session.eval(`document.querySelector('.pomo-root') !== null`) === true)

  // Editing a duration here writes the same record the widget reads.
  const focusBefore = await session.eval(`(() => { try { return JSON.parse(localStorage.getItem('dsh-plugin-pomodoro:state:v1')).settings.focusMin } catch { return null } })()`)
  await session.eval(`document.querySelector('[data-pomo-config="page"] [data-pomo-setting="focus"] [data-pomo-action="increase"]').click()`)
  await new Promise(done => setTimeout(done, 400))
  const focusAfter = await session.eval(`(() => { try { return JSON.parse(localStorage.getItem('dsh-plugin-pomodoro:state:v1')).settings.focusMin } catch { return null } })()`)
  check('Configure page edits the shared timer settings', focusAfter === (focusBefore ?? 25) + 1, { focusBefore, focusAfter })

  // The Component switch is the real profile-level enable/disable: it unloads
  // the plugin (and with it this page), then loads it again. It lives on the
  // bundle page, so walk back to the parent crumb first.
  await session.eval(`document.querySelector('[aria-label="Back to dsh-plugin-pomodoro"]')?.click()`)
  await session.waitFor(`document.querySelector('[aria-label="Enable component dsh-plugin-pomodoro"]') !== null`, 10_000, 'bundle page again')
  await session.eval(`document.querySelector('[aria-label="Enable component dsh-plugin-pomodoro"]').click()`)
  const offState = `document.querySelector('.pomo-root') === null
    && document.querySelector('[data-pomo-config="page"]') === null
    && document.querySelector('[aria-label="Enable component dsh-plugin-pomodoro"]')?.getAttribute('aria-checked') === 'false'`
  const unloaded = await session.waitFor(`(${offState})`, 25_000, 'plugin unload').then(() => true).catch(() => false)
  check('Component switch unloads the plugin and reports the off state', unloaded)
  const offPatch = await session.eval(`document.querySelector('[aria-label="Enable component dsh-plugin-pomodoro"]')?.getAttribute('aria-checked')`)
  check('Component switch reports the off state', offPatch === 'false', offPatch)

  await session.eval(`document.querySelector('[aria-label="Enable component dsh-plugin-pomodoro"]').click()`)
  const onState = `document.querySelector('.pomo-root') !== null
    && document.querySelector('[aria-label="Enable component dsh-plugin-pomodoro"]')?.getAttribute('aria-checked') === 'true'`
  const reloadedPlugin = await session.waitFor(`(${onState})`, 30_000, 'plugin reload').then(() => true).catch(() => false)
  check('Component switch re-enables the plugin', reloadedPlugin)
  await session.screenshot('09-plugins-back-on')

  const failed = checks.filter(entry => !entry.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  console.log(`screenshots: ${OUT}`)
  if (failed.length > 0) {
    console.error(`\n${failed.length} failed: ${failed.map(entry => entry.name).join(', ')}`)
  }
  // The CDP socket would otherwise keep the event loop alive forever.
  session.socket.close()
  process.exit(failed.length > 0 ? 1 : 0)
}

await main()
