#!/usr/bin/env node
/**
 * End-to-end verification of the task board against a live DSH instance.
 *
 * The script drives a headless Chrome over the DevTools protocol through the
 * board's real user journeys: seeded SQLite board, smart sections, search,
 * composer, drawer, labels, subtasks, drag & drop, keyboard moves, exported
 * focus time (measured pause + catch-up after reload), JSON import/export and
 * the accessibility contract. Pass `--out <dir>` to keep WebP screenshots.
 *
 * Requires an ISOLATED DSH instance with a FRESH board database (the import
 * phase replaces the board), e.g.:
 *
 *   cd pomodoro-plugin
 *   ./scripts/verify-plugin.sh --keep     # prints the authenticated URL
 *   node scripts/verify-board.mjs --url "<url>" --out /tmp/board-shots
 *
 * Usage: node scripts/verify-board.mjs --url <authenticated-url> [--cdp http://127.0.0.1:9333] [--out dir]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/* ─────────────────────────── arguments ─────────────────────────── */

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const URL_ARG = arg('url', '')
const CDP = arg('cdp', 'http://127.0.0.1:9333').replace(/\/$/, '')
const OUT = arg('out', '')
if (URL_ARG.length === 0) {
  console.error('verify-board: --url <authenticated dsh web URL> is required')
  process.exit(2)
}
if (OUT.length > 0) mkdirSync(resolve(OUT), { recursive: true })

/* ───────────────────────── DevTools client ─────────────────────── */

class Session {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.errors = []
    this.consoleErrors = []
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve: done, reject: fail } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error !== undefined) fail(new Error(message.error.message))
        else done(message.result)
        return
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push((message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text || '').slice(0, 400))
      }
      if (message.method === 'Runtime.consoleAPICalled' && (message.params.type === 'error' || message.params.type === 'assert')) {
        const text = (message.params.args ?? []).map(argument => argument.value ?? argument.description ?? '').join(' ')
        this.consoleErrors.push(text.slice(0, 400))
      }
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        this.consoleErrors.push(`[log] ${message.params.entry.text}`.slice(0, 400))
      }
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    const promise = new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }) })
    this.socket.send(JSON.stringify({ id, method, params }))
    return promise
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (result.exceptionDetails !== undefined) {
      throw new Error(`page exception: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    }
    return result.result.value
  }

  async waitFor(expression, timeoutMs = 20_000, label = expression) {
    const start = Date.now()
    for (;;) {
      if (await this.eval(`(() => { try { return Boolean(${expression}) } catch { return false } })()`)) return
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`)
      await pause(120)
    }
  }

  async screenshot(name, selector, padding = 16) {
    if (OUT.length === 0) return null
    let clip
    if (selector !== undefined) {
      const rect = await this.eval(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)})
        if (node === null) return null
        const box = node.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: box.height }
      })()`)
      if (rect === null) throw new Error(`cannot screenshot missing ${selector}`)
      clip = { x: Math.max(0, rect.x - padding), y: Math.max(0, rect.y - padding), width: rect.width + padding * 2, height: rect.height + padding * 2, scale: 1 }
    }
    const { data } = await this.send('Page.captureScreenshot', clip === undefined
      ? { format: 'webp', quality: 90, captureBeyondViewport: false }
      : { format: 'webp', quality: 90, captureBeyondViewport: true, clip })
    const path = resolve(OUT, `${name}.webp`)
    writeFileSync(path, Buffer.from(data, 'base64'))
    return path
  }
}

const pause = ms => new Promise(done => setTimeout(done, ms))

async function connect() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await fetch(`${CDP}/json/list`).then(response => response.json())
      const page = targets.find(target => target.type === 'page')
      if (page !== undefined) {
        const socket = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((done, fail) => {
          socket.addEventListener('open', done, { once: true })
          socket.addEventListener('error', () => fail(new Error('CDP socket failed')), { once: true })
        })
        return new Session(socket)
      }
    } catch { /* CDP not ready */ }
    await pause(200)
  }
  throw new Error(`could not connect to CDP at ${CDP}`)
}

/* ─────────────────────────── helpers ──────────────────────────── */

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok) })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

async function dismissAppDialogs(session) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const done = await session.eval(`(async () => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(d => !d.classList.contains('tb-panel') && !d.classList.contains('tb-drawer') && !d.classList.contains('tb-modal'))
      if (dialogs.length === 0) return true
      const buttons = [...dialogs[0].querySelectorAll('button')]
      // Prefer acknowledging/continuing; otherwise close. Never click the
      // app's "Sign in" button: in a throw-away profile it starts an external
      // auth flow and leaves a "Waiting for sign in" overlay on screen.
      const continueButton = buttons.find(b => /^(continue|got it|ok|understood|知道了|继续|开始使用|get started)$/i.test((b.textContent || '').trim()))
      const closeButton = buttons.find(b => /close|dismiss|cancel|关闭|取消/i.test(b.getAttribute('aria-label') ?? '') || (b.textContent || '').trim() === '')
      const primary = continueButton ?? closeButton
      if (primary === undefined) return false
      primary.click()
      await new Promise(resolve => setTimeout(resolve, 350))
      return false
    })()`)
    if (done === true) {
      if (await session.eval(`document.querySelector('#root[inert]') === null`)) return
      await pause(400)
    }
  }
}

async function openBoard(session) {
  await dismissAppDialogs(session)
  await session.eval(`document.querySelector('[data-pomo-action="board"]').click()`)
  await session.waitFor(`document.querySelector('.tb-panel .tb-column') !== null`, 25_000, 'board panel')
  await dismissAppDialogs(session)
  await session.waitFor(`document.querySelector('#root[inert]') === null`, 15_000, 'root not inert')
}

const rectOf = (session, selector) => session.eval(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)})
  if (node === null) return null
  const box = node.getBoundingClientRect()
  return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }
})()`)
const inside = (outer, inner, tolerance = 1.5) => inner !== null && outer !== null
  && inner.x >= outer.x - tolerance && inner.y >= outer.y - tolerance
  && inner.right <= outer.right + tolerance && inner.bottom <= outer.bottom + tolerance
const centredIn = (outer, inner, tolerance = 2) => inside(outer, inner)
  && Math.abs((inner.x + inner.width / 2) - (outer.x + outer.width / 2)) <= tolerance

const hostBoard = session => session.eval(`fetch('/api/pomodoro-board/state').then(r => r.json()).then(j => JSON.stringify(j.board))`).then(JSON.parse)
const timerState = session => session.eval(`localStorage.getItem('dsh-plugin-pomodoro:state:v1')`).then(raw => (raw === null ? null : JSON.parse(raw)))
const taskByTitle = (board, title) => board.tasks.find(task => task.title === title)

/** Seed a small demo board through the host API. */
async function seedDemoBoard(session) {
  return session.eval(`(async () => {
    const post = async (op, payload) => {
      const response = await fetch('/api/pomodoro-board/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, payload }) })
      return response.json()
    }
    const state = await (await fetch('/api/pomodoro-board/state')).json()
    const [todo, doing, done] = state.board.lists
    const labels = {}
    for (const [name, color] of [['diseño', 'blue'], ['bug', 'red'], ['docs', 'green']]) {
      await post('label.create', { name, color })
    }
    const board = await (await fetch('/api/pomodoro-board/state')).json()
    for (const label of board.board.labels) labels[label.name] = label.id
    const day = offset => { const value = new Date(); value.setDate(value.getDate() + offset); return value.getFullYear() + '-' + String(value.getMonth() + 1).padStart(2, '0') + '-' + String(value.getDate()).padStart(2, '0') }
    await post('task.create', { listId: todo.id, title: 'Diseñar tablero', priority: 'high', dueDate: day(0), estimateMin: 90, labelIds: [labels['diseño']], subtasks: [{ title: 'Bocetos' }, { title: 'Revisión' }] })
    await post('task.create', { listId: todo.id, title: 'Revisar PRs', priority: 'medium', dueDate: day(1), estimateMin: 30, labelIds: [labels['bug']] })
    await post('task.create', { listId: doing.id, title: 'Documentar API', priority: 'low', estimateMin: 45, labelIds: [labels['docs']] })
    await post('task.create', { listId: todo.id, title: 'Preparar demo', priority: 'high', dueDate: day(0), estimateMin: 20 })
    const created = await (await fetch('/api/pomodoro-board/state')).json()
    const demo = created.board.tasks.find(task => task.title === 'Preparar demo')
    await post('task.move', { id: demo.id, listId: done.id })
    return JSON.stringify({ todo: todo.id, doing: doing.id, done: done.id, demo: demo.id })
  })()`).then(JSON.parse)
}

/* ───────────────────────────── main ───────────────────────────── */

async function main() {
  const session = await connect()
  await session.send('Page.enable')
  await session.send('Runtime.enable')
  await session.send('Log.enable')
  await session.send('DOM.enable')
  // A fresh throw-away profile may try to redirect to the platform sign-in;
  // keep the run on the local instance.
  await session.send('Network.enable')
  await session.send('Network.setBlockedURLs', { urls: ['*://platform.deepseek.com/*', '*://*.deepseek.com/*'] })
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await session.send('Page.navigate', { url: URL_ARG })
  await session.waitFor(`document.querySelector('.pomo-root') !== null`, 30_000, 'widget')
  await dismissAppDialogs(session)

  const ids = await seedDemoBoard(session)
  await openBoard(session)
  let board = await hostBoard(session)
  check('seeded board reaches the client', board.tasks.length === 4 && board.labels.length === 3, { tasks: board.tasks.length, labels: board.labels.length })
  check('default columns render', await session.eval(`document.querySelectorAll('.tb-column').length === 3`))
  check('stats sum the demo estimates (185m)', await session.eval(`[...document.querySelectorAll('.tb-stat')].some(n => n.textContent.includes('3h 5m'))`))
  check('completed task is counted', await session.eval(`[...document.querySelectorAll('.tb-stat')].some(n => n.textContent.includes('Completed') && n.querySelector('.tb-statValue').textContent === '1')`))
  await session.screenshot('board-overview')

  // smart sections + search
  await session.eval(`[...document.querySelectorAll('.tb-railItem')].find(n => (n.textContent || '').startsWith('Today')).click()`)
  await pause(400)
  check('Today section filters the columns', await session.eval(`document.querySelectorAll('.tb-card').length >= 2`), await session.eval(`document.querySelectorAll('.tb-card').length`))
  await session.screenshot('board-section-today')
  await session.eval(`[...document.querySelectorAll('.tb-railItem')].find(n => (n.textContent || '').startsWith('All tasks')).click()`)
  await pause(300)
  await session.eval(`(() => { const input = document.querySelector('.tb-search input'); input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'diseño'); input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await pause(400)
  check('search by label narrows the board', await session.eval(`document.querySelectorAll('.tb-card').length === 1`), await session.eval(`document.querySelectorAll('.tb-card').length`))
  await session.eval(`(() => { const input = document.querySelector('.tb-search input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await pause(300)

  // composer with subtasks
  await session.eval(`document.querySelector('.tb-newTaskBtn').click()`)
  await session.waitFor(`document.querySelector('.tb-modal') !== null`, 8_000, 'composer')
  await session.screenshot('task-composer')
  await session.eval(`(() => {
    const set = (selector, value) => {
      const el = document.querySelector(selector)
      if (el === null) return false
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      el.focus()
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }
    set('.tb-modal [aria-label="Title"]', 'Tarea E2E')
    set('.tb-modal [aria-label="Estimate"]', '60')
    const select = document.querySelector('.tb-modal [aria-label="Priority"]')
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'high')
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await session.eval(`(() => {
    const input = document.querySelector('.tb-modal .tb-subtaskAdd input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Sub E2E')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await session.eval(`document.querySelector('.tb-modal .tb-subtaskAdd .tb-btn').click()`)
  await pause(200)
  await session.eval(`document.querySelector('.tb-modalFooter .tb-btn[data-variant="primary"]').click()`)
  await session.waitFor(`document.querySelector('.tb-modal') === null`, 15_000, 'composer closed')
  await pause(500)
  board = await hostBoard(session)
  const e2e = taskByTitle(board, 'Tarea E2E')
  check('composer persists a full task', e2e !== undefined && e2e.priority === 'high' && e2e.estimateMin === 60 && e2e.subtasks.length === 1, e2e && { priority: e2e.priority, estimate: e2e.estimateMin, subtasks: e2e.subtasks.length })

  // drawer edits + labels + subtasks
  await session.eval(`(() => { const card = [...document.querySelectorAll('.tb-card')].find(n => n.textContent.includes('Tarea E2E')); card.click(); return true })()`)
  await session.waitFor(`document.querySelector('.tb-drawer') !== null`, 8_000, 'drawer')
  await session.screenshot('task-drawer')
  await session.eval(`(() => {
    const el = document.querySelector('.tb-drawer [aria-label="Notes"]')
    el.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'Nota E2E')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.blur()
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    return true
  })()`)
  await pause(500)
  board = await hostBoard(session)
  check('drawer notes persist', taskByTitle(board, 'Tarea E2E').notes === 'Nota E2E')
  await session.eval(`(() => {
    const chip = [...document.querySelectorAll('.tb-drawer .tb-subtaskCheck')][0]
    chip.click(); return true
  })()`)
  await pause(400)
  board = await hostBoard(session)
  check('drawer toggles a subtask', taskByTitle(board, 'Tarea E2E').subtasks[0].done === true)

  // labels: the inline picker lives inside the drawer, not in a floating popover
  check('trigger opens the inline label panel', await session.eval(`(() => {
    const trigger = document.querySelector('.tb-drawer [aria-controls="pomodoro-label-panel"]')
    if (trigger === null) return false
    if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click()
    return true
  })()`))
  await session.waitFor(`document.querySelector('.tb-drawer .tb-labelPanel') !== null`, 8_000, 'inline label panel')
  await pause(250)
  const drawer = await rectOf(session, '.tb-drawer')
  const labelPanel = await rectOf(session, '.tb-drawer .tb-labelPanel')
  check('label panel stays inside the drawer', inside(drawer, labelPanel), { drawer, labelPanel })
  check('label panel is centred in the drawer', centredIn(drawer, labelPanel), { drawer: drawer && drawer.x + drawer.width / 2, panel: labelPanel && labelPanel.x + labelPanel.width / 2 })
  check('label panel spans the drawer width', labelPanel !== null && drawer !== null && labelPanel.width >= drawer.width - 40, { panel: labelPanel && labelPanel.width, drawer: drawer && drawer.width })
  await session.eval(`(() => { document.querySelector('.tb-drawer .tb-labelPanel [role="checkbox"]').click(); return true })()`)
  await pause(500)
  board = await hostBoard(session)
  check('label panel assigns a label', taskByTitle(board, 'Tarea E2E').labelIds.length === 1, taskByTitle(board, 'Tarea E2E').labelIds)
  check('assigned label shows as a drawer chip', await session.eval(`document.querySelectorAll('.tb-drawer .tb-labelToken').length === 1`))
  await session.screenshot('task-labels-picker')
  await session.eval(`(() => { document.querySelector('.tb-drawer .tb-labelToken button').click(); return true })()`)
  await pause(500)
  board = await hostBoard(session)
  check('label chip removes the label', taskByTitle(board, 'Tarea E2E').labelIds.length === 0)

  // manager opened from the inline panel: absolutely centred inside the board panel
  await session.eval(`(() => {
    const manage = [...document.querySelectorAll('.tb-drawer .tb-labelPanelFooter .tb-btn')].find(button => button.textContent.trim() === 'Manage labels')
    if (manage === undefined) return false
    manage.click()
    return true
  })()`)
  await session.waitFor(`document.querySelector('.tb-modal') !== null`, 8_000, 'label manager from panel')
  await pause(300)
  const boardPanel = await rectOf(session, '.tb-panel')
  const manager = await rectOf(session, '.tb-modal')
  check('label manager is centred in the board panel', centredIn(boardPanel, manager), { boardPanel, manager })
  check('label manager lists every label', await session.eval(`document.querySelectorAll('.tb-modal .tb-labelManageRow').length === 4`))
  await session.screenshot('labels-manager')
  await session.eval(`(() => {
    const input = document.querySelector('.tb-modal [aria-label="Label name"]')
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'E2E etiqueta')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await pause(150)
  await session.eval(`document.querySelector('.tb-modal form.tb-labelManageRow .tb-btn[data-variant="primary"]').click()`)
  await pause(600)
  board = await hostBoard(session)
  check('label manager creates a label', board.labels.some(label => label.name === 'E2E etiqueta'), board.labels.map(label => label.name))
  await session.eval(`(() => {
    const row = [...document.querySelectorAll('.tb-modal .tb-labelManageRow')].find(node => node.querySelector('.tb-labelName')?.textContent === 'E2E etiqueta')
    if (row === undefined) return false
    const remove = [...row.querySelectorAll('button')].find(button => (button.getAttribute('aria-label') ?? '').startsWith('Delete label'))
    if (remove === undefined) return false
    remove.click()
    return true
  })()`)
  await pause(300)
  await session.eval(`document.querySelector('.tb-modal .tb-labelManageRow .tb-btn[data-variant="danger"]').click()`)
  await pause(600)
  board = await hostBoard(session)
  check('label manager deletes a label', !board.labels.some(label => label.name === 'E2E etiqueta'), board.labels.map(label => label.name))
  await session.eval(`document.querySelector('.tb-modal .tb-modalFooter .tb-btn').click()`)
  await session.waitFor(`document.querySelector('.tb-modal') === null`, 8_000, 'label manager closed')
  check('board survives the label manager round-trip', await session.eval(`document.querySelector('.tb-drawer') !== null && document.querySelector('.tb-panel .tb-column') !== null`))

  // the header entry point opens the same manager
  await session.eval(`(() => { const close = document.querySelector('.tb-drawer .tb-labelPanelFooter .tb-quickBtn'); if (close !== null) close.click(); return true })()`)
  await pause(200)
  await session.eval(`document.querySelector('.tb-drawer [aria-label="Close task details"]').click()`)
  await pause(300)
  await session.eval(`document.querySelector('.tb-header [aria-label="Manage labels"]').click()`)
  await session.waitFor(`document.querySelector('.tb-modal') !== null`, 8_000, 'label manager from header')
  await pause(300)
  check('label manager opens from the header and stays centred', await session.eval(`(() => {
    const panel = document.querySelector('.tb-panel').getBoundingClientRect()
    const modal = document.querySelector('.tb-modal').getBoundingClientRect()
    return Math.abs((modal.x + modal.width / 2) - (panel.x + panel.width / 2)) <= 2 && modal.width <= panel.width
  })()`))
  await session.eval(`document.querySelector('.tb-modal .tb-modalFooter .tb-btn').click()`)
  await session.waitFor(`document.querySelector('.tb-modal') === null`, 8_000, 'label manager closed')
  check('board still renders after closing the manager', await session.eval(`document.querySelector('.tb-panel .tb-column') !== null`))

  // drag & drop
  await session.eval(`(async () => {
    const card = [...document.querySelectorAll('.tb-card')].find(n => n.textContent.includes('Revisar PRs'))
    const done = [...document.querySelectorAll('.tb-column')][2]
    const transfer = new DataTransfer()
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    await new Promise(resolve => setTimeout(resolve, 250))
    const rect = done.getBoundingClientRect()
    done.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: rect.bottom - 12 }))
    await new Promise(resolve => setTimeout(resolve, 150))
    done.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: rect.bottom - 12 }))
    return true
  })()`)
  await pause(900)
  board = await hostBoard(session)
  check('drag & drop completes a task in Done', taskByTitle(board, 'Revisar PRs').completedAt !== null)

  // keyboard move + column reorder
  await session.eval(`(() => {
    const card = [...document.querySelectorAll('.tb-card')].find(n => n.textContent.includes('Tarea E2E'))
    card.focus()
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true }))
    return true
  })()`)
  await pause(800)
  board = await hostBoard(session)
  check('Alt+Right moves a card to the next list', taskByTitle(board, 'Tarea E2E').listId === ids.doing, taskByTitle(board, 'Tarea E2E').listId)
  await session.eval(`(async () => {
    const columns = [...document.querySelectorAll('.tb-column')]
    const handle = columns[2].querySelector('.tb-dragHandle')
    const first = columns[0]
    const transfer = new DataTransfer()
    handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    await new Promise(resolve => setTimeout(resolve, 250))
    const rect = first.getBoundingClientRect()
    first.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: rect.top + rect.height / 2 }))
    await new Promise(resolve => setTimeout(resolve, 150))
    first.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: rect.top + rect.height / 2 }))
    return true
  })()`)
  await pause(800)
  board = await hostBoard(session)
  check('list handles reorder the columns', [...board.lists].sort((l, r) => l.position - r.position)[0].title === 'Done', board.lists.map(l => l.title))

  // timer integration: measured pause credit + catch-up
  await session.eval(`(() => { const card = [...document.querySelectorAll('.tb-card')].find(n => n.textContent.includes('Tarea E2E')); card.querySelector('[aria-label="Focus on task"]').click(); return true })()`)
  await session.waitFor(`document.querySelector('.tb-card[data-active="true"]') !== null`, 8_000, 'active card')
  await session.screenshot('timer-focus')
  await pause(2200)
  await session.eval(`document.querySelector('.pomo-pill').click()`)
  await session.waitFor(`document.querySelector('.pomo-card') !== null`, 5_000, 'widget card')
  await session.eval(`document.querySelector('[data-pomo-action="toggle-run"]').click()`)
  await pause(900)
  board = await hostBoard(session)
  const measured = taskByTitle(board, 'Tarea E2E').timeSpentMs
  check('pause credits measured focus time', measured >= 1_000 && measured < 15_000, measured)
  const beforeCatchUp = measured
  await session.eval(`(() => {
    const raw = JSON.parse(localStorage.getItem('dsh-plugin-pomodoro:state:v1'))
    const now = Date.now()
    raw.status = 'running'
    raw.deadline = now - 2000
    raw.focusStartedAt = raw.deadline - 25 * 60 * 1000
    localStorage.setItem('dsh-plugin-pomodoro:state:v1', JSON.stringify(raw))
    return true
  })()`)
  await session.send('Page.reload')
  await session.waitFor(`document.querySelector('.pomo-root') !== null`, 30_000, 'widget after reload')
  await pause(1500)
  board = await hostBoard(session)
  check('catch-up credits a completed focus phase', taskByTitle(board, 'Tarea E2E').timeSpentMs >= beforeCatchUp + 25 * 60 * 1000, { before: beforeCatchUp, after: taskByTitle(board, 'Tarea E2E').timeSpentMs })
  check('catch-up counts the pomodoro', taskByTitle(board, 'Tarea E2E').pomodoros === 1)

  // export + import
  const exported = await session.eval(`fetch('/api/pomodoro-board/export').then(r => r.json()).then(j => JSON.stringify({ format: j.format, tasks: j.board.tasks.length }))`).then(JSON.parse)
  check('export endpoint returns the envelope', exported.format === 'dsh-pomodoro-board' && exported.tasks === 5, exported)
  await openBoard(session)
  await session.eval(`document.querySelector('[aria-label="Board menu"]').click()`)
  await pause(250)
  await session.screenshot('board-menu')
  const fixture = await session.eval(`(() => {
    const board = { version: 1, id: 'imported', title: 'Importado E2E', createdAt: 1, updatedAt: 1,
      lists: [{ id: 'i-todo', title: 'Pendiente', position: 0, isDone: false }, { id: 'i-done', title: 'Hecho', position: 1, isDone: true }],
      labels: [{ id: 'i-lab', name: 'importada', color: 'green', createdAt: 1 }],
      tasks: [{ id: 'i-task', listId: 'i-todo', title: 'Tarea importada', notes: '', priority: 'medium', dueDate: null, estimateMin: 30, timeSpentMs: 0, pomodoros: 0, completedAt: null, position: 0, createdAt: 1, updatedAt: 1, labelIds: ['i-lab'], subtasks: [] }] }
    return JSON.stringify({ format: 'dsh-pomodoro-board', version: 1, board })
  })()`)
  // Deliver the fixture as a drop on the hidden file input.
  await session.eval(`(() => {
    const input = document.querySelector('.tb-panel input[type="file"]')
    const data = new DataTransfer()
    data.items.add(new File([${JSON.stringify(fixture)}], 'board.json', { type: 'application/json' }))
    input.files = data.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await session.waitFor(`document.querySelector('.tb-modal') !== null`, 8_000, 'import confirmation')
  await session.screenshot('board-import')
  await session.eval(`document.querySelector('.tb-modalFooter .tb-btn[data-variant="danger"]').click()`)
  await session.waitFor(`document.querySelector('.tb-modal') === null`, 15_000, 'import applied')
  await pause(700)
  board = await hostBoard(session)
  check('import replaces the board from JSON', board.title === 'Importado E2E' && board.tasks.length === 1 && board.labels.length === 1, { title: board.title, tasks: board.tasks.length })
  await session.send('Page.reload')
  await session.waitFor(`document.querySelector('.pomo-root') !== null`, 30_000, 'widget after import')
  await openBoard(session)
  check('imported board survives a reload', await session.eval(`document.querySelector('.tb-titleInput').value === 'Importado E2E'`))
  check('columns and cards expose ARIA semantics', await session.eval(`document.querySelectorAll('.tb-column[role="list"]').length === 2 && document.querySelector('.tb-card')?.getAttribute('role') === 'listitem'`))
  check('board keeps a polite live region', await session.eval(`document.querySelector('.tb-srOnly[role="status"]') !== null`))
  await session.screenshot('board-imported')

  // accessibility: composer focus trap
  await session.eval(`document.querySelector('.tb-newTaskBtn').click()`)
  await session.waitFor(`document.querySelector('.tb-modal') !== null`, 8_000, 'composer')
  check('composer traps focus inside the dialog', await session.eval(`(() => { const modal = document.querySelector('.tb-modal'); return modal !== null && modal.contains(document.activeElement) })()`))
  check('no page exceptions during the run', session.errors.length === 0, session.errors.slice(0, 2))
  // A crashed slot entry logs through console.error and unmounts the overlay.
  // Ignore the environment noise from blocking the platform sign-in redirect.
  const expectedNoise = /(platform\.deepseek\.com|deepseek\.com|ERR_BLOCKED_BY_CLIENT|ERR_NAME_NOT_RESOLVED|Failed to fetch|401|Unauthorized)/i
  const consoleErrors = session.consoleErrors.filter(text => !expectedNoise.test(text))
  check('no console errors during the run', consoleErrors.length === 0, consoleErrors.slice(0, 3))
  check('widget and board overlay are both mounted at the end', await session.eval(`document.querySelector('.pomo-root') !== null && document.querySelector('.tb-panel') !== null`))

  const failed = checks.filter(entry => !entry.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} board checks passed`)
  if (OUT.length > 0) console.log(`screenshots: ${resolve(OUT)}`)
  session.socket.close()
  process.exit(failed.length > 0 ? 1 : 0)
}

await main()
