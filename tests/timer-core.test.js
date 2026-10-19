/**
 * Unit tests for the pure Pomodoro state machine.
 * Run with: node --test tests/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PHASE,
  STATUS,
  DEFAULT_SETTINGS,
  catchUp,
  createState,
  cycleProgress,
  deserialize,
  formatClock,
  fractionRemaining,
  normalizeSettings,
  pause,
  phaseDuration,
  remaining,
  reset,
  serialize,
  skip,
  start,
  tick,
  updateSettings,
} from '../src/timer-core.js'

const T0 = 1_760_000_000_000
const MIN = 60_000

function running(settings = DEFAULT_SETTINGS) {
  return start(createState(settings), T0)
}

test('createState starts idle at a full focus block', () => {
  const state = createState(DEFAULT_SETTINGS)
  assert.equal(state.phase, PHASE.FOCUS)
  assert.equal(state.status, STATUS.IDLE)
  assert.equal(state.remainingMs, 25 * MIN)
  assert.equal(state.deadline, null)
  assert.equal(state.completedFocus, 0)
})

test('start derives an absolute deadline and remaining() follows the wall clock', () => {
  const state = running()
  assert.equal(state.deadline, T0 + 25 * MIN)
  assert.equal(remaining(state, T0 + 10 * MIN), 15 * MIN)
  assert.equal(remaining(state, T0 + 26 * MIN), 0)
})

test('pause freezes the remaining time and resume continues from it', () => {
  const paused = pause(running(), T0 + 5 * MIN)
  assert.equal(paused.status, STATUS.PAUSED)
  assert.equal(paused.remainingMs, 20 * MIN)
  assert.equal(paused.deadline, null)
  assert.equal(remaining(paused, T0 + 60 * MIN), 20 * MIN)

  const resumed = start(paused, T0 + 60 * MIN)
  assert.equal(resumed.deadline, T0 + 80 * MIN)
})

test('a finished focus block lands on a short break and counts as completed', () => {
  const { state, completed } = tick(running(), T0 + 25 * MIN)
  assert.equal(completed, PHASE.FOCUS)
  assert.equal(state.phase, PHASE.SHORT_BREAK)
  assert.equal(state.completedFocus, 1)
  assert.equal(state.remainingMs, 5 * MIN)
  // autoStartBreaks is on by default, so the break is already running.
  assert.equal(state.status, STATUS.RUNNING)
  assert.equal(state.deadline, T0 + 30 * MIN)
})

test('the fourth completed focus block earns a long break', () => {
  const settings = normalizeSettings({ autoStartBreaks: true, autoStartFocus: true })
  let state = start(createState(settings), T0)
  let now = T0
  const focusSuccessors = []
  let completedFocus = 0
  // Walk 8 phase completions (4 focus + 4 breaks) and record what follows focus.
  for (let i = 0; i < 8; i += 1) {
    now = state.deadline
    const result = tick(state, now)
    assert.notEqual(result.completed, null)
    if (result.completed === PHASE.FOCUS) {
      completedFocus += 1
      focusSuccessors.push(result.state.phase)
    }
    state = result.state
  }
  assert.equal(completedFocus, 4)
  assert.deepEqual(focusSuccessors, [PHASE.SHORT_BREAK, PHASE.SHORT_BREAK, PHASE.SHORT_BREAK, PHASE.LONG_BREAK])
  assert.equal(state.completedFocus, 4)
  assert.equal(cycleProgress(state), 0)
})

test('autoStartBreaks defaults to on, autoStartFocus to off', () => {
  const { state } = tick(running(), T0 + 25 * MIN)
  assert.equal(state.status, STATUS.RUNNING)
  assert.equal(state.deadline, T0 + 25 * MIN + 5 * MIN)

  const breakDone = tick(state, T0 + 30 * MIN)
  assert.equal(breakDone.completed, PHASE.SHORT_BREAK)
  assert.equal(breakDone.state.phase, PHASE.FOCUS)
  assert.equal(breakDone.state.status, STATUS.IDLE)
})

test('skip advances without crediting a focus block', () => {
  const skipped = skip(running(), T0)
  assert.equal(skipped.phase, PHASE.SHORT_BREAK)
  assert.equal(skipped.completedFocus, 0)
  assert.equal(skipped.status, STATUS.IDLE)
})

test('reset restores the current phase full duration and stops', () => {
  const resetting = reset(pause(running(), T0 + 5 * MIN))
  assert.equal(resetting.status, STATUS.IDLE)
  assert.equal(resetting.remainingMs, 25 * MIN)
  assert.equal(resetting.deadline, null)
})

test('updateSettings does not move a live clock but resizes a stopped one', () => {
  const live = updateSettings(running(), { focusMin: 50 })
  assert.equal(live.settings.focusMin, 50)
  assert.equal(remaining(live, T0), 25 * MIN)

  const stopped = updateSettings(createState(DEFAULT_SETTINGS), { focusMin: 50 })
  assert.equal(stopped.remainingMs, 50 * MIN)
})

test('normalizeSettings clamps numbers and drops unknown keys', () => {
  const settings = normalizeSettings({ focusMin: 0, shortBreakMin: 999, longBreakEvery: 'x', bogus: 1 })
  assert.equal(settings.focusMin, 1)
  assert.equal(settings.shortBreakMin, 60)
  assert.equal(settings.longBreakEvery, DEFAULT_SETTINGS.longBreakEvery)
  assert.equal('bogus' in settings, false)
})

test('serialize/deserialize round-trips a running timer', () => {
  const state = running()
  const restored = deserialize(serialize(state), T0 + MIN)
  assert.deepEqual(restored, state)
  assert.equal(remaining(restored, T0 + MIN), 24 * MIN)
})

test('deserialize survives garbage and unknown phases', () => {
  assert.equal(deserialize(null, T0).phase, PHASE.FOCUS)
  assert.equal(deserialize('nope', T0).phase, PHASE.FOCUS)
  const weird = deserialize({ v: 1, phase: 'siesta', status: 'running', remainingMs: 5, completedFocus: -3 }, T0)
  assert.equal(weird.phase, PHASE.FOCUS)
  assert.equal(weird.completedFocus, 0)
  assert.equal(weird.status, STATUS.PAUSED, 'running without a deadline cannot resume')
})

test('catchUp replays auto-started phases after a reload', () => {
  const state = running() // 25m focus
  // 31 minutes later: focus done at +25m, 5m break auto-started, done at +30m,
  // then focus auto-start is off -> stopped focus at 1m into the block? No:
  // autoStartFocus defaults off, so the third phase is idle at full length.
  const { state: caught, completed } = catchUp(state, T0 + 31 * MIN)
  assert.deepEqual(completed, [PHASE.FOCUS, PHASE.SHORT_BREAK])
  assert.equal(caught.phase, PHASE.FOCUS)
  assert.equal(caught.status, STATUS.IDLE)
  assert.equal(caught.remainingMs, 25 * MIN)
  assert.equal(caught.completedFocus, 1)
})

test('catchUp stops instead of replaying a week of pomodoros', () => {
  const settings = normalizeSettings({ autoStartBreaks: true, autoStartFocus: true })
  const { state, completed } = catchUp(start(createState(settings), T0), T0 + 7 * 24 * 60 * MIN, 8)
  assert.equal(completed.length, 8)
  assert.equal(state.status, STATUS.IDLE)
})

test('formatClock pads and grows past an hour', () => {
  assert.equal(formatClock(25 * MIN), '25:00')
  assert.equal(formatClock(9_000), '00:09')
  assert.equal(formatClock(0), '00:00')
  assert.equal(formatClock(65 * MIN), '1:05:00')
  assert.equal(formatClock(-5), '00:00')
})

test('fractionRemaining reports progress within the phase', () => {
  assert.equal(fractionRemaining(running(), T0), 1)
  assert.equal(fractionRemaining(running(), T0 + 12.5 * MIN), 0.5)
  assert.equal(fractionRemaining(running(), T0 + 99 * MIN), 0)
})

test('tick is a no-op when stopped and reports the completed phase exactly once', () => {
  const idle = createState(DEFAULT_SETTINGS)
  assert.equal(tick(idle, T0 + 10 * MIN).completed, null)

  const first = tick(running(), T0 + 25 * MIN)
  assert.equal(first.completed, PHASE.FOCUS)
  const second = tick(first.state, T0 + 25 * MIN)
  assert.equal(second.completed, null)
})

/* ─────────────────────── task focus accounting ────────────────── */

import {
  attachTask,
  beginFocusSegment,
  catchUpFocus,
  settleFocus,
} from '../src/timer-core.js'

/** A task-linked running focus phase started at T0. */
function focusedTask(settings = DEFAULT_SETTINGS) {
  return beginFocusSegment(attachTask(start(createState(settings), T0), 'task-1', 'Write docs'), T0)
}

test('beginFocusSegment marks running task-linked focus phases only', () => {
  const linked = focusedTask()
  assert.equal(linked.focusStartedAt, T0)
  assert.equal(linked.taskId, 'task-1')
  assert.equal(linked.taskTitle, 'Write docs')

  assert.equal(beginFocusSegment(start(createState(), T0), T0).focusStartedAt, null, 'no task')
  assert.equal(beginFocusSegment(attachTask(createState(), 'task-1'), T0).focusStartedAt, null, 'not running')
  const breakState = { ...focusedTask(), phase: PHASE.SHORT_BREAK }
  assert.equal(beginFocusSegment(breakState, T0).focusStartedAt, null, 'break phase')
})

test('settleFocus measures the real segment and clamps it to the phase', () => {
  const settled = settleFocus(focusedTask(), T0 + 10 * MIN)
  assert.equal(settled.state.focusStartedAt, null)
  assert.deepEqual(settled.credit, {
    taskId: 'task-1',
    creditId: `task-1@${T0}`,
    deltaMs: 10 * MIN,
    pomodoros: 0,
  })
  assert.equal(settleFocus(focusedTask(), T0).credit, null, 'no time elapsed')
  assert.equal(settleFocus(focusedTask(), T0 + 99 * MIN).credit.deltaMs, 25 * MIN, 'clamped to the phase')
  assert.equal(settleFocus(createState(), T0 + MIN).credit, null, 'no task')
  const completed = settleFocus(focusedTask(), T0 + 25 * MIN, { pomodoros: 1 })
  assert.equal(completed.credit.pomodoros, 1)
})

test('settleFocus does not credit beyond the deadline', () => {
  const state = focusedTask()
  const credit = settleFocus(state, state.deadline + 60 * MIN).credit
  assert.equal(credit.deltaMs, 25 * MIN)
})

test('catchUpFocus credits completed focus phases and restarts the segment', () => {
  const running = focusedTask()
  // 26 minutes later: the focus block completed; its break auto-started.
  const caught = catchUpFocus(running, T0 + 26 * MIN)
  assert.deepEqual(caught.completed, [PHASE.FOCUS])
  assert.equal(caught.credits.length, 1)
  assert.equal(caught.credits[0].taskId, 'task-1')
  assert.equal(caught.credits[0].deltaMs, 25 * MIN)
  assert.equal(caught.credits[0].pomodoros, 1)
  assert.equal(caught.state.phase, PHASE.SHORT_BREAK)
  assert.equal(caught.state.status, STATUS.RUNNING)
  assert.equal(caught.state.focusStartedAt, null, 'a break is not measured')

  // Still inside the focus block: no credit, segment restarts at the phase start.
  const inside = catchUpFocus(running, T0 + 10 * MIN)
  assert.equal(inside.credits.length, 0)
  assert.equal(inside.state.focusStartedAt, T0)
})

test('attachTask links and clears the task snapshot', () => {
  const linked = attachTask(createState(), 'task-9', 'Title')
  assert.equal(linked.taskId, 'task-9')
  assert.equal(linked.taskTitle, 'Title')
  const cleared = attachTask(linked, null)
  assert.equal(cleared.taskId, null)
  assert.equal(cleared.taskTitle, null)
})

test('serialize/deserialize keep the task link and running segment', () => {
  const running = focusedTask()
  const restored = deserialize(serialize(running), T0 + MIN)
  assert.equal(restored.taskId, 'task-1')
  assert.equal(restored.taskTitle, 'Write docs')
  assert.equal(restored.focusStartedAt, T0)
})
