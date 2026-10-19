/**
 * Task-board client state: the host API bridge plus observable snapshots.
 *
 * The board data lives in the host's SQLite database. This module is the only
 * writer: every mutation goes through `POST /api/pomodoro-board/command`, the
 * response replaces the snapshot, and other windows are told to refetch through
 * a BroadcastChannel. While the board is open a light revision poll catches
 * changes made by another window or by an import.
 *
 * Presentation state (active section, search, label filter, order) is per
 * window and persists in `localStorage`; board data itself never does.
 *
 * @module dsh-plugin-pomodoro/board-store
 */

/** Host routes this module talks to. */
export const BOARD_API = Object.freeze({
  state: '/api/pomodoro-board/state',
  revision: '/api/pomodoro-board/revision',
  command: '/api/pomodoro-board/command',
  export: '/api/pomodoro-board/export',
  import: '/api/pomodoro-board/import',
})

/** localStorage key for per-window presentation. */
export const BOARD_UI_KEY = 'dsh-plugin-pomodoro:board-ui:v1'

/** Defaults for the presentation store. */
export const BOARD_UI_DEFAULTS = Object.freeze({
  section: 'all',
  search: '',
  labelIds: [],
  estimateMode: 'all',
  sort: 'manual',
})

/** Cross-window change announcement. */
export const BOARD_CHANNEL = 'dsh-plugin-pomodoro-board'

/** localStorage key for measured focus time waiting to reach the host. */
export const PENDING_CREDITS_KEY = 'dsh-plugin-pomodoro:pending-credits:v1'

/**
 * Bridge the board UI uses to control the timer without importing the widget:
 * the widget installs `start(taskId, title)` and clears it on unmount.
 */
export const focusBridge = { start: null }

/** Observable "task currently focused by the timer" snapshot. */
export function createActiveTaskStore() {
  let snapshot = { taskId: null, title: null }
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /** Record the active task (or clear it with nulls). */
    set(taskId, title = null) {
      if (snapshot.taskId === taskId && snapshot.title === title) return
      snapshot = { taskId, title }
      for (const listener of [...listeners]) listener()
    },
  }
}

/** Singleton active-task store used by the bundle. */
export const activeTaskStore = createActiveTaskStore()

/** Typed transport failure the UI can word. */
export class BoardApiError extends Error {
  /**
   * @param {string} code - machine code (`offline`, `unknown-command`, `http-500`, …).
   * @param {string} message - safe human message.
   * @param {number} [status] - HTTP status when the host answered.
   */
  constructor(code, message, status = 0) {
    super(message)
    this.name = 'BoardApiError'
    this.code = code
    this.status = status
  }
}

/* ───────────────────────── local storage ─────────────────────── */

/** Read a JSON value, tolerating private mode and corruption. */
function readBoardStorage(key) {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    return raw === null || raw === undefined ? null : JSON.parse(raw)
  } catch {
    return null
  }
}

/** Write a JSON value, swallowing quota/private-mode failures. */
function writeBoardStorage(key, value) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value))
  } catch {
    /* presentation state is best effort */
  }
}

/* ────────────────────────── UI store ─────────────────────────── */

/** Coerce an untrusted presentation record into the canonical shape. */
function normalizeBoardUi(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const section = typeof source.section === 'string' ? source.section : BOARD_UI_DEFAULTS.section
  const search = typeof source.search === 'string' ? source.search : BOARD_UI_DEFAULTS.search
  const labelIds = Array.isArray(source.labelIds) ? source.labelIds.filter(id => typeof id === 'string') : []
  const estimateMode = source.estimateMode === 'open' ? 'open' : 'all'
  const sort = ['manual', 'due', 'priority', 'created'].includes(source.sort) ? source.sort : 'manual'
  return { section, search, labelIds, estimateMode, sort }
}

/**
 * Create the per-window presentation store.
 * @param {{storageKey?: string}} [options] - storage override for tests.
 * @returns {{getSnapshot: () => object, subscribe: Function, update: Function, reset: Function, isOpen: Function, setOpen: Function, toggleOpen: Function}} store.
 */
export function createBoardUiStore(options = {}) {
  const storageKey = options.storageKey ?? BOARD_UI_KEY
  let stored = readBoardStorage(storageKey)
  let snapshot = { ...normalizeBoardUi(stored), open: false }
  const listeners = new Set()
  const notify = () => { for (const listener of [...listeners]) listener() }
  const persist = () => {
    const { section, search, labelIds, estimateMode, sort } = snapshot
    writeBoardStorage(storageKey, { section, search, labelIds, estimateMode, sort })
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /** Merge presentation fields and persist them (never `open`). */
    update(patch) {
      const next = { ...snapshot, ...patch, open: snapshot.open }
      const normalized = normalizeBoardUi(next)
      snapshot = { ...normalized, open: snapshot.open }
      persist()
      notify()
    },
    reset() {
      snapshot = { ...normalizeBoardUi(null), open: snapshot.open }
      persist()
      notify()
    },
    isOpen: () => snapshot.open,
    setOpen(open) {
      if (snapshot.open === open) return
      snapshot = { ...snapshot, open }
      notify()
    },
    toggleOpen() { this.setOpen(!snapshot.open) },
  }
}

/** Singleton presentation store used by the bundle. */
export const boardUiStore = createBoardUiStore()

/* ───────────────────────── board store ───────────────────────── */

/** Empty snapshot before the first load. */
const EMPTY_SNAPSHOT = Object.freeze({ status: 'idle', error: null, revision: 0, board: null, syncedAt: 0 })

/**
 * Create the board data store.
 * @param {object} [options] - test seams (fetch, timers, channel, polling).
 * @returns {object} store with `getSnapshot`, `subscribe`, `open`, `close`,
 *   `load`, `refreshRevision`, `command`, convenience commands, `dispose`.
 */
export function createBoardStore(options = {}) {
  const fetchImpl = options.fetchImpl ?? (typeof fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)
  const now = options.now ?? Date.now
  const pollMs = options.pollMs ?? 3000
  const setIntervalFn = options.setInterval ?? ((fn, ms) => setInterval(fn, ms))
  const clearIntervalFn = options.clearInterval ?? (id => clearInterval(id))
  const channelFactory = options.createChannel ?? (name => (typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : null))
  const pendingKey = options.pendingKey ?? PENDING_CREDITS_KEY
  let flushing = false

  let snapshot = EMPTY_SNAPSHOT
  const listeners = new Set()
  let timer = null
  let channel = null

  const notify = () => { for (const listener of [...listeners]) listener() }
  const set = patch => {
    snapshot = { ...snapshot, ...patch }
    notify()
  }

  /** One JSON request against the board host. */
  async function request(path, init = {}) {
    if (fetchImpl === null) throw new BoardApiError('offline', 'the board host is unavailable in this window')
    let response
    try {
      response = await fetchImpl(path, { credentials: 'same-origin', ...init })
    } catch (error) {
      throw new BoardApiError('offline', error instanceof Error ? error.message : String(error))
    }
    const text = await response.text()
    let body = null
    if (text.length > 0) {
      try { body = JSON.parse(text) } catch {
        throw new BoardApiError('invalid-response', 'the board host returned an unreadable response', response.status)
      }
    }
    if (!response.ok) {
      const error = body !== null && typeof body === 'object' ? body.error : undefined
      throw new BoardApiError(
        typeof error?.code === 'string' ? error.code : `http-${response.status}`,
        typeof error?.message === 'string' ? error.message : `board request failed (${response.status})`,
        response.status,
      )
    }
    return body
  }

  function ensureChannel() {
    if (channel !== null) return
    try {
      channel = channelFactory(BOARD_CHANNEL)
      if (channel !== null) {
        channel.onmessage = () => {
          if (snapshot.status === 'ready') void refreshRevision()
        }
      }
    } catch {
      channel = null
    }
  }

  function startPolling() {
    if (timer !== null || pollMs <= 0) return
    timer = setIntervalFn(() => { void refreshRevision() }, pollMs)
  }

  function stopPolling() {
    if (timer === null) return
    clearIntervalFn(timer)
    timer = null
  }

  /** Fetch the whole board. */
  async function load() {
    set({ status: snapshot.board === null ? 'loading' : snapshot.status, error: null })
    try {
      const data = await request(BOARD_API.state)
      set({ status: 'ready', error: null, revision: data.revision, board: data.board, syncedAt: now() })
      void flushPendingCredits()
      return true
    } catch (error) {
      set({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  /** Refetch when another window (or an import) advanced the revision. */
  async function refreshRevision() {
    if (fetchImpl === null || snapshot.status !== 'ready') return
    try {
      const data = await request(BOARD_API.revision)
      if (typeof data?.revision === 'number' && data.revision !== snapshot.revision) {
        const full = await request(BOARD_API.state)
        set({ revision: full.revision, board: full.board, syncedAt: now(), error: null })
      }
    } catch {
      /* polling failures keep the current board; the next poll retries */
    }
  }

  /** Run one host command and adopt its board. */
  async function command(op, payload = {}) {
    try {
      const data = await request(BOARD_API.command, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, payload }),
      })
      set({ status: 'ready', revision: data.revision, board: data.board, syncedAt: now(), error: null })
      channel?.postMessage({ type: 'changed' })
      return { ok: true, changed: data.changed !== false, revision: data.revision }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
      return { ok: false, error }
    }
  }

  /* ── measured focus time ─────────────────────────────────────── */

  const readPending = () => {
    const raw = readBoardStorage(pendingKey)
    if (!Array.isArray(raw)) return []
    return raw.filter(entry => entry !== null && typeof entry === 'object'
      && typeof entry.taskId === 'string' && typeof entry.creditId === 'string'
      && Number.isFinite(Number(entry.deltaMs)))
  }
  const writePending = entries => writeBoardStorage(pendingKey, entries)

  /**
   * Send one measured focus credit. On transport failure the credit is queued
   * locally; credit ids make retries idempotent on the host.
   * @param {string} taskId - task to credit.
   * @param {string} creditId - stable segment identity.
   * @param {number} deltaMs - measured focus milliseconds.
   * @param {number} [pomodoros] - 1 when the phase completed.
   * @returns {Promise<{ok: boolean, error?: Error}>} outcome.
   */
  async function creditTime(taskId, creditId, deltaMs, pomodoros = 0) {
    const entry = { taskId, creditId, deltaMs: Math.max(0, Math.round(deltaMs)), pomodoros: pomodoros > 0 ? 1 : 0 }
    if (entry.deltaMs <= 0 && entry.pomodoros === 0) return { ok: true }
    const result = await command('task.addTime', entry)
    if (result.ok) {
      void flushPendingCredits()
      return { ok: true }
    }
    const pending = readPending()
    if (!pending.some(item => item.creditId === entry.creditId)) {
      pending.push(entry)
      writePending(pending)
    }
    return { ok: false, error: result.error }
  }

  /** Retry queued credits (called after a successful load/open). */
  async function flushPendingCredits() {
    if (flushing || fetchImpl === null) return
    const pending = readPending()
    if (pending.length === 0) return
    flushing = true
    try {
      const remaining = []
      for (const entry of pending) {
        const result = await command('task.addTime', entry)
        if (!result.ok) {
          const code = result.error instanceof BoardApiError ? result.error.code : ''
          if (code !== 'unknown-task') remaining.push(entry)
        }
      }
      writePending(remaining)
    } finally {
      flushing = false
    }
  }

  /* ── export / import ─────────────────────────────────────────── */

  /** Fetch the host's JSON export envelope. */
  async function exportJson() {
    return request(BOARD_API.export)
  }

  /** Replace the board from an export envelope (or a bare board). */
  async function replaceBoard(payload) {
    const body = payload !== null && typeof payload === 'object' && payload.format === 'dsh-pomodoro-board'
      ? payload
      : { board: payload }
    try {
      const data = await request(BOARD_API.import, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'replace', ...body }),
      })
      set({ status: 'ready', revision: data.revision, board: data.board, syncedAt: now(), error: null })
      channel?.postMessage({ type: 'changed' })
      return { ok: true, revision: data.revision }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
      return { ok: false, error }
    }
  }

  /** Trigger a JSON download through the browser (no-op outside a DOM). */
  async function downloadExport() {
    const envelope = await exportJson()
    if (typeof document === 'undefined' || typeof URL === 'undefined') return { ok: true }
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `pomodoro-board-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return { ok: true }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    open() {
      ensureChannel()
      startPolling()
      void flushPendingCredits()
      if (snapshot.status === 'ready') return Promise.resolve(true)
      return load()
    },
    creditTime,
    flushPendingCredits,
    getPendingCredits: () => readPending(),
    exportJson,
    replaceBoard,
    downloadExport,
    close() {
      stopPolling()
    },
    load,
    refreshRevision,
    command,
    clearError() { set({ error: null }) },
    dispose() {
      stopPolling()
      try { channel?.close() } catch { /* already closed */ }
      channel = null
    },

    /* Convenience commands used by the UI. */
    renameBoard(title) { return command('board.rename', { title }) },
    createList(title, isDone = false) { return command('list.create', { title, isDone }) },
    renameList(id, title) { return command('list.rename', { id, title }) },
    setListDone(id, isDone) { return command('list.setDone', { id, isDone }) },
    deleteList(id, moveTasksTo) { return command('list.delete', { id, moveTasksTo }) },
    createTask(listId, title, extra = {}) { return command('task.create', { listId, title, ...extra }) },
    updateTask(id, patch) { return command('task.update', { id, patch }) },
    moveTask(id, listId, position) {
      return command('task.move', position === undefined ? { id, listId } : { id, listId, position })
    },
    deleteTask(id) { return command('task.delete', { id }) },
    addSubtask(taskId, title) { return command('subtask.create', { taskId, title }) },
    updateSubtask(id, patch) { return command('subtask.update', { id, ...patch }) },
    deleteSubtask(id) { return command('subtask.delete', { id }) },
    toggleSubtask(subtaskId, done) { return command('subtask.update', { id: subtaskId, done }) },
    createLabel(name, color) { return command('label.create', { name, color }) },
    updateLabel(id, patch) { return command('label.update', { id, ...patch }) },
    deleteLabel(id) { return command('label.delete', { id }) },
    reorderLists(ids) { return command('list.reorder', { ids }) },
  }
}

/** Singleton board store used by the bundle. */
export const boardStore = createBoardStore()
