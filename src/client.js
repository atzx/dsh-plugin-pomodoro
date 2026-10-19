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

import * as React from 'react'
import { NS, en, zh } from './locales.js'
import { activeTaskStore, boardStore, boardUiStore, focusBridge } from './board-store.js'
import { TaskBoardPanel } from './board-ui.js'
import { injectBoardStyles } from './board-styles.js'
import {
  DEFAULT_SETTINGS,
  PHASE,
  STATUS,
  attachTask,
  beginFocusSegment,
  catchUp,
  catchUpFocus,
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
  settleFocus,
  skip,
  start,
  updateSettings,
} from './timer-core.js'

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

.pomo-taskChip {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 7px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2);
  font-size: 11.5px; line-height: 16px;
  color: var(--dsw-alias-label-secondary);
}
.pomo-taskChip::before { content: '▶'; color: var(--pomo-accent); font-size: 9px; flex: none; }
.pomo-taskLabel { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pomo-taskClear {
  width: 16px; height: 16px; padding: 0; border: 0; border-radius: 50%;
  background: transparent; color: var(--dsw-alias-label-tertiary);
  font: inherit; font-size: 12px; line-height: 1; cursor: pointer; flex: none;
}
.pomo-taskClear:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }

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

  /** Send one measured focus credit; the board store queues it when offline. */
  const sendCredit = React.useCallback(credit => {
    if (credit === null || credit === undefined) return
    void boardStore.creditTime(credit.taskId, credit.creditId, credit.deltaMs, credit.pomodoros ?? 0)
  }, [])

  /** Rehydrate the record and replay phases finished while the page was away. */
  const initial = React.useMemo(() => {
    const now = Date.now()
    const stored = readJson(PLUGIN.storageKey)
    const restored = stored === null ? createState(PLUGIN.settings) : deserialize(stored, now)
    const caught = catchUpFocus(restored, now)
    for (const credit of caught.credits) void boardStore.creditTime(credit.taskId, credit.creditId, credit.deltaMs, credit.pomodoros)
    return caught.state
  }, [])

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
    const base = t(isFocus ? 'done.focus' : finishedPhase === PHASE.LONG_BREAK ? 'done.longBreak' : 'done.shortBreak')
    showBanner(stateRef.current.taskTitle === null ? base : `${base} · ${stateRef.current.taskTitle}`)
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
    const result = catchUpFocus(stateRef.current, at)
    setNow(at)
    for (const credit of result.credits) void boardStore.creditTime(credit.taskId, credit.creditId, credit.deltaMs, credit.pomodoros)
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
    const at = Date.now()
    commit(beginFocusSegment(start(stateRef.current, at), at))
    setNow(at)
  }

  const handlePause = () => {
    const at = Date.now()
    const paused = pause(stateRef.current, at)
    const settled = settleFocus(paused, at)
    sendCredit(settled.credit)
    commit(settled.state)
    setNow(at)
  }

  const handleReset = () => {
    const at = Date.now()
    const settled = settleFocus(stateRef.current, at)
    sendCredit(settled.credit)
    commit(reset(settled.state))
    setNow(at)
  }

  const handleSkip = () => {
    const at = Date.now()
    const settled = settleFocus(stateRef.current, at)
    sendCredit(settled.credit)
    commit(skip(settled.state, at))
    setNow(at)
  }

  /** Board/drawer entry point: focus a task, crediting any previous segment. */
  const startFocusOnTask = (taskId, title) => {
    const at = Date.now()
    let next = stateRef.current
    if (next.taskId !== taskId) {
      const settled = settleFocus(next, at)
      sendCredit(settled.credit)
      next = settled.state
    }
    if (next.phase !== PHASE.FOCUS) next = reset({ ...next, phase: PHASE.FOCUS })
    if (next.status !== STATUS.RUNNING) next = start(next, at)
    next = beginFocusSegment(attachTask(next, taskId, title ?? null), at)
    primeAudio()
    if (next.settings.notify) ensureNotificationPermission()
    commit(next)
    setNow(at)
  }

  /** Detach the task (crediting the current measured segment). */
  const clearFocusTask = () => {
    const at = Date.now()
    const settled = settleFocus(stateRef.current, at)
    sendCredit(settled.credit)
    commit(attachTask(settled.state, null, null))
    setNow(at)
  }

  const focusStartRef = React.useRef(null)
  focusStartRef.current = startFocusOnTask
  React.useEffect(() => {
    focusBridge.start = (taskId, title) => focusStartRef.current?.(taskId, title)
    return () => { focusBridge.start = null }
  }, [])

  // Keep the board's active-task indicator in step with the timer.
  React.useEffect(() => {
    activeTaskStore.set(state.taskId, state.taskTitle)
  })

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
    state.taskId !== null
      ? h('div', { className: 'pomo-taskChip' },
        h('span', { className: 'pomo-taskLabel', title: state.taskTitle ?? '' }, state.taskTitle ?? t('focus.untitled')),
        h('button', {
          type: 'button',
          className: 'pomo-taskClear',
          'aria-label': t('focus.clear'),
          title: t('focus.clear'),
          onClick: clearFocusTask,
        }, '×'))
      : null,
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
      title: state.taskTitle === null ? `${t('widget.label')} — ${clock}` : `${state.taskTitle} — ${clock}`,
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
export const inject = ['slots', 'locale']

/**
 * Client plugin body.
 * @param ctx - client root context.
 * @param config - optional plugin config (`defaults` overrides the timer's
 *   initial lengths; `storageKey` isolates the record for a second instance).
 */
export function apply(ctx, config) {
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
