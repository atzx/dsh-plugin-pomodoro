/**
 * HTTP-contract tests for the host board API (`lib/api.js`).
 *
 * The handlers are driven with real `Request`/`Response` objects, exactly what
 * DSH's connection carrier passes to them, and a temporary SQLite file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BOARD_ROUTES, MAX_COMMAND_BYTES, createBoardHandlers } from '../lib/api.js'
import { closeBoardDatabase, openBoardDatabase, readBoard } from '../lib/db.js'

/** Fresh handler set + database in a temp dir. */
function fresh(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pomodoro-api-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const db = openBoardDatabase(join(dir, 'board.sqlite'))
  t.after(() => closeBoardDatabase(db))
  return { db, handlers: createBoardHandlers(db) }
}

/** Build a POST request for a handler. */
function post(path, body) {
  return new Request(`http://board${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** Build a GET request for a handler. */
const get = path => new Request(`http://board${path}`, { method: 'GET' })

/** Send one board command through the HTTP handler. */
async function command(handlers, op, payload = {}) {
  const response = await handlers.command(post(BOARD_ROUTES.command.path, { op, payload }))
  return { status: response.status, body: await response.json() }
}

test('route table exposes the five exact authenticated paths', () => {
  assert.deepEqual(Object.values(BOARD_ROUTES).map(route => route.path).sort(), [
    '/api/pomodoro-board/command',
    '/api/pomodoro-board/export',
    '/api/pomodoro-board/import',
    '/api/pomodoro-board/revision',
    '/api/pomodoro-board/state',
  ].sort())
  assert.deepEqual(BOARD_ROUTES.command.methods, ['POST'])
})

test('GET state returns revision and the seeded board', async t => {
  const { handlers } = fresh(t)
  const response = await handlers.state(get(BOARD_ROUTES.state.path))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.revision, 1)
  assert.equal(body.board.title, 'My board')
  assert.deepEqual(body.board.lists.map(list => list.title), ['To Do', 'Doing', 'Done'])
})

test('GET revision answers only the revision', async t => {
  const { handlers } = fresh(t)
  const body = await (await handlers.revision(get(BOARD_ROUTES.revision.path))).json()
  assert.deepEqual(body, { revision: 1 })
})

test('POST command creates a task and returns the fresh board', async t => {
  const { handlers } = fresh(t)
  const todo = (await (await handlers.state(get(BOARD_ROUTES.state.path))).json()).board.lists[0].id
  const result = await command(handlers, 'task.create', { listId: todo, title: 'desde API', estimateMin: 25 })
  assert.equal(result.status, 200)
  assert.equal(result.body.changed, true)
  assert.equal(result.body.revision, 2)
  assert.equal(result.body.board.tasks.length, 1)
  assert.equal(result.body.board.tasks[0].title, 'desde API')
})

test('command errors answer typed JSON with the right status', async t => {
  const { handlers } = fresh(t)

  const unknown = await command(handlers, 'nope.oops')
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.error.code, 'unknown-command')

  const badJson = await handlers.command(post(BOARD_ROUTES.command.path, '{not json'))
  assert.equal(badJson.status, 400)
  assert.equal((await badJson.json()).error.code, 'invalid-json')

  const empty = await handlers.command(post(BOARD_ROUTES.command.path, ''))
  assert.equal(empty.status, 400)
  assert.equal((await empty.json()).error.code, 'invalid-json')

  const missingTask = await command(handlers, 'task.move', { id: 'missing', listId: 'x' })
  assert.equal(missingTask.status, 404)
  assert.equal(missingTask.body.error.code, 'unknown-task')

  const badField = await command(handlers, 'task.create', { listId: 'missing', title: 'x' })
  assert.equal(badField.status, 404)
  assert.equal(badField.body.error.code, 'unknown-list')
})

test('wrong HTTP method is refused per route', async t => {
  const { handlers } = fresh(t)
  const response = await handlers.command(get(BOARD_ROUTES.command.path))
  assert.equal(response.status, 405)
  assert.equal((await response.json()).error.code, 'method-not-allowed')
})

test('an oversized command body is rejected before parsing', async t => {
  const { handlers } = fresh(t)
  const fake = {
    method: 'POST',
    headers: { get: name => (name === 'content-length' ? String(MAX_COMMAND_BYTES + 1) : null) },
    text: async () => '{}',
  }
  const response = await handlers.command(fake)
  assert.equal(response.status, 413)
  assert.equal((await response.json()).error.code, 'payload-too-large')
})

test('addTime is idempotent over HTTP', async t => {
  const { db, handlers } = fresh(t)
  const state = await (await handlers.state(get(BOARD_ROUTES.state.path))).json()
  const todo = state.board.lists[0].id
  const created = await command(handlers, 'task.create', { listId: todo, title: 'focus' })
  const id = created.body.board.tasks[0].id

  const first = await command(handlers, 'task.addTime', { taskId: id, creditId: 'http-credit', deltaMs: 1500, pomodoros: 1 })
  assert.equal(first.body.changed, true)
  const second = await command(handlers, 'task.addTime', { taskId: id, creditId: 'http-credit', deltaMs: 1500, pomodoros: 1 })
  assert.equal(second.body.changed, false)
  assert.equal(second.body.revision, first.body.revision)
  assert.equal(readBoard(db).tasks[0].timeSpentMs, 1500)
})

test('export answers a JSON attachment and import restores it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pomodoro-api-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const db = openBoardDatabase(join(dir, 'board.sqlite'))
  t.after(() => closeBoardDatabase(db))
  const handlers = createBoardHandlers(db)

  const todo = readBoard(db).lists[0].id
  await command(handlers, 'task.create', { listId: todo, title: 'exported', estimateMin: 45 })

  const exported = await handlers.export(get(BOARD_ROUTES.export.path))
  assert.equal(exported.status, 200)
  assert.match(exported.headers.get('content-disposition') ?? '', /attachment; filename="pomodoro-board-\d{4}-\d{2}-\d{2}\.json"/)
  const envelope = await exported.json()
  assert.equal(envelope.format, 'dsh-pomodoro-board')
  assert.equal(envelope.board.tasks.length, 1)

  await command(handlers, 'task.delete', { id: envelope.board.tasks[0].id })
  assert.equal(readBoard(db).tasks.length, 0)

  const imported = await handlers.import(post(BOARD_ROUTES.import.path, { mode: 'replace', board: envelope.board }))
  assert.equal(imported.status, 200)
  const result = await imported.json()
  assert.equal(result.board.tasks[0].title, 'exported')
  assert.equal(result.board.tasks[0].estimateMin, 45)

  const unsupported = await handlers.import(post(BOARD_ROUTES.import.path, { mode: 'merge', board: envelope.board }))
  assert.equal(unsupported.status, 400)
  assert.equal((await unsupported.json()).error.code, 'unsupported-import-mode')
})
