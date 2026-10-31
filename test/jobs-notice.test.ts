import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { NoticeDelivery, noticeSource, noticeText, type NoticeHost, type NoticeSource } from '../src/jobs/notice.ts'
import { JobRegistry, type JobOutcome, type JobSpec, type JobView } from '../src/jobs/registry.ts'
import type { Chunk } from '../src/llm/types.ts'
import * as JobsPlugin from '../src/plugins/jobs.ts'
import SessionPlugin from '../src/plugins/session.ts'
import TurnsPlugin from '../src/plugins/turns.ts'
import { INBOX_SPLICED } from '../src/session/inbox.ts'
import type { SessionEvent } from '../src/session/store.ts'

const scratch = mkdtempSync(join(tmpdir(), 'heddle-jobs-notice-'))
after(() => rmSync(scratch, { recursive: true, force: true }))
let counter = 0

/** A producer the test ends by hand. */
function manual(owner?: string, label = 'make build') {
  let finish: (outcome: JobOutcome) => void = () => undefined
  const spec: JobSpec = {
    kind: 'bash',
    label,
    ...(owner !== undefined ? { owner } : {}),
    run: () => ({ cancel: () => undefined, done: new Promise<JobOutcome>((resolve) => (finish = resolve)) }),
  }
  return { spec, finish: (outcome: JobOutcome) => finish(outcome) }
}

/** A host that records what delivery asked for; `running` and `sessions` are the knobs. */
function fakeHost() {
  const running = new Set<string>()
  const sessions = new Set<string>(['session-a', 'session-b'])
  const pending = new Map<string, string>()
  const idle = new Map<string, (() => void)[]>()
  const calls: { op: 'wake' | 'inject'; session: string; text: string; source: NoticeSource; answerPending?: boolean }[] = []
  let next = 0
  const host: NoticeHost = {
    exists: (id) => sessions.has(id),
    isRunning: (id) => running.has(id),
    whenIdle: (id) => (running.has(id) ? new Promise<void>((resolve) => idle.set(id, [...(idle.get(id) ?? []), resolve])) : Promise.resolve()),
    inject: (session, text, source) => {
      calls.push({ op: 'inject', session, text, source })
      const id = `inbox-${(next += 1)}`
      pending.set(id, session)
      return id
    },
    isPending: (_session, id) => pending.has(id),
    wake: (session, text, source, options) => calls.push({ op: 'wake', session, text, source, answerPending: options.answerPending }),
    warn: () => undefined,
  }
  const finishTurn = (id: string) => {
    running.delete(id)
    for (const resolve of idle.get(id) ?? []) resolve()
    idle.delete(id)
  }
  return { host, running, sessions, pending, calls, finishTurn }
}

function setup(options: ConstructorParameters<typeof NoticeDelivery>[2] = {}) {
  const jobs = new JobRegistry({ sessionExists: (id) => id.startsWith('session-') })
  jobs.attachController('test')
  const fake = fakeHost()
  const delivery = new NoticeDelivery(jobs, fake.host, options)
  return { jobs, delivery, ...fake }
}

async function settleJob(jobs: JobRegistry, delivery: NoticeDelivery, producer: ReturnType<typeof manual>, outcome: JobOutcome): Promise<void> {
  producer.finish(outcome)
  for (let attempt = 0; attempt < 50; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2))
  await delivery.idle()
}

test('the notice text and source are DSH’s', () => {
  const job: JobView = {
    id: 'bash-0123456789abcdef',
    kind: 'bash',
    label: 'npm test',
    owner: 'session-a',
    status: 'completed',
    detail: 'exit code: 1',
    startedAt: 1,
    finishedAt: 2,
    output: { total: 0, earliest: 0 },
  }
  assert.equal(noticeText(job), 'background job bash-0123456789abcdef (bash: npm test) finished [status: completed, exit code: 1]. Read its output with job_output.')
  assert.deepEqual(noticeSource(job), { kind: 'tool-jobs', form: 'notice', summary: 'bash npm test [status: completed, exit code: 1]' })
  const { detail: _detail, ...bare } = job
  assert.equal(noticeText(bare), 'background job bash-0123456789abcdef (bash: npm test) finished [status: completed]. Read its output with job_output.')
  const long = noticeSource({ ...job, label: 'x'.repeat(200) }).summary
  assert.equal(long.length, 120)
  assert.ok(long.endsWith('…'))
})

test('an idle owner is woken with the notice; a running owner gets it injected into the next step', async () => {
  const { jobs, delivery, calls, running } = setup()
  const idle = manual('session-a')
  const id = jobs.start(idle.spec)
  await settleJob(jobs, delivery, idle, { status: 'completed', detail: 'exit code: 0' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.op, 'wake')
  assert.equal(calls[0]?.answerPending, false)
  assert.equal(calls[0]?.text, `background job ${id} (bash: make build) finished [status: completed, exit code: 0]. Read its output with job_output.`)
  running.add('session-b')
  const busy = manual('session-b')
  jobs.start(busy.spec)
  await settleJob(jobs, delivery, busy, { status: 'completed', detail: 'exit code: 0' })
  assert.equal(calls.length, 2)
  assert.equal(calls[1]?.op, 'inject')
  assert.deepEqual(calls[1]?.source.kind, 'tool-jobs')
})

test('a notice injected into a turn that ended without claiming it is answered by a turn of its own', async () => {
  const { jobs, delivery, calls, running, finishTurn } = setup()
  running.add('session-a')
  const producer = manual('session-a')
  jobs.start(producer.spec)
  await settleJob(jobs, delivery, producer, { status: 'completed', detail: 'exit code: 0' })
  assert.deepEqual(
    calls.map((call) => call.op),
    ['inject'],
  )
  finishTurn('session-a')
  await new Promise((resolve) => setTimeout(resolve, 5))
  await delivery.idle()
  assert.deepEqual(
    calls.map((call) => [call.op, call.answerPending]),
    [
      ['inject', undefined],
      ['wake', true],
    ],
  )
})

test('no notice when awaited, killed by the model, torn down, unowned, or the owner is gone; a person’s kill notifies', async () => {
  const { jobs, delivery, calls, sessions } = setup()
  const awaited = manual('session-a')
  const awaitedId = jobs.start(awaited.spec)
  const waiting = jobs.wait(awaitedId, 10_000, 'session-a')
  await settleJob(jobs, delivery, awaited, { status: 'completed' })
  await waiting

  const modelKilled = manual('session-a')
  const modelId = jobs.start(modelKilled.spec)
  jobs.kill(modelId, 'session-a')
  delivery.markModelKill(modelId)
  await settleJob(jobs, delivery, modelKilled, { status: 'killed', detail: 'signal: SIGTERM' })

  const unowned = manual()
  jobs.start(unowned.spec)
  await settleJob(jobs, delivery, unowned, { status: 'completed' })

  const orphan = manual('session-b')
  jobs.start(orphan.spec)
  sessions.delete('session-b')
  await settleJob(jobs, delivery, orphan, { status: 'completed' })
  assert.equal(calls.length, 0)

  const person = manual('session-a', 'sleep 30')
  const personId = jobs.start(person.spec)
  jobs.kill(personId, 'session-a', 'cancelled by the user')
  await settleJob(jobs, delivery, person, { status: 'killed', detail: 'signal: SIGTERM' })
  assert.equal(calls.length, 1)
  assert.equal(
    calls[0]?.text,
    `background job ${personId} (bash: sleep 30) finished [status: killed, signal: SIGTERM; cancelled by the user]. Read its output with job_output.`,
  )

  const torn = manual('session-a')
  jobs.start(torn.spec)
  const disposing = jobs.dispose()
  await settleJob(jobs, delivery, torn, { status: 'killed' })
  await disposing
  assert.equal(calls.length, 1, 'teardown sends nothing')
})

test('quiet delivery only injects, even for an idle owner', async () => {
  const { jobs, delivery, calls } = setup({ completionDelivery: 'quiet' })
  const producer = manual('session-a')
  jobs.start(producer.spec)
  await settleJob(jobs, delivery, producer, { status: 'completed' })
  assert.deepEqual(
    calls.map((call) => call.op),
    ['inject'],
  )
})

test('past maxConsecutiveWakes a notice is injected without a wake, and a person’s message resets the count', async () => {
  const { jobs, delivery, calls } = setup({ maxConsecutiveWakes: 2 })
  for (let index = 0; index < 3; index += 1) {
    const producer = manual('session-a')
    jobs.start(producer.spec)
    await settleJob(jobs, delivery, producer, { status: 'completed' })
  }
  assert.deepEqual(
    calls.map((call) => call.op),
    ['wake', 'wake', 'inject'],
  )
  assert.ok(!calls[2]?.text.includes('cap'), 'no cap text is added')
  delivery.resetWakes('session-a')
  const producer = manual('session-a')
  jobs.start(producer.spec)
  await settleJob(jobs, delivery, producer, { status: 'completed' })
  assert.equal(calls[3]?.op, 'wake')
  assert.throws(() => setup({ maxConsecutiveWakes: 1.5 }), /maxConsecutiveWakes \(1\.5\) must be a whole number of turns/)
})

// ---------------------------------------------------------------------------------------------------------------
// The plugin, over a real session store and the real turn loop
// ---------------------------------------------------------------------------------------------------------------

async function pluginContext(config: JobsPlugin.Config = {}) {
  const root = join(scratch, `plugin-${(counter += 1)}`)
  const ctx = new Context()
  await ctx.plugin(SessionPlugin, { root })
  await ctx.plugin(TurnsPlugin)
  let gate: Promise<void> | undefined
  const purposes: (string | undefined)[] = []
  ctx.provide('model')
  ctx.set('model', {
    defaultEndpoint: () => 'fake',
    names: () => ['fake'],
    async *stream(request: { purpose?: string }): AsyncIterable<Chunk> {
      purposes.push(request.purpose)
      if (gate !== undefined) await gate
      yield { type: 'text-delta', text: 'noted' } as Chunk
      yield { type: 'done', finishReason: 'stop' } as Chunk
    },
  })
  const registered: string[] = []
  ctx.provide('tools')
  ctx.set('tools', { register: (tool: { spec: { name: string } }) => registered.push(tool.spec.name), describe: () => [] })
  ctx.provide('sandbox')
  const sandbox = { workspaceRoot: root, mode: 'danger-full-access', policy: () => ({ mode: 'danger-full-access' }), rootFor: (folder?: string) => folder ?? root, escalationTargets: () => [] }
  ctx.set('sandbox', sandbox)
  ctx.provide('context')
  ctx.set('context', {
    recordRuntimeContext: () => undefined,
    prepare: async () => ({ messages: [], estimatedTokens: 0, thresholdTokens: 1, pruned: 0, compacted: false, breakdown: {} }),
  })
  const changed: number[] = []
  ctx.on('jobs/changed', () => changed.push(Date.now()))
  await ctx.plugin(JobsPlugin, config)
  return {
    ctx,
    registered,
    changed,
    purposes,
    hold: () => {
      let release: () => void = () => undefined
      gate = new Promise<void>((resolve) => (release = resolve))
      return () => {
        gate = undefined
        release()
      }
    },
  }
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`timed out waiting for ${what}`)
}

const userMessages = (events: readonly SessionEvent[]) =>
  events
    .filter((event) => event.type === 'message' && (event.message as { role?: string }).role === 'user')
    .map((event) => event.message as { content: { text: string }[]; source?: { kind?: string } })

test('the plugin provides ctx.jobs, registers the three tools, and an idle session is woken by a turn whose prompt is the notice', async () => {
  const { ctx, registered, changed, purposes } = await pluginContext()
  assert.deepEqual(registered, ['job_output', 'job_list', 'job_kill'])
  const handle = ctx.session.store.create({ cwd: scratch, endpoint: 'fake' })
  const producer = manual(handle.id)
  const id = ctx.jobs.start(producer.spec)
  producer.finish({ status: 'completed', detail: 'exit code: 0' })
  await until(() => ctx.session.store.read(handle).some((event) => event.type === 'turn/completed'), 'the notice turn to complete')
  const events = ctx.session.store.read(handle)
  assert.ok(events.some((event) => event.type === 'job/registered' && event.jobId === id))
  assert.ok(events.some((event) => event.type === 'job/settled' && event.jobId === id))
  const [notice] = userMessages(events)
  assert.deepEqual(notice?.source, { kind: 'tool-jobs', form: 'notice', summary: 'bash make build [status: completed, exit code: 0]' })
  assert.equal(notice?.content[0]?.text, `background job ${id} (bash: make build) finished [status: completed, exit code: 0]. Read its output with job_output.`)
  assert.deepEqual(purposes, ['jobs-notice'])
  assert.ok(changed.length >= 2, 'jobs/changed reached the context for registered and settled')
  await ctx.fiber.dispose()
})

test('a running session gets the notice injected and its running turn answers it, with no second turn', async () => {
  const { ctx, hold } = await pluginContext()
  const handle = ctx.session.store.create({ cwd: scratch, endpoint: 'fake' })
  const release = hold()
  const { runTurn } = await import('../src/agent/loop.ts')
  const turn = runTurn(ctx, { session: handle, endpoint: 'fake', prompt: 'work on it' })
  await until(() => ctx.session.store.read(handle).some((event) => event.type === 'model/request'), 'the turn to call the model')
  const producer = manual(handle.id)
  ctx.jobs.start(producer.spec)
  producer.finish({ status: 'completed', detail: 'exit code: 0' })
  await until(() => ctx.session.store.read(handle).some((event) => event.type === INBOX_SPLICED), 'the notice to be injected')
  release()
  await turn
  await new Promise((resolve) => setTimeout(resolve, 50))
  const events = ctx.session.store.read(handle)
  const users = userMessages(events)
  assert.deepEqual(
    users.map((message) => message.source?.kind),
    [undefined, 'tool-jobs'],
    'the person’s prompt, then the claimed notice',
  )
  assert.equal(events.filter((event) => event.type === 'turn/completed').length, 1, 'the running turn answered it; no wake turn')
  await ctx.fiber.dispose()
})

test('disposing the plugin tears jobs down with no notice', async () => {
  const { ctx } = await pluginContext()
  const store = ctx.session.store
  const handle = store.create({ cwd: scratch, endpoint: 'fake' })
  const cancels: (string | undefined)[] = []
  let finish: (outcome: JobOutcome) => void = () => undefined
  ctx.jobs.start({
    kind: 'bash',
    label: 'sleep 30',
    owner: handle.id,
    run: () => ({
      cancel: (reason) => {
        cancels.push(reason)
        finish({ status: 'killed', detail: 'signal: SIGTERM' })
      },
      done: new Promise<JobOutcome>((resolve) => (finish = resolve)),
    }),
  })
  await ctx.fiber.dispose()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(cancels, ['jobs service disposed'])
  assert.equal(userMessages(store.read(handle)).length, 0)
  const settled = store.read(handle).find((event) => event.type === 'job/settled')
  assert.equal(settled?.cause, 'teardown')
})
