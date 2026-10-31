import type { IncomingMessage, ServerResponse } from 'node:http'

import type { SessionHandle } from '../session/store.ts'

/**
 * The plan route, handed to by the server in one line, behind its door:
 *
 *   if (plan !== undefined && (await handlePlanRequest(plan.routes, request, response, url))) return
 *
 * `GET /api/sessions/{id}/plan` answers `{session, active}`: whether the session is in plan mode, which the composer's
 * Plan chip and placeholder follow when a session is shown. Changes arrive afterwards as `plan/mode` session events.
 */

/** What the route reads. */
export interface PlanRouteHost {
  open(id: string): SessionHandle | null
  active(handle: SessionHandle): boolean
}

const SESSION_ID = /^session-[0-9a-f-]{36}$/i

/** Handle the plan route, or answer `false` so the server goes on to its other routes. */
export async function handlePlanRequest(host: PlanRouteHost, request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  if (!(url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/plan') && request.method === 'GET')) return false
  const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length, -'/plan'.length))
  if (!SESSION_ID.test(id)) {
    json(response, 400, { error: 'not a session id' })
    return true
  }
  const handle = host.open(id)
  if (handle === null) {
    json(response, 404, { error: `no session ${id}` })
    return true
  }
  json(response, 200, { session: id, active: host.active(handle) })
  return true
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(`${JSON.stringify(value, null, 2)}\n`)
}
