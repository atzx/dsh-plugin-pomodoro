/**
 * HTTP surface of the Pomodoro task board (host half).
 *
 * Five authenticated exact routes on DSH's connection carrier: read the board,
 * read its revision, run one mutation, export, import. The carrier owns auth
 * (browser cookie or the desktop IPC proxy) and trust; this module owns request
 * parsing, limits, and turning `BoardError`s into JSON the client can word.
 *
 * @module dsh-plugin-pomodoro/api
 */
import {
  BoardError,
  applyBoardCommand,
  exportBoard,
  importBoard,
  readBoard,
  readRevision,
} from './db.js'

/** Route table: key → carrier registration. */
export const BOARD_ROUTES = Object.freeze({
  state: { path: '/api/pomodoro-board/state', methods: ['GET'] },
  revision: { path: '/api/pomodoro-board/revision', methods: ['GET'] },
  command: { path: '/api/pomodoro-board/command', methods: ['POST'] },
  export: { path: '/api/pomodoro-board/export', methods: ['GET'] },
  import: { path: '/api/pomodoro-board/import', methods: ['POST'] },
})

/** Largest accepted command body. */
export const MAX_COMMAND_BYTES = 1_048_576
/** Largest accepted import body. */
export const MAX_IMPORT_BYTES = 5 * 1_048_576

/** JSON response with no-store caching. */
function jsonResponse(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  })
}

/** Today's date as a file-name-safe suffix. */
function exportFilename(at = new Date()) {
  return `pomodoro-board-${at.toISOString().slice(0, 10)}.json`
}

/**
 * Read and parse a JSON body within a byte budget.
 * @param {Request} request - carrier request.
 * @param {number} maxBytes - maximum accepted body length.
 * @returns {Promise<unknown>} parsed JSON.
 */
async function readJsonBody(request, maxBytes) {
  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) {
    throw new BoardError('payload-too-large', `request body exceeds ${maxBytes} bytes`, 413)
  }
  const text = await request.text()
  if (text.length > maxBytes) throw new BoardError('payload-too-large', `request body exceeds ${maxBytes} bytes`, 413)
  if (text.trim().length === 0) throw new BoardError('invalid-json', 'request body is empty', 400)
  try {
    return JSON.parse(text)
  } catch {
    throw new BoardError('invalid-json', 'request body is not valid JSON', 400)
  }
}

/** Enforce the route's HTTP method (the carrier also filters, defensively). */
function requireMethod(request, method) {
  if (request.method !== method) throw new BoardError('method-not-allowed', `expected ${method}`, 405)
}

/**
 * Map a handler into a carrier fetch handler with JSON error responses.
 * @param {(request: Request) => Promise<Response>} work - route implementation.
 * @returns {(request: Request) => Promise<Response>} wrapped handler.
 */
function handle(work) {
  return async request => {
    try {
      return await work(request)
    } catch (error) {
      if (error instanceof BoardError) {
        return jsonResponse(
          {
            error: {
              code: error.code,
              message: error.message,
              ...(error.details === undefined ? {} : { details: error.details }),
            },
          },
          error.status,
        )
      }
      console.error('[pomodoro-board] unexpected API failure:', error)
      return jsonResponse({ error: { code: 'internal', message: 'board operation failed' } }, 500)
    }
  }
}

/**
 * Build the five route handlers bound to one open board database.
 * @param {import('node:sqlite').DatabaseSync} db - open board database.
 * @returns {Record<keyof typeof BOARD_ROUTES, (request: Request) => Promise<Response>>} handlers.
 */
export function createBoardHandlers(db) {
  return {
    state: handle(async request => {
      requireMethod(request, 'GET')
      return jsonResponse({ revision: readRevision(db), board: readBoard(db) })
    }),

    revision: handle(async request => {
      requireMethod(request, 'GET')
      return jsonResponse({ revision: readRevision(db) })
    }),

    command: handle(async request => {
      requireMethod(request, 'POST')
      const body = await readJsonBody(request, MAX_COMMAND_BYTES)
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new BoardError('invalid-payload', 'body must be an object with op and payload', 400)
      }
      const payload = body.payload === undefined || body.payload === null ? {} : body.payload
      return jsonResponse(applyBoardCommand(db, body.op, payload))
    }),

    export: handle(async request => {
      requireMethod(request, 'GET')
      return jsonResponse(exportBoard(db), 200, {
        'content-disposition': `attachment; filename="${exportFilename()}"`,
      })
    }),

    import: handle(async request => {
      requireMethod(request, 'POST')
      const body = await readJsonBody(request, MAX_IMPORT_BYTES)
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new BoardError('invalid-payload', 'body must be an object', 400)
      }
      const mode = body.mode ?? 'replace'
      if (mode !== 'replace') throw new BoardError('unsupported-import-mode', `unsupported import mode: ${String(mode)}`, 400)
      // Accept either the export envelope (`{ format, board }`) or `{ board }`.
      const board = body.board
      if (board === null || typeof board !== 'object') throw new BoardError('invalid-import', 'body.board must be an object', 400)
      return jsonResponse(importBoard(db, board))
    }),
  }
}
