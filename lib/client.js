/**
 * GENERATED FILE — do not edit. Source: src/*.js, build: scripts/build.mjs.
 * DSH browser bundle for dsh-plugin-pomodoro.
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-pomodoro",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

// ─── src/timer-core.js ─────────────────────────────────────────────
/**
 * Pomodoro state machine — pure, framework-free, and side-effect free.
 *
 * The UI layer owns the clock (a 1s interval), storage, notifications and
 * locale. This module owns only the rules: what a phase is, when it ends,
 * what comes next, and how a state survives a reload.
 *
 * A running timer is represented by an absolute `deadline` (epoch ms), never
 * by a countdown the UI decrements. That keeps the timer honest across tab
 * throttling, sleep, and reloads: elapsed time is derived from the wall clock.
 *
 * @module dsh-plugin-pomodoro/timer-core
 */

/** The three phase kinds. */
const PHASE = Object.freeze({
  FOCUS: 'focus',
  SHORT_BREAK: 'shortBreak',
  LONG_BREAK: 'longBreak',
})

/** Lifecycle status of the pump. */
const STATUS = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
})

/** Defaults for everything the user can change. */
const DEFAULT_SETTINGS = Object.freeze({
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  longBreakEvery: 4,
  autoStartBreaks: true,
  autoStartFocus: false,
  sound: true,
  notify: true,
})

/** Settings are clamped to sane, integer, user-typeable ranges. */
const LIMITS = Object.freeze({
  focusMin: [1, 180],
  shortBreakMin: [1, 60],
  longBreakMin: [1, 120],
  longBreakEvery: [1, 12],
})

/**
 * Coerce a settings bag into the canonical shape.
 * Unknown keys are dropped, booleans are coerced, numbers clamped.
 * @param {Partial<typeof DEFAULT_SETTINGS>} [input] - untrusted settings.
 * @returns {typeof DEFAULT_SETTINGS} canonical settings.
 */
function normalizeSettings(input) {
  const src = input && typeof input === 'object' ? input : {}
  const out = { ...DEFAULT_SETTINGS }
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    const value = Number(src[key])
    if (Number.isFinite(value)) {
      out[key] = Math.min(max, Math.max(min, Math.round(value)))
    }
  }
  for (const key of ['autoStartBreaks', 'autoStartFocus', 'sound', 'notify']) {
    if (typeof src[key] === 'boolean') out[key] = src[key]
  }
  return out
}

/**
 * Duration of a phase in milliseconds.
 * @param {string} phase - one of {@link PHASE}.
 * @param {typeof DEFAULT_SETTINGS} settings - canonical settings.
 * @returns {number} duration in ms (at least one minute).
 */
function phaseDuration(phase, settings) {
  const minutes = phase === PHASE.FOCUS
    ? settings.focusMin
    : phase === PHASE.SHORT_BREAK
      ? settings.shortBreakMin
      : settings.longBreakMin
  return Math.max(1, minutes) * 60_000
}

/**
 * A fresh timer for the given settings, stopped at the start of a focus block.
 * @param {typeof DEFAULT_SETTINGS} settings - canonical settings.
 * @returns {object} initial state.
 */
function createState(settings) {
  const canonical = normalizeSettings(settings)
  return {
    phase: PHASE.FOCUS,
    status: STATUS.IDLE,
    remainingMs: phaseDuration(PHASE.FOCUS, canonical),
    deadline: null,
    completedFocus: 0,
    settings: canonical,
  }
}

/**
 * Remaining time in ms, honoring the running deadline.
 * @param {object} state - timer state.
 * @param {number} now - epoch ms.
 * @returns {number} non-negative remaining ms.
 */
function remaining(state, now) {
  if (state.status === STATUS.RUNNING && typeof state.deadline === 'number') {
    return Math.max(0, state.deadline - now)
  }
  return Math.max(0, state.remainingMs)
}

/**
 * Start or resume the current phase from a stopped state.
 * @param {object} state - timer state.
 * @param {number} now - epoch ms.
 * @returns {object} next state (running).
 */
function start(state, now) {
  if (state.status === STATUS.RUNNING) return state
  const remainingMs = Math.max(0, state.remainingMs)
  return { ...state, status: STATUS.RUNNING, deadline: now + remainingMs }
}

/**
 * Freeze the current phase, preserving the remaining time.
 * @param {object} state - timer state.
 * @param {number} now - epoch ms.
 * @returns {object} next state (paused).
 */
function pause(state, now) {
  if (state.status !== STATUS.RUNNING) return state
  return { ...state, status: STATUS.PAUSED, remainingMs: remaining(state, now), deadline: null }
}

/**
 * Return the current phase to its full duration and stop.
 * @param {object} state - timer state.
 * @returns {object} next state (idle, fresh current phase).
 */
function reset(state) {
  return {
    ...state,
    status: STATUS.IDLE,
    remainingMs: phaseDuration(state.phase, state.settings),
    deadline: null,
  }
}

/**
 * Move to the next phase in the cycle and stop (unless auto-start applies).
 * Skipping a focus block does not count it as completed.
 * @param {object} state - timer state.
 * @param {number} now - epoch ms.
 * @returns {object} next state.
 */
function skip(state, now) {
  return enterNext(state, now, false, false)
}

/**
 * Compute the phase that follows the current one, and whether it is a long break.
 * @param {object} state - timer state.
 * @param {boolean} completed - whether the finished phase counted as completed focus.
 * @returns {{phase: string, completedFocus: number}} the successor.
 */
function successor(state, completed) {
  if (state.phase === PHASE.FOCUS) {
    const completedFocus = state.completedFocus + (completed ? 1 : 0)
    const isLong = completedFocus > 0 && completedFocus % state.settings.longBreakEvery === 0
    return { phase: isLong ? PHASE.LONG_BREAK : PHASE.SHORT_BREAK, completedFocus }
  }
  return { phase: PHASE.FOCUS, completedFocus: state.completedFocus }
}

/**
 * Enter the successor phase, auto-starting it when settings ask for it.
 * @param {object} state - timer state.
 * @param {number} now - epoch ms at which the successor begins.
 * @param {boolean} completed - whether the finished phase counted.
 * @param {boolean} [autoStart] - override the settings-driven auto-start decision.
 * @returns {object} next state.
 */
function enterNext(state, now, completed, autoStart) {
  const { phase, completedFocus } = successor(state, completed)
  const next = {
    ...state,
    phase,
    completedFocus,
    remainingMs: phaseDuration(phase, state.settings),
    deadline: null,
    status: STATUS.IDLE,
  }
  const auto = autoStart ?? (phase === PHASE.FOCUS ? state.settings.autoStartFocus : state.settings.autoStartBreaks)
  return auto ? start(next, now) : next
}

/**
 * Advance the clock. Returns the same object when nothing changed, so callers
 * can cheaply skip re-renders; otherwise returns the new state plus the phase
 * that just finished (for notification/sound hooks).
 * @param {object} state - timer state.
 * @param {number} now - epoch ms.
 * @returns {{state: object, completed: string|null}} tick result.
 */
function tick(state, now) {
  if (state.status !== STATUS.RUNNING || typeof state.deadline !== 'number') {
    return { state, completed: null }
  }
  if (now < state.deadline) return { state, completed: null }
  const completedPhase = state.phase
  // Complete at the exact deadline, not at the (possibly late) tick time, so an
  // auto-started successor inherits the true leftover budget.
  return { state: enterNext(state, state.deadline, completedPhase === PHASE.FOCUS), completed: completedPhase }
}

/**
 * Catch up a persisted state after the page was closed or suspended.
 *
 * Automatically started phases keep chaining until either a phase is left
 * stopped at full duration or the catch-up budget is exhausted, which keeps a
 * week-old tab from replaying hundreds of pomodoros. Each completed phase is
 * reported so the UI can announce the last one.
 * @param {object} state - persisted state.
 * @param {number} now - epoch ms.
 * @param {number} [budget] - maximum transitions to replay.
 * @returns {{state: object, completed: string[]}} caught-up state and finished phases.
 */
function catchUp(state, now, budget = 24) {
  let current = state
  const completed = []
  while (
    completed.length < budget
    && current.status === STATUS.RUNNING
    && typeof current.deadline === 'number'
    && current.deadline <= now
  ) {
    const finished = current.phase
    current = enterNext(current, current.deadline, finished === PHASE.FOCUS)
    completed.push(finished)
  }
  // Long absences: stop the chain instead of pretending the user is still there.
  if (completed.length >= budget && current.status === STATUS.RUNNING) {
    current = { ...current, status: STATUS.IDLE, deadline: null, remainingMs: phaseDuration(current.phase, current.settings) }
  }
  return { state: current, completed }
}

/**
 * Update settings. A duration change only rewrites the current phase when it is
 * stopped at full length, so editing settings never silently moves a live clock.
 * @param {object} state - timer state.
 * @param {Partial<typeof DEFAULT_SETTINGS>} patch - partial settings.
 * @returns {object} next state.
 */
function updateSettings(state, patch) {
  const settings = normalizeSettings({ ...state.settings, ...patch })
  const wasFull = state.status !== STATUS.RUNNING
    && state.remainingMs === phaseDuration(state.phase, state.settings)
  const next = { ...state, settings }
  return wasFull ? { ...next, remainingMs: phaseDuration(state.phase, settings) } : next
}

/**
 * Serialize state for storage. Deadlines are stored as absolute epoch ms, so
 * the clock keeps running while the page is gone.
 * @param {object} state - timer state.
 * @returns {object} JSON-safe record.
 */
function serialize(state) {
  return {
    v: 1,
    phase: state.phase,
    status: state.status,
    remainingMs: state.remainingMs,
    deadline: state.deadline,
    completedFocus: state.completedFocus,
    settings: state.settings,
  }
}

/**
 * Rehydrate a persisted record, tolerating any corruption.
 * @param {unknown} raw - parsed JSON value.
 * @param {number} now - epoch ms.
 * @returns {object} usable state (falls back to a fresh timer).
 */
function deserialize(raw, now) {
  if (!raw || typeof raw !== 'object') return createState(DEFAULT_SETTINGS)
  const record = /** @type {Record<string, unknown>} */ (raw)
  const settings = normalizeSettings(record.settings)
  const phase = record.phase === PHASE.SHORT_BREAK || record.phase === PHASE.LONG_BREAK
    ? record.phase
    : PHASE.FOCUS
  const status = record.status === STATUS.RUNNING || record.status === STATUS.PAUSED
    ? record.status
    : STATUS.IDLE
  const completedFocus = Number.isFinite(Number(record.completedFocus))
    ? Math.max(0, Math.round(Number(record.completedFocus)))
    : 0
  const duration = phaseDuration(phase, settings)
  let remainingMs = Number.isFinite(Number(record.remainingMs))
    ? Math.min(duration, Math.max(0, Number(record.remainingMs)))
    : duration
  let deadline = status === STATUS.RUNNING && Number.isFinite(Number(record.deadline))
    ? Number(record.deadline)
    : null
  if (status === STATUS.RUNNING && deadline === null) {
    // A running record without a deadline cannot be trusted; fall back to paused.
    return { phase, status: STATUS.PAUSED, remainingMs, deadline: null, completedFocus, settings }
  }
  if (status === STATUS.IDLE) remainingMs = duration
  return { phase, status, remainingMs, deadline, completedFocus, settings }
}

/**
 * Human-readable MM:SS (or H:MM:SS past an hour).
 * @param {number} ms - remaining milliseconds.
 * @returns {string} formatted clock.
 */
function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${String(hours)}:${mm}:${ss}` : `${mm}:${ss}`
}

/**
 * 0..1 fraction of the current phase still remaining (1 = full, 0 = done).
 * @param {object} state - timer state.
 * @param {number} now - epoch ms.
 * @returns {number} progress fraction.
 */
function fractionRemaining(state, now) {
  const total = phaseDuration(state.phase, state.settings)
  if (total <= 0) return 0
  return Math.min(1, Math.max(0, remaining(state, now) / total))
}

/**
 * Position in the long-break cycle: how many focus blocks are done since the
 * last long break (0..longBreakEvery-1), used for the cycle dots.
 * @param {object} state - timer state.
 * @returns {number} completed focus blocks in the current cycle.
 */
function cycleProgress(state) {
  const every = Math.max(1, state.settings.longBreakEvery)
  return state.completedFocus % every
}

// ─── src/locales.js ─────────────────────────────────────────────
/**
 * Locale dictionaries for the Pomodoro plugin.
 *
 * Flat key -> template strings with `{name}` placeholders, exactly what the
 * client locale registry consumes: zh is the source of truth every shipped
 * namespace keeps, en is the translation, and the lookup chain falls back from
 * the active locale to zh. Keys are stable strings rather than typed, because
 * this bundle is plain JavaScript (the registry's TypeScript typing is a
 * build-time convenience for package authors, not a runtime requirement).
 *
 * @module dsh-plugin-pomodoro/locales
 */

/** Registry namespace owned by this plugin. */
const NS = 'pomodoro'

/** English copy. */
const en = {
  'widget.label': 'Pomodoro timer',
  'widget.open': 'Open Pomodoro timer',
  'widget.collapse': 'Collapse Pomodoro timer',
  'widget.expand': 'Expand Pomodoro timer',

  'phase.focus': 'Focus',
  'phase.shortBreak': 'Short break',
  'phase.longBreak': 'Long break',

  'status.idle': 'ready',
  'status.running': 'running',
  'status.paused': 'paused',

  'action.start': 'Start',
  'action.resume': 'Resume',
  'action.pause': 'Pause',
  'action.skip': 'Skip phase',
  'action.reset': 'Reset phase',
  'action.settings': 'Timer settings',
  'action.back': 'Back to timer',
  'action.close': 'Close',

  'timer.aria': 'Pomodoro timer: {phase}, {time} remaining, {status}',
  'timer.remaining': '{time} remaining',
  'timer.cycle': '{done} of {total} focus blocks in this cycle',
  'timer.sessionCount': '{count} focus blocks completed',

  'done.focus': 'Focus block complete. Time for a break.',
  'done.shortBreak': 'Break over. Ready for the next focus block?',
  'done.longBreak': 'Long break over. A fresh cycle is ready.',

  'settings.title': 'Timer settings',
  'settings.focus': 'Focus length',
  'settings.shortBreak': 'Short break length',
  'settings.longBreak': 'Long break length',
  'settings.every': 'Long break every',
  'settings.minutes': '{minutes} min',
  'settings.blocks': '{count} blocks',
  'settings.autoBreaks': 'Auto-start breaks',
  'settings.autoBreaksHint': 'Begin each break as soon as focus ends.',
  'settings.autoFocus': 'Auto-start focus',
  'settings.autoFocusHint': 'Begin the next focus block as soon as a break ends.',
  'settings.sound': 'Chime',
  'settings.soundHint': 'Play a short chime when a phase ends.',
  'settings.notify': 'Desktop notifications',
  'settings.notifyHint': 'Ask the browser to announce finished phases.',
  'settings.decrease': 'Decrease',
  'settings.increase': 'Increase',

  'config.summaryOn': 'Timer widget is shown.',
  'config.summaryOff': 'Timer widget is hidden.',
  'config.widgetHeading': 'Widget',
  'config.widgetHint': 'Show the timer pill over the app. The clock keeps running while it is hidden.',
  'config.widget': 'Floating timer',
  'config.durationsHeading': 'Focus and break lengths',
  'config.behaviourHeading': 'Cycle behaviour',
  'config.signalsHeading': 'Completion signals',
  'config.note': 'These settings live in this browser. To unload the plugin entirely, switch off its bundle or Component row on the bundle page.',

  'board.open': 'Open task board',
  'board.title': 'Task board',
  'board.boardTitle': 'Board title',
  'board.close': 'Close task board',
  'board.loading': 'Loading board…',
  'board.loadError': 'The task board host is unavailable.',
  'board.retry': 'Retry',
  'board.searchPlaceholder': 'Search tasks, notes, labels…',
  'board.sections': 'Sections',
  'board.labels': 'Labels',
  'board.sort': 'Order',
  'board.sortManual': 'Manual',
  'board.sortDue': 'Due date',
  'board.sortPriority': 'Priority',
  'board.sortCreated': 'Newest',
  'board.newList': 'New list',
  'board.listTitlePlaceholder': 'List title',
  'board.addTask': 'Add task',
  'board.taskTitlePlaceholder': 'Task title',
  'board.listMenu': 'List actions',
  'board.estimateMode': 'Estimate scope',
  'board.estimateAll': 'All tasks',
  'board.estimateOpen': 'Open only',
  'board.noTasks': 'No tasks here yet.',

  'section.all': 'All tasks',
  'section.today': 'Today',
  'section.overdue': 'Overdue',
  'section.tomorrow': 'Tomorrow',
  'section.thisWeek': 'This week',
  'section.next7': 'Next 7 days',
  'section.high': 'High priority',
  'section.medium': 'Medium priority',
  'section.low': 'Low priority',
  'section.noDue': 'No due date',
  'section.completed': 'Completed',

  'stats.estimated': 'Estimated time',
  'stats.open': 'To complete',
  'stats.elapsed': 'Elapsed time',
  'stats.completed': 'Completed',

  'priority.low': 'Low',
  'priority.medium': 'Medium',
  'priority.high': 'High',

  'due.overdue': 'Overdue {days}d',
  'due.today': 'Today',
  'due.tomorrow': 'Tomorrow',
  'due.inDays': 'In {days}d',

  'list.title': 'List title',
  'list.setDone': 'Completes tasks in this list',
  'list.unsetDone': 'Stop completing tasks here',
  'list.delete': 'Delete list',
  'list.confirmDelete': 'Delete “{name}”? Its tasks move to the list you pick.',
  'list.moveTasksTo': 'Move its tasks to',

  'card.complete': 'Mark complete',
  'card.uncomplete': 'Mark incomplete',
  'card.menu': 'Task actions',
  'card.moveTo': 'Move to list',
  'card.delete': 'Delete task',
  'card.subtasks': '{done}/{total} subtasks',

  'action.cancel': 'Cancel',

  'notify.focusDone': 'Focus block complete',
  'notify.focusBody': 'Take a {minutes}-minute break.',
  'notify.breakDone': 'Break over',
  'notify.breakBody': 'Start your next {minutes}-minute focus block.',
  'notify.denied': 'Notifications are blocked in this browser.',
}

/** Chinese copy (source-of-truth locale beside English). */
const zh = {
  'widget.label': '番茄钟',
  'widget.open': '打开番茄钟',
  'widget.collapse': '收起番茄钟',
  'widget.expand': '展开番茄钟',

  'phase.focus': '专注',
  'phase.shortBreak': '短休息',
  'phase.longBreak': '长休息',

  'status.idle': '就绪',
  'status.running': '进行中',
  'status.paused': '已暂停',

  'action.start': '开始',
  'action.resume': '继续',
  'action.pause': '暂停',
  'action.skip': '跳过此阶段',
  'action.reset': '重置此阶段',
  'action.settings': '计时设置',
  'action.back': '返回计时器',
  'action.close': '关闭',

  'timer.aria': '番茄钟：{phase}，剩余 {time}，{status}',
  'timer.remaining': '剩余 {time}',
  'timer.cycle': '本轮已完成 {done}/{total} 个专注',
  'timer.sessionCount': '已完成 {count} 个专注',

  'done.focus': '专注结束，该休息了。',
  'done.shortBreak': '休息结束，准备下一轮专注。',
  'done.longBreak': '长休息结束，可以开始新一轮了。',

  'settings.title': '计时设置',
  'settings.focus': '专注时长',
  'settings.shortBreak': '短休息时长',
  'settings.longBreak': '长休息时长',
  'settings.every': '长休息间隔',
  'settings.minutes': '{minutes} 分钟',
  'settings.blocks': '{count} 个',
  'settings.autoBreaks': '自动开始休息',
  'settings.autoBreaksHint': '专注结束后立即开始休息。',
  'settings.autoFocus': '自动开始专注',
  'settings.autoFocusHint': '休息结束后立即开始下一轮专注。',
  'settings.sound': '提示音',
  'settings.soundHint': '阶段结束时播放简短提示音。',
  'settings.notify': '桌面通知',
  'settings.notifyHint': '允许浏览器在阶段结束时提醒。',
  'settings.decrease': '减少',
  'settings.increase': '增加',

  'config.summaryOn': '计时器已显示。',
  'config.summaryOff': '计时器已隐藏。',
  'config.widgetHeading': '悬浮计时器',
  'config.widgetHint': '在应用上方显示计时器悬浮条；隐藏后计时仍会继续。',
  'config.widget': '悬浮计时器',
  'config.durationsHeading': '专注与休息时长',
  'config.behaviourHeading': '循环行为',
  'config.signalsHeading': '结束提醒',
  'config.note': '这些设置保存在当前浏览器。如需完全卸载插件，请在插件包页面关闭对应的插件包或组件开关。',

  'board.open': '打开任务看板',
  'board.title': '任务看板',
  'board.boardTitle': '看板标题',
  'board.close': '关闭任务看板',
  'board.loading': '正在加载看板…',
  'board.loadError': '任务看板服务不可用。',
  'board.retry': '重试',
  'board.searchPlaceholder': '搜索任务、备注、标签…',
  'board.sections': '分组',
  'board.labels': '标签',
  'board.sort': '排序',
  'board.sortManual': '手动',
  'board.sortDue': '到期日',
  'board.sortPriority': '优先级',
  'board.sortCreated': '最新创建',
  'board.newList': '新建列表',
  'board.listTitlePlaceholder': '列表名称',
  'board.addTask': '添加任务',
  'board.taskTitlePlaceholder': '任务标题',
  'board.listMenu': '列表操作',
  'board.estimateMode': '预估范围',
  'board.estimateAll': '全部任务',
  'board.estimateOpen': '仅未完成',
  'board.noTasks': '这里还没有任务。',

  'section.all': '全部任务',
  'section.today': '今天',
  'section.overdue': '已逾期',
  'section.tomorrow': '明天',
  'section.thisWeek': '本周',
  'section.next7': '未来 7 天',
  'section.high': '高优先级',
  'section.medium': '中优先级',
  'section.low': '低优先级',
  'section.noDue': '无到期日',
  'section.completed': '已完成',

  'stats.estimated': '预计耗时',
  'stats.open': '待完成',
  'stats.elapsed': '已用时间',
  'stats.completed': '已完成',

  'priority.low': '低',
  'priority.medium': '中',
  'priority.high': '高',

  'due.overdue': '逾期 {days} 天',
  'due.today': '今天',
  'due.tomorrow': '明天',
  'due.inDays': '{days} 天后',

  'list.title': '列表名称',
  'list.setDone': '此列表中的任务视为完成',
  'list.unsetDone': '此列表中的任务不再自动完成',
  'list.delete': '删除列表',
  'list.confirmDelete': '删除“{name}”？其任务将移动到所选的列表。',
  'list.moveTasksTo': '将其任务移动到',

  'card.complete': '标记完成',
  'card.uncomplete': '标记未完成',
  'card.menu': '任务操作',
  'card.moveTo': '移动到列表',
  'card.delete': '删除任务',
  'card.subtasks': '{done}/{total} 个子任务',

  'action.cancel': '取消',

  'notify.focusDone': '专注完成',
  'notify.focusBody': '休息 {minutes} 分钟。',
  'notify.breakDone': '休息结束',
  'notify.breakBody': '开始下一轮 {minutes} 分钟的专注。',
  'notify.denied': '浏览器已阻止通知。',
}

// ─── src/tasks-core.js ─────────────────────────────────────────────
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
const SECTIONS = Object.freeze([
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
const PRIORITIES = Object.freeze(['high', 'medium', 'low', 'none'])

/** Orders offered by the toolbar. */
const SORTS = Object.freeze(['manual', 'due', 'priority', 'created'])

/** Estimate modes: every task, or open tasks only. */
const ESTIMATE_MODES = Object.freeze(['all', 'open'])

/** Label color names the palette supports. */
const LABEL_COLORS = Object.freeze([
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
function localDateKey(ms = Date.now()) {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Parse a civil date key into a local Date at midnight. */
function parseKey(key) {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

/** Shift a civil date key by whole days. */
function shiftDateKey(key, days) {
  const date = parseKey(key)
  date.setDate(date.getDate() + days)
  return localDateKey(date.getTime())
}

/** Monday of the ISO week containing `key`. */
function weekStartKey(key) {
  const date = parseKey(key)
  const offset = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - offset)
  return localDateKey(date.getTime())
}

/** Sunday of the ISO week containing `key`. */
function weekEndKey(key) {
  return shiftDateKey(weekStartKey(key), 6)
}

/**
 * Bucket a task's due date relative to today.
 * @param {object} task - task snapshot.
 * @param {string} today - local date key.
 * @returns {'none'|'overdue'|'today'|'tomorrow'|'thisWeek'|'next7'|'later'} bucket.
 */
function dueBucket(task, today) {
  if (task.dueDate === null || task.dueDate === undefined) return 'none'
  if (task.dueDate < today) return 'overdue'
  if (task.dueDate === today) return 'today'
  if (task.dueDate === shiftDateKey(today, 1)) return 'tomorrow'
  if (task.dueDate <= weekEndKey(today)) return 'thisWeek'
  if (task.dueDate <= shiftDateKey(today, 6)) return 'next7'
  return 'later'
}

/** Is the task completed? Completion is membership in a done list. */
function isCompleted(task) {
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
function inSection(task, section, today) {
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
function sectionTasks(board, section, today = localDateKey()) {
  return board.tasks.filter(task => inSection(task, section, today))
}

/**
 * Counts for every rail section, so badges never need a second filter pass.
 * @param {object} board - board snapshot.
 * @param {string} [today] - local date key.
 * @returns {Record<string, number>} section → count.
 */
function sectionCounts(board, today = localDateKey()) {
  const counts = Object.fromEntries(SECTIONS.map(section => [section, 0]))
  for (const task of board.tasks) {
    for (const section of SECTIONS) {
      if (inSection(task, section, today)) counts[section] += 1
    }
  }
  return counts
}

/** Fold accents and case so "diseño" matches "diseno". */
function normalizeSearch(text) {
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
function matchesSearch(task, query, labelsById) {
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
function labelsById(board) {
  return Object.fromEntries(board.labels.map(label => [label.id, label]))
}

/**
 * Apply section + search + label filters.
 * @param {object} board - board snapshot.
 * @param {{section?: string, search?: string, labelIds?: string[], today?: string}} [view] - active view.
 * @returns {object[]} visible tasks.
 */
function filterTasks(board, view = {}) {
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
function computeStats(tasks, estimateMode = 'all') {
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
function priorityRank(priority) {
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
function sortTasks(tasks, sort = 'manual', board = { lists: [] }) {
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
function groupByList(board, tasks) {
  const groups = new Map(board.lists.map(list => [list.id, []]))
  for (const task of tasks) {
    const bucket = groups.get(task.listId)
    if (bucket !== undefined) bucket.push(task)
  }
  return groups
}

/** Human duration from minutes (`90` → `1h 30m`). */
function formatMinutes(minutes) {
  const value = Number(minutes)
  if (!Number.isFinite(value) || value <= 0) return '—'
  const hours = Math.floor(value / 60)
  const rest = Math.round(value % 60)
  if (hours === 0) return `${rest}m`
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/** Human duration from milliseconds (`5400000` → `1h 30m`). */
function formatElapsed(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return '—'
  return formatMinutes(Math.round(value / 60_000))
}

/** Whole days between two civil keys (negative when `to` is in the past). */
function daysBetween(fromKey, toKey) {
  return Math.round((parseKey(toKey).getTime() - parseKey(fromKey).getTime()) / DAY_MS)
}

/**
 * Short due-date wording for a card chip.
 * @param {object} task - task snapshot.
 * @param {string} today - local date key.
 * @param {object} t - namespace translator.
 * @returns {{label: string, state: 'none'|'overdue'|'today'|'soon'|'later'}} chip data.
 */
function dueChip(task, today, t) {
  if (task.dueDate === null || task.dueDate === undefined) return { label: '', state: 'none' }
  const delta = daysBetween(today, task.dueDate)
  if (delta < 0) return { label: t('due.overdue', { days: Math.abs(delta) }), state: 'overdue' }
  if (delta === 0) return { label: t('due.today'), state: 'today' }
  if (delta === 1) return { label: t('due.tomorrow'), state: 'soon' }
  return { label: t('due.inDays', { days: delta }), state: 'later' }
}

/** Sum of estimates for one column header. */
function columnSummary(tasks) {
  return {
    count: tasks.length,
    estimatedMin: tasks.reduce((total, task) => total + (Number(task.estimateMin) || 0), 0),
  }
}

// ─── src/board-store.js ─────────────────────────────────────────────
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
const BOARD_API = Object.freeze({
  state: '/api/pomodoro-board/state',
  revision: '/api/pomodoro-board/revision',
  command: '/api/pomodoro-board/command',
  export: '/api/pomodoro-board/export',
  import: '/api/pomodoro-board/import',
})

/** localStorage key for per-window presentation. */
const BOARD_UI_KEY = 'dsh-plugin-pomodoro:board-ui:v1'

/** Defaults for the presentation store. */
const BOARD_UI_DEFAULTS = Object.freeze({
  section: 'all',
  search: '',
  labelIds: [],
  estimateMode: 'all',
  sort: 'manual',
})

/** Cross-window change announcement. */
const BOARD_CHANNEL = 'dsh-plugin-pomodoro-board'

/** Typed transport failure the UI can word. */
class BoardApiError extends Error {
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
function createBoardUiStore(options = {}) {
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
const boardUiStore = createBoardUiStore()

/* ───────────────────────── board store ───────────────────────── */

/** Empty snapshot before the first load. */
const EMPTY_SNAPSHOT = Object.freeze({ status: 'idle', error: null, revision: 0, board: null, syncedAt: 0 })

/**
 * Create the board data store.
 * @param {object} [options] - test seams (fetch, timers, channel, polling).
 * @returns {object} store with `getSnapshot`, `subscribe`, `open`, `close`,
 *   `load`, `refreshRevision`, `command`, convenience commands, `dispose`.
 */
function createBoardStore(options = {}) {
  const fetchImpl = options.fetchImpl ?? (typeof fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)
  const now = options.now ?? Date.now
  const pollMs = options.pollMs ?? 3000
  const setIntervalFn = options.setInterval ?? ((fn, ms) => setInterval(fn, ms))
  const clearIntervalFn = options.clearInterval ?? (id => clearInterval(id))
  const channelFactory = options.createChannel ?? (name => (typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : null))

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

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    open() {
      ensureChannel()
      startPolling()
      if (snapshot.status === 'ready') return Promise.resolve(true)
      return load()
    },
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
    toggleSubtask(subtaskId, done) { return command('subtask.update', { id: subtaskId, done }) },
  }
}

/** Singleton board store used by the bundle. */
const boardStore = createBoardStore()

// ─── src/board-styles.js ─────────────────────────────────────────────
/**
 * Stylesheet for the task-board overlay.
 *
 * Only `--dsw-*` design tokens are used, so the board follows the active
 * light/dark theme. Injected once per page by the plugin's `apply` (the factory
 * can re-run under HMR, hence the idempotence guard).
 *
 * @module dsh-plugin-pomodoro/board-styles
 */

/** Stylesheet text. */
const BOARD_CSS = `
.tb-backdrop {
  position: fixed; inset: 0; z-index: 50;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, .45);
  backdrop-filter: blur(2px);
  pointer-events: auto;
  animation: tb-fade .12s ease-out;
}
@keyframes tb-fade { from { opacity: 0; } to { opacity: 1; } }
.tb-panel {
  display: flex; flex-direction: column;
  width: min(1240px, 100%); height: min(860px, 100%);
  min-height: 0;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 16px;
  box-shadow: var(--dsw-shadow-lv3, 0 24px 64px rgba(0,0,0,.28));
  overflow: hidden;
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
  animation: tb-rise .16s ease-out;
}
@keyframes tb-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.tb-header {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 10px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}
.tb-titleInput {
  min-width: 140px; max-width: 320px; flex: 0 1 240px;
  padding: 5px 8px; border: 1px solid transparent; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 14px; font-weight: 600;
}
.tb-titleInput:hover { border-color: var(--dsw-alias-border-l2); }
.tb-titleInput:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-bg-layer-2); }
.tb-spacer { flex: 1; }
.tb-search {
  display: flex; align-items: center; gap: 6px;
  flex: 0 1 260px; min-width: 160px;
  padding: 4px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-tertiary);
}
.tb-search input {
  flex: 1; min-width: 0; border: 0; background: transparent; outline: none;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px;
}
.tb-search:focus-within { border-color: var(--dsw-alias-state-business-primary); }
.tb-iconBtn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; flex: none;
  border: 1px solid transparent; border-radius: 7px;
  background: transparent; color: var(--dsw-alias-label-tertiary);
  font: inherit; font-size: 13px; line-height: 1; cursor: pointer;
}
.tb-iconBtn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); color: var(--dsw-alias-label-primary); }
.tb-iconBtn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.tb-iconBtn[data-active='true'] { color: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-border-l2); }
.tb-select {
  padding: 4px 8px; border-radius: 8px; font: inherit; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
}
.tb-errorBar {
  display: flex; align-items: center; gap: 8px;
  margin: 8px 14px 0; padding: 6px 10px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  border-radius: 8px; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2); font-size: 12px;
}
.tb-errorBar button { margin-left: auto; }
.tb-labelFilters { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 8px 14px 0; }
.tb-labelFilter {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 11px;
}
.tb-labelFilter[data-active='true'] { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.tb-body { flex: 1; display: flex; min-height: 0; }
.tb-rail {
  width: 214px; flex: none; display: flex; flex-direction: column; gap: 2px;
  padding: 10px; overflow: auto;
  border-right: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
}
.tb-railHeading {
  margin: 6px 8px 4px; font-size: 10.5px; font-weight: 600;
  letter-spacing: .06em; text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
}
.tb-railItem {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 8px; border: 0; border-radius: 8px; background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12.5px;
  text-align: left; cursor: pointer;
}
.tb-railItem:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); color: var(--dsw-alias-label-primary); }
.tb-railItem[data-active='true'] { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: var(--dsw-shadow-lv1, 0 1px 2px rgba(0,0,0,.08)); font-weight: 600; }
.tb-railItem:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -1px; }
.tb-railLabel { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb-railCount { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.tb-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.tb-stats {
  display: flex; align-items: stretch; gap: 8px; flex-wrap: wrap;
  padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.tb-stat {
  flex: 1 1 140px; min-width: 120px;
  display: flex; flex-direction: column; gap: 2px;
  padding: 7px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2);
}
.tb-statLabel { font-size: 10.5px; letter-spacing: .03em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
.tb-statValue { font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums; }
.tb-modeToggle { display: inline-flex; margin-left: auto; align-self: center; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; overflow: hidden; }
.tb-modeToggle button {
  padding: 4px 8px; border: 0; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 11px;
}
.tb-modeToggle button[data-active='true'] { background: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary-foreground, #fff); }
.tb-columns { flex: 1; display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; overflow: auto; min-height: 0; }
.tb-column {
  display: flex; flex-direction: column; flex: none;
  width: 286px; max-height: 100%; min-height: 96px;
  padding: 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
}
.tb-column[data-done='true'] { background: var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-2)); }
.tb-columnHeader { display: flex; align-items: center; gap: 6px; padding: 2px 2px 8px; }
.tb-columnTitle {
  flex: 1; min-width: 0; padding: 3px 6px; border: 1px solid transparent; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12.5px; font-weight: 650;
}
.tb-columnTitle:hover { border-color: var(--dsw-alias-border-l2); }
.tb-columnTitle:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-bg-layer-1); }
.tb-columnCount { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.tb-columnTasks { display: flex; flex-direction: column; gap: 6px; overflow: auto; padding: 0 1px; min-height: 8px; }
.tb-card {
  position: relative;
  display: flex; flex-direction: column; gap: 5px;
  padding: 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  cursor: pointer;
  transition: border-color .12s ease, box-shadow .12s ease;
}
.tb-card:hover { border-color: var(--dsw-alias-border-l3); box-shadow: var(--dsw-shadow-lv1, 0 2px 4px rgba(0,0,0,.08)); }
.tb-card:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.tb-cardTop { display: flex; align-items: flex-start; gap: 6px; }
.tb-cardTitle { flex: 1; min-width: 0; font-size: 12.5px; line-height: 18px; word-break: break-word; }
.tb-card[data-completed='true'] .tb-cardTitle { text-decoration: line-through; color: var(--dsw-alias-label-tertiary); }
.tb-cardMeta { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.tb-chip {
  display: inline-flex; align-items: center; gap: 3px;
  padding: 0 6px; border-radius: 5px; font-size: 10.5px; line-height: 17px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
}
.tb-chip[data-tone='overdue'] { color: var(--dsw-alias-state-error-primary); }
.tb-chip[data-tone='today'] { color: var(--dsw-alias-state-warn-primary); }
.tb-chip[data-tone='soon'] { color: var(--dsw-alias-state-business-primary); }
.tb-chip[data-tone='high'] { color: var(--dsw-alias-state-error-primary); }
.tb-chip[data-tone='medium'] { color: var(--dsw-alias-state-warn-primary); }
.tb-chip[data-tone='low'] { color: var(--dsw-alias-state-success-primary); }
.tb-chipMeta { color: var(--dsw-alias-label-tertiary); }
.tb-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; display: inline-block; }
.tb-labelChip { gap: 4px; background: color-mix(in srgb, var(--tb-label-color) 16%, transparent); color: var(--dsw-alias-label-primary); }
.tb-priority { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; }
.tb-priority[data-priority='high'] { color: var(--dsw-alias-state-error-primary); }
.tb-priority[data-priority='medium'] { color: var(--dsw-alias-state-warn-primary); }
.tb-priority[data-priority='low'] { color: var(--dsw-alias-state-success-primary); }
.tb-priority[data-priority='none'] { color: var(--dsw-alias-label-tertiary); }
.tb-cardActions { display: flex; align-items: center; gap: 2px; opacity: 0; transition: opacity .12s ease; }
.tb-card:hover .tb-cardActions, .tb-card:focus-within .tb-cardActions { opacity: 1; }
.tb-menuWrap { position: relative; display: inline-flex; }
.tb-menu {
  position: absolute; z-index: 80; top: calc(100% + 4px); right: 0;
  min-width: 168px; max-height: 260px; overflow: auto;
  padding: 4px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-1));
  box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.18));
  backdrop-filter: blur(40px) saturate(1.5);
}
.tb-menuItem {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 8px; border: 0; border-radius: 7px; background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; text-align: left; cursor: pointer;
}
.tb-menuItem:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); color: var(--dsw-alias-label-primary); }
.tb-menuItem:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -1px; }
.tb-menuItem[data-danger='true'] { color: var(--dsw-alias-state-error-primary); }
.tb-menuHeading { padding: 4px 8px; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--dsw-alias-label-tertiary); }
.tb-menuSeparator { height: 1px; margin: 4px 0; background: var(--dsw-alias-border-l2); }
.tb-addTask {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 6px 8px; margin-top: 6px;
  border: 1px dashed var(--dsw-alias-border-l2); border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-tertiary);
  font: inherit; font-size: 12px; text-align: left; cursor: pointer;
}
.tb-addTask:hover { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }
.tb-composer { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.tb-composer input {
  flex: 1; min-width: 0; padding: 6px 8px;
  border: 1px solid var(--dsw-alias-state-business-primary); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; outline: none;
}
.tb-newColumn { flex: none; width: 240px; }
.tb-newColumn input {
  width: 100%; padding: 8px 10px; border-radius: 10px;
  border: 1px solid var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12.5px; outline: none;
}
.tb-addColumn {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 10px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px;
  background: transparent; color: var(--dsw-alias-label-tertiary);
  font: inherit; font-size: 12.5px; cursor: pointer;
}
.tb-addColumn:hover { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); }
.tb-empty { padding: 18px 10px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.tb-loading { display: flex; flex: 1; align-items: center; justify-content: center; font-size: 13px; color: var(--dsw-alias-label-tertiary); }
.tb-confirm {
  display: flex; flex-direction: column; gap: 8px;
  margin-top: 6px; padding: 8px; border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1);
}
.tb-confirmText { font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-secondary); }
.tb-confirmRow { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tb-btn {
  padding: 5px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 11.5px; cursor: pointer;
}
.tb-btn:hover { border-color: var(--dsw-alias-border-l3); }
.tb-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.tb-btn[data-variant='primary'] { background: var(--dsw-alias-state-business-primary); border-color: transparent; color: var(--dsw-alias-label-primary-foreground, #fff); }
.tb-btn[data-variant='danger'] { color: var(--dsw-alias-state-error-primary); }
.tb-color-gray { --tb-label-color: #8b8f98; }
.tb-color-blue { --tb-label-color: #4d8df6; }
.tb-color-green { --tb-label-color: #2fa36b; }
.tb-color-teal { --tb-label-color: #1f9d9d; }
.tb-color-yellow { --tb-label-color: #c9a227; }
.tb-color-orange { --tb-label-color: #e07a24; }
.tb-color-red { --tb-label-color: #d9534f; }
.tb-color-pink { --tb-label-color: #d95c9a; }
.tb-color-purple { --tb-label-color: #8b5cf6; }
.tb-color-brown { --tb-label-color: #8a6a4f; }
.tb-colorTarget { background: var(--tb-label-color, #8b8f98); }
@media (max-width: 900px) {
  .tb-backdrop { padding: 8px; }
  .tb-rail { width: 168px; }
  .tb-column { width: 250px; }
}
@media (prefers-reduced-motion: reduce) {
  .tb-backdrop, .tb-panel, .tb-card, .tb-cardActions { animation: none !important; transition: none !important; }
}
`

/** Inject the board stylesheet once per page. */
function injectBoardStyles() {
  if (typeof document === 'undefined') return
  const tagId = 'dsh-plugin-pomodoro/board.css'
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-plugin-pomodoro'
  tag.dataset.pluginCss = tagId
  tag.textContent = BOARD_CSS
  document.head.appendChild(tag)
}

// ─── src/board-ui.js ─────────────────────────────────────────────
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
const BoardReact = require("react")



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
function TaskBoardPanel({ t }) {
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

// ─── src/client.js ─────────────────────────────────────────────
/**
 * Pomodoro timer, browser half.
 *
 * The plugin contributes one entry to `shell.overlay` — the frame-wide,
 * click-through floating layer the layout reserves for surfaces of their own —
 * and renders a compact countdown pill there. Expanding the pill reveals the
 * clock, phase controls and settings.
 *
 * Design rules that matter here:
 *
 * - The widget is a single leaf component. It talks to no host service, holds
 *   no session state, and issues no RPC, so it cannot affect prompts, tools or
 *   the model's view of the conversation.
 * - The clock is wall-clock derived (`timer-core` stores a deadline), so a
 *   throttled tab, a sleeping laptop or a reload never drifts the timer.
 * - All styling goes through `--dsw-*` design tokens, so the widget follows the
 *   active light/dark theme without a second code path.
 * - Everything user-visible is localizable through the plugin's `pomodoro`
 *   locale namespace; the component receives `t` because the registration
 *   declares `locale`.
 *
 * @module dsh-plugin-pomodoro/client
 */

const React = require("react")






const h = React.createElement

/** localStorage key for the timer record. */
const STORAGE_KEY = 'dsh-plugin-pomodoro:state:v1'
/** localStorage key for the widget's own presentation (expanded/collapsed, panel). */
const UI_KEY = 'dsh-plugin-pomodoro:ui:v1'
/** localStorage key for user preferences that outlive a single widget instance. */
const PREFS_KEY = 'dsh-plugin-pomodoro:prefs:v1'

/** This package's name (must match package.json and the loader row name). */
const PACKAGE_NAME = 'dsh-plugin-pomodoro'
/** Loader row id this bundle's patch declares; the Plugins page keys configuration on it. */
const ROW_ID = 'pomodoro'

/** Filled in by `apply` from the plugin's cordis config before registering. */
const PLUGIN = {
  settings: DEFAULT_SETTINGS,
  storageKey: STORAGE_KEY,
}

/* ────────────────────────────── styles ────────────────────────────── */

const CSS = `
.pomo-root {
  position: absolute;
  right: 20px;
  bottom: 20px;
  z-index: 40;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  pointer-events: auto;
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
  color: var(--dsw-alias-label-primary);
  --pomo-accent: var(--dsw-alias-state-business-primary);
  --pomo-mono: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
}
.pomo-root[data-phase='${PHASE.SHORT_BREAK}'] { --pomo-accent: var(--dsw-alias-state-success-primary); }
.pomo-root[data-phase='${PHASE.LONG_BREAK}'] { --pomo-accent: var(--dsw-alias-state-warn-primary); }

.pomo-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 11px 5px 8px;
  min-height: 30px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-specific-menu);
  backdrop-filter: blur(40px) saturate(1.5);
  -webkit-backdrop-filter: blur(40px) saturate(1.5);
  box-shadow: var(--dsw-shadow-lv2, 0 4px 12px rgba(0,0,0,.06));
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  transition: color .12s ease, border-color .12s ease, transform .12s ease;
}
.pomo-pill:hover,
.pomo-pill:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 2px;
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-border-l3);
}
.pomo-pill:active { transform: scale(.97); }
.pomo-pillGroup { display: inline-flex; align-items: stretch; gap: 4px; }
.pomo-pillSide {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; min-height: 30px; padding: 0;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px;
  background: var(--dsw-specific-menu);
  backdrop-filter: blur(40px) saturate(1.5);
  -webkit-backdrop-filter: blur(40px) saturate(1.5);
  box-shadow: var(--dsw-shadow-lv2, 0 4px 12px rgba(0,0,0,.06));
  color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.pomo-pillSide:hover, .pomo-pillSide:focus-visible { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l3); }
.pomo-pillSide:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .pomo-pill, .pomo-card { background: var(--dsw-alias-bg-layer-2); }
}
.pomo-pillIcon { color: var(--pomo-accent); flex: none; display: inline-flex; }
.pomo-pillTime {
  font-family: var(--pomo-mono);
  font-variant-numeric: tabular-nums;
  font-size: 12.5px;
  letter-spacing: .01em;
  color: var(--dsw-alias-label-primary);
}
.pomo-pillPhase {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  max-width: 92px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pomo-pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--pomo-accent);
  flex: none;
  animation: pomo-pulse 2s ease-in-out infinite;
}
.pomo-root[data-status='${STATUS.PAUSED}'] .pomo-pulse { animation: none; opacity: .55; }
@keyframes pomo-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .45; transform: scale(.82); } }

.pomo-card {
  box-sizing: border-box;
  width: 272px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  background: var(--dsw-specific-menu);
  backdrop-filter: blur(40px) saturate(1.5);
  -webkit-backdrop-filter: blur(40px) saturate(1.5);
  box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.12));
  animation: pomo-rise .14s ease-out;
}
@keyframes pomo-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

.pomo-head { display: flex; align-items: center; gap: 8px; min-height: 22px; }
.pomo-phase {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: .01em;
  color: var(--pomo-accent);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pomo-headActions { display: inline-flex; align-items: center; gap: 2px; }

.pomo-iconBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  flex: none;
  transition: background-color .12s ease, color .12s ease;
}
.pomo-iconBtn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.pomo-iconBtn:hover, .pomo-iconBtn:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12));
  color: var(--dsw-alias-label-primary);
}
.pomo-iconBtn:disabled { opacity: .4; cursor: default; }

.pomo-clock { position: relative; display: flex; align-items: center; justify-content: center; padding: 2px 0 0; }
.pomo-ring { width: 148px; height: 148px; display: block; }
.pomo-ringTrack { stroke: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }
.pomo-ringValue {
  stroke: var(--pomo-accent);
  stroke-linecap: round;
  transition: stroke-dashoffset .45s linear;
}
.pomo-timeWrap {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  pointer-events: none;
}
.pomo-time {
  font-family: var(--pomo-mono);
  font-variant-numeric: tabular-nums;
  font-size: 30px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: -.02em;
}
.pomo-status {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: .08em;
  color: var(--dsw-alias-label-tertiary);
}
.pomo-cycles { display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 10px; }
.pomo-cycleDot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14));
  transition: background-color .2s ease, transform .2s ease;
}
.pomo-cycleDot[data-done='true'] { background: var(--pomo-accent); transform: scale(1.12); }
.pomo-cycleCount { margin-left: 4px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }

.pomo-actions { display: flex; align-items: center; gap: 6px; }
.pomo-primary {
  flex: 1;
  min-height: 32px;
  padding: 0 14px;
  border: 0;
  border-radius: 9px;
  background: var(--pomo-accent);
  color: var(--dsw-alias-label-primary-foreground, #fff);
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: filter .12s ease, transform .12s ease;
}
.pomo-primary:hover { filter: brightness(1.08); }
.pomo-primary:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.pomo-primary:active { transform: scale(.985); }
.pomo-primary:disabled { opacity: .55; cursor: default; }
.pomo-ghost {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 32px;
  padding: 0 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 9px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  transition: background-color .12s ease, color .12s ease, border-color .12s ease;
}
.pomo-ghost:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.pomo-ghost:hover, .pomo-ghost:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1));
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-border-l3);
}
.pomo-ghost:disabled { opacity: .45; cursor: default; }

.pomo-banner {
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  line-height: 16px;
}

.pomo-settings { display: flex; flex-direction: column; gap: 2px; }
.pomo-row { display: flex; align-items: center; gap: 8px; min-height: 30px; }
.pomo-rowLabel { flex: 1; min-width: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.pomo-stepper { display: inline-flex; align-items: center; gap: 2px; flex: none; }
.pomo-stepperBtn {
  width: 22px; height: 22px;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 14px;
  line-height: 1;
  padding: 0 0 2px;
  cursor: pointer;
}
.pomo-stepperBtn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.pomo-stepperBtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); color: var(--dsw-alias-label-primary); }
.pomo-stepperBtn:disabled { opacity: .35; cursor: default; }
.pomo-stepperValue {
  min-width: 52px;
  text-align: center;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary);
}
.pomo-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 30px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.pomo-switchText { flex: 1; min-width: 0; }
.pomo-switchTrack {
  flex: none;
  width: 30px;
  height: 18px;
  padding: 2px;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14));
  transition: background-color .15s ease;
}
.pomo-switch[aria-checked='true'] .pomo-switchTrack { background: var(--dsw-alias-state-business-primary); }
.pomo-switch:focus-visible .pomo-switchTrack { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.pomo-switchThumb {
  display: block;
  width: 14px; height: 14px;
  border-radius: 50%;
  background: var(--dsw-alias-bg-base, #fff);
  box-shadow: 0 0 0 1px var(--dsw-alias-border-l2), 0 1px 2px rgba(0,0,0,.25);
  transition: transform .15s ease;
}
.pomo-switch[aria-checked='true'] .pomo-switchThumb { transform: translateX(12px); }

.pomo-foot { margin-top: -4px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); text-align: center; }

/* ── Plugins → Configure page ── */
.pomo-config {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 2px 0 6px;
  max-width: 620px;
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
  color: var(--dsw-alias-label-primary);
  --pomo-accent: var(--dsw-alias-state-business-primary);
}
.pomo-configSection { display: flex; flex-direction: column; gap: 2px; }
.pomo-configHeading {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  letter-spacing: .01em;
  color: var(--dsw-alias-label-primary);
}
.pomo-configHint {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.pomo-config .pomo-row { min-height: 34px; }
.pomo-config .pomo-rowLabel { font-size: 13px; color: var(--dsw-alias-label-primary); }
.pomo-config .pomo-switch { min-height: 34px; font-size: 13px; }
.pomo-config .pomo-stepperBtn { width: 24px; height: 24px; }
.pomo-config .pomo-stepperValue { min-width: 62px; font-size: 12px; }
.pomo-configNote {
  margin: 0;
  padding-top: 12px;
  border-top: 1px solid var(--dsw-alias-border-l2);
  font-size: 11.5px;
  line-height: 17px;
  color: var(--dsw-alias-label-tertiary);
}
.pomo-configStatus {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}

@media (max-width: 720px) {
  .pomo-root { right: 12px; bottom: 12px; }
  .pomo-card { width: 236px; }
  .pomo-ring { width: 124px; height: 124px; }
  .pomo-time { font-size: 26px; }
}
@media (prefers-reduced-motion: reduce) {
  .pomo-card, .pomo-pulse, .pomo-ringValue, .pomo-cycleDot, .pomo-switchThumb { animation: none !important; transition: none !important; }
}
`

/** Inject the stylesheet once per page (the factory re-runs on HMR). */
function injectStyles() {
  if (typeof document === 'undefined') return
  const tagId = 'dsh-plugin-pomodoro/client.css'
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-plugin-pomodoro'
  tag.dataset.pluginCss = tagId
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/* ───────────────────────────── storage ───────────────────────────── */

/** Read one JSON value, tolerating a missing or corrupt entry. */
function readJson(key) {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    return raw === null || raw === undefined ? null : JSON.parse(raw)
  } catch {
    return null
  }
}

/** Write one JSON value, swallowing quota/private-mode failures. */
function writeJson(key, value) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value))
  } catch {
    /* a timer must keep working even when storage refuses writes */
  }
}

/* ─────────────────────── plugin-level preferences ───────────────── */

/** Defaults for preferences that are not timer state. */
const DEFAULT_PREFS = Object.freeze({ widgetEnabled: true })

/** Cached preference snapshot; rebuilt only when a write changes it. */
let prefsSnapshot = null
const prefsListeners = new Set()

/** Normalize an untrusted preference record. */
function normalizePrefs(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return { widgetEnabled: source.widgetEnabled !== false }
}

/** Current preferences (stable identity until the next write). */
function getPrefs() {
  if (prefsSnapshot === null) prefsSnapshot = normalizePrefs(readJson(PREFS_KEY))
  return prefsSnapshot
}

/** Merge + persist preferences, then notify every subscriber. */
function setPrefs(patch) {
  prefsSnapshot = normalizePrefs({ ...getPrefs(), ...patch })
  writeJson(PREFS_KEY, prefsSnapshot)
  for (const listener of [...prefsListeners]) listener()
}

/** Subscribe to preference changes (for `useSyncExternalStore`). */
function subscribePrefs(listener) {
  prefsListeners.add(listener)
  return () => { prefsListeners.delete(listener) }
}

/* ───────────────────────── shared timer state ────────────────────── */

/** Same-page change notifications for the persisted timer record. */
const timerBus = {
  listeners: new Set(),
  emit() { for (const listener of [...this.listeners]) listener() },
  subscribe(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  },
}

/** Rehydrate the timer record (or a fresh one) and catch it up with the clock. */
function loadTimerState() {
  const now = Date.now()
  const stored = readJson(PLUGIN.storageKey)
  const restored = stored === null ? createState(PLUGIN.settings) : deserialize(stored, now)
  return catchUp(restored, now).state
}

/**
 * Apply a settings patch to the persisted record from outside the widget (the
 * Plugins configuration page). `updateSettings` never moves a live clock, so a
 * change made here is safe while a phase is running.
 */
function applySettingsPatch(patch) {
  const next = updateSettings(loadTimerState(), patch)
  writeJson(PLUGIN.storageKey, serialize(next))
  timerBus.emit()
  return next
}

/* ──────────────────────────── announcers ─────────────────────────── */

/** Lazily created AudioContext; browsers only allow one after a user gesture. */
let audioContext = null

/** Play a two-note chime. Silent on any audio failure. */
function chime() {
  try {
    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext
    if (!AudioCtx) return
    if (audioContext === null) audioContext = new AudioCtx()
    if (audioContext.state === 'suspended') void audioContext.resume()
    const now = audioContext.currentTime
    for (const [offset, frequency] of [[0, 880], [0.14, 1174.66]]) {
      const oscillator = audioContext.createOscillator()
      const gain = audioContext.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, now + offset)
      gain.gain.exponentialRampToValueAtTime(0.12, now + offset + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.3)
      oscillator.connect(gain).connect(audioContext.destination)
      oscillator.start(now + offset)
      oscillator.stop(now + offset + 0.32)
    }
  } catch {
    /* audio is a nicety, never a failure surface */
  }
}

/** Create/resume the audio context from a user gesture so the completion chime can sound later. */
function primeAudio() {
  try {
    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext
    if (!AudioCtx) return
    if (audioContext === null) audioContext = new AudioCtx()
    if (audioContext.state === 'suspended') void audioContext.resume()
  } catch {
    /* ignore */
  }
}

/** Ask for notification permission, but only from a user gesture. */
function ensureNotificationPermission() {
  try {
    if (typeof Notification === 'undefined') return 'unsupported'
    if (Notification.permission !== 'default') return Notification.permission
    void Notification.requestPermission()
    return 'pending'
  } catch {
    return 'unsupported'
  }
}

/** Desktop notification for a finished phase, if permission allows it. */
function notify(title, body) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    const notification = new Notification(title, { body, tag: 'dsh-pomodoro', silent: true })
    notification.onclick = () => {
      try { notification.close() } catch { /* already gone */ }
      globalThis.focus?.()
    }
  } catch {
    /* ignore */
  }
}

/* ───────────────────────────── the widget ────────────────────────── */

/** Inline tomato mark used by the collapsed pill. */
function TomatoIcon({ size = 15 }) {
  return h('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true',
  },
  h('circle', { cx: 8, cy: 9.6, r: 4.5, fill: 'currentColor' }),
  h('path', {
    d: 'M8 5.2c-.3-1.3-1.2-2.3-2.5-2.8.4 1 .6 1.8 1.2 2.4-.7.1-1.3.4-1.8.9 1.7-.2 2.6.1 3.1 1 .5-.9 1.4-1.2 3.1-1-.5-.5-1.1-.8-1.8-.9.6-.6.8-1.4 1.2-2.4-1.3.5-2.2 1.5-2.5 2.8Z',
    fill: 'currentColor',
  }))
}

/** 16px three-column board glyph. */
function BoardIcon({ size = 15 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    h('rect', { x: 1.6, y: 2.4, width: 3.6, height: 11.2, rx: 1.1, fill: 'currentColor' }),
    h('rect', { x: 6.2, y: 2.4, width: 3.6, height: 8, rx: 1.1, fill: 'currentColor' }),
    h('rect', { x: 10.8, y: 2.4, width: 3.6, height: 10, rx: 1.1, fill: 'currentColor' }))
}

/** 14px chevron pointing down (collapse / back). */
function ChevronDownIcon({ size = 14 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' },
    h('path', {
      d: 'M11.849 5.5 11.424 5.924 8.697 8.651c-.255.256-.481.483-.685.647-.213.171-.456.32-.762.368a2.28 2.28 0 0 1-.5 0c-.306-.048-.549-.197-.762-.368-.204-.164-.43-.391-.685-.647L2.576 5.924 2.151 5.5 3 4.651l.424.425 2.727 2.727c.275.274.448.445.589.559.133.107.183.116.197.118a.86.86 0 0 0 .126 0c.014-.002.064-.011.197-.118.141-.114.314-.285.589-.559l2.727-2.727.424-.425.849.849Z',
      fill: 'currentColor',
    }))
}

/** 14px chevron pointing left (back to the timer panel). */
function ChevronLeftIcon({ size = 14 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' },
    h('path', {
      d: 'M8.5 2.151 8.076 2.576 5.349 5.303c-.256.255-.483.481-.647.685-.171.213-.32.456-.368.762a2.28 2.28 0 0 0 0 .5c.048.306.197.549.368.762.164.204.391.43.647.685l2.727 2.727.424.425.849-.849-.425-.424-2.727-2.727c-.274-.275-.445-.448-.559-.589-.107-.133-.116-.183-.118-.197a.86.86 0 0 1 0-.126c.002-.014.011-.064.118-.197.114-.141.285-.314.559-.589l2.727-2.727.425-.424L8.5 2.151Z',
      fill: 'currentColor',
    }))
}

/** 16px circular-arrow reset glyph. */
function RefreshIcon({ size = 14 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    h('path', {
      d: 'M7.921.349a7.65 7.65 0 0 1 6.035 2.95l1.172-1.171c.202-.203.549-.059.549.227v3.184a.505.505 0 0 1-.505.505h-3.184c-.286 0-.428-.345-.227-.548l1.02-1.021A6.09 6.09 0 0 0 7.921 1.741 6.26 6.26 0 0 0 1.662 8a6.26 6.26 0 0 0 6.259 6.259 6.26 6.26 0 0 0 6.259-6.259h1.392A7.65 7.65 0 0 1 7.921 15.65 7.65 7.65 0 0 1 .271 8 7.65 7.65 0 0 1 7.921.349Z',
      fill: 'currentColor',
    }))
}

/** 16px sliders glyph for the settings affordance. */
function SlidersIcon({ size = 14 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    h('path', {
      d: 'M2 4h6.1M10.3 4H14M2 8h1.6M5.8 8H14M2 12h6.1M10.3 12H14',
      stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round',
    }),
    h('circle', { cx: 9.2, cy: 4, r: 1.55, fill: 'currentColor' }),
    h('circle', { cx: 4.7, cy: 8, r: 1.55, fill: 'currentColor' }),
    h('circle', { cx: 9.2, cy: 12, r: 1.55, fill: 'currentColor' }))
}

/** Skip-forward glyph (triangle against a bar). */
function SkipIcon({ size = 14 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    h('path', { d: 'M3.5 3.6 10 8l-6.5 4.4V3.6Z', fill: 'currentColor' }),
    h('rect', { x: 11, y: 3.6, width: 1.7, height: 8.8, rx: 0.5, fill: 'currentColor' }))
}

/** Stepper button used by the settings rows. */
function Stepper({ value, display, canDecrease, canIncrease, onChange, t }) {
  return h('div', { className: 'pomo-stepper' },
    h('button', {
      type: 'button', className: 'pomo-stepperBtn', disabled: !canDecrease,
      'data-pomo-action': 'decrease',
      'aria-label': t('settings.decrease'),
      onClick: () => onChange(-1),
    }, '\u2212'),
    h('span', { className: 'pomo-stepperValue' }, display),
    h('button', {
      type: 'button', className: 'pomo-stepperBtn', disabled: !canIncrease,
      'data-pomo-action': 'increase',
      'aria-label': t('settings.increase'),
      onClick: () => onChange(1),
    }, '+'))
}

/** A labelled switch row. */
function SwitchRow({ setting, label, hint, checked, onToggle }) {
  return h('button', {
    type: 'button',
    role: 'switch',
    'data-pomo-setting': setting,
    'aria-checked': checked,
    'aria-label': label,
    title: hint,
    className: 'pomo-switch',
    onClick: onToggle,
  },
  h('span', { className: 'pomo-switchText' }, label),
  h('span', { className: 'pomo-switchTrack', 'aria-hidden': 'true' },
    h('span', { className: 'pomo-switchThumb' })))
}

/**
 * The whole widget: one floating pill plus its popover panel.
 *
 * State rules: `stateRef` is the authoritative timer record (so interval
 * callbacks never close over a stale value), `now` is the render clock, and
 * `setState` is only a re-render trigger. Settings edits go through
 * `updateSettings`, which leaves a live clock alone.
 *
 * @param props.t - namespace translator injected by the slot runtime.
 * @returns the overlay entry.
 */
function PomodoroWidget({ t }) {
  const prefs = React.useSyncExternalStore(subscribePrefs, getPrefs, getPrefs)
  const boardUi = React.useSyncExternalStore(boardUiStore.subscribe, boardUiStore.getSnapshot, boardUiStore.getSnapshot)
  const initial = React.useMemo(() => loadTimerState(), [])

  const stateRef = React.useRef(initial)
  const [, forceRender] = React.useReducer(count => count + 1, 0)
  const [now, setNow] = React.useState(() => Date.now())
  const [ui, setUi] = React.useState(() => {
    const stored = readJson(UI_KEY)
    return {
      expanded: stored?.expanded === true,
      panel: stored?.panel === 'settings' ? 'settings' : 'timer',
    }
  })
  const [banner, setBanner] = React.useState(null)
  const bannerTimer = React.useRef(null)

  const state = stateRef.current

  /** Persist + re-render; the single mutation path for timer state. */
  const commit = React.useCallback(next => {
    stateRef.current = next
    writeJson(PLUGIN.storageKey, serialize(next))
    timerBus.emit()
    forceRender()
  }, [])

  /** Show a transient inline message. */
  const showBanner = React.useCallback(text => {
    if (bannerTimer.current !== null) clearTimeout(bannerTimer.current)
    setBanner(text)
    bannerTimer.current = setTimeout(() => {
      bannerTimer.current = null
      setBanner(null)
    }, 6000)
  }, [])

  /** Announce a finished phase through the channels the user enabled. */
  const announce = React.useCallback(finishedPhase => {
    const settings = stateRef.current.settings
    const isFocus = finishedPhase === PHASE.FOCUS
    const nextMinutes = isFocus
      ? (stateRef.current.phase === PHASE.LONG_BREAK ? settings.longBreakMin : settings.shortBreakMin)
      : settings.focusMin
    if (settings.sound) chime()
    if (settings.notify) {
      notify(
        t(isFocus ? 'notify.focusDone' : 'notify.breakDone'),
        t(isFocus ? 'notify.focusBody' : 'notify.breakBody', { minutes: nextMinutes }),
      )
    }
    showBanner(t(isFocus ? 'done.focus' : finishedPhase === PHASE.LONG_BREAK ? 'done.longBreak' : 'done.shortBreak'))
  }, [showBanner, t])

  // Reconcile must keep one identity for the interval's lifetime, while still
  // announcing in the current locale with the current copy.
  const announceRef = React.useRef(announce)
  announceRef.current = announce

  /**
   * Bring the record up to date with the wall clock, replaying every phase that
   * ended while the page was throttled, asleep or away. Announces only the last
   * one so a long absence cannot machine-gun notifications.
   */
  const reconcile = React.useCallback(() => {
    const at = Date.now()
    const result = catchUp(stateRef.current, at)
    setNow(at)
    if (result.completed.length === 0) {
      if (result.state !== stateRef.current) commit(result.state)
      return
    }
    commit(result.state)
    announceRef.current(result.completed[result.completed.length - 1])
  }, [commit])

  // The clock only runs while a phase is running.
  React.useEffect(() => {
    if (state.status !== STATUS.RUNNING) return undefined
    const id = setInterval(reconcile, 1000)
    return () => clearInterval(id)
  }, [state.status, reconcile])

  // A tab that was hidden or asleep resumes from the wall clock immediately.
  React.useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') reconcile()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [reconcile])

  // The Plugins configuration page (or another mount of this widget) edits the
  // same record; reload it here so both surfaces agree.
  React.useEffect(() => timerBus.subscribe(() => {
    stateRef.current = loadTimerState()
    setNow(Date.now())
    forceRender()
  }), [])

  // Another window (or another DSH page) sharing the same storage stays in sync.
  React.useEffect(() => {
    const onStorage = event => {
      if (event.key !== PLUGIN.storageKey || event.newValue === null) return
      try {
        const restored = deserialize(JSON.parse(event.newValue), Date.now())
        stateRef.current = catchUp(restored, Date.now()).state
        forceRender()
      } catch {
        /* ignore a corrupt peer write */
      }
    }
    globalThis.addEventListener?.('storage', onStorage)
    return () => globalThis.removeEventListener?.('storage', onStorage)
  }, [])

  // Persist presentation choices too, without making them timer state.
  React.useEffect(() => {
    writeJson(UI_KEY, ui)
  }, [ui])

  React.useEffect(() => () => {
    if (bannerTimer.current !== null) clearTimeout(bannerTimer.current)
  }, [])

  const setExpanded = next => setUi(current => ({ ...current, expanded: next, panel: next ? current.panel : 'timer' }))

  const toggleExpanded = () => setExpanded(!ui.expanded)

  const handleStart = () => {
    // The chime needs an audio context that was created inside a gesture.
    primeAudio()
    if (state.settings.notify) ensureNotificationPermission()
    commit(start(stateRef.current, Date.now()))
    setNow(Date.now())
  }

  const handlePause = () => {
    commit(pause(stateRef.current, Date.now()))
    setNow(Date.now())
  }

  const handleReset = () => {
    commit(reset(stateRef.current))
    setNow(Date.now())
  }

  const handleSkip = () => {
    commit(skip(stateRef.current, Date.now()))
    setNow(Date.now())
  }

  const patchSettings = patch => {
    const next = updateSettings(stateRef.current, patch)
    // A settings change can also auto-start nothing; keep the clock view honest.
    commit(next)
    setNow(Date.now())
  }

  // Escape collapses, Space toggles the phase, S skips, R resets — but never
  // while the user is typing, and never on top of a focused control that
  // already handles those keys natively.
  React.useEffect(() => {
    if (!ui.expanded) return undefined
    const onKey = event => {
      const target = event.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return
        if (tag === 'BUTTON' || tag === 'A') {
          if (event.key === 'Escape') {
            event.stopPropagation()
            setExpanded(false)
          }
          return
        }
      }
      if (event.key === 'Escape') {
        event.stopPropagation()
        setExpanded(false)
        return
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key === ' ') {
        event.preventDefault()
        if (stateRef.current.status === STATUS.RUNNING) handlePause()
        else handleStart()
      } else if (event.key === 's' || event.key === 'S') {
        event.preventDefault()
        handleSkip()
      } else if (event.key === 'r' || event.key === 'R') {
        event.preventDefault()
        handleReset()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  })

  // `B` opens or closes the task board from anywhere except a text field.
  React.useEffect(() => {
    const onKeyDown = event => {
      if (event.key !== 'b' && event.key !== 'B') return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return
      }
      event.preventDefault()
      boardUiStore.toggleOpen()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const clock = formatClock(remaining(state, now))
  const fraction = fractionRemaining(state, now)
  const phaseLabel = t(state.phase === PHASE.FOCUS
    ? 'phase.focus'
    : state.phase === PHASE.SHORT_BREAK ? 'phase.shortBreak' : 'phase.longBreak')
  const statusLabel = t(state.status === STATUS.RUNNING
    ? 'status.running'
    : state.status === STATUS.PAUSED ? 'status.paused' : 'status.idle')
  const doneInCycle = cycleProgress(state)
  const every = state.settings.longBreakEvery
  const circumference = 2 * Math.PI * 42
  const minutesOf = value => t('settings.minutes', { minutes: value })
  const ariaLabel = t('timer.aria', { phase: phaseLabel, time: clock, status: statusLabel })

  const cycleDots = []
  for (let index = 0; index < every; index += 1) {
    cycleDots.push(h('span', {
      key: index,
      className: 'pomo-cycleDot',
      'data-done': String(index < doneInCycle),
      'aria-hidden': 'true',
    }))
  }

  const clockView = h('div', { className: 'pomo-clock' },
    h('svg', { className: 'pomo-ring', viewBox: '0 0 100 100', role: 'img', 'aria-label': ariaLabel },
      h('circle', { className: 'pomo-ringTrack', cx: 50, cy: 50, r: 42, fill: 'none', strokeWidth: 5 }),
      h('circle', {
        className: 'pomo-ringValue', cx: 50, cy: 50, r: 42, fill: 'none', strokeWidth: 5,
        strokeDasharray: circumference,
        strokeDashoffset: circumference * (1 - fraction),
        transform: 'rotate(-90 50 50)',
      })),
    h('div', { className: 'pomo-timeWrap', 'aria-hidden': 'true' },
      h('span', { className: 'pomo-time' }, clock),
      h('span', { className: 'pomo-status' }, statusLabel)))

  const timerPanel = h(React.Fragment, null,
    clockView,
    h('div', { className: 'pomo-cycles', 'aria-hidden': 'true' },
      cycleDots,
      h('span', { className: 'pomo-cycleCount' }, t('timer.sessionCount', { count: state.completedFocus }))),
    h('div', { className: 'pomo-actions' },
      state.status === STATUS.RUNNING
        ? h('button', {
          type: 'button', className: 'pomo-primary', 'data-pomo-action': 'toggle-run', onClick: handlePause,
        }, t('action.pause'))
        : h('button', {
          type: 'button', className: 'pomo-primary', 'data-pomo-action': 'toggle-run', onClick: handleStart,
        }, state.status === STATUS.PAUSED ? t('action.resume') : t('action.start')),
      h('button', {
        type: 'button', className: 'pomo-ghost', 'data-pomo-action': 'skip',
        'aria-label': t('action.skip'), title: t('action.skip'),
        onClick: handleSkip,
      }, h(SkipIcon)),
      h('button', {
        type: 'button', className: 'pomo-ghost', 'data-pomo-action': 'reset',
        'aria-label': t('action.reset'), title: t('action.reset'),
        onClick: handleReset,
      }, h(RefreshIcon, { size: 14 })),
      h('button', {
        type: 'button', className: 'pomo-ghost', 'data-pomo-action': 'settings',
        'aria-label': t('action.settings'), title: t('action.settings'),
        onClick: () => setUi(current => ({ ...current, panel: 'settings' })),
      }, h(SlidersIcon, { size: 14 }))),
    banner !== null ? h('div', { className: 'pomo-banner', role: 'status' }, banner) : null)

  const settingsPanel = h(React.Fragment, null,
    h('div', { className: 'pomo-settings' },
      h('div', { className: 'pomo-row', 'data-pomo-setting': 'focus' },
        h('span', { className: 'pomo-rowLabel' }, t('settings.focus')),
        h(Stepper, {
          value: state.settings.focusMin,
          display: minutesOf(state.settings.focusMin),
          canDecrease: state.settings.focusMin > 1,
          canIncrease: state.settings.focusMin < 180,
          onChange: step => patchSettings({ focusMin: state.settings.focusMin + step }),
          t,
        })),
      h('div', { className: 'pomo-row', 'data-pomo-setting': 'shortBreak' },
        h('span', { className: 'pomo-rowLabel' }, t('settings.shortBreak')),
        h(Stepper, {
          value: state.settings.shortBreakMin,
          display: minutesOf(state.settings.shortBreakMin),
          canDecrease: state.settings.shortBreakMin > 1,
          canIncrease: state.settings.shortBreakMin < 60,
          onChange: step => patchSettings({ shortBreakMin: state.settings.shortBreakMin + step }),
          t,
        })),
      h('div', { className: 'pomo-row', 'data-pomo-setting': 'longBreak' },
        h('span', { className: 'pomo-rowLabel' }, t('settings.longBreak')),
        h(Stepper, {
          value: state.settings.longBreakMin,
          display: minutesOf(state.settings.longBreakMin),
          canDecrease: state.settings.longBreakMin > 1,
          canIncrease: state.settings.longBreakMin < 120,
          onChange: step => patchSettings({ longBreakMin: state.settings.longBreakMin + step }),
          t,
        })),
      h('div', { className: 'pomo-row', 'data-pomo-setting': 'every' },
        h('span', { className: 'pomo-rowLabel' }, t('settings.every')),
        h(Stepper, {
          value: state.settings.longBreakEvery,
          display: t('settings.blocks', { count: state.settings.longBreakEvery }),
          canDecrease: state.settings.longBreakEvery > 1,
          canIncrease: state.settings.longBreakEvery < 12,
          onChange: step => patchSettings({ longBreakEvery: state.settings.longBreakEvery + step }),
          t,
        }))),
    h('div', { className: 'pomo-settings' },
      h(SwitchRow, {
        setting: 'autoBreaks', label: t('settings.autoBreaks'), hint: t('settings.autoBreaksHint'),
        checked: state.settings.autoStartBreaks,
        onToggle: () => patchSettings({ autoStartBreaks: !state.settings.autoStartBreaks }),
      }),
      h(SwitchRow, {
        setting: 'autoFocus', label: t('settings.autoFocus'), hint: t('settings.autoFocusHint'),
        checked: state.settings.autoStartFocus,
        onToggle: () => patchSettings({ autoStartFocus: !state.settings.autoStartFocus }),
      }),
      h(SwitchRow, {
        setting: 'sound', label: t('settings.sound'), hint: t('settings.soundHint'),
        checked: state.settings.sound,
        onToggle: () => patchSettings({ sound: !state.settings.sound }),
      }),
      h(SwitchRow, {
        setting: 'notify', label: t('settings.notify'), hint: t('settings.notifyHint'),
        checked: state.settings.notify,
        onToggle: () => {
          const next = !state.settings.notify
          patchSettings({ notify: next })
          if (next && ensureNotificationPermission() === 'denied') showBanner(t('notify.denied'))
        },
      })))

  const card = h('div', {
    className: 'pomo-card',
    role: 'group',
    'data-pomo-panel': ui.panel,
    'aria-label': t('widget.label'),
  },
  h('div', { className: 'pomo-head' },
    h('span', { className: 'pomo-phase' }, phaseLabel),
    h('div', { className: 'pomo-headActions' },
      ui.panel === 'settings'
        ? null
        : h('button', {
          type: 'button', className: 'pomo-iconBtn', 'data-pomo-action': 'board',
          'aria-label': t('board.open'), title: t('board.open'),
          onClick: () => boardUiStore.setOpen(true),
        }, h(BoardIcon, { size: 14 })),
      ui.panel === 'settings'
        ? h('button', {
          type: 'button', className: 'pomo-iconBtn', 'data-pomo-action': 'back',
          'aria-label': t('action.back'), title: t('action.back'),
          onClick: () => setUi(current => ({ ...current, panel: 'timer' })),
        }, h(ChevronLeftIcon, { size: 14 }))
        : null,
      h('button', {
        type: 'button', className: 'pomo-iconBtn', 'data-pomo-action': 'collapse',
        'aria-label': t('widget.collapse'), title: t('widget.collapse'),
        onClick: () => setExpanded(false),
      }, h(ChevronDownIcon, { size: 14 })))),
  ui.panel === 'settings' ? settingsPanel : timerPanel)

  const pill = h('div', { className: 'pomo-pillGroup' },
    h('button', {
      type: 'button',
      className: 'pomo-pill',
      'data-pomo-action': 'toggle',
      onClick: toggleExpanded,
      'aria-label': t('widget.open'),
      title: `${t('widget.label')} — ${clock}`,
    },
    h('span', { className: 'pomo-pillIcon' }, h(TomatoIcon, { size: 15 })),
    h('span', { className: 'pomo-pillTime' }, clock),
    h('span', { className: 'pomo-pillPhase' }, phaseLabel),
    state.status === STATUS.RUNNING || state.status === STATUS.PAUSED
      ? h('span', { className: 'pomo-pulse', 'aria-hidden': 'true' })
      : null),
    h('button', {
      type: 'button',
      className: 'pomo-pillSide',
      'data-pomo-action': 'board',
      'aria-label': t('board.open'),
      title: t('board.open'),
      onClick: () => boardUiStore.setOpen(true),
    }, h(BoardIcon, { size: 15 })))

  const widget = prefs.widgetEnabled
    ? h('div', {
      className: 'pomo-root',
      'data-phase': state.phase,
      'data-status': state.status,
      'data-board-open': boardUi.open ? 'true' : 'false',
    }, ui.expanded ? card : pill)
    : null

  return h(React.Fragment, null, widget, h(TaskBoardPanel, { t }))
}

/* ─────────────────────── Plugins configuration page ─────────────── */

/**
 * Configuration page for this plugin's row, rendered inside the sidebar
 * **Plugins** page (Plugins → Installed plugins → dsh-plugin-pomodoro →
 * Configure).
 *
 * Two kinds of control live here on purpose:
 *
 * - the widget switch hides/shows the floating timer without unloading the
 *   plugin (the profile-level Component switch on the bundle page unloads the
 *   plugin itself, which needs no reload);
 * - the timer defaults edit the same persisted record the widget reads, through
 *   `applySettingsPatch`, which leaves a running clock untouched.
 *
 * `view: 'summary'` is the row description fallback the manager renders.
 *
 * @param props.t - namespace translator injected through the slot's locale seat.
 * @param props.view - `page` for the form, `summary` for one-line row copy.
 * @returns the configuration form.
 */
function PomodoroConfigPage({ t, view }) {
  const prefs = React.useSyncExternalStore(subscribePrefs, getPrefs, getPrefs)
  const [state, setState] = React.useState(() => loadTimerState())
  React.useEffect(() => timerBus.subscribe(() => setState(loadTimerState())), [])

  if (view === 'summary') return t(prefs.widgetEnabled ? 'config.summaryOn' : 'config.summaryOff')

  const settings = state.settings
  const stepperRow = (row, key, label, value, min, max) => h('div', {
    className: 'pomo-row',
    'data-pomo-setting': row,
  },
  h('span', { className: 'pomo-rowLabel' }, label),
  h(Stepper, {
    display: row === 'every' ? t('settings.blocks', { count: value }) : t('settings.minutes', { minutes: value }),
    canDecrease: value > min,
    canIncrease: value < max,
    onChange: step => applySettingsPatch({ [key]: value + step }),
    t,
  }))

  return h('div', { className: 'pomo-config', 'data-pomo-config': 'page' },
    h('section', { className: 'pomo-configSection' },
      h('h3', { className: 'pomo-configHeading' }, t('config.widgetHeading')),
      h('p', { className: 'pomo-configHint' }, t('config.widgetHint')),
      h(SwitchRow, {
        setting: 'widget',
        label: t('config.widget'),
        hint: t('config.widgetHint'),
        checked: prefs.widgetEnabled,
        onToggle: () => setPrefs({ widgetEnabled: !prefs.widgetEnabled }),
      })),
    h('section', { className: 'pomo-configSection' },
      h('h3', { className: 'pomo-configHeading' }, t('config.durationsHeading')),
      stepperRow('focus', 'focusMin', t('settings.focus'), settings.focusMin, 1, 180),
      stepperRow('shortBreak', 'shortBreakMin', t('settings.shortBreak'), settings.shortBreakMin, 1, 60),
      stepperRow('longBreak', 'longBreakMin', t('settings.longBreak'), settings.longBreakMin, 1, 120),
      stepperRow('every', 'longBreakEvery', t('settings.every'), settings.longBreakEvery, 1, 12)),
    h('section', { className: 'pomo-configSection' },
      h('h3', { className: 'pomo-configHeading' }, t('config.behaviourHeading')),
      h(SwitchRow, {
        setting: 'autoBreaks', label: t('settings.autoBreaks'), hint: t('settings.autoBreaksHint'),
        checked: settings.autoStartBreaks,
        onToggle: () => applySettingsPatch({ autoStartBreaks: !settings.autoStartBreaks }),
      }),
      h(SwitchRow, {
        setting: 'autoFocus', label: t('settings.autoFocus'), hint: t('settings.autoFocusHint'),
        checked: settings.autoStartFocus,
        onToggle: () => applySettingsPatch({ autoStartFocus: !settings.autoStartFocus }),
      })),
    h('section', { className: 'pomo-configSection' },
      h('h3', { className: 'pomo-configHeading' }, t('config.signalsHeading')),
      h(SwitchRow, {
        setting: 'sound', label: t('settings.sound'), hint: t('settings.soundHint'),
        checked: settings.sound,
        onToggle: () => applySettingsPatch({ sound: !settings.sound }),
      }),
      h(SwitchRow, {
        setting: 'notify', label: t('settings.notify'), hint: t('settings.notifyHint'),
        checked: settings.notify,
        onToggle: () => {
          const next = !settings.notify
          applySettingsPatch({ notify: next })
          if (next && ensureNotificationPermission() === 'denied') {
            // The page has no banner seat; the switch simply stays off in the UI.
          }
        },
      })),
    h('p', { className: 'pomo-configNote' }, t('config.note')))
}

/* ───────────────────────────── the plugin ────────────────────────── */

/** Cordis services this browser half needs before it may activate. */
const inject = ['slots', 'locale']

/**
 * Client plugin body.
 * @param ctx - client root context.
 * @param config - optional plugin config (`defaults` overrides the timer's
 *   initial lengths; `storageKey` isolates the record for a second instance).
 */
function apply(ctx, config) {
  const options = config !== null && typeof config === 'object' ? config : {}
  const defaults = options.defaults !== null && typeof options.defaults === 'object' ? options.defaults : {}
  PLUGIN.settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...defaults })
  if (typeof options.storageKey === 'string' && options.storageKey.length > 0) {
    PLUGIN.storageKey = options.storageKey
  }

  injectStyles()
  injectBoardStyles()

  ctx.effect(
    () => ctx.locale.register(NS, { zh, en }),
    'pomodoro: dictionaries',
  )

  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    {
      name: 'shell.overlay',
      id: 'pomodoro-timer',
      // Right of the shipped overlay entries; the slot layer is click-through.
      order: 40,
      label: () => 'Pomodoro',
      locale: NS,
    },
    PomodoroWidget,
  ))

  // Plugins → Installed plugins → dsh-plugin-pomodoro → Configure. The manager
  // keys row configuration on `<bundle>#<row>`; our bundle patch declares the row
  // as `pomodoro`, and the page disappears with the row if the plugin is
  // switched off at the profile level.
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register(
    {
      name: 'plugins.row.config',
      key: `${PACKAGE_NAME}#${ROW_ID}`,
      locale: NS,
    },
    PomodoroConfigPage,
  ))
}

    // ─── plugin exports ──────────────────────────────────────────
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
