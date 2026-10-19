/**
 * Unit tests for the client board stores (`src/board-store.js`).
 *
 * `fetch`, timers, storage and the cross-window channel are injected, so the
 * tests never touch a real host, real time or real browser storage.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BOARD_API,
  BOARD_UI_DEFAULTS,
  BOARD_UI_KEY,
  BoardApiError,
  PENDING_CREDITS_KEY,
  activeTaskStore,
  createActiveTaskStore,
  createBoardStore,
  createBoardUiStore,
  focusBridge,
} from '../src/board-store.js'

const BOARD = { version: 1, id: 'b', title: 'Board', lists: [{ id: 'todo', title: 'To Do', position: 0, isDone: false }], labels: [], tasks: [] }

/** Fake fetch response. */
function reply(body, status = 200) {
  return { ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) }
}

/** Recording fetch that answers by route. */
function fetchStub(routes = {}) {
  const calls = []
  const impl = async (path, init) => {
    calls.push({ path, init })
    const handler = routes[path]
    if (handler === undefined) return reply({ error: { code: 'not-found', message: 'no route' } }, 404)
    return typeof handler === 'function' ? handler({ path, init }) : reply(handler)
  }
  impl.calls = calls
  return impl
}

/** Fake BroadcastChannel. */
function channelStub() {
  const instance = { messages: [], onmessage: null, postMessage(message) { this.messages.push(message) }, close() { this.closed = true } }
  return { instance, factory: () => instance }
}

/** In-memory localStorage. */
function storageStub(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
    dump: () => Object.fromEntries(map),
  }
}

test('load() adopts the host snapshot', async () => {
  const fetchImpl = fetchStub({ [BOARD_API.state]: { revision: 4, board: BOARD } })
  const store = createBoardStore({ fetchImpl, pollMs: 0 })
  assert.equal(store.getSnapshot().status, 'idle')

  assert.equal(await store.load(), true)
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.revision, 4)
  assert.equal(snapshot.board.title, 'Board')
  assert.equal(fetchImpl.calls[0].path, BOARD_API.state)
  assert.equal(fetchImpl.calls[0].init.credentials, 'same-origin')
})

test('load() surfaces host failures without losing the previous board', async () => {
  const fetchImpl = fetchStub({
    [BOARD_API.state]: async () => reply({ error: { code: 'internal', message: 'board operation failed' } }, 500),
  })
  const store = createBoardStore({ fetchImpl, pollMs: 0 })
  assert.equal(await store.load(), false)
  assert.equal(store.getSnapshot().status, 'error')
  assert.match(store.getSnapshot().error, /board operation failed/)
})

test('command() posts the op and adopts the returned board', async () => {
  const updated = { revision: 5, changed: true, board: { ...BOARD, title: 'Renamed' } }
  const fetchImpl = fetchStub({ [BOARD_API.command]: updated })
  const { instance, factory } = channelStub()
  const store = createBoardStore({ fetchImpl, pollMs: 0, createChannel: factory })
  await store.load()

  const result = await store.renameBoard('Renamed')
  assert.deepEqual(result, { ok: true, changed: true, revision: 5 })
  assert.equal(store.getSnapshot().revision, 5)
  assert.equal(store.getSnapshot().board.title, 'Renamed')

  const call = fetchImpl.calls.at(-1)
  assert.equal(call.path, BOARD_API.command)
  assert.equal(call.init.method, 'POST')
  assert.deepEqual(JSON.parse(call.init.body), { op: 'board.rename', payload: { title: 'Renamed' } })
  assert.equal(instance.messages.length, 0, 'channel exists only after open()')
})

test('command() failures keep the board and report the host message', async () => {
  const fetchImpl = fetchStub({
    [BOARD_API.state]: { revision: 1, board: BOARD },
    [BOARD_API.command]: async () => reply({ error: { code: 'unknown-task', message: 'task not found' } }, 404),
  })
  const store = createBoardStore({ fetchImpl, pollMs: 0 })
  await store.load()
  const result = await store.updateTask('missing', { title: 'x' })
  assert.equal(result.ok, false)
  assert.ok(result.error instanceof BoardApiError)
  assert.equal(result.error.code, 'unknown-task')
  assert.equal(store.getSnapshot().board.title, 'Board')
  assert.match(store.getSnapshot().error, /task not found/)
  store.clearError()
  assert.equal(store.getSnapshot().error, null)
})

test('an unavailable fetch makes the store offline, not broken', async () => {
  const store = createBoardStore({ fetchImpl: null, pollMs: 0 })
  assert.equal(await store.load(), false)
  assert.equal(store.getSnapshot().status, 'error')
  const result = await store.createTask('todo', 'x')
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'offline')
})

test('polling picks up a newer revision and refreshes the board', async () => {
  let revision = 1
  const fetchImpl = fetchStub({
    [BOARD_API.revision]: () => reply({ revision }),
    [BOARD_API.state]: () => reply({ revision, board: { ...BOARD, title: `Rev ${revision}` } }),
  })
  const store = createBoardStore({ fetchImpl, pollMs: 0 })
  await store.load()
  assert.equal(store.getSnapshot().board.title, 'Rev 1')

  revision = 2
  await store.refreshRevision()
  assert.equal(store.getSnapshot().revision, 2)
  assert.equal(store.getSnapshot().board.title, 'Rev 2')

  // Same revision → no second state read.
  const stateReads = fetchImpl.calls.filter(call => call.path === BOARD_API.state).length
  await store.refreshRevision()
  assert.equal(fetchImpl.calls.filter(call => call.path === BOARD_API.state).length, stateReads)
})

test('open() starts polling, close() stops it and dispose() closes the channel', async () => {
  const intervals = []
  const cleared = []
  const fetchImpl = fetchStub({ [BOARD_API.state]: { revision: 1, board: BOARD } })
  const { instance, factory } = channelStub()
  const store = createBoardStore({
    fetchImpl,
    pollMs: 3000,
    createChannel: factory,
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return 42 },
    clearInterval: id => { cleared.push(id) },
  })

  await store.open()
  assert.equal(store.getSnapshot().status, 'ready')
  assert.equal(intervals.length, 1)
  assert.equal(intervals[0].ms, 3000)
  assert.ok(instance.onmessage, 'channel listener installed')

  // A cross-window announcement asks for a revision refresh.
  const fetchImpl2 = fetchImpl
  instance.onmessage({ data: { type: 'changed' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(fetchImpl2.calls.some(call => call.path === BOARD_API.revision))

  store.close()
  assert.deepEqual(cleared, [42])
  store.dispose()
  assert.equal(instance.closed, true)
})

test('convenience commands map to the host operations', async () => {
  const fetchImpl = fetchStub({ [BOARD_API.command]: { revision: 2, board: BOARD } })
  const store = createBoardStore({ fetchImpl, pollMs: 0 })
  await store.load()
  const sent = () => JSON.parse(fetchImpl.calls.at(-1).init.body)

  await store.createTask('todo', 'New', { priority: 'high' })
  assert.deepEqual(sent(), { op: 'task.create', payload: { listId: 'todo', title: 'New', priority: 'high' } })

  await store.moveTask('t1', 'done')
  assert.deepEqual(sent(), { op: 'task.move', payload: { id: 't1', listId: 'done' } })

  await store.moveTask('t1', 'done', 0)
  assert.deepEqual(sent(), { op: 'task.move', payload: { id: 't1', listId: 'done', position: 0 } })

  await store.deleteList('l1', 'l2')
  assert.deepEqual(sent(), { op: 'list.delete', payload: { id: 'l1', moveTasksTo: 'l2' } })

  await store.toggleSubtask('s1', true)
  assert.deepEqual(sent(), { op: 'subtask.update', payload: { id: 's1', done: true } })

  await store.addSubtask('t1', 'child')
  assert.deepEqual(sent(), { op: 'subtask.create', payload: { taskId: 't1', title: 'child' } })

  await store.updateSubtask('s1', { title: 'renamed' })
  assert.deepEqual(sent(), { op: 'subtask.update', payload: { id: 's1', title: 'renamed' } })

  await store.deleteSubtask('s1')
  assert.deepEqual(sent(), { op: 'subtask.delete', payload: { id: 's1' } })

  await store.createLabel('diseño', 'blue')
  assert.deepEqual(sent(), { op: 'label.create', payload: { name: 'diseño', color: 'blue' } })

  await store.updateLabel('l1', { color: 'red' })
  assert.deepEqual(sent(), { op: 'label.update', payload: { id: 'l1', color: 'red' } })

  await store.deleteLabel('l1')
  assert.deepEqual(sent(), { op: 'label.delete', payload: { id: 'l1' } })
})

test('presentation store defaults, persists view (not open) and resets', () => {
  const storage = storageStub()
  const store = createBoardUiStore({ storageKey: 'ui-test' })
  // Swap in the fake storage: the store reads through globalThis.localStorage.
  const previous = globalThis.localStorage
  globalThis.localStorage = storage
  try {
    const fresh = createBoardUiStore({ storageKey: 'ui-test' })
    assert.deepEqual(fresh.getSnapshot(), { ...BOARD_UI_DEFAULTS, open: false })

    fresh.update({ section: 'today', search: 'diseño', labelIds: ['l1'], estimateMode: 'open', sort: 'due' })
    assert.equal(fresh.getSnapshot().section, 'today')
    assert.deepEqual(JSON.parse(storage.dump()['ui-test']), {
      section: 'today', search: 'diseño', labelIds: ['l1'], estimateMode: 'open', sort: 'due',
    })
    assert.equal(JSON.parse(storage.dump()['ui-test']).open, undefined)

    fresh.setOpen(true)
    assert.equal(fresh.getSnapshot().open, true)
    assert.equal(JSON.parse(storage.dump()['ui-test']).open, undefined)

    fresh.reset()
    assert.deepEqual(fresh.getSnapshot(), { ...BOARD_UI_DEFAULTS, open: true })

    // A second store reads the persisted record.
    fresh.update({ sort: 'priority' })
    const reread = createBoardUiStore({ storageKey: 'ui-test' })
    assert.equal(reread.getSnapshot().sort, 'priority')
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
    store.dispose?.()
  }
  assert.equal(BOARD_UI_KEY, 'dsh-plugin-pomodoro:board-ui:v1')
})

test('invalid persisted presentation values fall back to defaults', () => {
  const storage = storageStub({ bad: JSON.stringify({ section: 42, labelIds: 'nope', estimateMode: 'x', sort: 'bogus' }) })
  const previous = globalThis.localStorage
  globalThis.localStorage = storage
  try {
    const store = createBoardUiStore({ storageKey: 'bad' })
    assert.deepEqual(store.getSnapshot(), { ...BOARD_UI_DEFAULTS, open: false })
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
})

test('active-task store publishes task changes', () => {
  const store = createActiveTaskStore()
  const seen = []
  const off = store.subscribe(() => seen.push(store.getSnapshot()))
  assert.deepEqual(store.getSnapshot(), { taskId: null, title: null })
  store.set('t1', 'Write')
  store.set('t1', 'Write')
  store.set(null, null)
  assert.deepEqual(seen, [{ taskId: 't1', title: 'Write' }, { taskId: null, title: null }])
  off()
  store.set('t2', 'Ignored')
  assert.equal(seen.length, 2)
  assert.deepEqual(activeTaskStore.getSnapshot(), { taskId: null, title: null })
  assert.equal(focusBridge.start, null)
})

test('creditTime sends a measured segment and never queues a zero credit', async () => {
  const fetchImpl = fetchStub({
    [BOARD_API.command]: { revision: 3, changed: true, board: BOARD },
  })
  const store = createBoardStore({ fetchImpl, pollMs: 0 })
  const result = await store.creditTime('t1', 'credit-1', 1500, 1)
  assert.equal(result.ok, true)
  await new Promise(resolve => setImmediate(resolve))
  const sent = JSON.parse(fetchImpl.calls.find(call => call.path === BOARD_API.command).init.body)
  assert.deepEqual(sent, { op: 'task.addTime', payload: { taskId: 't1', creditId: 'credit-1', deltaMs: 1500, pomodoros: 1 } })

  const zero = await store.creditTime('t1', 'credit-zero', 0, 0)
  assert.equal(zero.ok, true)
  assert.equal(fetchImpl.calls.filter(call => call.path === BOARD_API.command).length, 1)
})

test('a failed credit is queued and flushed later', async () => {
  let failing = true
  const fetchImpl = async path => {
    if (path !== BOARD_API.command) return reply({ error: { code: 'not-found', message: 'no route' } }, 404)
    return failing
      ? reply({ error: { code: 'offline', message: 'host down' } }, 500)
      : reply({ revision: 4, changed: true, board: BOARD })
  }
  const storage = storageStub()
  const previous = globalThis.localStorage
  globalThis.localStorage = storage
  try {
    const store = createBoardStore({ fetchImpl, pollMs: 0, pendingKey: 'pending-test' })
    const failed = await store.creditTime('t1', 'credit-offline', 900, 0)
    assert.equal(failed.ok, false)
    const pending = store.getPendingCredits()
    assert.equal(pending.length, 1)
    assert.deepEqual(pending[0], { taskId: 't1', creditId: 'credit-offline', deltaMs: 900, pomodoros: 0 })

    failing = false
    await store.flushPendingCredits()
    assert.deepEqual(store.getPendingCredits(), [])
    assert.equal(JSON.parse(storage.dump()['pending-test']).length, 0)
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
})

test('flushing drops credits for tasks that no longer exist', async () => {
  const storage = storageStub({
    pending: JSON.stringify([{ taskId: 'gone', creditId: 'c', deltaMs: 10, pomodoros: 0 }]),
  })
  const fetchImpl = fetchStub({
    [BOARD_API.command]: async () => reply({ error: { code: 'unknown-task', message: 'no task' } }, 404),
  })
  const previous = globalThis.localStorage
  globalThis.localStorage = storage
  try {
    const store = createBoardStore({ fetchImpl, pollMs: 0, pendingKey: 'pending' })
    await store.flushPendingCredits()
    assert.deepEqual(store.getPendingCredits(), [])
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
})

test('opening the board flushes queued credits', async () => {
  const storage = storageStub({
    pending: JSON.stringify([{ taskId: 't1', creditId: 'queued', deltaMs: 5, pomodoros: 0 }]),
  })
  const fetchImpl = fetchStub({
    [BOARD_API.state]: { revision: 1, board: BOARD },
    [BOARD_API.command]: { revision: 2, changed: true, board: BOARD },
  })
  const previous = globalThis.localStorage
  globalThis.localStorage = storage
  try {
    const store = createBoardStore({ fetchImpl, pollMs: 0, pendingKey: 'pending' })
    await store.open()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(store.getPendingCredits(), [])
    assert.ok(fetchImpl.calls.some(call => call.path === BOARD_API.command))
    store.dispose()
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
})
