/**
 * Task-board rules — pure, framework-free and side-effect free.
 *
 * The board data itself lives in the host's SQLite database; this module only
 * answers questions about an already-loaded snapshot: which smart section a
 * task belongs to, how search and label filters narrow it, how the four
 * per-section metrics add up, and how a list of tasks is ordered.
 *
 * Dates are civil `YYYY-MM-DD` strings in the browser's local timezone, so a
 * task due "today" stays today across timezone offsets.
 *
 * @module dsh-plugin-pomodoro/tasks-core
 */

/** Smart sections shown in the board rail, in display order. */
export const SECTIONS = Object.freeze([
  'all',
  'today',
  'overdue',
  'tomorrow',
  'thisWeek',
  'next7',
  'high',
  'medium',
  'low',
  'noDue',
  'completed',
])

/** Priorities, highest urgency first. */
export const PRIORITIES = Object.freeze(['high', 'medium', 'low', 'none'])

/** Orders offered by the toolbar. */
export const SORTS = Object.freeze(['manual', 'due', 'priority', 'created'])

/** Estimate modes: every task, or open tasks only. */
export const ESTIMATE_MODES = Object.freeze(['all', 'open'])

/** Label color names the palette supports. */
export const LABEL_COLORS = Object.freeze([
  'gray', 'blue', 'green', 'teal', 'yellow', 'orange', 'red', 'pink', 'purple', 'brown',
])

const DAY_MS = 24 * 60 * 60 * 1000

/** Zero-pad a calendar part. */
const pad = value => String(value).padStart(2, '0')

/**
 * Local civil date key for an epoch timestamp.
 * @param {number} [ms] - epoch ms (defaults to now).
 * @returns {string} `YYYY-MM-DD` in the local timezone.
 */
export function localDateKey(ms = Date.now()) {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Parse a civil date key into a local Date at midnight. */
function parseKey(key) {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

/** Shift a civil date key by whole days. */
export function shiftDateKey(key, days) {
  const date = parseKey(key)
  date.setDate(date.getDate() + days)
  return localDateKey(date.getTime())
}

/** Monday of the ISO week containing `key`. */
export function weekStartKey(key) {
  const date = parseKey(key)
  const offset = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - offset)
  return localDateKey(date.getTime())
}

/** Sunday of the ISO week containing `key`. */
export function weekEndKey(key) {
  return shiftDateKey(weekStartKey(key), 6)
}

/**
 * Bucket a task's due date relative to today.
 * @param {object} task - task snapshot.
 * @param {string} today - local date key.
 * @returns {'none'|'overdue'|'today'|'tomorrow'|'thisWeek'|'next7'|'later'} bucket.
 */
export function dueBucket(task, today) {
  if (task.dueDate === null || task.dueDate === undefined) return 'none'
  if (task.dueDate < today) return 'overdue'
  if (task.dueDate === today) return 'today'
  if (task.dueDate === shiftDateKey(today, 1)) return 'tomorrow'
  if (task.dueDate <= weekEndKey(today)) return 'thisWeek'
  if (task.dueDate <= shiftDateKey(today, 6)) return 'next7'
  return 'later'
}

/** Is the task completed? Completion is membership in a done list. */
export function isCompleted(task) {
  return task.completedAt !== null && task.completedAt !== undefined
}

/**
 * Does one task belong to a smart section?
 * Overdue deliberately excludes completed work; the date/priority sections
 * include it so their completed counters mean something.
 * @param {object} task - task snapshot.
 * @param {string} section - one of {@link SECTIONS}.
 * @param {string} today - local date key.
 * @returns {boolean} membership.
 */
export function inSection(task, section, today) {
  const due = task.dueDate ?? null
  switch (section) {
    case 'all': return true
    case 'today': return due === today
    case 'overdue': return due !== null && due < today && !isCompleted(task)
    case 'tomorrow': return due === shiftDateKey(today, 1)
    case 'thisWeek': return due !== null && due >= today && due <= weekEndKey(today)
    case 'next7': return due !== null && due >= today && due <= shiftDateKey(today, 6)
    case 'high': return task.priority === 'high'
    case 'medium': return task.priority === 'medium'
    case 'low': return task.priority === 'low'
    case 'noDue': return due === null
    case 'completed': return isCompleted(task)
    default: return true
  }
}

/**
 * Tasks of one section, before search/label filters.
 * @param {object} board - board snapshot.
 * @param {string} section - one of {@link SECTIONS}.
 * @param {string} [today] - local date key (defaults to now).
 * @returns {object[]} matching tasks.
 */
export function sectionTasks(board, section, today = localDateKey()) {
  return board.tasks.filter(task => inSection(task, section, today))
}

/**
 * Counts for every rail section, so badges never need a second filter pass.
 * @param {object} board - board snapshot.
 * @param {string} [today] - local date key.
 * @returns {Record<string, number>} section → count.
 */
export function sectionCounts(board, today = localDateKey()) {
  const counts = Object.fromEntries(SECTIONS.map(section => [section, 0]))
  for (const task of board.tasks) {
    for (const section of SECTIONS) {
      if (inSection(task, section, today)) counts[section] += 1
    }
  }
  return counts
}

/** Fold accents and case so "diseño" matches "diseno". */
export function normalizeSearch(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

/**
 * Free-text search across title, notes, subtask titles and label names.
 * @param {object} task - task snapshot.
 * @param {string} query - raw search text.
 * @param {Map<string, object>} labelsById - label lookup.
 * @returns {boolean} whether the task matches.
 */
export function matchesSearch(task, query, labelsById) {
  const needle = normalizeSearch(query)
  if (needle.length === 0) return true
  if (normalizeSearch(task.title).includes(needle)) return true
  if (normalizeSearch(task.notes).includes(needle)) return true
  for (const subtask of task.subtasks ?? []) {
    if (normalizeSearch(subtask.title).includes(needle)) return true
  }
  for (const id of task.labelIds ?? []) {
    const label = labelsById[id]
    if (label !== undefined && normalizeSearch(label.name).includes(needle)) return true
  }
  return false
}

/** Label lookup map for a board. */
export function labelsById(board) {
  return Object.fromEntries(board.labels.map(label => [label.id, label]))
}

/**
 * Apply section + search + label filters.
 * @param {object} board - board snapshot.
 * @param {{section?: string, search?: string, labelIds?: string[], today?: string}} [view] - active view.
 * @returns {object[]} visible tasks.
 */
export function filterTasks(board, view = {}) {
  const today = view.today ?? localDateKey()
  const section = view.section ?? 'all'
  const search = view.search ?? ''
  const labelIds = view.labelIds ?? []
  const lookup = labelsById(board)
  return board.tasks.filter(task => {
    if (!inSection(task, section, today)) return false
    if (!matchesSearch(task, search, lookup)) return false
    if (labelIds.length > 0) {
      const taskLabels = task.labelIds ?? []
      if (!labelIds.some(id => taskLabels.includes(id))) return false
    }
    return true
  })
}

/**
 * The four per-section metrics.
 * @param {object[]} tasks - tasks in the active section/filter.
 * @param {'all'|'open'} [estimateMode] - whether estimates include completed tasks.
 * @returns {{estimatedMin: number, openCount: number, elapsedMs: number, completedCount: number}} metrics.
 */
export function computeStats(tasks, estimateMode = 'all') {
  let estimatedMin = 0
  let openCount = 0
  let elapsedMs = 0
  let completedCount = 0
  for (const task of tasks) {
    const completed = isCompleted(task)
    const estimate = Number(task.estimateMin ?? 0)
    if (estimateMode === 'all' || !completed) estimatedMin += Number.isFinite(estimate) ? estimate : 0
    if (completed) completedCount += 1
    else openCount += 1
    elapsedMs += Number(task.timeSpentMs ?? 0)
  }
  return { estimatedMin, openCount, elapsedMs, completedCount }
}

/** Priority rank (high = 0). */
export function priorityRank(priority) {
  const index = PRIORITIES.indexOf(priority)
  return index < 0 ? PRIORITIES.length : index
}

/** List position lookup for manual order. */
function listRank(board) {
  const ranks = new Map(board.lists.map(list => [list.id, list.position]))
  return listId => ranks.get(listId) ?? 0
}

/**
 * Order visible tasks for rendering.
 * @param {object[]} tasks - tasks to order (not mutated).
 * @param {'manual'|'due'|'priority'|'created'} [sort] - order to apply.
 * @param {object} board - board snapshot (manual order uses list positions).
 * @returns {object[]} a new ordered array.
 */
export function sortTasks(tasks, sort = 'manual', board = { lists: [] }) {
  const rank = listRank(board)
  const ordered = [...tasks]
  const byManual = (left, right) => (rank(left.listId) - rank(right.listId)) || (left.position - right.position)
  switch (sort) {
    case 'due':
      ordered.sort((left, right) => {
        if (left.dueDate === null && right.dueDate === null) return byManual(left, right)
        if (left.dueDate === null) return 1
        if (right.dueDate === null) return -1
        return left.dueDate === right.dueDate ? byManual(left, right) : left.dueDate < right.dueDate ? -1 : 1
      })
      return ordered
    case 'priority':
      ordered.sort((left, right) => (priorityRank(left.priority) - priorityRank(right.priority)) || byManual(left, right))
      return ordered
    case 'created':
      ordered.sort((left, right) => (right.createdAt - left.createdAt) || byManual(left, right))
      return ordered
    default:
      ordered.sort(byManual)
      return ordered
  }
}

/**
 * Group ordered tasks under their lists for column rendering.
 * @param {object} board - board snapshot.
 * @param {object[]} tasks - already-ordered tasks.
 * @returns {Map<string, object[]>} list id → tasks.
 */
export function groupByList(board, tasks) {
  const groups = new Map(board.lists.map(list => [list.id, []]))
  for (const task of tasks) {
    const bucket = groups.get(task.listId)
    if (bucket !== undefined) bucket.push(task)
  }
  return groups
}

/** Human duration from minutes (`90` → `1h 30m`). */
export function formatMinutes(minutes) {
  const value = Number(minutes)
  if (!Number.isFinite(value) || value <= 0) return '—'
  const hours = Math.floor(value / 60)
  const rest = Math.round(value % 60)
  if (hours === 0) return `${rest}m`
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/** Human duration from milliseconds (`5400000` → `1h 30m`). */
export function formatElapsed(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return '—'
  return formatMinutes(Math.round(value / 60_000))
}

/** Whole days between two civil keys (negative when `to` is in the past). */
export function daysBetween(fromKey, toKey) {
  return Math.round((parseKey(toKey).getTime() - parseKey(fromKey).getTime()) / DAY_MS)
}

/**
 * Short due-date wording for a card chip.
 * @param {object} task - task snapshot.
 * @param {string} today - local date key.
 * @param {object} t - namespace translator.
 * @returns {{label: string, state: 'none'|'overdue'|'today'|'soon'|'later'}} chip data.
 */
export function dueChip(task, today, t) {
  if (task.dueDate === null || task.dueDate === undefined) return { label: '', state: 'none' }
  const delta = daysBetween(today, task.dueDate)
  if (delta < 0) return { label: t('due.overdue', { days: Math.abs(delta) }), state: 'overdue' }
  if (delta === 0) return { label: t('due.today'), state: 'today' }
  if (delta === 1) return { label: t('due.tomorrow'), state: 'soon' }
  return { label: t('due.inDays', { days: delta }), state: 'later' }
}

/** Sum of estimates for one column header. */
export function columnSummary(tasks) {
  return {
    count: tasks.length,
    estimatedMin: tasks.reduce((total, task) => total + (Number(task.estimateMin) || 0), 0),
  }
}
