/**
 * Board persistence for the Pomodoro task board (host half).
 *
 * One SQLite database per DSH home holds one board: lists (Trello-style
 * columns), labels, tasks, subtasks, task↔label links and the focus-time
 * credits that make `task.addTime` idempotent.
 *
 * The layer is deliberately framework-free: it takes an open `DatabaseSync`
 * and plain payloads, so the HTTP layer (`api.js`) and the unit tests can drive
 * the exact same semantics. Every mutation runs in one transaction, bumps the
 * board revision exactly once, and returns the board the client should render.
 *
 * @module dsh-plugin-pomodoro/db
 */
import { randomUUID } from 'node:crypto'
import { renameSync } from 'node:fs'
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite'

/** Schema version this build writes and accepts. */
export const BOARD_SCHEMA_VERSION = 1

/** Ordered priorities; `none` is the default. */
export const PRIORITIES = Object.freeze(['none', 'low', 'medium', 'high'])

/** Label colors the UI can render accessibly in both themes. */
export const LABEL_COLORS = Object.freeze([
  'gray', 'blue', 'green', 'teal', 'yellow', 'orange', 'red', 'pink', 'purple', 'brown',
])

/** Hard limits enforced by the host so a client cannot grow the board unbounded. */
export const LIMITS = Object.freeze({
  tasks: 500,
  lists: 20,
  labels: 50,
  subtasksPerTask: 100,
  creditsPerTask: 5000,
  titleLength: 500,
  notesLength: 20000,
  labelNameLength: 60,
  listTitleLength: 120,
  estimateMin: [0, 10080],
  deltaMs: [0, 86_400_000],
})

/** One typed failure the HTTP layer maps to a JSON error response. */
export class BoardError extends Error {
  /**
   * @param {string} code - stable machine code returned to the client.
   * @param {string} message - human-readable, safe to surface.
   * @param {number} [status] - HTTP status the API should answer with.
   * @param {object} [details] - optional structured context.
   */
  constructor(code, message, status = 400, details = undefined) {
    super(message)
    this.name = 'BoardError'
    this.code = code
    this.status = status
    if (details !== undefined) this.details = details
  }
}

const nowMs = () => Date.now()

/* ─────────────────────────── metadata ─────────────────────────── */

/** Read one `meta` value. */
function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
  return row === undefined ? undefined : row.value
}

/** Write one `meta` value. */
function setMeta(db, key, value) {
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value))
}

/** Current persisted revision. */
export function readRevision(db) {
  const value = Number(getMeta(db, 'revision') ?? '0')
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** Advance the revision and the board's updated timestamp. */
function bumpRevision(db, at = nowMs()) {
  const revision = readRevision(db) + 1
  setMeta(db, 'revision', revision)
  setMeta(db, 'updated_at', at)
  return revision
}

/** Run one synchronous transaction, rolling back on any throw. */
function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* transaction already gone */ }
    throw error
  }
}

/* ──────────────────────── schema + migrations ──────────────────── */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  position INTEGER NOT NULL,
  is_done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE,
  color TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS labels_name_unique ON labels(name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'none' CHECK (priority IN ('none','low','medium','high')),
  due_date TEXT,
  estimate_min INTEGER,
  time_spent_ms INTEGER NOT NULL DEFAULT 0,
  pomodoros INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS subtasks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_labels (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);
CREATE TABLE IF NOT EXISTS time_credits (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  delta_ms INTEGER NOT NULL,
  pomodoros INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_by_list_position ON tasks(list_id, position);
CREATE INDEX IF NOT EXISTS tasks_by_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS tasks_by_completed_at ON tasks(completed_at);
CREATE INDEX IF NOT EXISTS subtasks_by_task_position ON subtasks(task_id, position);
CREATE INDEX IF NOT EXISTS time_credits_by_task ON time_credits(task_id);
`

/** Insert the three default lists plus board metadata for a fresh database. */
function seedBoard(db, at) {
  setMeta(db, 'board_id', randomUUID())
  setMeta(db, 'board_title', 'My board')
  setMeta(db, 'created_at', at)
  setMeta(db, 'updated_at', at)
  setMeta(db, 'revision', 1)
  const insert = db.prepare(`INSERT INTO lists (id, title, position, is_done, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
  insert.run(randomUUID(), 'To Do', 0, 0, at, at)
  insert.run(randomUUID(), 'Doing', 1, 0, at, at)
  insert.run(randomUUID(), 'Done', 2, 1, at, at)
}

/**
 * Apply migrations. Version 1 is the initial schema; a database written by a
 * newer build is refused read-only rather than downgraded or erased.
 */
function migrate(db) {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
  if (version > BOARD_SCHEMA_VERSION) {
    throw new BoardError(
      'unsupported-schema',
      `board schema v${version} is newer than this plugin supports (v${BOARD_SCHEMA_VERSION})`,
      409,
    )
  }
  if (version === 0) {
    const at = nowMs()
    transaction(db, () => {
      db.exec(SCHEMA_SQL)
      seedBoard(db, at)
    })
    db.exec(`PRAGMA user_version = ${BOARD_SCHEMA_VERSION}`)
  }
}

/**
 * Open (and migrate) the board database.
 * @param {string} filePath - absolute SQLite file path; parent must exist.
 * @returns {DatabaseSync} open handle.
 */
export function openBoardDatabase(filePath) {
  const db = new DatabaseSync(filePath)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  migrate(db)
  return db
}

/** Checkpoint and close the handle, tolerating repeated closes. */
export function closeBoardDatabase(db) {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* best effort */ }
  try { db.close() } catch { /* already closed */ }
}

/* ─────────────────────────── reading ──────────────────────────── */

/** Row → API list shape. */
const mapList = row => ({
  id: row.id,
  title: row.title,
  position: row.position,
  isDone: row.is_done === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

/** Row → API label shape. */
const mapLabel = row => ({ id: row.id, name: row.name, color: row.color, createdAt: row.created_at })

/** Row → API subtask shape. */
const mapSubtask = row => ({
  id: row.id,
  taskId: row.task_id,
  title: row.title,
  done: row.done === 1,
  position: row.position,
  createdAt: row.created_at,
})

/** Row → API task shape, before labels/subtasks are attached. */
const mapTask = row => ({
  id: row.id,
  listId: row.list_id,
  title: row.title,
  notes: row.notes,
  priority: row.priority,
  dueDate: row.due_date,
  estimateMin: row.estimate_min,
  timeSpentMs: row.time_spent_ms,
  pomodoros: row.pomodoros,
  completedAt: row.completed_at,
  position: row.position,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  labelIds: [],
  subtasks: [],
})

/**
 * Read the whole board as the client-facing snapshot.
 * @param {DatabaseSync} db - open board database.
 * @returns {object} board (without revision; the API adds it).
 */
export function readBoard(db) {
  const lists = db.prepare('SELECT * FROM lists ORDER BY position ASC, id ASC').all().map(mapList)
  const labels = db.prepare('SELECT * FROM labels ORDER BY name ASC, id ASC').all().map(mapLabel)
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY list_id ASC, position ASC, id ASC').all().map(mapTask)
  const byId = new Map(tasks.map(task => [task.id, task]))

  for (const row of db.prepare('SELECT task_id, label_id FROM task_labels').all()) {
    byId.get(row.task_id)?.labelIds.push(row.label_id)
  }
  for (const row of db.prepare('SELECT * FROM subtasks ORDER BY task_id ASC, position ASC, id ASC').all()) {
    byId.get(row.task_id)?.subtasks.push(mapSubtask(row))
  }
  return {
    version: BOARD_SCHEMA_VERSION,
    id: getMeta(db, 'board_id'),
    title: getMeta(db, 'board_title') ?? 'My board',
    createdAt: Number(getMeta(db, 'created_at') ?? 0),
    updatedAt: Number(getMeta(db, 'updated_at') ?? 0),
    lists,
    labels,
    tasks,
  }
}

/* ───────────────────────── validation ─────────────────────────── */

const TEXT_LIMITS = { title: LIMITS.titleLength, notes: LIMITS.notesLength, list: LIMITS.listTitleLength, label: LIMITS.labelNameLength }

/** Require a non-blank bounded string. */
function requireText(value, field, max) {
  if (typeof value !== 'string') throw new BoardError('invalid-field', `${field} must be a string`, 400, { field })
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new BoardError('invalid-field', `${field} must not be empty`, 400, { field })
  if (value.length > max) throw new BoardError('invalid-field', `${field} exceeds ${max} characters`, 400, { field })
  return trimmed
}

/** Optional bounded string; `null`/`undefined` become the fallback. */
function optionalText(value, field, max, fallback = '') {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new BoardError('invalid-field', `${field} must be a string`, 400, { field })
  if (value.length > max) throw new BoardError('invalid-field', `${field} exceeds ${max} characters`, 400, { field })
  return value
}

/** Require a known enum member. */
function requireEnum(value, field, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new BoardError('invalid-field', `${field} must be one of ${allowed.join(', ')}`, 400, { field })
  }
  return value
}

/** Optional boolean. */
function optionalBool(value, field, fallback = false) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new BoardError('invalid-field', `${field} must be a boolean`, 400, { field })
  return value
}

/** Optional non-negative integer (or `null` to clear). */
function optionalInteger(value, field, range) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < range[0] || value > range[1]) {
    throw new BoardError('invalid-field', `${field} must be an integer between ${range[0]} and ${range[1]}`, 400, { field })
  }
  return value
}

/** Optional civil date `YYYY-MM-DD` (or `null` to clear). */
function optionalDate(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BoardError('invalid-field', `${field} must be YYYY-MM-DD`, 400, { field })
  }
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new BoardError('invalid-field', `${field} is not a real calendar date`, 400, { field })
  }
  return value
}

/** Optional ordered list of ids. */
function requireIdList(value, field, max) {
  if (!Array.isArray(value)) throw new BoardError('invalid-field', `${field} must be an array`, 400, { field })
  if (value.length > max) throw new BoardError('invalid-field', `${field} has too many ids`, 400, { field })
  const unique = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) throw new BoardError('invalid-field', `${field} contains an invalid id`, 400, { field })
    if (!unique.includes(item)) unique.push(item)
  }
  return unique
}

/* ─────────────────────── lookups + invariants ──────────────────── */

/** Require one row by id, or throw a 404-coded failure. */
function requireRow(db, table, id, code) {
  if (typeof id !== 'string' || id.length === 0) throw new BoardError('invalid-field', 'id must be a string', 400, { field: 'id' })
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)
  if (row === undefined) throw new BoardError(code, `${table.slice(0, -1)} not found: ${id}`, 404, { id })
  return row
}

/** Require a list row. */
const requireList = (db, id) => requireRow(db, 'lists', id, 'unknown-list')

/** Require a task row. */
const requireTask = (db, id) => requireRow(db, 'tasks', id, 'unknown-task')

/** Append position at the end of a list. */
function endPosition(db, listId) {
  const row = db.prepare('SELECT COALESCE(MAX(position), -1) AS max FROM tasks WHERE list_id = ?').get(listId)
  return Number(row.max) + 1
}

/** Rewrite list positions to a dense 0..n-1 order. */
function reindexList(db, listId) {
  const rows = db.prepare('SELECT id FROM tasks WHERE list_id = ? ORDER BY position ASC, id ASC').all()
  const update = db.prepare('UPDATE tasks SET position = ? WHERE id = ?')
  rows.forEach((row, index) => update.run(index, row.id))
}

/** Apply the completion invariant for a task entering a list. */
function completionFor(list, currentCompletedAt, at) {
  if (list.is_done === 1) return currentCompletedAt ?? at
  return null
}

/** Validate label ids exist and return them. */
function validateLabels(db, labelIds) {
  if (labelIds.length === 0) return []
  const found = new Set(db.prepare(`SELECT id FROM labels WHERE id IN (${labelIds.map(() => '?').join(', ')})`).all(...labelIds).map(row => row.id))
  const missing = labelIds.filter(id => !found.has(id))
  if (missing.length > 0) throw new BoardError('unknown-label', `unknown label: ${missing[0]}`, 404, { id: missing[0] })
  return labelIds
}

/** Insert the task↔label links for a task. */
function writeTaskLabels(db, taskId, labelIds) {
  db.prepare('DELETE FROM task_labels WHERE task_id = ?').run(taskId)
  const insert = db.prepare('INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)')
  for (const labelId of labelIds) insert.run(taskId, labelId)
}

/* ────────────────────────── commands ──────────────────────────── */

/** Insert a task row and its subtasks/labels; shared by create and import. */
function insertTask(db, payload, at) {
  const list = requireList(db, payload.listId)
  const title = requireText(payload.title, 'title', TEXT_LIMITS.title)
  const notes = optionalText(payload.notes, 'notes', TEXT_LIMITS.notes, '')
  const priority = payload.priority === undefined ? 'none' : requireEnum(payload.priority, 'priority', PRIORITIES)
  const dueDate = optionalDate(payload.dueDate, 'dueDate')
  const estimateMin = optionalInteger(payload.estimateMin, 'estimateMin', LIMITS.estimateMin)
  const labelIds = validateLabels(db, requireIdList(payload.labelIds ?? [], 'labelIds', LIMITS.labels))
  const subtasks = payload.subtasks === undefined ? [] : payload.subtasks
  if (!Array.isArray(subtasks)) throw new BoardError('invalid-field', 'subtasks must be an array', 400, { field: 'subtasks' })
  if (subtasks.length > LIMITS.subtasksPerTask) throw new BoardError('too-many-subtasks', `at most ${LIMITS.subtasksPerTask} subtasks per task`, 400)

  const count = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n
  if (Number(count) >= LIMITS.tasks) throw new BoardError('too-many-tasks', `at most ${LIMITS.tasks} tasks`, 409)
  const id = randomUUID()
  const completedAt = completionFor(list, null, at)
  db.prepare(`INSERT INTO tasks
    (id, list_id, title, notes, priority, due_date, estimate_min, time_spent_ms, pomodoros, completed_at, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`)
    .run(id, list.id, title, notes, priority, dueDate, estimateMin, completedAt, endPosition(db, list.id), at, at)
  writeTaskLabels(db, id, labelIds)

  const insertSubtask = db.prepare(`INSERT INTO subtasks (id, task_id, title, done, position, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
  subtasks.forEach((subtask, index) => {
    if (subtask === null || typeof subtask !== 'object') throw new BoardError('invalid-field', 'subtasks entries must be objects', 400)
    const subTitle = requireText(subtask.title, 'subtask.title', TEXT_LIMITS.title)
    insertSubtask.run(randomUUID(), id, subTitle, subtask.done === true ? 1 : 0, index, at)
  })
  return id
}

/** Command table: op name → mutating handler returning `{ changed? }`. */
const COMMANDS = {
  'board.rename'(db, payload) {
    setMeta(db, 'board_title', requireText(payload.title, 'title', TEXT_LIMITS.title))
  },

  'list.create'(db, payload, at) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM lists').get().n
    if (Number(count) >= LIMITS.lists) throw new BoardError('too-many-lists', `at most ${LIMITS.lists} lists`, 409)
    const position = Number(db.prepare('SELECT COALESCE(MAX(position), -1) AS max FROM lists').get().max) + 1
    db.prepare('INSERT INTO lists (id, title, position, is_done, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), requireText(payload.title, 'title', TEXT_LIMITS.list), position, optionalBool(payload.isDone, 'isDone') ? 1 : 0, at, at)
  },

  'list.rename'(db, payload, at) {
    const list = requireList(db, payload.id)
    db.prepare('UPDATE lists SET title = ?, updated_at = ? WHERE id = ?')
      .run(requireText(payload.title, 'title', TEXT_LIMITS.list), at, list.id)
  },

  'list.reorder'(db, payload, at) {
    const ids = requireIdList(payload.ids, 'ids', LIMITS.lists)
    const existing = db.prepare('SELECT id FROM lists').all().map(row => row.id)
    const sameSet = existing.length === ids.length && existing.every(id => ids.includes(id))
    if (!sameSet) throw new BoardError('invalid-order', 'ids must contain every list exactly once', 400)
    const update = db.prepare('UPDATE lists SET position = ?, updated_at = ? WHERE id = ?')
    ids.forEach((id, index) => update.run(index, at, id))
  },

  'list.setDone'(db, payload, at) {
    const list = requireList(db, payload.id)
    const isDone = optionalBool(payload.isDone, 'isDone')
    db.prepare('UPDATE lists SET is_done = ?, updated_at = ? WHERE id = ?').run(isDone ? 1 : 0, at, list.id)
    if (isDone) db.prepare('UPDATE tasks SET completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE list_id = ?').run(at, at, list.id)
    else db.prepare('UPDATE tasks SET completed_at = NULL, updated_at = ? WHERE list_id = ? AND completed_at IS NOT NULL').run(at, list.id)
  },

  'list.delete'(db, payload, at) {
    const list = requireList(db, payload.id)
    const targetId = payload.moveTasksTo
    if (typeof targetId !== 'string' || targetId.length === 0) throw new BoardError('invalid-field', 'moveTasksTo must be a list id', 400, { field: 'moveTasksTo' })
    if (targetId === list.id) throw new BoardError('invalid-field', 'moveTasksTo must differ from the deleted list', 400)
    const target = requireList(db, targetId)
    if (list.is_done === 1) {
      const doneLists = db.prepare('SELECT COUNT(*) AS n FROM lists WHERE is_done = 1').get().n
      if (Number(doneLists) <= 1) throw new BoardError('last-done-list', 'create another done list before deleting the only one', 409)
    }
    const tasks = db.prepare('SELECT * FROM tasks WHERE list_id = ? ORDER BY position ASC, id ASC').all(list.id)
    const update = db.prepare('UPDATE tasks SET list_id = ?, position = ?, completed_at = ?, updated_at = ? WHERE id = ?')
    let position = endPosition(db, target.id)
    for (const task of tasks) {
      update.run(target.id, position, completionFor(target, task.completed_at, at), at, task.id)
      position += 1
    }
    db.prepare('DELETE FROM lists WHERE id = ?').run(list.id)
    reindexList(db, target.id)
  },

  'task.create'(db, payload, at) {
    insertTask(db, payload, at)
  },

  'task.update'(db, payload, at) {
    const task = requireTask(db, payload.id)
    const patch = payload.patch === undefined || payload.patch === null ? payload : payload.patch
    if (patch === null || typeof patch !== 'object') throw new BoardError('invalid-field', 'patch must be an object', 400)
    const fields = []
    const values = []
    if (patch.title !== undefined) { fields.push('title = ?'); values.push(requireText(patch.title, 'title', TEXT_LIMITS.title)) }
    if (patch.notes !== undefined) { fields.push('notes = ?'); values.push(optionalText(patch.notes, 'notes', TEXT_LIMITS.notes, '')) }
    if (patch.priority !== undefined) { fields.push('priority = ?'); values.push(requireEnum(patch.priority, 'priority', PRIORITIES)) }
    if (patch.dueDate !== undefined) { fields.push('due_date = ?'); values.push(optionalDate(patch.dueDate, 'dueDate')) }
    if (patch.estimateMin !== undefined) { fields.push('estimate_min = ?'); values.push(optionalInteger(patch.estimateMin, 'estimateMin', LIMITS.estimateMin)) }
    if (patch.completed !== undefined) {
      const completed = optionalBool(patch.completed, 'completed')
      if (completed && task.completed_at === null) { fields.push('completed_at = ?'); values.push(at) }
      if (!completed && task.completed_at !== null) { fields.push('completed_at = NULL') }
    }
    if (patch.labelIds !== undefined) {
      const labelIds = validateLabels(db, requireIdList(patch.labelIds, 'labelIds', LIMITS.labels))
      writeTaskLabels(db, task.id, labelIds)
    }
    if (fields.length > 0) {
      fields.push('updated_at = ?'); values.push(at, task.id)
      db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    }
  },

  'task.delete'(db, payload) {
    const task = requireTask(db, payload.id)
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id)
  },

  'task.move'(db, payload, at) {
    const task = requireTask(db, payload.id)
    const target = requireList(db, payload.listId)
    const position = payload.position === undefined || payload.position === null ? null : optionalInteger(payload.position, 'position', [0, LIMITS.tasks])
    const siblings = db.prepare('SELECT id FROM tasks WHERE list_id = ? AND id <> ? ORDER BY position ASC, id ASC')
      .all(target.id, task.id).map(row => row.id)
    const index = position === null ? siblings.length : Math.min(position, siblings.length)
    siblings.splice(index, 0, task.id)
    db.prepare('UPDATE tasks SET list_id = ?, completed_at = ?, updated_at = ? WHERE id = ?')
      .run(target.id, completionFor(target, task.completed_at, at), at, task.id)
    const reorder = db.prepare('UPDATE tasks SET position = ? WHERE id = ?')
    siblings.forEach((id, order) => reorder.run(order, id))
    reindexList(db, target.id)
    if (task.list_id !== target.id) reindexList(db, task.list_id)
  },

  'task.addTime'(db, payload, at) {
    const task = requireTask(db, payload.taskId)
    const creditId = requireText(payload.creditId, 'creditId', 120)
    const deltaMs = optionalInteger(payload.deltaMs, 'deltaMs', LIMITS.deltaMs)
    if (deltaMs === null) throw new BoardError('invalid-field', 'deltaMs is required', 400, { field: 'deltaMs' })
    const pomodoros = optionalInteger(payload.pomodoros ?? 0, 'pomodoros', [0, 1]) ?? 0
    const duplicate = db.prepare('SELECT 1 AS hit FROM time_credits WHERE id = ?').get(creditId)
    if (duplicate !== undefined) return { changed: false }
    const credits = db.prepare('SELECT COUNT(*) AS n FROM time_credits WHERE task_id = ?').get(task.id).n
    if (Number(credits) >= LIMITS.creditsPerTask) throw new BoardError('too-many-credits', 'this task has too many time credits', 409)
    db.prepare('INSERT INTO time_credits (id, task_id, delta_ms, pomodoros, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(creditId, task.id, deltaMs, pomodoros, at)
    db.prepare('UPDATE tasks SET time_spent_ms = time_spent_ms + ?, pomodoros = pomodoros + ?, updated_at = ? WHERE id = ?')
      .run(deltaMs, pomodoros, at, task.id)
    return { changed: true }
  },

  'subtask.create'(db, payload, at) {
    const task = requireTask(db, payload.taskId)
    const count = db.prepare('SELECT COUNT(*) AS n FROM subtasks WHERE task_id = ?').get(task.id).n
    if (Number(count) >= LIMITS.subtasksPerTask) throw new BoardError('too-many-subtasks', `at most ${LIMITS.subtasksPerTask} subtasks per task`, 409)
    const position = Number(db.prepare('SELECT COALESCE(MAX(position), -1) AS max FROM subtasks WHERE task_id = ?').get(task.id).max) + 1
    db.prepare('INSERT INTO subtasks (id, task_id, title, done, position, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), task.id, requireText(payload.title, 'title', TEXT_LIMITS.title), optionalBool(payload.done, 'done') ? 1 : 0, position, at)
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(at, task.id)
  },

  'subtask.update'(db, payload, at) {
    const subtask = requireRow(db, 'subtasks', payload.id, 'unknown-subtask')
    const fields = []
    const values = []
    if (payload.title !== undefined) { fields.push('title = ?'); values.push(requireText(payload.title, 'title', TEXT_LIMITS.title)) }
    if (payload.done !== undefined) { fields.push('done = ?'); values.push(optionalBool(payload.done, 'done') ? 1 : 0) }
    if (fields.length === 0) return { changed: false }
    values.push(subtask.id)
    db.prepare(`UPDATE subtasks SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(at, subtask.task_id)
  },

  'subtask.delete'(db, payload, at) {
    const subtask = requireRow(db, 'subtasks', payload.id, 'unknown-subtask')
    db.prepare('DELETE FROM subtasks WHERE id = ?').run(subtask.id)
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(at, subtask.task_id)
  },

  'label.create'(db, payload, at) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM labels').get().n
    if (Number(count) >= LIMITS.labels) throw new BoardError('too-many-labels', `at most ${LIMITS.labels} labels`, 409)
    const name = requireText(payload.name, 'name', TEXT_LIMITS.label)
    const color = requireEnum(payload.color ?? 'gray', 'color', LABEL_COLORS)
    try {
      db.prepare('INSERT INTO labels (id, name, color, created_at) VALUES (?, ?, ?, ?)').run(randomUUID(), name, color, at)
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new BoardError('label-exists', `a label named "${name}" already exists`, 409)
      throw error
    }
  },

  'label.update'(db, payload) {
    const label = requireRow(db, 'labels', payload.id, 'unknown-label')
    const fields = []
    const values = []
    if (payload.name !== undefined) { fields.push('name = ?'); values.push(requireText(payload.name, 'name', TEXT_LIMITS.label)) }
    if (payload.color !== undefined) { fields.push('color = ?'); values.push(requireEnum(payload.color, 'color', LABEL_COLORS)) }
    if (fields.length === 0) return { changed: false }
    values.push(label.id)
    try {
      db.prepare(`UPDATE labels SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new BoardError('label-exists', 'another label already uses that name', 409)
      throw error
    }
  },

  'label.delete'(db, payload) {
    const label = requireRow(db, 'labels', payload.id, 'unknown-label')
    db.prepare('DELETE FROM labels WHERE id = ?').run(label.id)
  },
}

/**
 * Apply one mutation and return the fresh board.
 * @param {DatabaseSync} db - open board database.
 * @param {string} op - command name.
 * @param {object} payload - command arguments.
 * @returns {{changed: boolean, revision: number, board: object}} result envelope.
 */
export function applyBoardCommand(db, op, payload = {}) {
  if (typeof op !== 'string' || op.length === 0) throw new BoardError('invalid-command', 'op must be a command name', 400)
  const handler = COMMANDS[op]
  if (handler === undefined) throw new BoardError('unknown-command', `unknown board command: ${op}`, 400, { op })
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new BoardError('invalid-payload', 'payload must be an object', 400)
  }
  const at = nowMs()
  const outcome = transaction(db, () => handler(db, payload, at))
  const changed = outcome === undefined || outcome === null ? true : outcome.changed !== false
  if (changed) bumpRevision(db, at)
  return { changed, revision: readRevision(db), board: readBoard(db) }
}

/* ─────────────────────── export / import ──────────────────────── */

/** File-name-safe board export payload. */
export function exportBoard(db) {
  return {
    format: 'dsh-pomodoro-board',
    version: BOARD_SCHEMA_VERSION,
    exportedAt: new Date(nowMs()).toISOString(),
    board: readBoard(db),
  }
}

/** Validate a client-supplied export payload before touching the database. */
function validateImportedBoard(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new BoardError('invalid-import', 'board must be an object', 400)
  if (raw.version !== undefined && raw.version !== BOARD_SCHEMA_VERSION) {
    throw new BoardError('unsupported-schema', `imported board version ${raw.version} is not supported`, 400)
  }
  if (!Array.isArray(raw.lists) || raw.lists.length === 0) throw new BoardError('invalid-import', 'board.lists must be a non-empty array', 400)
  if (raw.lists.length > LIMITS.lists) throw new BoardError('too-many-lists', `at most ${LIMITS.lists} lists`, 400)
  if (!Array.isArray(raw.tasks) || raw.tasks.length > LIMITS.tasks) throw new BoardError('invalid-import', 'board.tasks is invalid or too large', 400)
  if (!Array.isArray(raw.labels) || raw.labels.length > LIMITS.labels) throw new BoardError('invalid-import', 'board.labels is invalid or too large', 400)
  const listIds = new Set()
  for (const list of raw.lists) {
    if (list === null || typeof list !== 'object' || typeof list.id !== 'string' || listIds.has(list.id)) throw new BoardError('invalid-import', 'duplicate or malformed list id', 400)
    listIds.add(list.id)
  }
  const labelIds = new Set()
  for (const label of raw.labels) {
    if (label === null || typeof label !== 'object' || typeof label.id !== 'string' || labelIds.has(label.id)) throw new BoardError('invalid-import', 'duplicate or malformed label id', 400)
    labelIds.add(label.id)
  }
  const taskIds = new Set()
  for (const task of raw.tasks) {
    if (task === null || typeof task !== 'object' || typeof task.id !== 'string' || taskIds.has(task.id)) throw new BoardError('invalid-import', 'duplicate or malformed task id', 400)
    taskIds.add(task.id)
    if (!listIds.has(task.listId)) throw new BoardError('invalid-import', `task ${task.id} references an unknown list`, 400)
    if (!PRIORITIES.includes(task.priority ?? 'none')) throw new BoardError('invalid-import', `task ${task.id} has an invalid priority`, 400)
    if (task.dueDate !== null && task.dueDate !== undefined) optionalDate(task.dueDate, 'dueDate')
    if (task.estimateMin !== null && task.estimateMin !== undefined) optionalInteger(task.estimateMin, 'estimateMin', LIMITS.estimateMin)
    if (!Array.isArray(task.labelIds ?? [])) throw new BoardError('invalid-import', `task ${task.id} has invalid labels`, 400)
    for (const labelId of task.labelIds ?? []) if (!labelIds.has(labelId)) throw new BoardError('invalid-import', `task ${task.id} references an unknown label`, 400)
    if (!Array.isArray(task.subtasks ?? [])) throw new BoardError('invalid-import', `task ${task.id} has invalid subtasks`, 400)
    if ((task.subtasks ?? []).length > LIMITS.subtasksPerTask) throw new BoardError('too-many-subtasks', 'imported task has too many subtasks', 400)
  }
  return raw
}

/**
 * Replace the board with an imported snapshot (single transaction).
 * @param {DatabaseSync} db - open board database.
 * @param {object} raw - `board` payload from an export.
 * @returns {{revision: number, board: object}} fresh board envelope.
 */
export function importBoard(db, raw) {
  const incoming = validateImportedBoard(raw)
  const at = nowMs()
  transaction(db, () => {
    db.exec('DELETE FROM task_labels; DELETE FROM time_credits; DELETE FROM subtasks; DELETE FROM tasks; DELETE FROM labels; DELETE FROM lists;')
    const insertList = db.prepare('INSERT INTO lists (id, title, position, is_done, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    incoming.lists.forEach((list, index) => {
      insertList.run(list.id, requireText(list.title, 'title', TEXT_LIMITS.list), index, list.isDone === true ? 1 : 0, Number(list.createdAt) || at, Number(list.updatedAt) || at)
    })
    const insertLabel = db.prepare('INSERT INTO labels (id, name, color, created_at) VALUES (?, ?, ?, ?)')
    for (const label of incoming.labels) {
      insertLabel.run(label.id, requireText(label.name, 'name', TEXT_LIMITS.label), requireEnum(label.color ?? 'gray', 'color', LABEL_COLORS), Number(label.createdAt) || at)
    }
    const insertTask = db.prepare(`INSERT INTO tasks
      (id, list_id, title, notes, priority, due_date, estimate_min, time_spent_ms, pomodoros, completed_at, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const insertSubtask = db.prepare('INSERT INTO subtasks (id, task_id, title, done, position, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    const insertLink = db.prepare('INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)')
    const listById = new Map(incoming.lists.map(list => [list.id, list]))
    incoming.tasks.forEach((task, index) => {
      const list = listById.get(task.listId)
      const completedAt = list !== undefined && list.isDone === true
        ? (task.completedAt === null || task.completedAt === undefined ? at : Number(task.completedAt))
        : null
      insertTask.run(
        task.id,
        task.listId,
        requireText(task.title, 'title', TEXT_LIMITS.title),
        optionalText(task.notes, 'notes', TEXT_LIMITS.notes, ''),
        task.priority ?? 'none',
        optionalDate(task.dueDate, 'dueDate'),
        optionalInteger(task.estimateMin, 'estimateMin', LIMITS.estimateMin),
        Number(task.timeSpentMs) >= 0 ? Math.floor(Number(task.timeSpentMs)) : 0,
        Number(task.pomodoros) >= 0 ? Math.floor(Number(task.pomodoros)) : 0,
        completedAt,
        Number.isInteger(task.position) ? task.position : index,
        Number(task.createdAt) || at,
        Number(task.updatedAt) || at,
      )
      for (const labelId of task.labelIds ?? []) insertLink.run(task.id, labelId)
      ;(task.subtasks ?? []).forEach((subtask, order) => {
        insertSubtask.run(
          typeof subtask.id === 'string' ? subtask.id : randomUUID(),
          task.id,
          requireText(subtask.title, 'title', TEXT_LIMITS.title),
          subtask.done === true ? 1 : 0,
          Number.isInteger(subtask.position) ? subtask.position : order,
          Number(subtask.createdAt) || at,
        )
      })
    })
    setMeta(db, 'board_title', raw.title === undefined ? 'My board' : requireText(raw.title, 'title', TEXT_LIMITS.title))
    setMeta(db, 'created_at', Number(raw.createdAt) || at)
  })
  bumpRevision(db, at)
  return { revision: readRevision(db), board: readBoard(db) }
}

/* ─────────────────────────── backups ──────────────────────────── */

/**
 * Refresh `board.sqlite.bak` at most once per interval, rotating the previous
 * copies to `.bak.1` … `.bak.N`.
 * @param {DatabaseSync} db - open board database.
 * @param {string} filePath - live database path.
 * @param {{keep?: number, intervalMs?: number, now?: number}} [options]
 * @returns {Promise<{created: boolean, path: string}>} outcome.
 */
export async function createBoardBackup(db, filePath, options = {}) {
  const keep = options.keep ?? 7
  const intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1000
  const at = options.now ?? nowMs()
  const backupPath = `${filePath}.bak`
  // Track the snapshot time in the database rather than the file mtime: the
  // comparison must be stable for tests and across file copies.
  const last = Number(getMeta(db, 'backup_at') ?? '0')
  if (Number.isFinite(last) && last > 0 && at - last < intervalMs) return { created: false, path: backupPath }
  for (let index = keep - 1; index >= 1; index -= 1) {
    try { renameSync(`${backupPath}.${index}`, `${backupPath}.${index + 1}`) } catch { /* missing */ }
  }
  try { renameSync(backupPath, `${backupPath}.1`) } catch { /* missing */ }
  await sqliteBackup(db, backupPath)
  setMeta(db, 'backup_at', at)
  return { created: true, path: backupPath }
}
