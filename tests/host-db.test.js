/**
 * Unit tests for the host-side board store (`lib/db.js`).
 *
 * Each test gets its own SQLite file in a temporary directory, so the suite is
 * parallel-safe and never touches a real DSH home.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  BoardError,
  LABEL_COLORS,
  LIMITS,
  applyBoardCommand,
  closeBoardDatabase,
  createBoardBackup,
  exportBoard,
  importBoard,
  openBoardDatabase,
  readBoard,
  readRevision,
} from '../lib/db.js'

/** Fresh database in a temp dir, removed after the test. */
function fresh(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pomodoro-db-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'board.sqlite')
  return { dir, file, db: openBoardDatabase(file) }
}

/** Shorthand for a command that must succeed. */
const run = (db, op, payload = {}) => applyBoardCommand(db, op, payload)

/** First list id by title. */
const listId = (db, title) => readBoard(db).lists.find(list => list.title === title).id

/** First label id by name. */
const labelId = (board, name) => board.labels.find(label => label.name === name).id

/** Ids of a task by title. */
const taskByTitle = (board, title) => board.tasks.find(task => task.title === title)

test('a fresh database seeds board metadata and the three default lists', t => {
  const { db } = fresh(t)
  const board = readBoard(db)
  assert.equal(board.version, 1)
  assert.equal(board.title, 'My board')
  assert.equal(readRevision(db), 1)
  assert.deepEqual(board.lists.map(list => list.title), ['To Do', 'Doing', 'Done'])
  assert.deepEqual(board.lists.map(list => list.isDone), [false, false, true])
  assert.deepEqual(board.tasks, [])
  assert.deepEqual(board.labels, [])
})

test('labels: create, rename, recolor and reject duplicates', t => {
  const { db } = fresh(t)
  run(db, 'label.create', { name: 'diseño', color: 'blue' })
  let board = readBoard(db)
  assert.equal(board.labels.length, 1)
  assert.equal(board.labels[0].name, 'diseño')
  assert.equal(board.labels[0].color, 'blue')

  run(db, 'label.update', { id: board.labels[0].id, name: 'design', color: 'purple' })
  board = readBoard(db)
  assert.equal(board.labels[0].name, 'design')
  assert.equal(board.labels[0].color, 'purple')

  assert.throws(
    () => run(db, 'label.create', { name: 'DESIGN', color: 'red' }),
    error => error instanceof BoardError && error.code === 'label-exists' && error.status === 409,
  )
  assert.throws(
    () => run(db, 'label.create', { name: 'nope', color: 'chartreuse' }),
    error => error instanceof BoardError && error.code === 'invalid-field',
  )
  assert.ok(LABEL_COLORS.includes('blue'))
})

test('tasks: create with labels, subtasks, due date and estimate', t => {
  const { db, } = fresh(t)
  run(db, 'label.create', { name: 'diseño', color: 'blue' })
  const label = readBoard(db).labels[0].id
  const todo = listId(db, 'To Do')
  run(db, 'task.create', {
    listId: todo,
    title: 'Diseñar pantalla',
    notes: 'Line one\nLine two',
    priority: 'high',
    labelIds: [label],
    dueDate: '2026-10-21',
    estimateMin: 90,
    subtasks: [{ title: 'Wireframe' }, { title: 'Mockup', done: true }],
  })
  const board = readBoard(db)
  const task = board.tasks[0]
  assert.equal(task.title, 'Diseñar pantalla')
  assert.equal(task.listId, todo)
  assert.equal(task.priority, 'high')
  assert.equal(task.notes, 'Line one\nLine two')
  assert.equal(task.dueDate, '2026-10-21')
  assert.equal(task.estimateMin, 90)
  assert.deepEqual(task.labelIds, [label])
  assert.deepEqual(task.subtasks.map(sub => sub.title), ['Wireframe', 'Mockup'])
  assert.equal(task.subtasks[1].done, true)
  assert.equal(task.completedAt, null)
  assert.equal(task.timeSpentMs, 0)
  assert.equal(task.pomodoros, 0)
})

test('task validation rejects bad fields and unknown references', t => {
  const { db } = fresh(t)
  const todo = listId(db, 'To Do')
  const cases = [
    [{ listId: todo, title: '' }, 'invalid-field'],
    [{ listId: 'missing', title: 'x' }, 'unknown-list'],
    [{ listId: todo, title: 'x', priority: 'urgent' }, 'invalid-field'],
    [{ listId: todo, title: 'x', dueDate: '2026-02-30' }, 'invalid-field'],
    [{ listId: todo, title: 'x', estimateMin: -5 }, 'invalid-field'],
    [{ listId: todo, title: 'x', labelIds: ['missing'] }, 'unknown-label'],
  ]
  for (const [payload, code] of cases) {
    assert.throws(() => run(db, 'task.create', payload), error => error instanceof BoardError && error.code === code, JSON.stringify(payload))
  }
})

test('completion follows done lists: move in completes, move out clears', t => {
  const { db } = fresh(t)
  const todo = listId(db, 'To Do')
  const done = listId(db, 'Done')
  run(db, 'task.create', { listId: todo, title: 'Ship it' })
  let task = readBoard(db).tasks[0]
  assert.equal(task.completedAt, null)
  const revisionBefore = readRevision(db)

  run(db, 'task.move', { id: task.id, listId: done })
  task = readBoard(db).tasks[0]
  assert.equal(typeof task.completedAt, 'number')
  assert.ok(readRevision(db) > revisionBefore)

  run(db, 'task.move', { id: task.id, listId: todo })
  task = readBoard(db).tasks[0]
  assert.equal(task.completedAt, null)
})

test('list.setDone completes and clears its tasks', t => {
  const { db } = fresh(t)
  const doing = listId(db, 'Doing')
  run(db, 'task.create', { listId: doing, title: 'A' })
  run(db, 'list.setDone', { id: doing, isDone: true })
  assert.equal(typeof readBoard(db).tasks[0].completedAt, 'number')
  run(db, 'list.setDone', { id: doing, isDone: false })
  assert.equal(readBoard(db).tasks[0].completedAt, null)
})

test('task.move reorders within a list', t => {
  const { db } = fresh(t)
  const todo = listId(db, 'To Do')
  for (const title of ['a', 'b', 'c']) run(db, 'task.create', { listId: todo, title })
  let board = readBoard(db)
  const c = taskByTitle(board, 'c')
  assert.deepEqual(board.tasks.map(task => task.title), ['a', 'b', 'c'])

  run(db, 'task.move', { id: c.id, listId: todo, position: 0 })
  board = readBoard(db)
  assert.deepEqual(board.tasks.map(task => task.title), ['c', 'a', 'b'])
  assert.deepEqual(board.tasks.map(task => task.position), [0, 1, 2])
})

test('list.reorder accepts exactly the full set', t => {
  const { db } = fresh(t)
  const ids = readBoard(db).lists.map(list => list.id).reverse()
  run(db, 'list.reorder', { ids })
  assert.deepEqual(readBoard(db).lists.map(list => list.title), ['Done', 'Doing', 'To Do'])
  assert.throws(
    () => run(db, 'list.reorder', { ids: ids.slice(0, 2) }),
    error => error instanceof BoardError && error.code === 'invalid-order',
  )
})

test('list.delete moves its tasks and protects the last done list', t => {
  const { db } = fresh(t)
  const todo = listId(db, 'To Do')
  const doing = listId(db, 'Doing')
  const done = listId(db, 'Done')
  run(db, 'task.create', { listId: todo, title: 'moved' })

  run(db, 'list.delete', { id: todo, moveTasksTo: done })
  const task = readBoard(db).tasks[0]
  assert.equal(task.listId, done)
  assert.equal(typeof task.completedAt, 'number', 'moving into Done completes')

  assert.throws(
    () => run(db, 'list.delete', { id: done, moveTasksTo: doing }),
    error => error instanceof BoardError && error.code === 'last-done-list',
  )
})

test('time credits are idempotent and bump the revision once', t => {
  const { db } = fresh(t)
  const todo = listId(db, 'To Do')
  run(db, 'task.create', { listId: todo, title: 'focus me' })
  const id = readBoard(db).tasks[0].id

  const first = run(db, 'task.addTime', { taskId: id, creditId: 'credit-1', deltaMs: 1_500_000, pomodoros: 1 })
  assert.equal(first.changed, true)
  const revisionAfterFirst = first.revision
  let task = readBoard(db).tasks[0]
  assert.equal(task.timeSpentMs, 1_500_000)
  assert.equal(task.pomodoros, 1)

  const duplicate = run(db, 'task.addTime', { taskId: id, creditId: 'credit-1', deltaMs: 1_500_000, pomodoros: 1 })
  assert.equal(duplicate.changed, false)
  assert.equal(duplicate.revision, revisionAfterFirst)
  task = readBoard(db).tasks[0]
  assert.equal(task.timeSpentMs, 1_500_000)

  const second = run(db, 'task.addTime', { taskId: id, creditId: 'credit-2', deltaMs: 60_000, pomodoros: 0 })
  assert.equal(second.changed, true)
  assert.equal(readBoard(db).tasks[0].timeSpentMs, 1_560_000)

  assert.throws(
    () => run(db, 'task.addTime', { taskId: id, creditId: 'credit-3' }),
    error => error instanceof BoardError && error.code === 'invalid-field',
  )
})

test('subtasks: create, update, delete', t => {
  const { db } = fresh(t)
  const todo = listId(db, 'To Do')
  run(db, 'task.create', { listId: todo, title: 'parent' })
  const task = readBoard(db).tasks[0]

  run(db, 'subtask.create', { taskId: task.id, title: 'one' })
  run(db, 'subtask.create', { taskId: task.id, title: 'two', done: true })
  let board = readBoard(db)
  assert.equal(board.tasks[0].subtasks.length, 2)

  const first = board.tasks[0].subtasks[0]
  run(db, 'subtask.update', { id: first.id, done: true, title: 'one!' })
  board = readBoard(db)
  assert.equal(board.tasks[0].subtasks[0].title, 'one!')
  assert.equal(board.tasks[0].subtasks[0].done, true)

  run(db, 'subtask.delete', { id: first.id })
  assert.deepEqual(readBoard(db).tasks[0].subtasks.map(sub => sub.title), ['two'])
})

test('deleting a task cascades its subtasks, links and credits', t => {
  const { db } = fresh(t)
  run(db, 'label.create', { name: 'x', color: 'gray' })
  const label = readBoard(db).labels[0].id
  const todo = listId(db, 'To Do')
  run(db, 'task.create', { listId: todo, title: 'child', labelIds: [label], subtasks: [{ title: 's' }] })
  const id = readBoard(db).tasks[0].id
  run(db, 'task.addTime', { taskId: id, creditId: 'c', deltaMs: 10 })
  run(db, 'task.delete', { id })
  assert.deepEqual(readBoard(db).tasks, [])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subtasks').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_labels').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM time_credits').get().n, 0)
})

test('export → import round-trips the whole board and bumps the revision', t => {
  const { db } = fresh(t)
  run(db, 'board.rename', { title: 'Trabajo' })
  run(db, 'label.create', { name: 'diseño', color: 'blue' })
  const label = readBoard(db).labels[0].id
  const todo = listId(db, 'To Do')
  run(db, 'task.create', { listId: todo, title: 'A', labelIds: [label], estimateMin: 30, subtasks: [{ title: 's' }] })
  const exported = exportBoard(db)
  assert.equal(exported.format, 'dsh-pomodoro-board')
  assert.equal(exported.version, 1)
  const snapshot = exported.board

  run(db, 'task.create', { listId: todo, title: 'B' })
  assert.equal(readBoard(db).tasks.length, 2)
  const revisionBeforeImport = readRevision(db)

  const result = importBoard(db, snapshot)
  assert.equal(result.revision, revisionBeforeImport + 1)
  assert.equal(result.board.title, 'Trabajo')
  assert.deepEqual(result.board.tasks.map(task => task.title), ['A'])
  assert.equal(result.board.tasks[0].estimateMin, 30)
  assert.equal(result.board.tasks[0].subtasks.length, 1)
  assert.equal(result.board.labels.length, 1)
})

test('import validates malformed snapshots before touching data', t => {
  const { db } = fresh(t)
  const todo = listId(db, 'To Do')
  const validList = { id: 'l1', title: 'L', isDone: false }
  const validTask = { id: 't1', listId: 'l1', title: 'T', priority: 'none' }
  const base = { version: 1, title: 'X', lists: [validList], labels: [], tasks: [validTask] }

  const cases = [
    [{ ...base, lists: [] }, 'invalid-import'],
    [{ ...base, tasks: [{ ...validTask, listId: 'missing' }] }, 'invalid-import'],
    [{ ...base, tasks: [{ ...validTask, priority: 'urgent' }] }, 'invalid-import'],
    [{ ...base, tasks: [validTask, validTask] }, 'invalid-import'],
    [{ ...base, version: 99 }, 'unsupported-schema'],
  ]
  for (const [snapshot, code] of cases) {
    assert.throws(() => importBoard(db, snapshot), error => error instanceof BoardError && error.code === code)
  }
  // Nothing was replaced by the rejected imports.
  assert.equal(readBoard(db).lists.length, 3)
  assert.equal(readBoard(db).tasks.length, 0)
  assert.equal(listId(db, 'To Do'), todo)
})

test('limits cap lists and tasks', t => {
  const { db } = fresh(t)
  const currentLists = readBoard(db).lists.length
  for (let index = currentLists; index < LIMITS.lists; index += 1) run(db, 'list.create', { title: `L${index}` })
  assert.throws(() => run(db, 'list.create', { title: 'one too many' }), error => error instanceof BoardError && error.code === 'too-many-lists')
})

test('reopening the same file preserves data without re-seeding', t => {
  const { db, file } = fresh(t)
  run(db, 'task.create', { listId: listId(db, 'To Do'), title: 'persisted' })
  const revision = readRevision(db)
  closeBoardDatabase(db)

  const reopened = openBoardDatabase(file)
  t.after(() => closeBoardDatabase(reopened))
  assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 1)
  assert.equal(readRevision(reopened), revision)
  assert.deepEqual(readBoard(reopened).tasks.map(task => task.title), ['persisted'])
  assert.equal(readBoard(reopened).lists.length, 3)
})

test('a database written by a newer schema is refused', t => {
  const { db, file } = fresh(t)
  closeBoardDatabase(db)
  const raw = new DatabaseSync(file)
  raw.exec('PRAGMA user_version = 99')
  raw.close()
  assert.throws(
    () => openBoardDatabase(file),
    error => error instanceof BoardError && error.code === 'unsupported-schema' && error.status === 409,
  )
})

test('backups rotate once per interval and keep a consistent copy', async t => {
  const { db, file } = fresh(t)
  run(db, 'task.create', { listId: listId(db, 'To Do'), title: 'backed up' })

  const day = 24 * 60 * 60 * 1000
  const first = await createBoardBackup(db, file, { keep: 3, intervalMs: day, now: 1_000_000_000_000 })
  assert.equal(first.created, true)
  assert.ok(existsSync(first.path))

  const skipped = await createBoardBackup(db, file, { keep: 3, intervalMs: day, now: 1_000_000_000_000 + 60_000 })
  assert.equal(skipped.created, false)

  const rotated = await createBoardBackup(db, file, { keep: 3, intervalMs: day, now: 1_000_000_000_000 + 2 * day })
  assert.equal(rotated.created, true)
  assert.ok(existsSync(`${first.path}.1`), 'previous backup kept as .bak.1')
  assert.ok(statSync(first.path).size > 0)

  const copy = new DatabaseSync(first.path, { readOnly: true })
  t.after(() => copy.close())
  assert.deepEqual(copy.prepare('SELECT title FROM tasks').all().map(row => row.title), ['backed up'])
})
