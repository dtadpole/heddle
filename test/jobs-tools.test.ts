import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { ApprovalService } from '../src/approvals/service.ts'
import { bashBackground, processOutcome, runningToolCall, RUN_IN_BACKGROUND_DESCRIPTION } from '../src/jobs/bash.ts'
import { JobRegistry, type JobEvent, type JobOutcome } from '../src/jobs/registry.ts'
import { jobTools, renderJobList, renderModelDelta, statusLine } from '../src/jobs/tools.ts'
import { killProcessGroup } from '../src/sandbox/process-group.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { SessionService } from '../src/session/service.ts'
import type { SessionEvent } from '../src/session/store.ts'
import { attachBashBackground, builtinTools } from '../src/tools/builtin.ts'
import { ToolRegistry } from '../src/tools/service.ts'

const scratch = mkdtempSync(join(tmpdir(), 'heddle-jobs-tools-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
let counter = 0

/** The real tool registry, the built-ins, the job tools and background bash over one registry and one session store. */
function harness(options: { readonly attach?: boolean; readonly killGraceMs?: number } = {}) {
  const root = join(scratch, `h-${(counter += 1)}`)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const sandbox = new SandboxService(new Context(), { mode: 'danger-full-access', workspaceRoot: workspace, backend: 'none' })
  const sessions = new SessionService(new Context(), { root: join(root, 'sessions') })
  const tools = new ToolRegistry(new Context(), new ApprovalService(new Context(), { mode: 'allow' }), sandbox, sessions)
  for (const tool of builtinTools(sandbox)) tools.register(tool)
  const jobs = new JobRegistry({
    sessionExists: (id) => sessions.store.open(id) !== null,
    record: (id, type, data) => {
      const handle = sessions.store.open(id)
      if (handle !== null) sessions.store.append(handle, { type, ...data })
    },
  })
  jobs.attachController('test')
  const modelKills: string[] = []
  for (const tool of jobTools(jobs, { onModelKill: (id) => modelKills.push(id) })) tools.register(tool)
  const pids = new Map<string, number>()
  const detach =
    options.attach === false
      ? () => undefined
      : attachBashBackground(
          sandbox,
          bashBackground(jobs, sandbox, {
            readLog: (handle) => sessions.store.read(handle),
            ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
            onSpawn: (id, pid) => pids.set(id, pid),
          }),
        )
  const events: JobEvent[] = []
  jobs.subscribe((event) => events.push(event))
  const a = sessions.start({ cwd: workspace })
  const b = sessions.start({ cwd: workspace })
  const call = (name: string, args: Record<string, unknown>, session = a) => tools.call(name, args, { cwd: workspace, session, log: () => undefined })
  return { tools, jobs, sessions, sandbox, a, b, call, events, pids, modelKills, detach, workspace }
}

async function settled(events: JobEvent[], id: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = events.find((event) => event.type === 'settled' && event.job.id === id)
    if (found !== undefined) return found as Extract<JobEvent, { type: 'settled' }>
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`job ${id} never settled`)
}

/** Whether any process is left in a process group. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

const jobIdOf = (output: string): string => {
  const match = /^started background job (bash-[0-9a-f]{16})$/.exec(output)
  assert.ok(match !== null, `not a start answer: ${output}`)
  return match[1] as string
}

// ---------------------------------------------------------------------------------------------------------------
// Renderings
// ---------------------------------------------------------------------------------------------------------------

test('the delta renders stdout, then one [stderr] section, drops log chunks, and ends a lossy read with the note', () => {
  assert.equal(
    renderModelDelta(
      [
        { at: 0, text: 'out', channel: 'stdout' },
        { at: 3, text: 'err\n', channel: 'stderr' },
        { at: 7, text: 'narration', channel: 'log' },
        { at: 16, text: ' more\n', channel: 'stdout' },
      ],
      false,
      [],
    ),
    'out more\n[stderr]\nerr\n',
  )
  assert.equal(renderModelDelta([{ at: 0, text: 'x', channel: 'stdout' }], false, []), 'x')
  assert.equal(renderModelDelta([{ at: 0, text: 'e', channel: 'stderr' }], false, []), '[stderr]\ne')
  assert.equal(renderModelDelta([{ at: 9, text: 'tail' }], true, []), 'tail\n[some output was dropped from memory; full output: (unavailable)]')
  assert.equal(renderModelDelta([{ at: 9, text: 'tail\n', gapBefore: true }], false, ['/a', '/b']), 'tail\n[some output was dropped from memory; full output: /a, /b]')
  assert.equal(statusLine({ status: 'running' }), '[status: running]')
  assert.equal(statusLine({ status: 'completed', detail: 'exit code: 3' }), '[status: completed, exit code: 3]')
  assert.equal(renderJobList([]), '(no background jobs)')
})

test('the three tools carry DSH descriptions and parameter schemas', () => {
  const { tools } = harness()
  const specs = Object.fromEntries(tools.describe().map((spec) => [spec.name, spec]))
  assert.equal(specs.job_output?.description, 'Read a background job: output since the previous read for stream jobs, or the result of a finished final-output job.')
  assert.deepEqual(specs.job_output?.parameters.properties, {
    job_id: { type: 'string', description: 'Job id returned by the tool that started the background work.' },
    wait: { type: 'boolean', description: 'Block until the job finishes or the timeout expires; a timed-out wait leaves the job running. Defaults to false.' },
    timeout_ms: { type: 'number', description: 'Max wait in milliseconds with wait: true. Defaults to and is capped by configuration.' },
  })
  assert.deepEqual(specs.job_output?.parameters.required, ['job_id'])
  assert.equal(specs.job_list?.description, 'List your background jobs (running and finished) with their ids, kinds, and statuses.')
  assert.deepEqual(specs.job_list?.parameters.properties, {})
  assert.equal(specs.job_kill?.description, 'Request cancellation of a running background job.')
  assert.deepEqual(specs.job_kill?.parameters.properties, {
    job_id: { type: 'string', description: 'Job id returned by the tool that started the background work.' },
    reason: { type: 'string', description: 'Optional short reason, recorded in the log and forwarded to the job.' },
  })
})

test('bash advertises run_in_background only while the jobs runner is attached, and the foreground schema is otherwise unchanged', () => {
  const plain = harness({ attach: false })
  const before = plain.tools.describe().find((spec) => spec.name === 'bash')
  assert.deepEqual(Object.keys(before?.parameters.properties ?? {}), ['command', 'timeoutMs'])
  const attached = harness()
  const bash = attached.tools.describe().find((spec) => spec.name === 'bash')
  assert.deepEqual(Object.keys(bash?.parameters.properties ?? {}), ['command', 'timeoutMs', 'run_in_background'])
  assert.deepEqual((bash?.parameters.properties as Record<string, unknown> | undefined)?.run_in_background, { type: 'boolean', description: RUN_IN_BACKGROUND_DESCRIPTION })
  assert.equal(RUN_IN_BACKGROUND_DESCRIPTION, 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.')
  attached.detach()
  const detached = attached.tools.describe().find((spec) => spec.name === 'bash')
  assert.deepEqual(detached, before, 'detached, the schema is the foreground one again')
})

test('a background call with no jobs row is refused, and a foreground call still runs in the foreground', async () => {
  const { call } = harness({ attach: false })
  const refused = await call('bash', { command: 'echo hi', run_in_background: true })
  assert.deepEqual(refused.error, { code: 'JOB_UNAVAILABLE', message: 'background jobs unavailable: load the jobs row (src/plugins/jobs.ts)' })
  const foreground = await call('bash', { command: 'echo hi' })
  assert.equal(foreground.output, 'hi\n')
  assert.equal(foreground.error, undefined)
})

// ---------------------------------------------------------------------------------------------------------------
// Background bash, end to end with real processes
// ---------------------------------------------------------------------------------------------------------------

test('sleep 30 answers an id at once; job_kill requests cancellation, the group is gone and the job settles killed with the signal', async () => {
  const h = harness()
  const started = Date.now()
  const result = await h.call('bash', { command: 'sleep 30', run_in_background: true })
  assert.ok(Date.now() - started < 2_000, 'the call returned without waiting for the command')
  assert.equal(result.error, undefined)
  const id = jobIdOf(result.output)
  const pid = h.pids.get(id)
  assert.ok(pid !== undefined && groupAlive(pid), 'the command runs in its own process group')
  const listed = await h.call('job_list', {})
  assert.equal(listed.output, `${id} [bash] running — sleep 30`)
  const running = await h.call('job_output', { job_id: id })
  assert.equal(running.output, '(no new output)\n[status: running]')
  const kill = await h.call('job_kill', { job_id: id })
  assert.equal(kill.output, `requested cancellation of job ${id}`)
  assert.deepEqual(h.modelKills, [id])
  const end = await settled(h.events, id)
  assert.equal(end.job.status, 'killed')
  assert.equal(end.job.detail, 'signal: SIGTERM')
  assert.equal(end.cause, 'kill')
  assert.equal(groupAlive(pid), false, 'the process group is gone')
  const again = await h.call('job_kill', { job_id: id })
  assert.equal(again.output, `job ${id} had already finished [status: killed, signal: SIGTERM]`)
  const finished = await h.call('job_list', {})
  assert.equal(finished.output, `${id} [bash] killed — sleep 30`)
})

test('a job_kill reason is merged into the settled detail', async () => {
  const h = harness()
  const id = jobIdOf((await h.call('bash', { command: 'sleep 30', run_in_background: true })).output)
  await h.call('job_kill', { job_id: id, reason: 'superseded' })
  assert.equal((await settled(h.events, id)).job.detail, 'signal: SIGTERM; superseded')
})

test('a command that ignores SIGTERM is killed with SIGKILL after the grace period, grandchildren included', async () => {
  const h = harness({ killGraceMs: 200 })
  const id = jobIdOf((await h.call('bash', { command: "trap '' TERM; sleep 30 & wait", run_in_background: true })).output)
  const pid = h.pids.get(id) as number
  await new Promise((resolve) => setTimeout(resolve, 100))
  h.jobs.kill(id, h.a.id)
  const end = await settled(h.events, id)
  assert.equal(end.job.status, 'killed')
  assert.match(end.job.detail ?? '', /^signal: SIG(KILL|TERM)$/)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(groupAlive(pid), false, 'nothing of the group survives')
})

test('a job kill and a foreground stop share one group helper: it sends the signal it is given, and refuses pids 0 and 1', async () => {
  // The jobs producer sends SIGTERM, then SIGKILL, through the helper the foreground bash sends SIGKILL with.
  assert.equal(killProcessGroup(0, 'SIGTERM'), false)
  assert.equal(killProcessGroup(1, 'SIGTERM'), false)
  const shell = spawn('/bin/sh', ['-c', 'sleep 30 & wait'], { detached: true, stdio: 'ignore' })
  const pid = shell.pid as number
  const exited = new Promise<NodeJS.Signals | null>((resolve) => shell.on('exit', (_code, signal) => resolve(signal)))
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(groupAlive(pid), true)
  assert.equal(killProcessGroup(pid, 'SIGTERM'), true)
  assert.equal(await exited, 'SIGTERM', 'the leader died of the signal it was sent, not SIGKILL')
  const deadline = Date.now() + 3_000
  while (groupAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(groupAlive(pid), false, 'the sleep the shell started got the SIGTERM too')
  assert.equal(killProcessGroup(pid, 'SIGTERM'), true, 'a group already gone counts as signalled')
})

test('echo x; exit 3 settles completed with exit code 3, and job_output renders it verbatim', async () => {
  const h = harness()
  const id = jobIdOf((await h.call('bash', { command: 'echo x; echo oops >&2; exit 3', run_in_background: true })).output)
  const end = await settled(h.events, id)
  assert.equal(end.job.status, 'completed')
  assert.equal(end.job.detail, 'exit code: 3')
  const read = await h.call('job_output', { job_id: id })
  assert.equal(read.output, 'x\n[stderr]\noops\n[status: completed, exit code: 3]')
  const empty = await h.call('job_output', { job_id: id })
  assert.equal(empty.output, '(no new output)\n[status: completed, exit code: 3]')
})

test('job_output reads only new output, and wait with a short timeout leaves the job running', async () => {
  const h = harness()
  const id = jobIdOf((await h.call('bash', { command: 'echo one; sleep 0.3; echo two; sleep 30', run_in_background: true })).output)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const first = await h.call('job_output', { job_id: id })
  assert.equal(first.output, 'one\n[status: running]')
  await new Promise((resolve) => setTimeout(resolve, 400))
  const second = await h.call('job_output', { job_id: id })
  assert.equal(second.output, 'two\n[status: running]')
  const waited = Date.now()
  const timedOut = await h.call('job_output', { job_id: id, wait: true, timeout_ms: 100 })
  assert.ok(Date.now() - waited >= 90)
  assert.equal(timedOut.output, '(no new output)\n[status: running]')
  assert.equal(h.jobs.get(id, h.a.id).status, 'running')
  h.jobs.kill(id, h.a.id)
  await settled(h.events, id)
})

test('job_output with wait collects the settle, which is then awaited', async () => {
  const h = harness()
  const id = jobIdOf((await h.call('bash', { command: 'sleep 0.2; echo done', run_in_background: true })).output)
  const read = await h.call('job_output', { job_id: id, wait: true, timeout_ms: 5_000 })
  assert.equal(read.output, 'done\n[status: completed, exit code: 0]')
  assert.equal((await settled(h.events, id)).awaited, true)
})

test('another session is refused job_output and job_kill on a job it does not own', async () => {
  const h = harness()
  const id = jobIdOf((await h.call('bash', { command: 'sleep 30', run_in_background: true })).output)
  const read = await h.call('job_output', { job_id: id }, h.b)
  assert.deepEqual(read.error, { code: 'JOB_FOREIGN', message: `job ${id} belongs to another session` })
  const kill = await h.call('job_kill', { job_id: id }, h.b)
  assert.deepEqual(kill.error, { code: 'JOB_FOREIGN', message: `job ${id} belongs to another session` })
  assert.equal((await h.call('job_list', {}, h.b)).output, '(no background jobs)')
  const unknown = await h.call('job_output', { job_id: 'bash-0000000000000000' })
  assert.deepEqual(unknown.error, { code: 'JOB_UNKNOWN', message: 'unknown job bash-0000000000000000' })
  const empty = await h.call('job_output', { job_id: '' })
  assert.deepEqual(empty.error, { code: 'JOB_INVALID_ARGS', message: 'invalid job_id: expected a non-empty string, got ""' })
  h.jobs.kill(id, h.a.id)
  await settled(h.events, id)
})

test('a spawn failure settles failed with the error', async () => {
  const h = harness()
  const missing = join(h.workspace, 'no-such-folder')
  const result = await h.tools.call('bash', { command: 'echo hi', run_in_background: true }, { cwd: missing, session: h.a, log: () => undefined })
  const id = jobIdOf(result.output)
  const end = await settled(h.events, id)
  assert.equal(end.job.status, 'failed')
  assert.match(end.job.detail ?? '', /ENOENT/)
})

test('the background job writes job/registered with the tool call read from the log, and job/settled', async () => {
  const h = harness()
  // The model's answer, as the loop records it, before the tool runs.
  h.sessions.store.append(h.a, { type: 'model/request', endpoint: 'fake' })
  h.sessions.store.append(h.a, { type: 'assistant/chunk', chunk: { type: 'tool-call', id: 'call_x', name: 'bash', arguments: '{"command":"exit 0","run_in_background":true}' } })
  const id = jobIdOf((await h.call('bash', { command: 'exit 0', run_in_background: true })).output)
  await settled(h.events, id)
  const events = h.sessions.store.read(h.a)
  const registered = events.find((event) => event.type === 'job/registered') as SessionEvent
  assert.equal(registered.jobId, id)
  assert.equal(registered.owner, h.a.id)
  assert.equal(registered.kind, 'bash')
  assert.equal(registered.label, 'exit 0')
  assert.deepEqual(registered.toolCall, { callId: 'call_x', rootCallId: 'call_x' })
  const end = events.find((event) => event.type === 'job/settled') as SessionEvent
  assert.equal(end.status, 'completed')
  assert.equal(end.detail, 'exit code: 0')
  assert.equal(end.cause, 'producer')
})

test('runningToolCall skips answered calls and matches arguments', () => {
  const event = (seq: number, type: string, rest: Record<string, unknown>): SessionEvent => ({ seq, at: '', type, ...rest })
  const log = [
    event(0, 'model/request', {}),
    event(1, 'assistant/chunk', { chunk: { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"a"}' } }),
    event(2, 'assistant/chunk', { chunk: { type: 'tool-call', id: 'c2', name: 'bash', arguments: '{"command":"a"}' } }),
    event(3, 'message', { message: { role: 'tool', toolCallId: 'c1', content: [] } }),
  ]
  assert.deepEqual(runningToolCall(log, 'bash', { command: 'a' }), { callId: 'c2', rootCallId: 'c2' })
  assert.equal(runningToolCall(log, 'bash', { command: 'b' }), undefined)
})

test('processOutcome maps a settled process as DSH does, sandbox notes joined with "; "', () => {
  const outcome = (end: Parameters<typeof processOutcome>[0], modes: string[] = []): JobOutcome => processOutcome(end, modes)
  assert.deepEqual(outcome({ killed: true, exitCode: null, signal: 'SIGTERM' }), { status: 'killed', detail: 'signal: SIGTERM' })
  assert.deepEqual(outcome({ killed: true, exitCode: 143, signal: null }), { status: 'killed', detail: 'killed before exit' })
  assert.deepEqual(outcome({ killed: false, exitCode: 2, signal: null }), { status: 'completed', detail: 'exit code: 2' })
  assert.deepEqual(outcome({ killed: false, exitCode: 1, signal: null, sandbox: { mode: 'read-only', denied: true, runnerFailed: false } }), {
    status: 'completed',
    detail: 'exit code: 1; [sandbox: file access denied under read-only mode]',
  })
  assert.deepEqual(outcome({ killed: false, exitCode: 1, signal: null, sandbox: { mode: 'read-only', denied: true, runnerFailed: false } }, ['workspace-write']), {
    status: 'completed',
    detail:
      'exit code: 1; [sandbox: file access denied under read-only mode] [sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]',
  })
  assert.deepEqual(outcome({ killed: false, exitCode: 71, signal: null, sandbox: { mode: 'workspace-write', denied: false, runnerFailed: true } }), {
    status: 'completed',
    detail:
      'exit code: 71; [sandbox: the sandbox runner itself failed under workspace-write mode — the command did not run; this is a sandbox problem, not a command failure]',
  })
})

test('the process tree of a background job is the job’s own group, not the harness’s', async () => {
  const h = harness()
  const id = jobIdOf((await h.call('bash', { command: 'sleep 30', run_in_background: true })).output)
  const pid = h.pids.get(id) as number
  const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)]).toString().trim())
  assert.equal(pgid, pid, 'detached: the job leads its own process group')
  assert.notEqual(pgid, Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)]).toString().trim()))
  h.jobs.kill(id, h.a.id)
  await settled(h.events, id)
})

test('composed as rows, the jobs plugin gives the tools row’s bash its background half, across cordis service proxies', async () => {
  const { default: SandboxServicePlugin } = await import('../src/sandbox/service.ts')
  const { default: ApprovalServicePlugin } = await import('../src/approvals/service.ts')
  const { default: SessionPlugin } = await import('../src/plugins/session.ts')
  const { default: ToolsPlugin } = await import('../src/plugins/tools.ts')
  const JobsPlugin = await import('../src/plugins/jobs.ts')
  const root = join(scratch, `rows-${(counter += 1)}`)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const ctx = new Context()
  await ctx.plugin(SessionPlugin, { root: join(root, 'sessions') })
  await ctx.plugin(SandboxServicePlugin, { mode: 'danger-full-access', workspaceRoot: workspace, backend: 'none' })
  await ctx.plugin(ApprovalServicePlugin, { mode: 'allow' })
  await ctx.plugin(ToolsPlugin, {})
  ctx.provide('model')
  ctx.set('model', { defaultEndpoint: () => undefined, names: () => [] })
  ctx.provide('context')
  ctx.set('context', {})
  await ctx.plugin(JobsPlugin, {})
  const bash = ctx.tools.describe().find((spec) => spec.name === 'bash')
  assert.ok((bash?.parameters.properties as Record<string, unknown> | undefined)?.run_in_background !== undefined, 'the schema carries run_in_background')
  const handle = ctx.session.store.create({ cwd: workspace })
  const result = await ctx.tools.call('bash', { command: 'echo hi', run_in_background: true }, { cwd: workspace, session: handle, log: () => undefined })
  const id = jobIdOf(result.output)
  const waited = await ctx.tools.call('job_output', { job_id: id, wait: true, timeout_ms: 5_000 }, { cwd: workspace, session: handle, log: () => undefined })
  assert.equal(waited.output, 'hi\n[status: completed, exit code: 0]')
  await ctx.fiber.dispose()
  const after = ctx.tools?.describe?.().find((spec) => spec.name === 'bash')
  assert.ok(after === undefined || (after.parameters.properties as Record<string, unknown>).run_in_background === undefined)
})
