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
function TaskBoardCard({ t, task, board, today }) {
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
    onClick: () => setMenuOpen(open => !open),
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
function TaskBoardColumn({ t, list, tasks, board, today }) {
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
      : tasks.map(task => bh(TaskBoardCard, { key: task.id, t, task, board, today })))),
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

/** Header: title, search, sort and close. */
function TaskBoardHeader({ t, board, ui }) {
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
    bh(TaskBoardIconButton, { label: t('board.close'), onClick: () => boardUiStore.setOpen(false) }, '×'))
}

/** Error banner with retry. */
function TaskBoardErrorBar({ t, message }) {
  return bh('div', { className: 'tb-errorBar', role: 'alert' },
    bh('span', null, message),
    bh('button', { type: 'button', className: 'tb-btn', onClick: () => void boardStore.load() }, t('board.retry')))
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

  BoardReact.useEffect(() => {
    if (open) void boardStore.open()
    else boardStore.close()
  }, [open])

  BoardReact.useEffect(() => {
    if (!open) return undefined
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        const target = event.target
        if (target instanceof HTMLElement) {
          const tag = target.tagName
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return
        }
        boardUiStore.setOpen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open])

  if (!open) return null

  const board = data.board
  const today = localDateKey()
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
  bh(TaskBoardHeader, { t, board: board ?? { title: '' }, ui }),
  data.error !== null ? bh(TaskBoardErrorBar, { t, message: data.error }) : null,
  bh('div', { className: 'tb-body' },
    board === null ? null : bh(TaskBoardRail, { t, board, ui, counts: sectionCounts(board, today) }),
    bh('div', { className: 'tb-main' }, body))))
}
