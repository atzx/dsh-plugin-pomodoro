/**
 * Component smoke tests for the board surfaces (`src/board-ui.js`).
 *
 * Every dialog the board can open is rendered with React's server renderer and
 * a fixture board. This is the regression net for the class of failure that
 * crashes a whole slot entry: a component that references an undeclared value
 * (for example a focus-trap ref) throws during its first render.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { en } from '../src/locales.js'
import {
  TaskBoardBoardMenu,
  TaskBoardComposerDialog,
  TaskBoardDrawer,
  TaskBoardLabelManager,
  TaskBoardLabelPicker,
  TaskBoardSubtaskList,
} from '../src/board-ui.js'

const requireFrom = createRequire(import.meta.url)
const React = requireFrom('react')
const { renderToStaticMarkup } = requireFrom('react-dom/server')

/** `t` implementation over the English dictionary (placeholder substitution). */
function translator(dictionary = en) {
  return (key, params = {}) => {
    const template = dictionary[key]
    if (template === undefined) return key
    return template.replace(/\{(\w+)\}/g, (_match, name) => String(params[name] ?? `{${name}}`))
  }
}

const TASK = {
  id: 't1',
  listId: 'todo',
  title: 'Diseñar tablero',
  notes: 'nota de prueba',
  priority: 'high',
  dueDate: null,
  estimateMin: 45,
  timeSpentMs: 0,
  pomodoros: 0,
  completedAt: null,
  position: 0,
  createdAt: 1,
  updatedAt: 1,
  labelIds: ['l1'],
  subtasks: [{ id: 's1', taskId: 't1', title: 'Sub uno', done: false, position: 0, createdAt: 1 }],
}

const BOARD = {
  version: 1,
  id: 'b1',
  title: 'Board',
  createdAt: 1,
  updatedAt: 1,
  lists: [
    { id: 'todo', title: 'To Do', position: 0, isDone: false },
    { id: 'doing', title: 'Doing', position: 1, isDone: false },
    { id: 'done', title: 'Done', position: 2, isDone: true },
  ],
  labels: [
    { id: 'l1', name: 'diseño', color: 'blue', createdAt: 1 },
    { id: 'l2', name: 'bug', color: 'red', createdAt: 1 },
  ],
  tasks: [TASK],
}

const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props))

test('label manager renders its dialog, rows and create form', () => {
  const html = render(TaskBoardLabelManager, { t: translator(), board: BOARD, onClose: () => {} })
  assert.match(html, /role="dialog"/)
  assert.match(html, /aria-modal="true"/)
  assert.match(html, /Manage labels/)
  assert.match(html, /diseño/)
  assert.match(html, /bug/)
  assert.match(html, /Add label/)
})

test('label picker renders chips and an inline panel when open', () => {
  const closed = render(TaskBoardLabelPicker, { t: translator(), board: BOARD, task: TASK, onManage: () => {} })
  assert.match(closed, /tb-labelToken/)
  assert.match(closed, /\+ Label/)
  assert.doesNotMatch(closed, /tb-labelPanel/)

  const open = render(TaskBoardLabelPicker, {
    t: translator(), board: BOARD, task: TASK, onManage: () => {}, defaultOpen: true,
  })
  assert.match(open, /class="tb-labelPanel"/)
  assert.match(open, /role="checkbox"/)
  assert.match(open, /aria-checked="true"/)
  assert.match(open, /aria-checked="false"/)
  assert.match(open, /Manage labels/)
})

test('task drawer renders every editing section', () => {
  const html = render(TaskBoardDrawer, {
    t: translator(), task: TASK, board: BOARD, onClose: () => {}, onManageLabels: () => {},
  })
  assert.match(html, /class="tb-drawer"/)
  assert.match(html, /aria-label="Task details"/)
  assert.match(html, /Diseñar tablero/)
  assert.match(html, /nota de prueba/)
  assert.match(html, /Sub uno/)
  assert.match(html, /diseño/)
})

test('composer renders a modal dialog with the full field set', () => {
  const html = render(TaskBoardComposerDialog, { t: translator(), board: BOARD, onClose: () => {} })
  assert.match(html, /class="tb-modal"/)
  assert.match(html, /aria-label="New task"/)
  assert.match(html, /Subtasks/)
  assert.match(html, /Create task/)
})

test('board menu (export/import) renders without throwing', () => {
  const html = render(TaskBoardBoardMenu, { t: translator() })
  assert.match(html, /aria-label="Board menu"/)
  assert.match(html, /type="file"/)
})

test('subtask checklist renders toggles and the add row', () => {
  const html = render(TaskBoardSubtaskList, { t: translator(), task: TASK })
  assert.match(html, /Sub uno/)
  assert.match(html, /subtaskCheck/)
  assert.match(html, /aria-label="Subtask title"/)
})
