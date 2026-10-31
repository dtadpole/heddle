import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'

import { handleJobsRoute } from '../src/jobs/http.ts'
import { JobRegistry, type JobEvent, type JobHandle, type JobOutcome } from '../src/jobs/registry.ts'

/** A server that answers only the job routes, as the web server's one dispatch line does. */
async function serve(jobs: JobRegistry | undefined): Promise<{ base: string; server: Server }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    void handleJobsRoute(jobs, url, request, response).then((handled) => {
      if (!handled) {
        response.writeHead(418)
        response.end('not a job route')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}

function setup() {
  const jobs = new JobRegistry({ sessionExists: (id) => id.startsWith('session-'), retainBytes: 8 })
  jobs.attachController('test')
  const events: JobEvent[] = []
  jobs.subscribe((event) => events.push(event))
  const start = (owner?: string) => {
    let handle: JobHandle | undefined
    let finish: (outcome: JobOutcome) => void = () => undefined
    const cancels: (string | undefined)[] = []
    const id = jobs.start({
      kind: 'bash',
      label: 'tail -f log',
      ...(owner !== undefined ? { owner } : {}),
      run: (h) => {
        handle = h
        return {
          cancel: (reason) => {
            cancels.push(reason)
            finish({ status: 'killed', detail: 'signal: SIGTERM' })
          },
          done: new Promise<JobOutcome>((resolve) => (finish = resolve)),
        }
      },
    })
    return { id, cancels, append: (text: string) => handle?.append(text, { channel: 'stdout' }), finish: (outcome: JobOutcome) => finish(outcome) }
  }
  return { jobs, events, start }
}

const settledOf = async (events: JobEvent[], id: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = events.find((event) => event.type === 'settled' && event.job.id === id)
    if (found !== undefined) return found as Extract<JobEvent, { type: 'settled' }>
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('never settled')
}

test('GET /api/jobs lists the session’s jobs plus the unowned ones', async () => {
  const { jobs, start } = setup()
  const mine = start('session-a')
  start('session-b')
  const open = start()
  const { base, server } = await serve(jobs)
  try {
    const response = await fetch(`${base}/api/jobs?session=session-a`)
    assert.equal(response.status, 200)
    const body = (await response.json()) as { jobs: { id: string; owner?: string; status: string; output: unknown }[] }
    assert.deepEqual(
      body.jobs.map((job) => job.id),
      [mine.id, open.id],
    )
    assert.equal(body.jobs[0]?.owner, 'session-a')
    assert.deepEqual(body.jobs[0]?.output, { total: 0, earliest: 0 })
    assert.equal((await fetch(`${base}/api/jobs`)).status, 400)
    assert.equal((await fetch(`${base}/api/jobsx`)).status, 418, 'a neighbouring path is not a job route')
  } finally {
    server.close()
  }
})

test('GET /api/jobs/follow reads without consuming: the model’s next read still returns the output', async () => {
  const { jobs, events, start } = setup()
  const job = start('session-a')
  job.append('one\n')
  const { base, server } = await serve(jobs)
  try {
    const first = (await (await fetch(`${base}/api/jobs/follow?session=session-a&job=${job.id}&from=0`)).json()) as {
      job: { status: string }
      chunks: { at: number; text: string }[]
      next: number
      lossy?: boolean
      settled: boolean
    }
    assert.deepEqual(first.chunks, [{ at: 0, text: 'one\n', channel: 'stdout' }])
    assert.equal(first.next, 4)
    assert.equal(first.settled, false)
    assert.equal(first.lossy, undefined)
    assert.equal(first.job.status, 'running')
    job.append('two\n')
    const second = (await (await fetch(`${base}/api/jobs/follow?session=session-a&job=${job.id}&from=${first.next}`)).json()) as {
      chunks: { text: string }[]
      next: number
    }
    assert.deepEqual(
      second.chunks.map((chunk) => chunk.text),
      ['two\n'],
    )
    // The model never saw any of it: its consuming read returns all of it.
    assert.deepEqual(
      jobs.read(job.id, 'session-a').chunks.map((chunk) => chunk.text),
      ['one\n', 'two\n'],
    )
    job.append('three\n')
    const lossy = (await (await fetch(`${base}/api/jobs/follow?session=session-a&job=${job.id}`)).json()) as { lossy?: boolean }
    assert.equal(lossy.lossy, true, 'from defaults to 0, below what an 8-byte ring keeps')
    job.finish({ status: 'completed', detail: 'exit code: 0' })
    await settledOf(events, job.id)
    const done = (await (await fetch(`${base}/api/jobs/follow?session=session-a&job=${job.id}&from=${second.next}`)).json()) as { settled: boolean; job: { status: string } }
    assert.equal(done.settled, true)
    assert.equal(done.job.status, 'completed')
    const bad = await fetch(`${base}/api/jobs/follow?session=session-a&job=${job.id}&from=-3`)
    assert.equal(bad.status, 400)
    assert.deepEqual(await bad.json(), { code: 'JOB_INVALID_ARGS', message: 'invalid output read offset: expected a non-negative safe integer, got -3' })
  } finally {
    server.close()
  }
})

test('POST /api/jobs/kill kills with "cancelled by the user"; unknown and foreign jobs are job/not-found', async () => {
  const { jobs, events, start } = setup()
  const job = start('session-a')
  const { base, server } = await serve(jobs)
  const post = (body: unknown) => fetch(`${base}/api/jobs/kill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const foreign = await post({ session: 'session-b', job: job.id })
    assert.equal(foreign.status, 404)
    assert.deepEqual(await foreign.json(), { code: 'job/not-found', message: `job ${job.id} belongs to another session` })
    const unknown = await post({ session: 'session-a', job: 'bash-0000000000000000' })
    assert.equal(unknown.status, 404)
    assert.deepEqual(await unknown.json(), { code: 'job/not-found', message: 'unknown job bash-0000000000000000' })
    const follow = await fetch(`${base}/api/jobs/follow?session=session-b&job=${job.id}`)
    assert.equal(follow.status, 404)
    const killed = await post({ session: 'session-a', job: job.id })
    assert.equal(killed.status, 200)
    assert.deepEqual(await killed.json(), { outcome: 'requested' })
    assert.deepEqual(job.cancels, ['cancelled by the user'])
    const end = await settledOf(events, job.id)
    assert.equal(end.job.detail, 'signal: SIGTERM; cancelled by the user')
    assert.deepEqual(await (await post({ session: 'session-a', job: job.id })).json(), { outcome: 'already-finished' })
    assert.equal((await post({ session: 'session-a' })).status, 400)
  } finally {
    server.close()
  }
})

test('without the jobs row the routes answer 503', async () => {
  const { base, server } = await serve(undefined)
  try {
    const response = await fetch(`${base}/api/jobs?session=session-a`)
    assert.equal(response.status, 503)
  } finally {
    server.close()
  }
})

test('a refusal from a registry loaded in another module graph is still recognised by its name and code', async () => {
  const foreign = Object.assign(new Error('job bash-0123456789abcdef belongs to another session'), { name: 'JobError', code: 'JOB_FOREIGN' })
  const stub = {
    list: () => [],
    get: () => {
      throw foreign
    },
  } as unknown as JobRegistry
  const { base, server } = await serve(stub)
  try {
    const response = await fetch(`${base}/api/jobs/follow?session=session-b&job=bash-0123456789abcdef`)
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { code: 'job/not-found', message: 'job bash-0123456789abcdef belongs to another session' })
  } finally {
    server.close()
  }
})
