import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { AttachmentInputError, readAttachments } from '../server/attachments.ts'
import type { SessionHandle } from '../session/store.ts'
import { CommandInputError, type CommandLog, type CommandRegistry } from './registry.ts'

/**
 * The command routes, handed to by the server in one line:
 *
 *   if (await handleCommandRequest(commandHost, request, response, url)) return
 *
 * - `GET /commands/menu.js` serves the composer's slash menu, which the page imports (`menu.js`).
 * - `GET /api/commands` lists the registered commands (the page's slash menu reads it).
 * - `POST /api/sessions/{id}/commands` with `{line, attachments?}` runs one line; `attachments` is the same list of
 *   uploaded paths a turn takes, and a command that does not accept them refuses with `400` before anything is written. A line that is not a registered command answers
 *   `{matched: false}` and writes nothing, so the page sends it on as an ordinary prompt — DSH's rule, and how an
 *   unknown `/word` still reaches the model. A registered one answers `{matched: true, commandId, name, kind, text?,
 *   action?, seq}`; a handler's refusal is `kind: 'error'` with status 200, because the command ran and its row says
 *   so.
 *
 * The server calls this behind its door, after the token check, like every other `/api` route.
 */

/** What the routes read: the registry, the session store and the log a run writes to. */
export interface CommandRouteHost {
  readonly registry: CommandRegistry
  readonly log: CommandLog
  open(id: string): SessionHandle | null
}

/** A session id as the store mints it. */
const SESSION_ID = /^session-[0-9a-f-]{36}$/i

/** Where the page imports the slash menu from. */
export const MENU_PATH = '/commands/menu.js'

/**
 * The menu module's source, read from `src/commands/menu.js` on each request.
 *
 * Two levels up from this file is the checkout's root both when it runs as `src/commands/http.ts` and when it runs
 * built as `dist/commands/http.js`, so the build needs no copy step and the Rust binary embeds the same file.
 */
export function menuSource(): string {
  return readFileSync(new URL('../../src/commands/menu.js', import.meta.url), 'utf8')
}

/** The largest command line a request may carry. */
export const MAX_COMMAND_LINE = 64 * 1024

/** Handle a command route, or answer `false` so the server goes on to its other routes. */
export async function handleCommandRequest(host: CommandRouteHost, request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === MENU_PATH && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    response.end(menuSource())
    return true
  }
  if (url.pathname === '/api/commands' && request.method === 'GET') {
    json(response, 200, { commands: host.registry.list() })
    return true
  }
  if (url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/commands') && request.method === 'POST') {
    const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length, -'/commands'.length))
    if (!SESSION_ID.test(id)) {
      json(response, 400, { error: 'not a session id' })
      return true
    }
    const handle = host.open(id)
    if (handle === null) {
      json(response, 404, { error: `no session ${id}` })
      return true
    }
    const body = await readBody(request)
    if (body === 'too-large') {
      json(response, 413, { error: `a command line is at most ${MAX_COMMAND_LINE} bytes` })
      return true
    }
    if (body === null || typeof body.line !== 'string') {
      json(response, 400, { error: 'the body must be JSON with a string "line"' })
      return true
    }
    let execution
    try {
      execution = await host.registry.execute(host.log, handle, body.line, readAttachments(body.attachments))
    } catch (error) {
      if (error instanceof AttachmentInputError || error instanceof CommandInputError) {
        json(response, 400, { error: error.message })
        return true
      }
      throw error
    }
    if (execution === undefined) {
      json(response, 200, { matched: false })
      return true
    }
    const { result } = execution
    json(response, 200, {
      matched: true,
      commandId: execution.commandId,
      name: execution.name,
      kind: result.kind,
      ...(result.text !== undefined ? { text: result.text } : {}),
      ...(result.kind === 'success' && result.action !== undefined ? { action: result.action } : {}),
      seq: execution.seq,
    })
    return true
  }
  return false
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown> | null | 'too-large'> {
  let raw = ''
  for await (const chunk of request) {
    raw += chunk
    if (Buffer.byteLength(raw) > MAX_COMMAND_LINE + 1024) return 'too-large'
  }
  try {
    const parsed: unknown = JSON.parse(raw.length === 0 ? '{}' : raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(`${JSON.stringify(value, null, 2)}\n`)
}
