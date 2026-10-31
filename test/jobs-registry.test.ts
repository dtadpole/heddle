import assert from 'node:assert/strict'
import { test } from 'node:test'

import { JobError, JobRegistry, type JobEvent, type JobHandle, type JobOutcome, type JobSpec } from '../src/jobs/registry.ts'
import { OutputRing, utf8Tail } from '../src/jobs/ring.ts'

/** A producer the test drives by hand: append through `handle`, end with `finish`. */
function manual(overrides: Partial<JobSpec> = {}) {
  let handle: JobHandle | undefined
  let finish: (outcome: JobOutcome) => void = () => undefined
  const cancels: (string | undefined)[] = []
  const spec: JobSpec = {
    kind: 'bash',
    label: 'sleep 30',
    run: (h) => {
      handle = h
      return {
        cancel: (reason) => {
          cancels.push(reason)
        },
        done: new Promise<JobOutcome>((resolve) => {
          finish = resolve
        }),
      }
    },
    ...overrides,
  }
  return {
    spec,
    cancels,
    get handle(): JobHandle {
      assert.ok(handle !== undefined)
      return handle
    },
    finish: (outcome: JobOutcome) => finish(outcome),
  }
}

/** A registry with a controller attached and every session existing, recording log events. */
function registry(options: ConstructorParameters<typeof JobRegistry>[0] = {}) {
  const records: { session: string; type: string; data: Record<string, unknown> }[] = []
  const jobs = new JobRegistry({
    sessionExists: (id) => id.startsWith('session-'),
    record: (session, type, data) => records.push({ session, type, data }),
    ...options,
  })
  jobs.attachController('test')
  const events: JobEvent[] = []
  jobs.subscribe((event) => events.push(event))
  return { jobs, records, events }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function settledOf(events: JobEvent[], id: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = events.find((event) => event.type === 'settled' && event.job.id === id)
    if (found !== undefined) return found as Extract<JobEvent, { type: 'settled' }>
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`job ${id} never settled`)
}

const refusedWith = (code: string, message: string) => (error: unknown) => {
  assert.ok(error instanceof JobError, `expected a JobError, got ${String(error)}`)
  assert.equal(error.code, code)
  assert.equal(error.message, message)
  return true
}

// ---------------------------------------------------------------------------------------------------------------
// The ring
// ---------------------------------------------------------------------------------------------------------------

test('the ring keeps absolute UTF-8 byte offsets across appends', () => {
  const ring = new OutputRing()
  ring.append('ab', { channel: 'stdout' }, 100)
  ring.append('é', { channel: 'stderr' }, 100)
  ring.append('c', undefined, 100)
  assert.equal(ring.total, 5, '"é" is two bytes')
  assert.deepEqual(ring.readFrom(0).chunks, [
    { at: 0, text: 'ab', channel: 'stdout' },
    { at: 2, text: 'é', channel: 'stderr' },
    { at: 4, text: 'c' },
  ])
  assert.deepEqual(
    ring.readFrom(3).chunks.map((chunk) => chunk.at),
    [2, 4],
    'a chunk overlapping the offset is returned whole',
  )
  assert.equal(ring.readFrom(5).chunks.length, 0)
  assert.equal(ring.readFrom(5).next, 5)
  assert.equal(ring.append('', undefined, 100), false, 'an empty chunk changes nothing')
})

test('the ring drops whole head chunks past its cap, and a read below earliest is lossy, not an error', () => {
  const ring = new OutputRing()
  ring.append('aaaa', undefined, 10)
  ring.append('bbbb', undefined, 10)
  ring.append('cccc', undefined, 10)
  assert.equal(ring.total, 12)
  assert.equal(ring.earliest, 4, 'the oldest whole chunk went; offsets did not move')
  const read = ring.readFrom(0)
  assert.equal(read.lossy, true)
  assert.deepEqual(
    read.chunks.map((chunk) => [chunk.at, chunk.text]),
    [
      [4, 'bbbb'],
      [8, 'cccc'],
    ],
  )
  assert.equal(ring.readFrom(4).lossy, false)
})

test('an oversized chunk keeps a UTF-8-safe tail marked gapBefore', () => {
  const ring = new OutputRing()
  ring.append('xé€', undefined, 4)
  // x(1) é(2) €(3) = 6 bytes; the last 4 bytes start inside "é", so the cut moves to "€" (3 bytes).
  const [chunk] = ring.readFrom(0).chunks
  assert.deepEqual(chunk, { at: 3, text: '€', gapBefore: true })
  assert.equal(ring.earliest, 3)
  assert.equal(ring.total, 6)
  assert.deepEqual(utf8Tail('héllo', 4), { text: 'llo', bytes: 3 })
})

// ---------------------------------------------------------------------------------------------------------------
// Ids and preflight
// ---------------------------------------------------------------------------------------------------------------

test('an id is <kind>-<16 hex>, re-rolled on a collision', () => {
  const rolls = ['0123456789abcdef0000', '0123456789abcdef1111', 'fedcba98765432100000']
  const { jobs } = registry({ randomHex: () => rolls.shift() ?? 'ffffffffffffffff' })
  const first = jobs.start(manual().spec)
  assert.equal(first, 'bash-0123456789abcdef')
  const second = jobs.start(manual().spec)
  assert.equal(second, 'bash-fedcba9876543210', 'the colliding roll was discarded')
  const { jobs: real } = registry()
  assert.match(real.start(manual().spec), /^bash-[0-9a-f]{16}$/)
})

test('preflight runs in DSH order with DSH texts', () => {
  const noStore = new JobRegistry()
  noStore.attachController('t')
  assert.throws(
    () => noStore.start(manual({ owner: 'session-a' }).spec),
    refusedWith('JOB_OWNER_UNAVAILABLE', 'background job ownership requires the session store (load the session row)'),
  )
  // The owner is checked before the controller, the kind, the label and the limit.
  const bare = new JobRegistry({ sessionExists: () => false })
  assert.throws(
    () => bare.start(manual({ owner: 'gone', kind: '', label: '' }).spec),
    refusedWith('JOB_OWNER_UNAVAILABLE', 'session "gone" has no live agent (background job owner must be live)'),
  )
  assert.throws(
    () => bare.start(manual({ kind: '' }).spec),
    refusedWith(
      'JOB_UNAVAILABLE',
      'background jobs unavailable: no job controller serves this agent (load the jobs row, src/plugins/jobs.ts, in its composition)',
    ),
  )
  const { jobs } = registry()
  assert.throws(() => jobs.start(manual({ kind: '', label: '' }).spec), refusedWith('JOB_INVALID_ARGS', 'invalid job kind: expected a non-empty string'))
  assert.throws(() => jobs.start(manual({ label: '' }).spec), refusedWith('JOB_INVALID_ARGS', 'invalid job label: expected a non-empty string'))
  assert.throws(
    () => jobs.start(manual({ outputLimitBytes: 1.5 }).spec),
    refusedWith('JOB_INVALID_ARGS', 'invalid outputLimitBytes: expected a positive safe integer, got 1.5'),
  )
  assert.throws(
    () => jobs.start(manual({ outputLimitBytes: 0 }).spec),
    refusedWith('JOB_INVALID_ARGS', 'invalid outputLimitBytes: expected a positive safe integer, got 0'),
  )
})

test('an owner holds at most the cap of running and stopping jobs; a stopping job keeps its slot', async () => {
  const { jobs, events } = registry({ maxConcurrentJobsPerOwner: 2 })
  const one = manual({ owner: 'session-a' })
  const a = jobs.start(one.spec)
  jobs.start(manual({ owner: 'session-a' }).spec)
  const limit = 'background job limit reached for this owner (limit: 2); use job_kill to stop an unneeded job, wait for it to finish, then retry'
  assert.throws(() => jobs.start(manual({ owner: 'session-a' }).spec), refusedWith('JOB_LIMIT', limit))
  jobs.start(manual({ owner: 'session-b' }).spec)
  jobs.start(manual().spec)
  jobs.kill(a, 'session-a')
  assert.throws(() => jobs.start(manual({ owner: 'session-a' }).spec), refusedWith('JOB_LIMIT', limit))
  one.finish({ status: 'killed', detail: 'signal: SIGTERM' })
  await settledOf(events, a)
  assert.match(jobs.start(manual({ owner: 'session-a' }).spec), /^bash-/)
  const defaults = new JobRegistry()
  assert.equal(defaults.maxConcurrentJobsPerOwner, 10)
  assert.equal(defaults.retainBytes, 262_144)
  assert.equal(defaults.settledRetainBytes, 16_384)
  assert.equal(defaults.pumpPollMs, 150)
})

// ---------------------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------------------

test('the consuming read moves the cursor; readAt never does', () => {
  const { jobs } = registry()
  const producer = manual({ owner: 'session-a' })
  const id = jobs.start(producer.spec)
  producer.handle.append('one\n', { channel: 'stdout' })
  // A person's follow reads everything and leaves the model's next read untouched.
  assert.deepEqual(
    jobs.readAt(id, 0, 'session-a').chunks.map((chunk) => chunk.text),
    ['one\n'],
  )
  assert.deepEqual(
    jobs.read(id, 'session-a').chunks.map((chunk) => chunk.text),
    ['one\n'],
  )
  producer.handle.append('two\n', { channel: 'stdout' })
  assert.deepEqual(
    jobs.readAt(id, 0, 'session-a').chunks.map((chunk) => chunk.text),
    ['one\n', 'two\n'],
  )
  assert.equal(jobs.readAt(id, 4, 'session-a').next, 8)
  assert.deepEqual(
    jobs.read(id, 'session-a').chunks.map((chunk) => chunk.text),
    ['two\n'],
    'the second consuming read has only the new output',
  )
  assert.equal(jobs.read(id, 'session-a').chunks.length, 0)
  assert.throws(
    () => jobs.readAt(id, -1, 'session-a'),
    refusedWith('JOB_INVALID_ARGS', 'invalid output read offset: expected a non-negative safe integer, got -1'),
  )
})

test('the result rides the first consuming read after settle, once', async () => {
  const { jobs, events } = registry()
  const producer = manual()
  const id = jobs.start(producer.spec)
  assert.equal(jobs.read(id, undefined).result, undefined)
  producer.finish({ status: 'completed', detail: 'done', result: 'the answer' })
  await settledOf(events, id)
  assert.equal(jobs.read(id, undefined).result, 'the answer')
  assert.equal(jobs.read(id, undefined).result, undefined)
})

test('settle trims to the unread bytes, and a terminal read drops to the settled cap', async () => {
  const { jobs, events } = registry({ retainBytes: 100, settledRetainBytes: 10 })
  const producer = manual()
  const id = jobs.start(producer.spec)
  for (let index = 0; index < 5; index += 1) producer.handle.append('0123456789')
  producer.finish({ status: 'completed', detail: 'exit code: 0' })
  await settledOf(events, id)
  assert.equal(jobs.get(id, undefined).output.earliest, 0, 'every unread byte is kept for the model')
  const read = jobs.read(id, undefined)
  assert.equal(read.chunks.length, 5)
  assert.equal(jobs.get(id, undefined).output.earliest, 40, 'after the terminal read only the settled cap remains')
})

// ---------------------------------------------------------------------------------------------------------------
// Kill, settle, wait
// ---------------------------------------------------------------------------------------------------------------

test('kill cancels first, answers requested at once, and the settle merges the reason into the detail', async () => {
  const { jobs, events, records } = registry()
  const producer = manual({ owner: 'session-a' })
  const id = jobs.start(producer.spec)
  assert.equal(jobs.kill(id, 'session-a', 'no longer needed'), 'requested')
  assert.deepEqual(producer.cancels, ['no longer needed'])
  assert.equal(jobs.get(id, 'session-a').status, 'stopping')
  assert.ok(events.some((event) => event.type === 'stopping'))
  producer.finish({ status: 'killed', detail: 'signal: SIGTERM' })
  const settled = await settledOf(events, id)
  assert.equal(settled.cause, 'kill')
  assert.equal(settled.awaited, false)
  assert.equal(settled.job.status, 'killed')
  assert.equal(settled.job.detail, 'signal: SIGTERM; no longer needed')
  assert.equal(jobs.kill(id, 'session-a'), 'already-finished')
  const logged = records.find((record) => record.type === 'job/settled')
  assert.equal(logged?.data.cause, 'kill')
  assert.equal(logged?.data.detail, 'signal: SIGTERM; no longer needed')
})

test('a cancel that throws leaves the job as it was', () => {
  const { jobs } = registry()
  const id = jobs.start({
    kind: 'bash',
    label: 'x',
    run: () => ({
      cancel: () => {
        throw new Error('cannot stop')
      },
      done: new Promise(() => undefined),
    }),
  })
  assert.throws(() => jobs.kill(id, undefined), /cannot stop/)
  assert.equal(jobs.get(id, undefined).status, 'running')
})

test('settle is first-wins and clears progress', async () => {
  const { jobs, events } = registry()
  const producer = manual()
  const id = jobs.start(producer.spec)
  producer.handle.updateProgress('50%')
  assert.equal(jobs.get(id, undefined).progress, '50%')
  producer.finish({ status: 'completed', detail: 'exit code: 0' })
  producer.finish({ status: 'failed', detail: 'late' })
  await settledOf(events, id)
  const view = jobs.get(id, undefined)
  assert.equal(view.status, 'completed')
  assert.equal(view.detail, 'exit code: 0')
  assert.equal(view.progress, undefined)
  assert.equal(typeof view.finishedAt, 'number')
})

test('a wait that times out answers the live view and leaves the job running; a released waiter marks the settle awaited', async () => {
  const { jobs, events } = registry()
  const producer = manual()
  const id = jobs.start(producer.spec)
  const timedOut = await jobs.wait(id, 20, undefined)
  assert.equal(timedOut.status, 'running')
  await assert.rejects(
    jobs.wait(id, 0, undefined),
    refusedWith('JOB_INVALID_ARGS', 'invalid wait timeout: expected a positive number of milliseconds, got 0'),
  )
  const controller = new AbortController()
  const aborted = jobs.wait(id, 10_000, undefined, controller.signal)
  controller.abort()
  await assert.rejects(aborted, refusedWith('JOB_WAIT_ABORTED', 'wait aborted'))
  const waiting = jobs.wait(id, 10_000, undefined)
  producer.finish({ status: 'completed', detail: 'exit code: 0' })
  assert.equal((await waiting).status, 'completed')
  assert.equal((await settledOf(events, id)).awaited, true)
})

test('remove forgets a settled job and refuses a live one', async () => {
  const { jobs, events } = registry()
  const producer = manual()
  const id = jobs.start(producer.spec)
  assert.throws(() => jobs.remove(id, undefined), refusedWith('JOB_LIVE', `job ${id} is still running; kill it and wait for settlement before removing it`))
  producer.finish({ status: 'completed' })
  await settledOf(events, id)
  jobs.remove(id, undefined)
  assert.ok(events.some((event) => event.type === 'removed' && event.job.id === id))
  assert.throws(() => jobs.get(id, undefined), refusedWith('JOB_UNKNOWN', `unknown job ${id}`))
})

// ---------------------------------------------------------------------------------------------------------------
// Ownership, the log, events, pump, teardown
// ---------------------------------------------------------------------------------------------------------------

test('an owned job is refused to another session; an unowned one is open to all', () => {
  const { jobs } = registry()
  const owned = jobs.start(manual({ owner: 'session-a' }).spec)
  const open = jobs.start(manual().spec)
  const foreign = refusedWith('JOB_FOREIGN', `job ${owned} belongs to another session`)
  assert.throws(() => jobs.get(owned, 'session-b'), foreign)
  assert.throws(() => jobs.read(owned, 'session-b'), foreign)
  assert.throws(() => jobs.readAt(owned, 0, 'session-b'), foreign)
  assert.throws(() => jobs.kill(owned, 'session-b'), foreign)
  assert.throws(() => jobs.get(owned, undefined), foreign, 'a caller-less read never matches an owned job')
  assert.throws(() => jobs.get('bash-0000000000000000', 'session-a'), refusedWith('JOB_UNKNOWN', 'unknown job bash-0000000000000000'))
  assert.equal(jobs.get(open, 'session-b').id, open)
  assert.deepEqual(
    jobs.list('session-b').map((job) => job.id),
    [open],
  )
  assert.deepEqual(
    jobs.list('session-a').map((job) => job.id),
    [owned, open],
    'registration order',
  )
})

test('owned jobs write job/registered and job/settled with DSH fields; unowned jobs write nothing', async () => {
  const { jobs, records, events } = registry()
  const producer = manual({ owner: 'session-a', toolCall: { callId: 'call_1', rootCallId: 'call_1' } })
  const id = jobs.start(producer.spec)
  producer.finish({ status: 'completed', detail: 'exit code: 0' })
  await settledOf(events, id)
  const unowned = manual()
  const other = jobs.start(unowned.spec)
  unowned.finish({ status: 'completed' })
  await settledOf(events, other)
  assert.equal(records.length, 2)
  const [registered, settled] = records
  assert.equal(registered?.session, 'session-a')
  assert.equal(registered?.type, 'job/registered')
  assert.deepEqual(Object.keys(registered?.data ?? {}), ['jobId', 'owner', 'kind', 'label', 'startedAt', 'toolCall'])
  assert.deepEqual(registered?.data.toolCall, { callId: 'call_1', rootCallId: 'call_1' })
  assert.equal(settled?.type, 'job/settled')
  assert.deepEqual(Object.keys(settled?.data ?? {}), [
    'jobId',
    'owner',
    'kind',
    'label',
    'startedAt',
    'toolCall',
    'finishedAt',
    'status',
    'cause',
    'producerReported',
    'detail',
  ])
  assert.equal(settled?.data.cause, 'producer')
  assert.equal(settled?.data.producerReported, true)
})

test('the event stream carries registered, progress, output, stopping, settled and removed', async () => {
  const { jobs, events } = registry()
  const producer = manual({ owner: 'session-a' })
  const id = jobs.start(producer.spec)
  producer.handle.updateProgress('step 1')
  producer.handle.append('x')
  jobs.kill(id, 'session-a')
  producer.finish({ status: 'killed' })
  await settledOf(events, id)
  jobs.remove(id, 'session-a')
  assert.deepEqual(
    events.map((event) => event.type),
    ['registered', 'progress', 'output', 'stopping', 'settled', 'output', 'removed'],
  )
  const output = events.find((event) => event.type === 'output')
  assert.deepEqual(output, { type: 'output', id, owner: 'session-a', total: 1 })
})

test('pull sources are drained on the poll and once more before the settle', async () => {
  const { jobs, events } = registry({ pumpPollMs: 5 })
  let text = 'early\n'
  let finish: (outcome: JobOutcome) => void = () => undefined
  const id = jobs.start({
    kind: 'pull',
    label: 'source',
    output: [
      {
        channel: 'stdout',
        read: (from) => {
          const bytes = Buffer.from(text)
          return { text: bytes.subarray(from).toString(), nextOffset: bytes.length, lossy: false }
        },
      },
    ],
    run: () => ({ cancel: () => undefined, done: new Promise((resolve) => (finish = resolve)) }),
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(
    jobs.readAt(id, 0, undefined).chunks.map((chunk) => chunk.text),
    ['early\n'],
  )
  text += 'last\n'
  finish({ status: 'completed' })
  await settledOf(events, id)
  assert.deepEqual(
    jobs.read(id, undefined).chunks.map((chunk) => [chunk.text, chunk.channel]),
    [
      ['early\n', 'stdout'],
      ['last\n', 'stdout'],
    ],
    'the final drain ran before the settle',
  )
})

test('dispose cancels live jobs with "jobs service disposed", settles them as teardown and drops them', async () => {
  const { jobs, events } = registry()
  const producer = manual({ owner: 'session-a' })
  const id = jobs.start(producer.spec)
  const disposing = jobs.dispose()
  assert.deepEqual(producer.cancels, ['jobs service disposed'])
  producer.finish({ status: 'killed', detail: 'signal: SIGTERM' })
  await disposing
  const settled = events.find((event) => event.type === 'settled') as Extract<JobEvent, { type: 'settled' }>
  assert.equal(settled.cause, 'teardown')
  assert.ok(events.some((event) => event.type === 'removed' && event.job.id === id))
  assert.throws(() => jobs.start(manual().spec), refusedWith('JOB_DISPOSED', 'jobs service disposed'))
  await tick()
})

test('killOwnedBy stops one session’s live jobs with one reason', async () => {
  const { jobs, events } = registry()
  const mine = manual({ owner: 'session-a' })
  const id = jobs.start(mine.spec)
  jobs.start(manual({ owner: 'session-b' }).spec)
  assert.deepEqual(jobs.killOwnedBy('session-a', 'session archived'), [id])
  mine.finish({ status: 'killed', detail: 'signal: SIGTERM' })
  assert.equal((await settledOf(events, id)).job.detail, 'signal: SIGTERM; session archived')
})
