/**
 * Unit tests for the pure task-board rules (`src/tasks-core.js`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PRIORITIES,
  SECTIONS,
  columnSummary,
  computeStats,
  daysBetween,
  dueBucket,
  dueChip,
  filterTasks,
  formatElapsed,
  formatMinutes,
  groupByList,
  inSection,
  isCompleted,
  labelsById,
  localDateKey,
  matchesSearch,
  normalizeSearch,
  sectionCounts,
  sectionTasks,
  shiftDateKey,
  sortTasks,
  weekEndKey,
  weekStartKey,
} from '../src/tasks-core.js'

const NOW = new Date(2026, 9, 22, 12, 0, 0).getTime() // Thursday 2026-10-22 local
const TODAY = localDateKey(NOW)

function task(id, patch = {}) {
  return {
    id,
    listId: 'todo',
    title: `Task ${id}`,
    notes: '',
    priority: 'none',
    dueDate: null,
    estimateMin: null,
    timeSpentMs: 0,
    pomodoros: 0,
    completedAt: null,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
    labelIds: [],
    subtasks: [],
    ...patch,
  }
}

function board(tasks, patch = {}) {
  return {
    version: 1,
    id: 'board',
    title: 'Board',
    createdAt: 1,
    updatedAt: 1,
    lists: [
      { id: 'todo', title: 'To Do', position: 0, isDone: false },
      { id: 'doing', title: 'Doing', position: 1, isDone: false },
      { id: 'done', title: 'Done', position: 2, isDone: true },
    ],
    labels: [{ id: 'diseño', name: 'diseño', color: 'blue' }],
    tasks,
    ...patch,
  }
}

/** `t` stub reading from a flat dictionary. */
function translator(dict = {}) {
  return (key, params = {}) => (dict[key] ?? key).replace(/\{(\w+)\}/g, (_m, name) => String(params[name] ?? ''))
}

test('date keys are local civil dates and shift across days', () => {
  assert.equal(localDateKey(new Date(2026, 0, 1, 0, 5).getTime()), '2026-01-01')
  assert.equal(localDateKey(new Date(2026, 11, 31, 23, 59).getTime()), '2026-12-31')
  assert.equal(shiftDateKey('2026-10-22', 1), '2026-10-23')
  assert.equal(shiftDateKey('2026-10-31', 1), '2026-11-01')
  assert.equal(shiftDateKey('2026-01-01', -1), '2025-12-31')
})

test('ISO week boundaries start on Monday and end on Sunday', () => {
  assert.equal(weekStartKey(TODAY), '2026-10-19')
  assert.equal(weekEndKey(TODAY), '2026-10-25')
  assert.equal(weekStartKey('2026-10-25'), '2026-10-19') // Sunday belongs to its own week
  assert.equal(weekStartKey('2026-10-19'), '2026-10-19')
})

test('due buckets classify past, today, tomorrow and later dates', () => {
  assert.equal(dueBucket(task('a'), TODAY), 'none')
  assert.equal(dueBucket(task('a', { dueDate: '2026-10-21' }), TODAY), 'overdue')
  assert.equal(dueBucket(task('a', { dueDate: TODAY }), TODAY), 'today')
  assert.equal(dueBucket(task('a', { dueDate: '2026-10-23' }), TODAY), 'tomorrow')
  assert.equal(dueBucket(task('a', { dueDate: '2026-10-24' }), TODAY), 'thisWeek')
  assert.equal(dueBucket(task('a', { dueDate: '2026-10-27' }), TODAY), 'next7')
  assert.equal(dueBucket(task('a', { dueDate: '2026-11-30' }), TODAY), 'later')
})

test('sections apply their documented filters', () => {
  const completed = task('done', { completedAt: 5, dueDate: '2026-10-21' })
  const overdueOpen = task('late', { dueDate: '2026-10-21' })
  const todayTask = task('today', { dueDate: TODAY, priority: 'high' })
  const tomorrow = task('tomorrow', { dueDate: '2026-10-23', priority: 'medium' })
  const week = task('week', { dueDate: '2026-10-24' })
  const next7 = task('next7', { dueDate: '2026-10-28', priority: 'low' })
  const noDue = task('nodue')

  assert.equal(inSection(overdueOpen, 'overdue', TODAY), true)
  assert.equal(inSection(completed, 'overdue', TODAY), false, 'completed work is not overdue')
  assert.equal(inSection(todayTask, 'today', TODAY), true)
  assert.equal(inSection(tomorrow, 'tomorrow', TODAY), true)
  assert.equal(inSection(week, 'thisWeek', TODAY), true)
  assert.equal(inSection(next7, 'thisWeek', TODAY), false)
  assert.equal(inSection(next7, 'next7', TODAY), true)
  assert.equal(inSection(noDue, 'noDue', TODAY), true)
  assert.equal(inSection(completed, 'completed', TODAY), true)
  assert.equal(inSection(todayTask, 'high', TODAY), true)
  assert.equal(inSection(tomorrow, 'medium', TODAY), true)
  assert.equal(inSection(next7, 'low', TODAY), true)
})

test('sectionTasks and sectionCounts agree', () => {
  const tasks = [
    task('a', { dueDate: TODAY }),
    task('b', { dueDate: '2026-10-21' }),
    task('c', { dueDate: '2026-10-21', completedAt: 1 }),
    task('d', { priority: 'high' }),
  ]
  const data = board(tasks)
  const counts = sectionCounts(data, TODAY)
  for (const section of SECTIONS) {
    assert.equal(counts[section], sectionTasks(data, section, TODAY).length, section)
  }
  assert.equal(counts.overdue, 1)
  assert.equal(counts.completed, 1)
  assert.equal(counts.high, 1)
  assert.equal(counts.all, 4)
})

test('search folds accents, case and nested text', () => {
  assert.equal(normalizeSearch('  Diseño  '), 'diseno')
  const labels = { 'lab-1': { id: 'lab-1', name: 'Diseño' } }
  const data = task('a', { title: 'PANTALLA', notes: 'nota sobre Diseño', subtasks: [{ title: 'Wireframe' }], labelIds: ['lab-1'] })
  assert.equal(matchesSearch(data, 'pantalla', labels), true)
  assert.equal(matchesSearch(data, 'diseno', labels), true)
  assert.equal(matchesSearch(data, 'wireframe', labels), true)
  assert.equal(matchesSearch(data, 'inexistente', labels), false)
  assert.equal(matchesSearch(data, '', labels), true)
})

test('filterTasks combines section, search and labels', () => {
  const data = board([
    task('a', { title: 'Alpha', dueDate: TODAY, labelIds: ['diseño'] }),
    task('b', { title: 'Beta', dueDate: TODAY }),
    task('c', { title: 'Gamma', priority: 'high' }),
  ])
  assert.deepEqual(filterTasks(data, { section: 'today', today: TODAY }).map(item => item.id), ['a', 'b'])
  assert.deepEqual(filterTasks(data, { section: 'today', search: 'alpha', today: TODAY }).map(item => item.id), ['a'])
  assert.deepEqual(filterTasks(data, { labelIds: ['diseño'], today: TODAY }).map(item => item.id), ['a'])
  assert.deepEqual(filterTasks(data, { section: 'high', today: TODAY }).map(item => item.id), ['c'])
})

test('computeStats respects both estimate modes', () => {
  const tasks = [
    task('a', { estimateMin: 60, timeSpentMs: 1000 }),
    task('b', { estimateMin: 30, completedAt: 2, timeSpentMs: 2000 }),
    task('c', { estimateMin: null }),
  ]
  assert.deepEqual(computeStats(tasks, 'all'), { estimatedMin: 90, openCount: 2, elapsedMs: 3000, completedCount: 1 })
  assert.deepEqual(computeStats(tasks, 'open'), { estimatedMin: 60, openCount: 2, elapsedMs: 3000, completedCount: 1 })
  assert.deepEqual(computeStats([], 'all'), { estimatedMin: 0, openCount: 0, elapsedMs: 0, completedCount: 0 })
})

test('sortTasks implements manual, due, priority and created orders', () => {
  const data = board([
    task('later', { dueDate: '2026-10-30', position: 0, priority: 'low', createdAt: 1 }),
    task('soonHigh', { dueDate: '2026-10-23', position: 1, priority: 'high', createdAt: 2 }),
    task('soonNone', { dueDate: '2026-10-23', position: 2, priority: 'none', createdAt: 3 }),
    task('noDueMedium', { dueDate: null, position: 3, priority: 'medium', createdAt: 4 }),
  ])
  const ids = tasks => tasks.map(item => item.id)
  assert.deepEqual(ids(sortTasks(data.tasks, 'manual', data)), ['later', 'soonHigh', 'soonNone', 'noDueMedium'])
  assert.deepEqual(ids(sortTasks(data.tasks, 'due', data)), ['soonHigh', 'soonNone', 'later', 'noDueMedium'])
  assert.deepEqual(ids(sortTasks(data.tasks, 'priority', data)), ['soonHigh', 'noDueMedium', 'later', 'soonNone'])
  assert.deepEqual(ids(sortTasks(data.tasks, 'created', data)), ['noDueMedium', 'soonNone', 'soonHigh', 'later'])
})

test('manual order follows list order before task position', () => {
  const data = board([
    task('doingA', { listId: 'doing', position: 0 }),
    task('todoB', { listId: 'todo', position: 1 }),
    task('todoA', { listId: 'todo', position: 0 }),
  ])
  assert.deepEqual(sortTasks(data.tasks, 'manual', data).map(item => item.id), ['todoA', 'todoB', 'doingA'])
})

test('groupByList keeps column buckets including empty lists', () => {
  const data = board([task('a', { listId: 'todo' }), task('b', { listId: 'done' })])
  const groups = groupByList(data, data.tasks)
  assert.deepEqual([...groups.keys()], ['todo', 'doing', 'done'])
  assert.deepEqual(groups.get('todo').map(item => item.id), ['a'])
  assert.deepEqual(groups.get('doing'), [])
})

test('duration formatting is compact and tolerant', () => {
  assert.equal(formatMinutes(0), '—')
  assert.equal(formatMinutes(null), '—')
  assert.equal(formatMinutes(45), '45m')
  assert.equal(formatMinutes(60), '1h')
  assert.equal(formatMinutes(90), '1h 30m')
  assert.equal(formatMinutes(125), '2h 5m')
  assert.equal(formatElapsed(5_400_000), '1h 30m')
  assert.equal(formatElapsed(0), '—')
})

test('civil day arithmetic and due chips', () => {
  assert.equal(daysBetween('2026-10-22', '2026-10-25'), 3)
  assert.equal(daysBetween('2026-10-22', '2026-10-20'), -2)
  const t = translator({
    'due.overdue': 'Vencida {days}d',
    'due.today': 'Hoy',
    'due.tomorrow': 'Mañana',
    'due.inDays': 'En {days}d',
  })
  assert.deepEqual(dueChip(task('a'), TODAY, t), { label: '', state: 'none' })
  assert.deepEqual(dueChip(task('a', { dueDate: '2026-10-20' }), TODAY, t), { label: 'Vencida 2d', state: 'overdue' })
  assert.deepEqual(dueChip(task('a', { dueDate: TODAY }), TODAY, t), { label: 'Hoy', state: 'today' })
  assert.deepEqual(dueChip(task('a', { dueDate: '2026-10-23' }), TODAY, t), { label: 'Mañana', state: 'soon' })
  assert.deepEqual(dueChip(task('a', { dueDate: '2026-10-27' }), TODAY, t), { label: 'En 5d', state: 'later' })
})

test('isCompleted, label lookup, priorities and column summaries', () => {
  assert.equal(isCompleted(task('a')), false)
  assert.equal(isCompleted(task('a', { completedAt: 0 })), true)
  const data = board([])
  assert.deepEqual(labelsById(data), { diseño: { id: 'diseño', name: 'diseño', color: 'blue' } })
  assert.deepEqual(PRIORITIES, ['high', 'medium', 'low', 'none'])
  assert.deepEqual(columnSummary([task('a', { estimateMin: 30 }), task('b', { estimateMin: 15 })]), { count: 2, estimatedMin: 45 })
})
