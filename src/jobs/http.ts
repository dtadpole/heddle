import type { IncomingMessage, ServerResponse } from 'node:http'

import { JobError, isTerminal, type JobRegistry } from './registry.ts'

/**
 * The person's job routes: DSH's `jobController` (`dsh-api-job-controller/lib/index.js:324-373`) over HTTP.
 *
 * - `GET /api/jobs?session=<id>` — `{jobs}`: the session's jobs plus the unowned ones (DSH's `job.list` frame).
 * - `GET /api/jobs/follow?session=&job=&from=<offset>` — `{job, chunks, next, lossy?, settled}`: one non-consuming
 *   read from an absolute offset (DSH's `job.follow`). It uses only `get` and `readAt`, so the model's cursor never
 *   moves: what the page shows, the model's next `job_output` still returns. The page polls it while a row is open,
 *   passing `next` back as `from`; `settled` is true once the job has settled and every byte up to it was answered.
 * - `POST /api/jobs/kill {session, job}` — `{outcome}`: a kill with reason `cancelled by the user`. It is not the
 *   model's kill, so the completion notice is still sent.
 *
 * A job the session cannot see, and an unknown one, are `404 {code: 'job/not-found', message}` (DSH's code). DSH
 * streams `list` and `follow`; heddle's page refreshes on the server's `jobs` event and polls `follow`, so both are
 * single answers here. The server dispatches every `/api/jobs` request here with one line, after its own
 * authentication.
 */
export const JOBS_ROUTE = '/api/jobs'

/** The largest request body a route reads; a kill carries two ids. */
const MAX_BODY_BYTES = 64 * 1024

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

const param = (url: URL, name: string): string | undefined => {
  const value = url.searchParams.get(name)
  return value === null || value.length === 0 ? undefined : value
}

/**
 * A registry refusal as the route answers it: an unseen job is DSH's `job/not-found`; a bad offset is a 400.
 *
 * Recognised by **class or name**: the server is compiled while the row's registry may be loaded from source, so the
 * error class can cross module graphs, and an `instanceof` that silently fails there would answer a refusal as a 500
 * (measured with the check: a foreign follow answered 500). The name and the code are part of the class's contract.
 */
function refuse(response: ServerResponse, error: unknown): void {
  if (error instanceof JobError || (error instanceof Error && error.name === 'JobError' && typeof (error as { code?: unknown }).code === 'string')) {
    const { code, message } = error as JobError
    if (code === 'JOB_UNKNOWN' || code === 'JOB_FOREIGN') {
      send(response, 404, { code: 'job/not-found', message })
      return
    }
    send(response, 400, { code, message })
    return
  }
  send(response, 500, { code: 'internal_error', message: 'The job operation failed.' })
}

/**
 * Answer one request if it is a job route, and say whether it was. `jobs` is `undefined` when the profile does not
 * load the jobs row; the routes then answer `503`, as the schedule and goal routes do.
 */
export async function handleJobsRoute(jobs: JobRegistry | undefined, url: URL, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (url.pathname !== JOBS_ROUTE && !url.pathname.startsWith(`${JOBS_ROUTE}/`)) return false
  if (jobs === undefined) {
    send(response, 503, { error: 'this profile does not load the jobs plugin' })
    return true
  }
  const route = `${request.method ?? 'GET'} ${url.pathname}`
  try {
    switch (route) {
      case `GET ${JOBS_ROUTE}`: {
        const session = param(url, 'session')
        if (session === undefined) {
          send(response, 400, { error: 'a session is required' })
          return true
        }
        send(response, 200, { jobs: jobs.list(session) })
        return true
      }
      case `GET ${JOBS_ROUTE}/follow`: {
        const session = param(url, 'session')
        const id = param(url, 'job')
        if (session === undefined || id === undefined) {
          send(response, 400, { error: 'a session and a job are required' })
          return true
        }
        const fromText = param(url, 'from')
        const from = fromText === undefined ? 0 : Number(fromText)
        // The view first: a job that has settled appends nothing more, so a read after it holds every byte.
        const job = jobs.get(id, session)
        const read = jobs.readAt(id, from, session)
        send(response, 200, { job, chunks: read.chunks, next: read.next, ...(read.lossy ? { lossy: true } : {}), settled: isTerminal(job.status) })
        return true
      }
      case `POST ${JOBS_ROUTE}/kill`: {
        const body = await readBody(request)
        if (body === null || typeof body['session'] !== 'string' || typeof body['job'] !== 'string') {
          send(response, 400, { error: 'the body must be {session, job}' })
          return true
        }
        const session = body['session']
        const id = body['job']
        jobs.get(id, session)
        send(response, 200, { outcome: jobs.kill(id, session, 'cancelled by the user') })
        return true
      }
      default: {
        send(response, 404, { error: `no job route ${route}` })
        return true
      }
    }
  } catch (error) {
    refuse(response, error)
    return true
  }
}
