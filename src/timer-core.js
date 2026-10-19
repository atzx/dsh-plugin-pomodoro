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
export const PHASE = Object.freeze({
  FOCUS: 'focus',
  SHORT_BREAK: 'shortBreak',
  LONG_BREAK: 'longBreak',
})

/** Lifecycle status of the pump. */
export const STATUS = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
})

/** Defaults for everything the user can change. */
export const DEFAULT_SETTINGS = Object.freeze({
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
export function normalizeSettings(input) {
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
export function phaseDuration(phase, settings) {
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
export function createState(settings) {
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
export function remaining(state, now) {
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
export function start(state, now) {
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
export function pause(state, now) {
  if (state.status !== STATUS.RUNNING) return state
  return { ...state, status: STATUS.PAUSED, remainingMs: remaining(state, now), deadline: null }
}

/**
 * Return the current phase to its full duration and stop.
 * @param {object} state - timer state.
 * @returns {object} next state (idle, fresh current phase).
 */
export function reset(state) {
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
export function skip(state, now) {
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
export function tick(state, now) {
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
export function catchUp(state, now, budget = 24) {
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
export function updateSettings(state, patch) {
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
export function serialize(state) {
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
export function deserialize(raw, now) {
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
export function formatClock(ms) {
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
export function fractionRemaining(state, now) {
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
export function cycleProgress(state) {
  const every = Math.max(1, state.settings.longBreakEvery)
  return state.completedFocus % every
}
