/**
 * Task-board overlay UI — Trello-style columns, smart sections, search, labels
 * and the four per-section metrics, wired to the host board store.
 *
 * Everything here is a pure function of the store snapshots plus local editing
 * state; the mutation path is always `boardStore` → `/api/pomodoro-board/command`.
 * The task detail drawer, drag & drop and label editing land in later milestones.
 *
 * @module dsh-plugin-pomodoro/board-ui
 */
import * as BoardReact from 'react'
import {
  LABEL_COLORS,
  PRIORITIES,
  SECTIONS,
  computeStats,
  dueChip,
  filterTasks,
  formatElapsed,
  formatMinutes,
  groupByList,
  labelsById,
  localDateKey,
  sectionCounts,
  shiftDateKey,
  sortTasks,
} from './tasks-core.js'
import { boardStore, boardUiStore } from './board-store.js'

/** createElement alias (the other modules keep their own to avoid collisions). */
const bh = BoardReact.createElement

/** Subscribe to the presentation store. */
function useBoardUi() {
  return BoardReact.useSyncExternalStore(boardUiStore.subscribe, boardUiStore.getSnapshot, boardUiStore.getSnapshot)
}

/** Subscribe to the board data store. */
function useBoardData() {
  return BoardReact.useSyncExternalStore(boardStore.subscribe, boardStore.getSnapshot, boardStore.getSnapshot)
}

/** Close a menu on an outside pointer press. */
function useOutsideDismiss(ref, open, close) {
  BoardReact.useEffect(() => {
    if (!open) return undefined
    const onPointerDown = event => {
      if (ref.current !== null && ref.current.contains(event.target)) return
      close()
    }
    document.addEventListener('mousedown', onPointerDown, true)
    return () => document.removeEventListener('mousedown', onPointerDown, true)
  }, [open, close])
}

/** Local date-time label for drawer metadata. */
function formatTimestamp(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms))
  } catch {
    return new Date(ms).toLocaleString()
  }
}

/** A one-line hint shown in place of an empty list of cards. */
function BoardEmptyLine({ t, children }) {
  return bh('div', { className: 'tb-empty' }, children ?? t('board.noTasks'))
}

/** Colored label chip. */
function TaskBoardLabelChip({ label }) {
  if (label === undefined) return null
  return bh('span', { className: `tb-chip tb-labelChip tb-color-${label.color}` },
    bh('span', { className: 'tb-dot tb-colorTarget', 'aria-hidden': 'true' }),
    label.name)
}

/** Priority flag chip (hidden for "none"). */
function TaskBoardPriorityChip({ t, priority }) {
  if (priority === undefined || priority === 'none') return null
  return bh('span', { className: 'tb-priority', 'data-priority': priority }, t(`priority.${priority}`))
}

/** Due-date chip. */
function TaskBoardDueChip({ t, task, today }) {
  const chip = dueChip(task, today, t)
  if (chip.state === 'none') return null
  return bh('span', { className: 'tb-chip', 'data-tone': chip.state }, chip.label)
}

/** Small "2/4" subtask progress chip. */
function TaskBoardSubtaskChip({ t, task }) {
  const subtasks = task.subtasks ?? []
  if (subtasks.length === 0) return null
  const done = subtasks.filter(subtask => subtask.done).length
  return bh('span', { className: 'tb-chip tb-chipMeta' }, t('card.subtasks', { done, total: subtasks.length }))
}

/** Icon button. */
function TaskBoardIconButton({ label, onClick, children, pressed }) {
  return bh('button', {
    type: 'button',
    className: 'tb-iconBtn',
    'aria-label': label,
    title: label,
    'data-active': pressed === true ? 'true' : undefined,
    onClick,
  }, children)
}

/**
 * One task card. Clicking the card opens the same quick menu as "⋯" (the task
 * detail drawer arrives in M3).
 */
function TaskBoardCard({ t, task, board, today, onOpen }) {
  const [menuOpen, setMenuOpen] = BoardReact.useState(false)
  const menuRef = BoardReact.useRef(null)
  const closeMenu = BoardReact.useCallback(() => setMenuOpen(false), [])
  useOutsideDismiss(menuRef, menuOpen, closeMenu)

  const doneLists = board.lists.filter(list => list.isDone)
  const openLists = board.lists.filter(list => !list.isDone)
  const completed = task.completedAt !== null && task.completedAt !== undefined
  const labels = labelsById(board)

  const complete = async () => {
    if (completed) {
      const fallback = openLists[0] ?? board.lists[0]
      if (fallback !== undefined) await boardStore.moveTask(task.id, fallback.id)
    } else {
      const target = doneLists[0]
      if (target !== undefined) await boardStore.moveTask(task.id, target.id)
    }
  }

  const move = async listId => {
    if (listId === task.listId) return
    await boardStore.moveTask(task.id, listId)
    setMenuOpen(false)
  }

  const remove = async () => {
    await boardStore.deleteTask(task.id)
    setMenuOpen(false)
  }

  return bh('div', {
    className: 'tb-card',
    'data-completed': completed ? 'true' : 'false',
    'data-task-id': task.id,
    onClick: () => onOpen?.(task.id),
  },
  bh('div', { className: 'tb-cardTop' },
    bh('span', { className: 'tb-cardTitle' }, task.title),
    bh('div', { className: 'tb-cardActions' },
      bh(TaskBoardIconButton, {
        label: completed ? t('card.uncomplete') : t('card.complete'),
        onClick: event => { event.stopPropagation(); void complete() },
      }, completed ? '↺' : '✓'),
      bh('div', { className: 'tb-menuWrap', ref: menuRef },
        bh(TaskBoardIconButton, {
          label: t('card.menu'),
          pressed: menuOpen,
          onClick: event => { event.stopPropagation(); setMenuOpen(open => !open) },
        }, '⋯'),
        menuOpen ? bh('div', {
          className: 'tb-menu',
          role: 'menu',
          onClick: event => event.stopPropagation(),
        },
        bh('div', { className: 'tb-menuHeading' }, t('card.moveTo')),
        ...board.lists.map(list => bh('button', {
          key: list.id,
          type: 'button',
          className: 'tb-menuItem',
          role: 'menuitem',
          onClick: () => void move(list.id),
        }, list.title, list.id === task.listId ? ' ·' : '')),
        bh('div', { className: 'tb-menuSeparator' }),
        bh('button', {
          type: 'button',
          className: 'tb-menuItem',
          role: 'menuitem',
          'data-danger': 'true',
          onClick: () => void remove(),
        }, t('card.delete'))) : null))),
  bh('div', { className: 'tb-cardMeta' },
    bh(TaskBoardPriorityChip, { t, priority: task.priority }),
    ...(task.labelIds ?? []).map(id => bh(TaskBoardLabelChip, { key: id, label: labels[id] })),
    bh(TaskBoardDueChip, { t, task, today }),
    bh(TaskBoardSubtaskChip, { t, task }),
    task.estimateMin !== null && task.estimateMin !== undefined
      ? bh('span', { className: 'tb-chip tb-chipMeta' }, formatMinutes(task.estimateMin))
      : null,
    task.timeSpentMs > 0
      ? bh('span', { className: 'tb-chip tb-chipMeta' }, formatElapsed(task.timeSpentMs))
      : null))
}

/** Inline quick-add composer at the bottom of a column. */
function TaskBoardComposer({ t, listId, onDone }) {
  const [value, setValue] = BoardReact.useState('')
  const [busy, setBusy] = BoardReact.useState(false)
  const inputRef = BoardReact.useRef(null)

  BoardReact.useEffect(() => { inputRef.current?.focus() }, [])

  const submit = async event => {
    event.preventDefault()
    const title = value.trim()
    if (title.length === 0 || busy) return
    setBusy(true)
    const result = await boardStore.createTask(listId, title)
    setBusy(false)
    if (result.ok) {
      setValue('')
      onDone?.()
    }
  }

  return bh('form', { className: 'tb-composer', onSubmit: event => void submit(event) },
    bh('input', {
      ref: inputRef,
      value,
      placeholder: t('board.taskTitlePlaceholder'),
      'aria-label': t('board.taskTitlePlaceholder'),
      disabled: busy,
      onChange: event => setValue(event.target.value),
      onKeyDown: event => { if (event.key === 'Escape') onDone?.() },
    }))
}

/** One Trello column. */
function TaskBoardColumn({ t, list, tasks, board, today, onOpen }) {
  const allLists = { lists: board.lists }
  const [title, setTitle] = BoardReact.useState(list.title)
  const [adding, setAdding] = BoardReact.useState(false)
  const [menuOpen, setMenuOpen] = BoardReact.useState(false)
  const [confirming, setConfirming] = BoardReact.useState(false)
  const [moveTarget, setMoveTarget] = BoardReact.useState('')
  const menuRef = BoardReact.useRef(null)
  const closeMenu = BoardReact.useCallback(() => setMenuOpen(false), [])
  useOutsideDismiss(menuRef, menuOpen, closeMenu)

  BoardReact.useEffect(() => { setTitle(list.title) }, [list.title])

  const commitTitle = async value => {
    const next = String(value ?? title).trim()
    if (next.length === 0) { setTitle(list.title); return }
    if (next !== list.title) {
      const result = await boardStore.renameList(list.id, next)
      if (!result.ok) setTitle(list.title)
    }
  }

  const otherLists = allLists.lists.filter(other => other.id !== list.id)

  const deleteList = async () => {
    const target = moveTarget === '' ? otherLists[0]?.id : moveTarget
    if (target === undefined || target === null) return
    const result = await boardStore.deleteList(list.id, target)
    if (result.ok) setConfirming(false)
  }

  return bh('section', {
    className: 'tb-column',
    'data-done': list.isDone ? 'true' : 'false',
    'data-list-id': list.id,
    'aria-label': list.title,
  },
  bh('header', { className: 'tb-columnHeader' },
    bh('input', {
      className: 'tb-columnTitle',
      value: title,
      'aria-label': t('list.title'),
      onChange: event => setTitle(event.target.value),
      onBlur: event => void commitTitle(event.currentTarget.value),
      onKeyDown: event => {
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
        if (event.key === 'Escape') { setTitle(list.title); event.currentTarget.blur() }
      },
    }),
    bh('span', { className: 'tb-columnCount' }, String(tasks.length)),
    bh('div', { className: 'tb-menuWrap', ref: menuRef },
      bh(TaskBoardIconButton, {
        label: t('board.listMenu'),
        pressed: menuOpen,
        onClick: () => setMenuOpen(open => !open),
      }, '⋯'),
      menuOpen ? bh('div', { className: 'tb-menu', role: 'menu' },
        bh('button', {
          type: 'button',
          className: 'tb-menuItem',
          role: 'menuitem',
          onClick: () => { setMenuOpen(false); void boardStore.setListDone(list.id, !list.isDone) },
        }, list.isDone ? t('list.unsetDone') : t('list.setDone')),
        bh('div', { className: 'tb-menuSeparator' }),
        bh('button', {
          type: 'button',
          className: 'tb-menuItem',
          role: 'menuitem',
          'data-danger': 'true',
          disabled: otherLists.length === 0,
          onClick: () => {
            setMenuOpen(false)
            setMoveTarget(otherLists[0]?.id ?? '')
            setConfirming(true)
          },
        }, t('list.delete'))) : null)),
  confirming ? bh('div', { className: 'tb-confirm' },
    bh('div', { className: 'tb-confirmText' }, t('list.confirmDelete', { name: list.title })),
    bh('div', { className: 'tb-confirmRow' },
      bh('select', {
        className: 'tb-select',
        value: moveTarget,
        'aria-label': t('list.moveTasksTo'),
        onChange: event => setMoveTarget(event.target.value),
      }, ...otherLists.map(other => bh('option', { key: other.id, value: other.id }, other.title))),
      bh('button', { type: 'button', className: 'tb-btn', onClick: () => setConfirming(false) }, t('action.cancel')),
      bh('button', { type: 'button', className: 'tb-btn', 'data-variant': 'danger', onClick: () => void deleteList() }, t('list.delete')))) : null,
  bh('div', { className: 'tb-columnTasks' },
    ...(tasks.length === 0
      ? [bh(BoardEmptyLine, { key: 'empty', t })]
      : tasks.map(task => bh(TaskBoardCard, { key: task.id, t, task, board, today, onOpen })))),
  adding ? bh(TaskBoardComposer, { t, listId: list.id, onDone: () => setAdding(false) }) : bh('button', {
    type: 'button',
    className: 'tb-addTask',
    onClick: () => setAdding(true),
  }, '+ ', t('board.addTask')))
}

/** Inline "add column" control. */
function TaskBoardAddColumn({ t }) {
  const [adding, setAdding] = BoardReact.useState(false)
  const [title, setTitle] = BoardReact.useState('')
  const inputRef = BoardReact.useRef(null)

  BoardReact.useEffect(() => { if (adding) inputRef.current?.focus() }, [adding])

  const submit = async event => {
    event.preventDefault()
    const value = title.trim()
    if (value.length === 0) { setAdding(false); return }
    const result = await boardStore.createList(value)
    if (result.ok) { setTitle(''); setAdding(false) }
  }

  if (!adding) {
    return bh('div', { className: 'tb-newColumn' },
      bh('button', { type: 'button', className: 'tb-addColumn', onClick: () => setAdding(true) }, '+ ', t('board.newList')))
  }
  return bh('form', { className: 'tb-newColumn', onSubmit: event => void submit(event) },
    bh('input', {
      ref: inputRef,
      value: title,
      placeholder: t('board.listTitlePlaceholder'),
      'aria-label': t('board.newList'),
      onChange: event => setTitle(event.target.value),
      onKeyDown: event => { if (event.key === 'Escape') { setAdding(false); setTitle('') } },
    }))
}

/** Smart-section rail with label filters. */
function TaskBoardRail({ t, board, ui, counts }) {
  const select = section => boardUiStore.update({ section })
  const toggleLabel = id => {
    const current = ui.labelIds
    boardUiStore.update({ labelIds: current.includes(id) ? current.filter(item => item !== id) : [...current, id] })
  }
  return bh('nav', { className: 'tb-rail', 'aria-label': t('board.sections') },
    bh('div', { className: 'tb-railHeading' }, t('board.sections')),
    ...SECTIONS.map(section => bh('button', {
      key: section,
      type: 'button',
      className: 'tb-railItem',
      'data-active': ui.section === section ? 'true' : 'false',
      'aria-pressed': ui.section === section,
      onClick: () => select(section),
    },
    bh('span', { className: 'tb-railLabel' }, t(`section.${section}`)),
    bh('span', { className: 'tb-railCount' }, String(counts[section] ?? 0)))),
    board.labels.length > 0
      ? bh(BoardReact.Fragment, null,
        bh('div', { className: 'tb-railHeading' }, t('board.labels')),
        ...board.labels.map(label => bh('button', {
          key: label.id,
          type: 'button',
          className: 'tb-railItem',
          'data-active': ui.labelIds.includes(label.id) ? 'true' : 'false',
          'aria-pressed': ui.labelIds.includes(label.id),
          onClick: () => toggleLabel(label.id),
        },
        bh('span', { className: `tb-dot tb-color-${label.color} tb-colorTarget`, 'aria-hidden': 'true' }),
        bh('span', { className: 'tb-railLabel' }, label.name))))
      : null)
}

/** The four metric cards plus the estimate-mode toggle. */
function TaskBoardStats({ t, tasks, ui }) {
  const stats = computeStats(tasks, ui.estimateMode)
  const card = (label, value, key) => bh('div', { key, className: 'tb-stat' },
    bh('span', { className: 'tb-statLabel' }, label),
    bh('span', { className: 'tb-statValue' }, value))
  return bh('div', { className: 'tb-stats' },
    card(t('stats.estimated'), formatMinutes(stats.estimatedMin), 'estimated'),
    card(t('stats.open'), String(stats.openCount), 'open'),
    card(t('stats.elapsed'), formatElapsed(stats.elapsedMs), 'elapsed'),
    card(t('stats.completed'), String(stats.completedCount), 'completed'),
    bh('div', { className: 'tb-modeToggle', role: 'group', 'aria-label': t('board.estimateMode') },
      bh('button', {
        type: 'button',
        'data-active': ui.estimateMode === 'all' ? 'true' : 'false',
        'aria-pressed': ui.estimateMode === 'all',
        onClick: () => boardUiStore.update({ estimateMode: 'all' }),
      }, t('board.estimateAll')),
      bh('button', {
        type: 'button',
        'data-active': ui.estimateMode === 'open' ? 'true' : 'false',
        'aria-pressed': ui.estimateMode === 'open',
        onClick: () => boardUiStore.update({ estimateMode: 'open' }),
      }, t('board.estimateOpen'))))
}

/** Editable board title. */
function TaskBoardTitle({ t, board }) {
  const [draft, setDraft] = BoardReact.useState(board.title)
  BoardReact.useEffect(() => { setDraft(board.title) }, [board.title])
  const commit = async value => {
    const next = String(value ?? draft).trim()
    if (next.length === 0) { setDraft(board.title); return }
    if (next !== board.title) {
      const result = await boardStore.renameBoard(next)
      if (!result.ok) setDraft(board.title)
    }
  }
  return bh('input', {
    className: 'tb-titleInput',
    value: draft,
    'aria-label': t('board.boardTitle'),
    title: t('board.boardTitle'),
    onChange: event => setDraft(event.target.value),
    onBlur: event => void commit(event.currentTarget.value),
    onKeyDown: event => {
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
      if (event.key === 'Escape') { setDraft(board.title); event.currentTarget.blur() }
    },
  })
}

/** Header: title, new-task button, search, sort, label manager and close. */
function TaskBoardHeader({ t, board, ui, onNewTask, onManageLabels }) {
  return bh('header', { className: 'tb-header' },
    bh(TaskBoardTitle, { t, board }),
    bh('div', { className: 'tb-search' },
      bh('span', { 'aria-hidden': 'true' }, '⌕'),
      bh('input', {
        type: 'search',
        value: ui.search,
        placeholder: t('board.searchPlaceholder'),
        'aria-label': t('board.searchPlaceholder'),
        onChange: event => boardUiStore.update({ search: event.target.value }),
      })),
    bh('select', {
      className: 'tb-select',
      value: ui.sort,
      'aria-label': t('board.sort'),
      onChange: event => boardUiStore.update({ sort: event.target.value }),
    },
    bh('option', { value: 'manual' }, t('board.sortManual')),
    bh('option', { value: 'due' }, t('board.sortDue')),
    bh('option', { value: 'priority' }, t('board.sortPriority')),
    bh('option', { value: 'created' }, t('board.sortCreated'))),
    bh('div', { className: 'tb-spacer' }),
    bh('button', { type: 'button', className: 'tb-newTaskBtn', onClick: onNewTask }, '+ ', t('board.newTask')),
    bh(TaskBoardIconButton, { label: t('label.manage'), title: t('label.manage'), onClick: onManageLabels }, '#'),
    bh(TaskBoardIconButton, { label: t('board.close'), onClick: () => boardUiStore.setOpen(false) }, '×'))
}

/** Error banner with retry. */
function TaskBoardErrorBar({ t, message }) {
  return bh('div', { className: 'tb-errorBar', role: 'alert' },
    bh('span', null, message),
    bh('button', { type: 'button', className: 'tb-btn', onClick: () => void boardStore.load() }, t('board.retry')))
}


/* ───────────────── task drawer, composer and label manager ───────────── */

/** Small select over the label palette. */
function TaskBoardColorSelect({ t, value, onChange, ariaLabel }) {
  return bh('select', {
    className: 'tb-select tb-colorSelect',
    value,
    'aria-label': ariaLabel,
    onChange: event => onChange(event.target.value),
  }, ...LABEL_COLORS.map(color => bh('option', { key: color, value: color }, t(`label.color.${color}`))))
}

/** Label assignment for one task (chips + a menu of the board's labels). */
function TaskBoardLabelPicker({ t, board, task, onManage }) {
  const [open, setOpen] = React.useState(false)
  const menuRef = React.useRef(null)
  const close = React.useCallback(() => setOpen(false), [])
  useOutsideDismiss(menuRef, open, close)
  const assigned = (task.labelIds ?? []).map(id => board.labels.find(label => label.id === id)).filter(label => label !== undefined)

  const toggle = async labelId => {
    const current = task.labelIds ?? []
    const next = current.includes(labelId) ? current.filter(id => id !== labelId) : [...current, labelId]
    await boardStore.updateTask(task.id, { labelIds: next })
  }

  return bh('div', { className: 'tb-field' },
    bh('span', { className: 'tb-fieldLabel' }, t('drawer.labels')),
    bh('div', { className: 'tb-labelTokens' },
      ...assigned.map(label => bh('span', {
        key: label.id,
        className: `tb-labelToken tb-color-${label.color}`,
      },
      bh('span', { className: 'tb-dot tb-colorTarget', 'aria-hidden': 'true' }),
      label.name,
      bh('button', {
        type: 'button',
        'aria-label': t('label.remove', { name: label.name }),
        onClick: () => void toggle(label.id),
      }, '×'))),
      bh('div', { className: 'tb-menuWrap', ref: menuRef },
        bh('button', {
          type: 'button',
          className: 'tb-quickBtn',
          'aria-expanded': open,
          onClick: () => setOpen(value => !value),
        }, '+ ', t('label.add')),
        open ? bh('div', { className: 'tb-menu', role: 'menu' },
          ...(board.labels.length === 0
            ? [bh('div', { key: 'none', className: 'tb-menuHeading' }, t('label.none'))]
            : board.labels.map(label => bh('button', {
              key: label.id,
              type: 'button',
              className: 'tb-menuItem',
              role: 'menuitemcheckbox',
              'aria-checked': (task.labelIds ?? []).includes(label.id),
              onClick: () => void toggle(label.id),
            },
            bh('span', { className: `tb-dot tb-color-${label.color} tb-colorTarget`, 'aria-hidden': 'true' }),
            label.name,
            (task.labelIds ?? []).includes(label.id) ? ' ✓' : ''))),
          bh('div', { className: 'tb-menuSeparator' }),
          bh('button', {
            type: 'button',
            className: 'tb-menuItem',
            role: 'menuitem',
            onClick: () => { setOpen(false); onManage() },
          }, t('label.manage'))) : null)))
}

/** Checklist of one task's subtasks, with inline add/delete/toggle. */
function TaskBoardSubtaskList({ t, task }) {
  const [draft, setDraft] = React.useState('')
  const subtasks = task.subtasks ?? []

  const add = async event => {
    event.preventDefault()
    const title = draft.trim()
    if (title.length === 0) return
    const result = await boardStore.addSubtask(task.id, title)
    if (result.ok) setDraft('')
  }

  return bh('div', { className: 'tb-field' },
    bh('span', { className: 'tb-fieldLabel' }, t('drawer.subtasks')),
    bh('div', { className: 'tb-subtasks' },
      ...subtasks.map(subtask => bh('div', {
        key: subtask.id,
        className: 'tb-subtask',
        'data-done': subtask.done ? 'true' : 'false',
      },
      bh('button', {
        type: 'button',
        className: 'tb-subtaskCheck',
        'data-done': subtask.done ? 'true' : 'false',
        'aria-label': subtask.done ? t('subtask.uncheck') : t('subtask.check'),
        'aria-pressed': subtask.done,
        onClick: () => void boardStore.updateSubtask(subtask.id, { done: !subtask.done }),
      }, '✓'),
      bh('span', { className: 'tb-subtaskTitle' }, subtask.title),
      bh(TaskBoardIconButton, {
        label: t('subtask.delete'),
        onClick: () => void boardStore.deleteSubtask(subtask.id),
      }, '×')))),
    subtasks.length === 0 ? bh('div', { className: 'tb-empty' }, t('drawer.noSubtasks')) : null,
    bh('form', { className: 'tb-subtaskAdd', onSubmit: event => void add(event) },
      bh('input', {
        value: draft,
        placeholder: t('subtask.placeholder'),
        'aria-label': t('subtask.placeholder'),
        onChange: event => setDraft(event.target.value),
      }),
      bh('button', { type: 'submit', className: 'tb-btn', disabled: draft.trim().length === 0 }, t('subtask.add'))))
}

/**
 * Right-hand task detail drawer: every editable field of one task, all writing
 * through `boardStore` with the host as the source of truth.
 */
function TaskBoardDrawer({ t, task, board, onClose, onManageLabels }) {
  const [title, setTitle] = React.useState(task.title)
  const [notes, setNotes] = React.useState(task.notes)
  const [estimate, setEstimate] = React.useState(task.estimateMin === null || task.estimateMin === undefined ? '' : String(task.estimateMin))
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const today = localDateKey()

  React.useEffect(() => { setTitle(task.title) }, [task.title])
  React.useEffect(() => { setNotes(task.notes) }, [task.notes])
  React.useEffect(() => {
    setEstimate(task.estimateMin === null || task.estimateMin === undefined ? '' : String(task.estimateMin))
  }, [task.estimateMin])

  const patch = fields => boardStore.updateTask(task.id, fields)

  const commitTitle = async value => {
    const next = String(value ?? title).trim()
    if (next.length === 0) { setTitle(task.title); return }
    if (next !== task.title) await patch({ title: next })
  }

  const commitNotes = async value => {
    if (value !== task.notes) await patch({ notes: value })
  }

  const commitEstimate = async value => {
    const raw = String(value).trim()
    if (raw.length === 0) { await patch({ estimateMin: null }); return }
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0) { setEstimate(task.estimateMin === null || task.estimateMin === undefined ? '' : String(task.estimateMin)); return }
    await patch({ estimateMin: Math.round(parsed) })
  }

  const remove = async () => {
    const result = await boardStore.deleteTask(task.id)
    if (result.ok) onClose()
  }

  const dueQuick = days => {
    const value = days === null ? null : shiftDateKey(today, days)
    void patch({ dueDate: value })
  }

  return bh('aside', {
    className: 'tb-drawer',
    role: 'dialog',
    'aria-label': t('drawer.title'),
  },
  bh('header', { className: 'tb-drawerHeader' },
    bh('span', { className: 'tb-drawerHeading' }, t('drawer.title')),
    bh(TaskBoardIconButton, { label: t('drawer.close'), onClick: onClose }, '×')),
  bh('div', { className: 'tb-drawerBody' },
    bh('div', { className: 'tb-field' },
      bh('span', { className: 'tb-fieldLabel' }, t('field.title')),
      bh('input', {
        className: 'tb-fieldInput',
        value: title,
        'aria-label': t('field.title'),
        onChange: event => setTitle(event.target.value),
        onBlur: event => void commitTitle(event.currentTarget.value),
        onKeyDown: event => {
          if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
          if (event.key === 'Escape') { setTitle(task.title); event.currentTarget.blur() }
        },
      })),
    bh('div', { className: 'tb-fieldRow' },
      bh('div', { className: 'tb-field' },
        bh('span', { className: 'tb-fieldLabel' }, t('field.list')),
        bh('select', {
          className: 'tb-fieldSelect',
          value: task.listId,
          'aria-label': t('field.list'),
          onChange: event => void boardStore.moveTask(task.id, event.target.value),
        }, ...board.lists.map(list => bh('option', { key: list.id, value: list.id }, list.title)))),
      bh('div', { className: 'tb-field' },
        bh('span', { className: 'tb-fieldLabel' }, t('field.priority')),
        bh('select', {
          className: 'tb-fieldSelect',
          value: task.priority,
          'aria-label': t('field.priority'),
          onChange: event => void patch({ priority: event.target.value }),
        }, ...PRIORITIES.map(priority => bh('option', { key: priority, value: priority }, t(`priority.${priority}`)))))),
    bh('div', { className: 'tb-field' },
      bh('span', { className: 'tb-fieldLabel' }, t('field.due')),
      bh('input', {
        type: 'date',
        className: 'tb-fieldInput',
        value: task.dueDate ?? '',
        'aria-label': t('field.due'),
        onChange: event => void patch({ dueDate: event.target.value.length === 0 ? null : event.target.value }),
      }),
      bh('div', { className: 'tb-quickRow' },
        bh('button', { type: 'button', className: 'tb-quickBtn', onClick: () => dueQuick(0) }, t('due.quickToday')),
        bh('button', { type: 'button', className: 'tb-quickBtn', onClick: () => dueQuick(1) }, t('due.quickTomorrow')),
        bh('button', { type: 'button', className: 'tb-quickBtn', onClick: () => dueQuick(7) }, t('due.quickWeek')),
        bh('button', { type: 'button', className: 'tb-quickBtn', onClick: () => dueQuick(null) }, t('due.clear')))),
    bh('div', { className: 'tb-field' },
      bh('span', { className: 'tb-fieldLabel' }, t('field.estimate')),
      bh('input', {
        type: 'number',
        min: 0,
        step: 5,
        className: 'tb-fieldInput',
        value: estimate,
        placeholder: t('estimate.placeholder'),
        'aria-label': t('field.estimate'),
        onChange: event => setEstimate(event.target.value),
        onBlur: event => void commitEstimate(event.currentTarget.value),
        onKeyDown: event => { if (event.key === 'Enter') event.currentTarget.blur() },
      }),
      bh('div', { className: 'tb-quickRow' },
        ...[15, 25, 45, 60, 90, 120].map(minutes => bh('button', {
          key: minutes,
          type: 'button',
          className: 'tb-quickBtn',
          onClick: () => { setEstimate(String(minutes)); void patch({ estimateMin: minutes }) },
        }, `${minutes}m`)),
        bh('button', {
          type: 'button',
          className: 'tb-quickBtn',
          onClick: () => { setEstimate(''); void patch({ estimateMin: null }) },
        }, t('estimate.clear')))),
    bh(TaskBoardLabelPicker, { t, board, task, onManage: onManageLabels }),
    bh('div', { className: 'tb-field' },
      bh('span', { className: 'tb-fieldLabel' }, t('field.notes')),
      bh('textarea', {
        className: 'tb-fieldTextarea',
        value: notes,
        'aria-label': t('field.notes'),
        onChange: event => setNotes(event.target.value),
        onBlur: event => void commitNotes(event.currentTarget.value),
      })),
    bh(TaskBoardSubtaskList, { t, task }),
    bh('div', { className: 'tb-meta' },
      bh('span', null, `${t('drawer.createdAt')}: ${formatTimestamp(task.createdAt)}`),
      bh('span', null, `${t('drawer.updatedAt')}: ${formatTimestamp(task.updatedAt)}`),
      task.completedAt !== null && task.completedAt !== undefined
        ? bh('span', null, `${t('drawer.completedAt')}: ${formatTimestamp(task.completedAt)}`)
        : null,
      bh('span', null, `${t('drawer.timeSpent')}: ${formatElapsed(task.timeSpentMs)} · ${t('drawer.pomodoros')}: ${task.pomodoros}`))),
  confirmDelete
    ? bh('div', { className: 'tb-drawerFooter' },
      bh('span', { className: 'tb-errorInline' }, t('drawer.deleteConfirm')),
      bh('button', { type: 'button', className: 'tb-btn', onClick: () => setConfirmDelete(false) }, t('action.cancel')),
      bh('button', { type: 'button', className: 'tb-btn', 'data-variant': 'danger', onClick: () => void remove() }, t('action.delete')))
    : bh('div', { className: 'tb-drawerFooter' },
      bh('button', { type: 'button', className: 'tb-btn', 'data-variant': 'danger', onClick: () => setConfirmDelete(true) }, t('drawer.delete')),
      bh('div', { className: 'tb-spacer' }),
      bh('button', { type: 'button', className: 'tb-btn', onClick: onClose }, t('action.close'))))
}

/** Full task composer, opened from the board header. */
function TaskBoardComposerDialog({ t, board, onClose }) {
  const firstOpen = board.lists.find(list => !list.isDone) ?? board.lists[0]
  const [title, setTitle] = React.useState('')
  const [listId, setListId] = React.useState(firstOpen?.id ?? '')
  const [priority, setPriority] = React.useState('none')
  const [due, setDue] = React.useState('')
  const [estimate, setEstimate] = React.useState('')
  const [labelIds, setLabelIds] = React.useState([])
  const [notes, setNotes] = React.useState('')
  const [subtasks, setSubtasks] = React.useState([])
  const [subDraft, setSubDraft] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const titleRef = React.useRef(null)

  React.useEffect(() => { titleRef.current?.focus() }, [])

  const toggleLabel = id => setLabelIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])

  const addSubtask = () => {
    const value = subDraft.trim()
    if (value.length === 0) return
    setSubtasks(current => [...current, { key: `${Date.now()}-${current.length}-${Math.random().toString(36).slice(2, 7)}`, title: value }])
    setSubDraft('')
  }

  const create = async event => {
    event.preventDefault()
    const clean = title.trim()
    if (clean.length === 0 || busy) return
    setBusy(true)
    const parsedEstimate = estimate.trim().length === 0 ? null : Math.round(Number(estimate))
    const result = await boardStore.createTask(listId, clean, {
      priority,
      dueDate: due.length === 0 ? null : due,
      estimateMin: Number.isFinite(parsedEstimate) ? parsedEstimate : null,
      labelIds,
      notes,
      subtasks: subtasks.map(subtask => ({ title: subtask.title })),
    })
    setBusy(false)
    if (result.ok) onClose()
  }

  const estimateValid = estimate.trim().length === 0 || (Number.isFinite(Number(estimate)) && Number(estimate) >= 0)

  return bh('div', {
    className: 'tb-modalBackdrop',
    onMouseDown: event => { if (event.target === event.currentTarget) onClose() },
  },
  bh('form', { className: 'tb-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('composer.title'), onSubmit: event => void create(event) },
    bh('header', { className: 'tb-modalHeader' },
      bh('span', { className: 'tb-modalTitle' }, t('composer.title')),
      bh(TaskBoardIconButton, { label: t('action.close'), onClick: onClose }, '×')),
    bh('div', { className: 'tb-modalBody' },
      bh('div', { className: 'tb-field' },
        bh('span', { className: 'tb-fieldLabel' }, t('field.title')),
        bh('input', {
          ref: titleRef,
          className: 'tb-fieldInput',
          value: title,
          'aria-label': t('field.title'),
          placeholder: t('board.taskTitlePlaceholder'),
          onChange: event => setTitle(event.target.value),
        })),
      bh('div', { className: 'tb-fieldRow' },
        bh('div', { className: 'tb-field' },
          bh('span', { className: 'tb-fieldLabel' }, t('field.list')),
          bh('select', {
            className: 'tb-fieldSelect',
            value: listId,
            'aria-label': t('field.list'),
            onChange: event => setListId(event.target.value),
          }, ...board.lists.map(list => bh('option', { key: list.id, value: list.id }, list.title)))),
        bh('div', { className: 'tb-field' },
          bh('span', { className: 'tb-fieldLabel' }, t('field.priority')),
          bh('select', {
            className: 'tb-fieldSelect',
            value: priority,
            'aria-label': t('field.priority'),
            onChange: event => setPriority(event.target.value),
          }, ...PRIORITIES.map(value => bh('option', { key: value, value }, t(`priority.${value}`)))))),
      bh('div', { className: 'tb-fieldRow' },
        bh('div', { className: 'tb-field' },
          bh('span', { className: 'tb-fieldLabel' }, t('field.due')),
          bh('input', {
            type: 'date',
            className: 'tb-fieldInput',
            value: due,
            'aria-label': t('field.due'),
            onChange: event => setDue(event.target.value),
          })),
        bh('div', { className: 'tb-field' },
          bh('span', { className: 'tb-fieldLabel' }, t('field.estimate')),
          bh('input', {
            type: 'number',
            min: 0,
            step: 5,
            className: 'tb-fieldInput',
            value: estimate,
            placeholder: t('estimate.placeholder'),
            'aria-label': t('field.estimate'),
            onChange: event => setEstimate(event.target.value),
          }))),
      board.labels.length > 0
        ? bh('div', { className: 'tb-field' },
          bh('span', { className: 'tb-fieldLabel' }, t('drawer.labels')),
          bh('div', { className: 'tb-checkList' },
            ...board.labels.map(label => bh('button', {
              key: label.id,
              type: 'button',
              className: 'tb-checkItem',
              'data-checked': labelIds.includes(label.id) ? 'true' : 'false',
              'aria-pressed': labelIds.includes(label.id),
              onClick: () => toggleLabel(label.id),
            },
            bh('span', { className: `tb-dot tb-color-${label.color} tb-colorTarget`, 'aria-hidden': 'true' }),
            label.name))))
        : null,
      bh('div', { className: 'tb-field' },
        bh('span', { className: 'tb-fieldLabel' }, t('field.notes')),
        bh('textarea', {
          className: 'tb-fieldTextarea',
          value: notes,
          'aria-label': t('field.notes'),
          onChange: event => setNotes(event.target.value),
        })),
      bh('div', { className: 'tb-field' },
        bh('span', { className: 'tb-fieldLabel' }, t('composer.subtasks')),
        ...subtasks.map(subtask => bh('div', { key: subtask.key, className: 'tb-subtaskDraftRow' },
          bh('input', {
            value: subtask.title,
            'aria-label': t('subtask.placeholder'),
            onChange: event => setSubtasks(current => current.map(item => item.key === subtask.key ? { ...item, title: event.target.value } : item)),
          }),
          bh(TaskBoardIconButton, {
            label: t('subtask.delete'),
            onClick: () => setSubtasks(current => current.filter(item => item.key !== subtask.key)),
          }, '×'))),
        bh('div', { className: 'tb-subtaskAdd' },
          bh('input', {
            value: subDraft,
            placeholder: t('subtask.placeholder'),
            'aria-label': t('subtask.placeholder'),
            onChange: event => setSubDraft(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Enter') { event.preventDefault(); addSubtask() }
            },
          }),
          bh('button', { type: 'button', className: 'tb-btn', onClick: addSubtask }, t('subtask.add'))))),
    bh('footer', { className: 'tb-modalFooter' },
      estimateValid ? null : bh('span', { className: 'tb-errorInline' }, t('composer.invalidEstimate')),
      bh('div', { className: 'tb-spacer' }),
      bh('button', { type: 'button', className: 'tb-btn', onClick: onClose }, t('action.cancel')),
      bh('button', { type: 'submit', className: 'tb-btn', 'data-variant': 'primary', disabled: title.trim().length === 0 || busy }, t('composer.create')))))
}

/** Board-wide label manager: create, recolor and delete labels. */
function TaskBoardLabelManager({ t, board, onClose }) {
  const [name, setName] = React.useState('')
  const [color, setColor] = React.useState('blue')
  const [pendingDelete, setPendingDelete] = React.useState(null)

  const create = async event => {
    event.preventDefault()
    const clean = name.trim()
    if (clean.length === 0) return
    const result = await boardStore.createLabel(clean, color)
    if (result.ok) setName('')
  }

  return bh('div', {
    className: 'tb-modalBackdrop',
    onMouseDown: event => { if (event.target === event.currentTarget) onClose() },
  },
  bh('div', { className: 'tb-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('label.manage') },
    bh('header', { className: 'tb-modalHeader' },
      bh('span', { className: 'tb-modalTitle' }, t('label.manage')),
      bh(TaskBoardIconButton, { label: t('action.close'), onClick: onClose }, '×')),
    bh('div', { className: 'tb-modalBody' },
      board.labels.length === 0 ? bh('div', { className: 'tb-empty' }, t('label.none')) : null,
      ...board.labels.map(label => bh('div', { key: label.id, className: 'tb-labelManageRow' },
        bh('span', { className: `tb-dot tb-color-${label.color} tb-colorTarget`, 'aria-hidden': 'true' }),
        bh('span', { className: 'tb-labelName' }, label.name),
        bh(TaskBoardColorSelect, {
          t,
          value: label.color,
          ariaLabel: t('label.color', { name: label.name }),
          onChange: next => void boardStore.updateLabel(label.id, { color: next }),
        }),
        pendingDelete === label.id
          ? bh(React.Fragment, null,
            bh('button', { type: 'button', className: 'tb-btn', onClick: () => setPendingDelete(null) }, t('action.cancel')),
            bh('button', { type: 'button', className: 'tb-btn', 'data-variant': 'danger', onClick: () => void boardStore.deleteLabel(label.id).then(() => setPendingDelete(null)) }, t('label.deleteConfirm')))
          : bh(TaskBoardIconButton, { label: t('label.delete', { name: label.name }), onClick: () => setPendingDelete(label.id) }, '×'))),
      bh('form', { className: 'tb-labelManageRow', onSubmit: event => void create(event) },
        bh('input', {
          className: 'tb-fieldInput',
          value: name,
          placeholder: t('label.namePlaceholder'),
          'aria-label': t('label.namePlaceholder'),
          onChange: event => setName(event.target.value),
        }),
        bh(TaskBoardColorSelect, { t, value: color, ariaLabel: t('label.color', { name }), onChange: setColor }),
        bh('button', { type: 'submit', className: 'tb-btn', 'data-variant': 'primary', disabled: name.trim().length === 0 }, t('label.create')))),
    bh('footer', { className: 'tb-modalFooter' },
      bh('div', { className: 'tb-spacer' }),
      bh('button', { type: 'button', className: 'tb-btn', onClick: onClose }, t('action.close')))))
}

/**
 * The whole board overlay. Renders nothing while closed; otherwise a modal card
 * with the smart-section rail, the metric bar and the filtered columns.
 * @param {{t: Function}} props - namespace translator.
 * @returns {object|null} React element or null.
 */
export function TaskBoardPanel({ t }) {
  const ui = useBoardUi()
  const data = useBoardData()
  const open = ui.open
  const [selectedTaskId, setSelectedTaskId] = BoardReact.useState(null)
  const [composerOpen, setComposerOpen] = BoardReact.useState(false)
  const [labelsOpen, setLabelsOpen] = BoardReact.useState(false)

  BoardReact.useEffect(() => {
    if (open) void boardStore.open()
    else boardStore.close()
  }, [open])

  BoardReact.useEffect(() => {
    if (open) return
    setSelectedTaskId(null)
    setComposerOpen(false)
    setLabelsOpen(false)
  }, [open])

  BoardReact.useEffect(() => {
    if (!open) return undefined
    const onKeyDown = event => {
      if (event.key !== 'Escape') return
      const target = event.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return
      }
      // Close the topmost surface first.
      if (composerOpen) { setComposerOpen(false); return }
      if (labelsOpen) { setLabelsOpen(false); return }
      if (selectedTaskId !== null) { setSelectedTaskId(null); return }
      boardUiStore.setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open, composerOpen, labelsOpen, selectedTaskId])

  // Compute the derived values and run every hook before the early return, so a
  // closed/open toggle never changes the hook count between renders.
  const board = data.board
  const today = localDateKey()
  const selectedTask = board === null || selectedTaskId === null
    ? null
    : (board.tasks.find(task => task.id === selectedTaskId) ?? null)

  BoardReact.useEffect(() => {
    if (selectedTaskId !== null && board !== null && selectedTask === null) setSelectedTaskId(null)
  }, [selectedTaskId, selectedTask, board])

  if (!open) return null

  const body = board === null
    ? bh('div', { className: 'tb-loading' }, data.status === 'error' ? t('board.loadError') : t('board.loading'))
    : (() => {
      const counts = sectionCounts(board, today)
      const filtered = filterTasks(board, { section: ui.section, search: ui.search, labelIds: ui.labelIds, today })
      const ordered = sortTasks(filtered, ui.sort, board)
      const groups = groupByList(board, ordered)
      return bh(BoardReact.Fragment, null,
        bh(TaskBoardStats, { t, tasks: ordered, ui }),
        bh('div', { className: 'tb-columns' },
          ...board.lists.map(list => bh(TaskBoardColumn, {
            key: list.id,
            t,
            list,
            board,
            today,
            tasks: groups.get(list.id) ?? [],
            onOpen: setSelectedTaskId,
          })),
          bh(TaskBoardAddColumn, { key: '__add', t })))
    })()

  return bh('div', {
    className: 'tb-backdrop',
    onMouseDown: event => { if (event.target === event.currentTarget) boardUiStore.setOpen(false) },
  },
  bh('div', {
    className: 'tb-panel',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': t('board.title'),
  },
  bh(TaskBoardHeader, {
    t,
    board: board ?? { title: '' },
    ui,
    onNewTask: () => setComposerOpen(true),
    onManageLabels: () => setLabelsOpen(true),
  }),
  data.error !== null ? bh(TaskBoardErrorBar, { t, message: data.error }) : null,
  bh('div', { className: 'tb-body' },
    board === null ? null : bh(TaskBoardRail, { t, board, ui, counts: sectionCounts(board, today) }),
    bh('div', { className: 'tb-main' }, body)),
  board !== null && selectedTask !== null
    ? bh(TaskBoardDrawer, {
      t,
      task: selectedTask,
      board,
      onClose: () => setSelectedTaskId(null),
      onManageLabels: () => setLabelsOpen(true),
    })
    : null,
  board !== null && composerOpen
    ? bh(TaskBoardComposerDialog, { t, board, onClose: () => setComposerOpen(false) })
    : null,
  board !== null && labelsOpen
    ? bh(TaskBoardLabelManager, { t, board, onClose: () => setLabelsOpen(false) })
    : null))
}
