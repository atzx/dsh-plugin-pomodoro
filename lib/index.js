/**
 * Pomodoro task board — host half.
 *
 * Owns the board's SQLite database and exposes it to the browser half through
 * five authenticated exact routes on DSH's connection carrier. The browser uses
 * same-origin `fetch('/api/pomodoro-board/…')`; over the Web carrier that is the
 * HTTP listener with the browser cookie, and in the desktop application the
 * shell's `dsh-app://` protocol forwards the request to the owned Host with its
 * authentication cookie (see `app.asar/lib/main.js`, `forwardWebRequest`).
 *
 * The plugin is inert in profiles without a `connection` service (headless
 * runs), and does nothing model-facing: no tool, prompt, session event, or
 * provider request is registered here.
 *
 * @module dsh-plugin-pomodoro/host
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { BOARD_ROUTES, createBoardHandlers } from './api.js'
import {
  BoardError,
  closeBoardDatabase,
  createBoardBackup,
  openBoardDatabase,
} from './db.js'

/** Cordis plugin name (the loader row id lives in the bundle patch). */
export const name = 'pomodoro-board'

/** The host half needs the connection carrier to publish its routes. */
export const inject = ['connection']

/** How often the backup task wakes up; the backup itself is once per day. */
const BACKUP_WAKE_MS = 6 * 60 * 60 * 1000

/**
 * Resolve the SQLite file path.
 * Priority: explicit `config.dbPath`, then `POMODORO_BOARD_DB`, then
 * `$DSH_HOME/pomodoro/board.sqlite` (`~/.dsh` when the variable is unset).
 * @param {{dbPath?: string}} [config] - loader-row configuration.
 * @returns {string} absolute database path.
 */
export function resolveDatabasePath(config = {}) {
  if (typeof config.dbPath === 'string' && config.dbPath.trim().length > 0) return config.dbPath
  const override = process.env.POMODORO_BOARD_DB
  if (typeof override === 'string' && override.trim().length > 0) return override
  const configured = process.env.DSH_HOME
  const home = typeof configured === 'string' && configured.trim().length > 0 ? configured : join(homedir(), '.dsh')
  return join(home, 'pomodoro', 'board.sqlite')
}

/**
 * Host plugin body: open the database, publish the routes, keep a daily backup.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context (has `connection`).
 * @param {{dbPath?: string}} [config] - loader-row configuration.
 */
export function apply(ctx, config = {}) {
  const filePath = resolveDatabasePath(config)
  try {
    mkdirSync(dirname(filePath), { recursive: true })
  } catch (error) {
    throw new Error(`pomodoro-board: cannot create the database directory for ${filePath}: ${String(error)}`)
  }

  const db = openBoardDatabase(filePath)
  const handlers = createBoardHandlers(db)
  const warn = message => {
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message)
    else console.warn(message)
  }
  const backup = () => {
    void createBoardBackup(db, filePath).catch(error => {
      warn(`pomodoro-board: backup failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  backup()

  ctx.effect(() => {
    const disposers = Object.entries(BOARD_ROUTES).map(([key, route]) => ctx.connection.fetch.register({
      path: route.path,
      methods: route.methods,
      requestBody: 'buffered',
      fetch: handlers[key],
    }))
    const timer = setInterval(backup, BACKUP_WAKE_MS)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      for (const dispose of disposers) {
        try { dispose() } catch { /* route already gone */ }
      }
      closeBoardDatabase(db)
    }
  }, 'pomodoro-board: sqlite routes')
}

export { BoardError }
