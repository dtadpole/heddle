import type { GenerateRequest, Message } from '../llm/types.ts'
import type { ToolDefinition, ToolResult } from '../tools/service.ts'
import type { JobChunk } from './ring.ts'
import { JobError, type JobRead, type JobRegistry, type JobView } from './registry.ts'

/**
 * The three model-facing job tools — `job_output`, `job_list`, `job_kill` — with DSH's descriptions, parameter
 * schemas, rendering and texts (`dsh-tool-jobs/lib/index.js`, cited `TOOL:n`).
 *
 * A registry refusal keeps heddle's tool error shape, `{code, message}`, with DSH's message: the model reads
 * `error (JOB_FOREIGN): job <id> belongs to another session` where DSH shows `Error: job <id> belongs to another
 * session`. The codes are the registry's, listed in `INDEX.md`.
 */

/** DSH's defaults for `job_output`'s wait (TOOL:88-93). */
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_WAIT_TIMEOUT_MS = 600_000

/**
 * DSH's `tool:jobs` prompt section (TOOL:257-261), verbatim. The jobs row adds it to every model request that offers
 * the job tools ({@link withJobsSection}, through the `model/request` waterfall).
 */
export const JOBS_PROMPT_SECTION =
  "Track every background job id you start. You are notified in-session when a job finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running job's work. Before giving a final answer, collect every still-relevant job with job_output (set wait: true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering."

/** The model-safe projection: no owner, offsets or limits; `detail` is the progress while live, the reason once settled. */
export interface PublicJob {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: JobView['status']
  readonly detail?: string
  readonly startedAt: number
  readonly finishedAt?: number
}

/** DSH's `publicJob` (TOOL:28-39). */
export function publicJob(job: JobView): PublicJob {
  const detail = job.progress ?? job.detail
  return {
    id: job.id,
    kind: job.kind,
    label: job.label,
    status: job.status,
    ...(detail !== undefined ? { detail } : {}),
    startedAt: job.startedAt,
    ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
  }
}

/** `[status: <s>]` or `[status: <s>, <detail>]` (TOOL:45-47). */
export function statusLine(job: { readonly status: string; readonly detail?: string }): string {
  return job.detail !== undefined ? `[status: ${job.status}, ${job.detail}]` : `[status: ${job.status}]`
}

/**
 * One consuming read as the model sees it (TOOL:61-70): stdout and unlabelled chunks in order, then every stderr chunk
 * in one `[stderr]` section; `log` chunks never reach the model; lost bytes end the read with the dropped-output note.
 */
export function renderModelDelta(chunks: readonly JobChunk[], lossy: boolean, spillPaths: readonly string[]): string {
  const visible = chunks.filter((chunk) => chunk.channel !== 'log')
  const out = visible
    .filter((chunk) => chunk.channel !== 'stderr')
    .map((chunk) => chunk.text)
    .join('')
  const err = visible
    .filter((chunk) => chunk.channel === 'stderr')
    .map((chunk) => chunk.text)
    .join('')
  const separator = out.length > 0 && !out.endsWith('\n') ? '\n' : ''
  const body = out + (err.length > 0 ? `${separator}[stderr]\n${err}` : '')
  if (!lossy && !visible.some((chunk) => chunk.gapBefore === true)) return body
  const notice = `[some output was dropped from memory; full output: ${spillPaths.length > 0 ? spillPaths.join(', ') : '(unavailable)'}]`
  return `${body}${body.length > 0 && !body.endsWith('\n') ? '\n' : ''}${notice}`
}

/** The delta, then the result once (TOOL:216-222). */
function readText(read: JobRead): string {
  const delta = renderModelDelta(read.chunks, read.lossy, read.job.output.spillPaths ?? [])
  return read.result === undefined ? delta : `${delta}${delta.length > 0 && !delta.endsWith('\n') ? '\n' : ''}${read.result}`
}

/** `job_output`'s text: the body or `(no new output)`, a newline if needed, then the status line (TOOL:331-337). */
export function renderJobOutput(text: string, job: PublicJob): string {
  const body = text.length > 0 ? text : '(no new output)'
  return `${body}${body.endsWith('\n') ? '' : '\n'}${statusLine(job)}`
}

/** `job_list`'s text (TOOL:356-359). The separator is DSH's em dash. */
export function renderJobList(jobs: readonly PublicJob[]): string {
  return jobs.length === 0 ? '(no background jobs)' : jobs.map((job) => `${job.id} [${job.kind}] ${job.status} — ${job.label}`).join('\n')
}

/** `job_kill`'s text (TOOL:398-401). */
export function renderJobKill(outcome: 'cancellation-requested' | 'already-finished', job: PublicJob): string {
  return outcome === 'already-finished' ? `job ${job.id} had already finished ${statusLine(job)}` : `requested cancellation of job ${job.id}`
}

/** The non-empty check the schema cannot express (TOOL:202-205). */
function validateJobId(value: unknown): string {
  const id = typeof value === 'string' ? value : ''
  if (id.length === 0) throw new JobError('JOB_INVALID_ARGS', `invalid job_id: expected a non-empty string, got ${JSON.stringify(value ?? '')}`)
  return id
}

function refusal(error: unknown): ToolResult {
  if (error instanceof JobError) return { output: '', error: { code: error.code, message: error.message } }
  throw error
}

const JOB_ID_DESCRIPTION = 'Job id returned by the tool that started the background work.'

export interface JobToolOptions {
  readonly waitTimeoutMs?: number
  readonly maxWaitTimeoutMs?: number
  /** Told when the model itself asked a job to stop, so its completion notice is suppressed (TOOL:262, 407). */
  readonly onModelKill?: (id: string) => void
}

/** Build the three tools over one registry. The caller is always the session the call runs in, never an argument. */
export function jobTools(jobs: JobRegistry, options: JobToolOptions = {}): readonly ToolDefinition[] {
  const waitDefault = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  const waitCap = options.maxWaitTimeoutMs ?? DEFAULT_MAX_WAIT_TIMEOUT_MS
  if (waitDefault > waitCap) throw new Error(`jobs: waitTimeoutMs (${waitDefault}) exceeds maxWaitTimeoutMs (${waitCap})`)

  const jobOutput: ToolDefinition = {
    spec: {
      name: 'job_output',
      description: 'Read a background job: output since the previous read for stream jobs, or the result of a finished final-output job.',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: JOB_ID_DESCRIPTION },
          wait: {
            type: 'boolean',
            description: 'Block until the job finishes or the timeout expires; a timed-out wait leaves the job running. Defaults to false.',
          },
          timeout_ms: { type: 'number', description: 'Max wait in milliseconds with wait: true. Defaults to and is capped by configuration.' },
        },
        required: ['job_id'],
        additionalProperties: false,
      },
    },
    run: async (args, context): Promise<ToolResult> => {
      const caller = context.session?.id
      try {
        const id = validateJobId(args.job_id)
        if (args.wait === true) {
          const requested = typeof args.timeout_ms === 'number' ? args.timeout_ms : waitDefault
          await jobs.wait(id, Math.min(requested, waitCap), caller, context.signal)
        }
        const read = jobs.read(id, caller)
        const job = publicJob(read.job)
        return { output: renderJobOutput(readText(read), job), data: { job } }
      } catch (error) {
        return refusal(error)
      }
    },
  }

  const jobList: ToolDefinition = {
    spec: {
      name: 'job_list',
      description: 'List your background jobs (running and finished) with their ids, kinds, and statuses.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    run: async (_args, context): Promise<ToolResult> => {
      const list = jobs.list(context.session?.id).map(publicJob)
      return { output: renderJobList(list), data: { jobs: list } }
    },
  }

  const jobKill: ToolDefinition = {
    spec: {
      name: 'job_kill',
      description: 'Request cancellation of a running background job.',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: JOB_ID_DESCRIPTION },
          reason: { type: 'string', description: 'Optional short reason, recorded in the log and forwarded to the job.' },
        },
        required: ['job_id'],
        additionalProperties: false,
      },
    },
    run: async (args, context): Promise<ToolResult> => {
      const caller = context.session?.id
      try {
        const id = validateJobId(args.job_id)
        const result = jobs.kill(id, caller, typeof args.reason === 'string' ? args.reason : undefined)
        if (result === 'requested') options.onModelKill?.(id)
        const job = publicJob(jobs.get(id, caller))
        const outcome = result === 'already-finished' ? 'already-finished' : 'cancellation-requested'
        return { output: renderJobKill(outcome, job), data: { outcome, job } }
      } catch (error) {
        return refusal(error)
      }
    },
  }

  return [jobOutput, jobList, jobKill]
}

/**
 * The request with DSH's `tool:jobs` section in its system prompt, when the request offers `job_output`.
 *
 * DSH registers the section with its system-prompt service whenever the job tools are loaded, and joins sections with a
 * blank line (`dsh-system-prompt`: `sections ... .join("\n\n")`). Heddle composes no sections, so the jobs row adds the
 * text where DSH's lands — at the end of the system prompt, the request's first `system` message — on the way to the
 * adapter. The session log keeps the request as the loop built it; the section is the composition's, like the rest of
 * the system prompt. A request without the job tools (a probe, a title, a profile without the row) is untouched, and a
 * request that already carries the section is not given it twice.
 */
export function withJobsSection(request: GenerateRequest): GenerateRequest {
  if (request.tools?.some((tool) => tool.name === 'job_output') !== true) return request
  const index = request.messages.findIndex((message) => message.role === 'system')
  if (index === -1) {
    const section: Message = { role: 'system', content: [{ type: 'text', text: JOBS_PROMPT_SECTION }] }
    return { ...request, messages: [section, ...request.messages] }
  }
  const system = request.messages[index] as Message
  if (system.content.some((part) => part.type === 'text' && part.text.includes(JOBS_PROMPT_SECTION))) return request
  const last = system.content.map((part) => part.type).lastIndexOf('text')
  const content =
    last === -1
      ? [...system.content, { type: 'text' as const, text: JOBS_PROMPT_SECTION }]
      : system.content.map((part, at) => (at === last && part.type === 'text' ? { ...part, text: `${part.text}\n\n${JOBS_PROMPT_SECTION}` } : part))
  const messages = request.messages.map((message, at) => (at === index ? { ...message, content } : message))
  return { ...request, messages }
}
