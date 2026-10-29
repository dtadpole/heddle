import type { IncomingMessage, ServerResponse } from 'node:http'

import { ScheduleInputError } from './errors.ts'
import { scheduleView } from './rules.ts'
import type { HistoryRequest, ScheduleService, UpdateRequest } from './service.ts'

/**
 * The page's reminder routes: DSH's remote `schedule` namespace (`catalog`, `list`, `history`, `update`, `delete`)
 * over HTTP, for the automation page, the session header's reminders and the sidebar mark.
 *
 * There is no create route, as DSH has no remote create: a reminder is created by the model in its own session
 * (`schedule_create`), and the page edits, inspects and deletes what exists. The answers are the service's own
 * values, so the page reads exactly what the tools read; a refused input is `400 {code, message}` with DSH's code,
 * and anything else is `500` with DSH's `internal_error` sentence, so storage details never reach the page.
 *
 * The server dispatches every `/api/schedule/` request here with one line, after its own authentication.
 */
export const SCHEDULE_ROUTE_PREFIX = '/api/schedule/'

/** The largest request body a route reads; an update carries one record and a change, far below this. */
const MAX_BODY_BYTES = 1_000_000

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(`${JSON.stringify(value, null, 2)}\n`)
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(buffer)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const required = (url: URL, name: string): string | undefined => {
  const value = url.searchParams.get(name)
  return value === null || value.length === 0 ? undefined : value
}

/**
 * Answer one request if it is a reminder route, and say whether it was.
 *
 * `schedule` is `undefined` when the profile does not load the schedule plugin; the route then answers `503`, the way
 * the goal and todo routes do.
 */
export async function handleScheduleRoute(schedule: ScheduleService | undefined, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (!url.pathname.startsWith(SCHEDULE_ROUTE_PREFIX)) return false
  if (schedule === undefined) {
    send(response, 503, { error: 'this profile does not load the schedule plugin' })
    return true
  }
  const route = `${request.method ?? 'GET'} ${url.pathname}`
  try {
    switch (route) {
      case 'GET /api/schedule/catalog': {
        send(response, 200, { tasks: await schedule.catalog() })
        return true
      }
      case 'GET /api/schedule/list': {
        const sessionId = required(url, 'session')
        if (sessionId === undefined) {
          send(response, 400, { error: 'a session is required' })
          return true
        }
        const now = schedule.now()
        send(response, 200, { sessionId, reminders: (await schedule.list({ sessionId })).map((record) => scheduleView(record, now)) })
        return true
      }
      case 'GET /api/schedule/history': {
        const sessionId = required(url, 'session')
        const id = required(url, 'id')
        if (sessionId === undefined || id === undefined) {
          send(response, 400, { error: 'a session and a reminder id are required' })
          return true
        }
        const limitText = url.searchParams.get('limit')
        const before = required(url, 'before')
        const request: HistoryRequest = { sessionId, id, limit: limitText === null ? 20 : Number(limitText), ...(before !== undefined ? { before } : {}) }
        send(response, 200, await schedule.history(request))
        return true
      }
      case 'POST /api/schedule/update': {
        const body = await readBody(request)
        if (body === null) {
          send(response, 400, { error: 'the body must be one JSON object' })
          return true
        }
        send(response, 200, await schedule.update(body as unknown as UpdateRequest))
        return true
      }
      case 'POST /api/schedule/delete': {
        const body = await readBody(request)
        if (body === null || typeof body['sessionId'] !== 'string' || typeof body['id'] !== 'string') {
          send(response, 400, { error: 'the body must be {sessionId, id}' })
          return true
        }
        send(response, 200, await schedule.delete({ sessionId: body['sessionId'], id: body['id'] }))
        return true
      }
      default: {
        send(response, 404, { error: `no reminder route ${route}` })
        return true
      }
    }
  } catch (error) {
    if (error instanceof ScheduleInputError) {
      send(response, 400, { code: error.code, message: error.message })
      return true
    }
    send(response, 500, { code: 'internal_error', message: 'The schedule operation failed.' })
    return true
  }
}
