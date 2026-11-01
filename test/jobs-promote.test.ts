import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { ApprovalService } from '../src/approvals/service.ts'
import { bashBackground, renderPromoted } from '../src/jobs/bash.ts'
import { JobRegistry, type JobEvent } from '../src/jobs/registry.ts'
import { jobTools } from '../src/jobs/tools.ts'
import { SandboxService } from '../src/sandbox/service.ts'
import { SessionService } from '../src/session/service.ts'
import { attachBashBackground, builtinTools } from '../src/tools/builtin.ts'
import { ToolRegistry } from '../src/tools/service.ts'

/**
 * DSH's `promoteOnTimeout` (dsh-tool-bash/lib/index.js:181-183, 386-491): while the jobs row is attached, a foreground
 * `bash` call runs as a job, and one that outlives its wall time moves to the background instead of being killed.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-jobs-promote-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
let counter = 0

function harness(options: { readonly promoteOnTimeout?: boolean; readonly maxConcurrentJobsPerOwner?: number } = {}) {
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
    ...(options.maxConcurrentJobsPerOwner !== undefined ? { maxConcurrentJobsPerOwner: options.maxConcurrentJobsPerOwner } : {}),
  })
  jobs.attachController('test')
  for (const tool of jobTools(jobs)) tools.register(tool)
  const pids = new Map<string, number>()
  attachBashBackground(
    sandbox,
    bashBackground(jobs, sandbox, {
      readLog: (handle) => sessions.store.read(handle),
      killGraceMs: 200,
      onSpawn: (id, pid) => pids.set(id, pid),
      ...(options.promoteOnTimeout !== undefined ? { promoteOnTimeout: options.promoteOnTimeout } : {}),
    }),
  )
  const events: JobEvent[] = []
  jobs.subscribe((event) => events.push(event))
  const a = sessions.start({ cwd: workspace })
  const call = (name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
    tools.call(name, args, { cwd: workspace, session: a, log: () => undefined, ...(signal !== undefined ? { signal } : {}) })
  return { jobs, sessions, a, call, events, pids }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

async function until(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const PROMOTED = /^([\s\S]*)\[still running after (\d+)ms; moved to background job (bash-[0-9a-f]{16})\]\nThe command keeps running in the background\. You will be notified when it finishes; read newer output with job_output, stop it with job_kill\.$/

test('renderPromoted is DSH’s text: the output so far on its own line, then the marker and the hand-off', () => {
  const tail = 'The command keeps running in the background. You will be notified when it finishes; read newer output with job_output, stop it with job_kill.'
  assert.equal(renderPromoted('', 500, 'bash-0123456789abcdef'), `[still running after 500ms; moved to background job bash-0123456789abcdef]\n${tail}`)
  assert.equal(renderPromoted('early', 500, 'bash-x'), `early\n[still running after 500ms; moved to background job bash-x]\n${tail}`)
  assert.equal(renderPromoted('early\n', 500, 'bash-x'), `early\n[still running after 500ms; moved to background job bash-x]\n${tail}`)
})

test('a call that ends within its wall time answers as a foreground call, and leaves no job and no notice behind', async () => {
  const h = harness()
  const ok = await h.call('bash', { command: 'echo out; echo err >&2' })
  assert.equal(ok.output, 'out\nerr\n')
  assert.equal(ok.error, undefined)
  assert.equal((ok.data as { exitCode?: number }).exitCode, 0)
  const failed = await h.call('bash', { command: 'echo x; exit 3' })
  assert.deepEqual(failed.error, { code: 'EXIT', message: 'the command exited 3' })
  assert.equal(failed.output, 'x\n')
  assert.equal(h.jobs.list(h.a.id).length, 0, 'the records were removed')
  const settledEvents = h.events.filter((event) => event.type === 'settled')
  assert.equal(settledEvents.length, 2)
  assert.ok(settledEvents.every((event) => event.type === 'settled' && event.awaited), 'each settle was collected by the call, so no notice follows')
  const logged = h.sessions.store.read(h.a).map((event) => event.type)
  assert.equal(logged.filter((type) => type === 'job/registered').length, 2, 'every call registered its process as a job, as DSH’s does')
  assert.equal(logged.filter((type) => type === 'job/settled').length, 2)
})

test('a call that outlives its wall time is not killed: it answers the output so far and moves to a background job', async () => {
  const h = harness()
  const started = Date.now()
  const answer = await h.call('bash', { command: 'echo early; sleep 0.8; echo late', timeoutMs: 300 })
  assert.ok(Date.now() - started < 2_000)
  assert.equal(answer.error, undefined)
  const match = PROMOTED.exec(answer.output)
  assert.ok(match !== null, `the promoted answer\nsaw: ${JSON.stringify(answer.output)}`)
  assert.equal(match[1], 'early\n')
  assert.equal(match[2], '300')
  const id = match[3] as string
  assert.deepEqual(answer.data, { jobId: id, promoted: true, cwd: answer.data !== undefined ? (answer.data as { cwd: string }).cwd : '' })
  const pid = h.pids.get(id) as number
  assert.ok(groupAlive(pid), 'the command keeps running')
  assert.equal((await h.call('job_list', {})).output, `${id} [bash] running — echo early; sleep 0.8; echo late`)
  const read = await h.call('job_output', { job_id: id, wait: true, timeout_ms: 5_000 })
  assert.equal(read.output, 'late\n[status: completed, exit code: 0]', 'job_output goes on after the output the call answered')
  const settled = h.events.find((event) => event.type === 'settled' && event.job.id === id)
  assert.ok(settled !== undefined && settled.type === 'settled')
})

test('a promoted job that ends on its own is not awaited, so its completion notice is sent', async () => {
  const h = harness()
  const answer = await h.call('bash', { command: 'sleep 0.5; echo done', timeoutMs: 150 })
  const id = (PROMOTED.exec(answer.output) as RegExpExecArray)[3] as string
  await until(() => h.events.some((event) => event.type === 'settled' && event.job.id === id), 'the job to settle')
  const settled = h.events.find((event) => event.type === 'settled' && event.job.id === id) as Extract<JobEvent, { type: 'settled' }>
  assert.equal(settled.awaited, false, 'nobody waited, so the notice rule sends one')
  assert.equal(settled.job.status, 'completed')
  assert.equal(settled.job.detail, 'exit code: 0')
})

test('a Stop during the wait kills the job’s group, removes the record and answers stopped', async () => {
  const h = harness()
  const controller = new AbortController()
  const running = h.call('bash', { command: 'echo before; sleep 30' }, controller.signal)
  await until(() => h.pids.size === 1, 'the command to start')
  const pid = [...h.pids.values()][0] as number
  await new Promise((resolve) => setTimeout(resolve, 100))
  controller.abort()
  const answer = await running
  assert.deepEqual(answer.error, { code: 'INTERRUPTED', message: 'the command was stopped before it finished' })
  assert.equal(answer.output, 'before\n')
  await until(() => !groupAlive(pid), 'the group to be gone')
  assert.equal(h.jobs.list(h.a.id).length, 0)
  const settled = h.events.find((event) => event.type === 'settled') as Extract<JobEvent, { type: 'settled' }>
  assert.equal(settled.job.detail, 'signal: SIGTERM; tool call aborted')
  assert.equal(settled.awaited, true, 'no notice for a call that answered stopped')
})

test('with promoteOnTimeout false, the wall time kills the command, as without the jobs row', async () => {
  const h = harness({ promoteOnTimeout: false })
  const answer = await h.call('bash', { command: 'echo early; sleep 30', timeoutMs: 200 })
  assert.deepEqual(answer.error, { code: 'TIMEOUT', message: 'the command exceeded 200ms and was killed' })
  assert.equal(answer.output, 'early\n')
  assert.equal(h.jobs.list(h.a.id).length, 0)
  assert.equal(h.events.length, 0, 'no job was registered')
})

test('a registration the row refuses (the session at its cap) runs in the foreground with the wall-time kill', async () => {
  const h = harness({ maxConcurrentJobsPerOwner: 1 })
  const background = await h.call('bash', { command: 'sleep 30', run_in_background: true })
  assert.match(background.output, /^started background job bash-/)
  const answer = await h.call('bash', { command: 'echo fell back; sleep 30', timeoutMs: 200 })
  assert.deepEqual(answer.error, { code: 'TIMEOUT', message: 'the command exceeded 200ms and was killed' })
  assert.equal(answer.output, 'fell back\n')
  const quick = await h.call('bash', { command: 'echo still fine' })
  assert.equal(quick.output, 'still fine\n')
  for (const job of h.jobs.list(h.a.id)) h.jobs.kill(job.id, h.a.id)
})
