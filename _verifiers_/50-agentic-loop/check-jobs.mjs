import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { chatDouble, fixtureDir, heddleCommand, httpConfig, isolatedHome, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Background jobs, judged as DSH's `dsh-jobs-local`, `dsh-tool-jobs`, background `dsh-tool-bash` and
 * `dsh-api-job-controller` behave (inventory rows A50-A55 and A57's routes).
 *
 * Seven claims, each through the build under test (the TypeScript dist, or the binary `HEDDLE_BIN` names):
 *
 * 1. **A50** `bash` with `run_in_background` answers `started background job bash-<16 hex>` at once, and the turn
 *    goes on.
 * 2. **A51** `job_output` is a consuming read: a second read has only the new output, and a wait that times out
 *    leaves the job running.
 * 3. **A52** `job_list` shows running and finished jobs, one DSH line each.
 * 4. **A53** `job_kill` answers `requested cancellation of job <id>` at once; the job then settles `killed` and its
 *    process group is gone.
 * 5. **A54** an idle session is woken by a turn whose user message is DSH's completion notice (source `tool-jobs`).
 * 6. **A55** another session's `job_output` and `job_kill` on the job are refused: `job <id> belongs to another
 *    session`.
 * 7. **A57** the page's follow route reads output without consuming it — the model's next `job_output` still
 *    returns it — and the kill route stops the job with `cancelled by the user`, which still notifies.
 * 8. **A54's guidance** a model request that offers the job tools carries DSH's `tool:jobs` prompt section at the end
 *    of its system prompt ("Track every background job id you start. …"), as the request reaches the provider.
 * 9. **A50, promoted** a foreground `bash` that outlives its `timeoutMs` is not killed: it answers the output so far
 *    and `[still running after <ms>ms; moved to background job <id>]` with DSH's hand-off, and the job goes on, so a
 *    later `job_output` reads the rest (DSH's `promoteOnTimeout`, default true while a job registry is loaded).
 *
 * It is gated on the Web command alone, never on the jobs capability, so a build without background jobs fails
 * here rather than skipping. Every model step comes from the offline scripted endpoint. The script is re-read on
 * every model request, so the check rewrites it between turns: a later turn names the real job id, and the turn a
 * completion notice starts (purpose `jobs-notice`) has steps of its own. Tool results are read from the session log.
 */
const CAPABILITY = 'the Web UI'

async function startServer(label) {
  const home = isolatedHome(`jobs-${label}`)
  const work = fixtureDir(`jobs-${label}-work`)
  mkdirSync(work, { recursive: true })
  const config = join(home, 'heddle.json')
  const script = join(home, 'script.json')
  scriptedConfig({ home, steps: [{ text: 'idle' }] })
  const child = spawn(...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')]), {
    cwd: work,
    env: { ...process.env, NO_COLOR: '1', HEDDLE_HOME: home, HEDDLE_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const url = await new Promise((resolvePromise, reject) => {
    const onData = (chunk) => {
      output += chunk.toString()
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match) resolvePromise(match[1])
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => reject(new Error(`the server exited ${code} before printing a URL\n${output}`)))
    setTimeout(() => reject(new Error(`the server printed no URL within 15s\n${output}`)), 15_000).unref()
  })
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
  if (cookie === undefined) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  const sessions = new Set()
  const server = {
    home,
    work,
    url,
    script,
    cookie,
    sessions,
    /** The server process, for a claim that stops it the way a restart does. */
    process: child,
    output: () => output,
    close: async () => {
      // A detached job outlives a killed server, so every live job is stopped first, through the page's own route.
      for (const session of sessions) await stopJobs(server, session)
      child.kill('SIGKILL')
      removeDir(home)
      removeDir(work)
    },
  }
  return server
}

async function api(server, path, init = {}) {
  const response = await fetch(new URL(path, server.url), { ...init, headers: { cookie: server.cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

async function stopJobs(server, session) {
  try {
    const listed = await api(server, `/api/jobs?session=${encodeURIComponent(session)}`)
    for (const job of listed.body.jobs ?? []) {
      if (job.status === 'running') await api(server, '/api/jobs/kill', { method: 'POST', body: JSON.stringify({ session, job: job.id }) })
    }
    if ((listed.body.jobs ?? []).some((job) => job.status === 'running')) await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
  } catch {
    // A build without the routes has nothing to stop.
  }
}

async function openSession(server, folder) {
  mkdirSync(folder, { recursive: true })
  await api(server, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: folder }) })
  const opened = await api(server, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder }) })
  const id = opened.body.session?.id ?? opened.body.id
  server.sessions.add(id)
  return id
}

const steps = (server, list) => writeFileSync(server.script, JSON.stringify({ steps: list }))

async function turn(server, session, folder, list) {
  steps(server, list)
  const response = await fetch(new URL('/api/turn', server.url), {
    method: 'POST',
    headers: { cookie: server.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'jobs probe', folder, session }),
  })
  assert.equal(response.status, 200, `the turn ran (${response.status})`)
  await response.text()
}

const events = (server, session) => readTranscript(join(server.home, 'sessions', session))
const textOf = (event) => (event.message?.content ?? []).map((part) => part.text ?? '').join('')
const toolTexts = (server, session, since) =>
  events(server, session)
    .slice(since)
    .filter((event) => event.type === 'message' && event.message?.role === 'tool')
    .map(textOf)
const notices = (server, session) => events(server, session).filter((event) => event.type === 'message' && event.message?.role === 'user' && event.message?.source?.kind === 'tool-jobs')
const settledEvent = (server, session, id) => events(server, session).find((event) => event.type === 'job/settled' && event.jobId === id)

async function waitFor(read, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
}

const STARTED = /^started background job (bash-[0-9a-f]{16})$/

/** The job id a background start answered with; a build that ran the command in the foreground fails here. */
function startedId(text) {
  const match = STARTED.exec(text ?? '')
  assert.ok(match, `bash with run_in_background answers "started background job bash-<16 hex>"\nsaw: ${JSON.stringify(text)}`)
  return match[1]
}

const backgroundBash = (command) => ({ toolCall: { name: 'bash', arguments: { command, run_in_background: true } } })

/** Whether a process (or, with a negative id, a process group) still exists. */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('A50: bash with run_in_background answers a job id at once and the turn goes on', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('start')
  try {
    const folder = join(server.work, 'start')
    const session = await openSession(server, folder)
    const mark = events(server, session).length
    const began = Date.now()
    await turn(server, session, folder, [backgroundBash('sleep 30'), { text: 'started it, carrying on' }])
    const took = Date.now() - began
    const [answer] = toolTexts(server, session, mark)
    startedId(answer)
    assert.ok(took < 15_000, `the turn did not wait for sleep 30 (took ${took} ms)`)
    const after = events(server, session).slice(mark)
    const resultAt = after.findIndex((event) => event.type === 'message' && event.message?.role === 'tool')
    assert.ok(
      after.slice(resultAt).some((event) => JSON.stringify(event).includes('started it, carrying on')),
      'the model answered after the tool result in the same turn',
    )
    assert.ok(after.some((event) => event.type === 'turn/completed'), 'the turn completed')
  } finally {
    await server.close()
  }
})

test('A51: job_output reads only new output, and a timed-out wait leaves the job running', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('output')
  try {
    const folder = join(server.work, 'output')
    const session = await openSession(server, folder)
    let mark = events(server, session).length
    await turn(server, session, folder, [backgroundBash('echo one; while [ ! -f go ]; do sleep 0.1; done; echo two; sleep 30'), { text: 'started' }])
    const id = startedId(toolTexts(server, session, mark)[0])
    mark = events(server, session).length
    await turn(server, session, folder, [
      { toolCall: { name: 'bash', arguments: { command: 'sleep 0.5' } } },
      { toolCall: { name: 'job_output', arguments: { job_id: id } } },
      { toolCall: { name: 'bash', arguments: { command: 'touch go; sleep 1' } } },
      { toolCall: { name: 'job_output', arguments: { job_id: id } } },
      { toolCall: { name: 'job_output', arguments: { job_id: id, wait: true, timeout_ms: 300 } } },
      { text: 'read it' },
    ])
    const answers = toolTexts(server, session, mark)
    assert.equal(answers[1], 'one\n[status: running]', `the first read has the output so far\nsaw: ${JSON.stringify(answers)}`)
    assert.equal(answers[3], 'two\n[status: running]', 'the second read has only the new output')
    assert.equal(answers[4], '(no new output)\n[status: running]', 'a wait that times out is not an error and the job keeps running')
    const listed = await api(server, `/api/jobs?session=${encodeURIComponent(session)}`)
    assert.equal(listed.body.jobs?.find((job) => job.id === id)?.status, 'running', 'the job is still running after the timed-out wait')
  } finally {
    await server.close()
  }
})

test('A52: job_list shows running and finished jobs', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('list')
  try {
    const folder = join(server.work, 'list')
    const session = await openSession(server, folder)
    const mark = events(server, session).length
    await turn(server, session, folder, [
      backgroundBash('sleep 30'),
      backgroundBash('echo done'),
      { toolCall: { name: 'bash', arguments: { command: 'sleep 1' } } },
      { toolCall: { name: 'job_list', arguments: {} } },
      { text: 'listed' },
    ])
    const answers = toolTexts(server, session, mark)
    const running = startedId(answers[0])
    const finished = startedId(answers[1])
    assert.equal(answers[3], `${running} [bash] running — sleep 30\n${finished} [bash] completed — echo done`, `one DSH line per job, in start order\nsaw: ${JSON.stringify(answers[3])}`)
  } finally {
    await server.close()
  }
})

test('A53: job_kill requests cancellation at once; the job settles killed and its process is gone', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('kill')
  try {
    const folder = join(server.work, 'kill')
    const session = await openSession(server, folder)
    let mark = events(server, session).length
    await turn(server, session, folder, [backgroundBash('echo $$ > job.pid; exec sleep 30'), { text: 'started' }])
    const id = startedId(toolTexts(server, session, mark)[0])
    const pid = Number(await waitFor(() => {
      try {
        return readFileSync(join(folder, 'job.pid'), 'utf8').trim()
      } catch {
        return undefined
      }
    }, 10_000, 'the job to write its pid'))
    assert.ok(alive(pid), 'the job process runs')
    mark = events(server, session).length
    await turn(server, session, folder, [{ toolCall: { name: 'job_kill', arguments: { job_id: id } } }, { text: 'killed' }])
    assert.equal(toolTexts(server, session, mark)[0], `requested cancellation of job ${id}`)
    const settled = await waitFor(() => settledEvent(server, session, id), 10_000, 'the job to settle')
    assert.equal(settled.status, 'killed')
    assert.equal(settled.detail, 'signal: SIGTERM')
    assert.equal(settled.cause, 'kill')
    assert.equal(alive(pid), false, 'the process is gone')
    assert.equal(alive(-pid), false, 'its process group is gone')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    assert.equal(notices(server, session).length, 0, 'the model killed it itself, so no completion notice')
  } finally {
    await server.close()
  }
})

test('A54: an idle session is woken by a turn whose user message is the completion notice', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('notice')
  try {
    const folder = join(server.work, 'notice')
    const session = await openSession(server, folder)
    const mark = events(server, session).length
    await turn(server, session, folder, [backgroundBash('sleep 1; echo finished'), { text: 'will be told' }, { purpose: 'jobs-notice', text: 'the job is done' }])
    const id = startedId(toolTexts(server, session, mark)[0])
    const notice = await waitFor(() => notices(server, session)[0], 15_000, 'the completion notice in the session log')
    assert.equal(
      textOf(notice),
      `background job ${id} (bash: sleep 1; echo finished) finished [status: completed, exit code: 0]. Read its output with job_output.`,
      'DSH notice text, word for word',
    )
    assert.deepEqual(notice.message.source, { kind: 'tool-jobs', form: 'notice', summary: 'bash sleep 1; echo finished [status: completed, exit code: 0]' })
    const afterNotice = () => {
      const all = events(server, session)
      return all.slice(all.findIndex((event) => event.type === 'message' && event.message?.source?.kind === 'tool-jobs'))
    }
    await waitFor(() => afterNotice().some((event) => event.type === 'turn/completed'), 15_000, 'the turn the notice started')
    assert.ok(afterNotice().some((event) => JSON.stringify(event).includes('the job is done')), 'the model answered the notice in that turn')
  } finally {
    await server.close()
  }
})

test('A55: another session is refused job_output and job_kill on the job', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('owner')
  try {
    const folderA = join(server.work, 'owner-a')
    const folderB = join(server.work, 'owner-b')
    const sessionA = await openSession(server, folderA)
    const sessionB = await openSession(server, folderB)
    let mark = events(server, sessionA).length
    await turn(server, sessionA, folderA, [backgroundBash('sleep 30'), { text: 'started' }])
    const id = startedId(toolTexts(server, sessionA, mark)[0])
    mark = events(server, sessionB).length
    await turn(server, sessionB, folderB, [
      { toolCall: { name: 'job_output', arguments: { job_id: id } } },
      { toolCall: { name: 'job_kill', arguments: { job_id: id } } },
      { toolCall: { name: 'job_list', arguments: {} } },
      { text: 'tried' },
    ])
    const answers = toolTexts(server, sessionB, mark)
    assert.match(answers[0] ?? '', new RegExp(`job ${id} belongs to another session$`), `job_output is refused\nsaw: ${JSON.stringify(answers)}`)
    assert.match(answers[1] ?? '', new RegExp(`job ${id} belongs to another session$`), 'job_kill is refused')
    assert.equal(answers[2], '(no background jobs)', 'the other session lists none of it')
    const listed = await api(server, `/api/jobs?session=${encodeURIComponent(sessionA)}`)
    assert.equal(listed.body.jobs?.find((job) => job.id === id)?.status, 'running', 'the refused kill did not stop the job')
  } finally {
    await server.close()
  }
})

test('A57: the follow route reads without consuming, and the kill route stops the job and still notifies', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('routes')
  const stream = new AbortController()
  try {
    const folder = join(server.work, 'routes')
    const session = await openSession(server, folder)
    let mark = events(server, session).length
    await turn(server, session, folder, [backgroundBash('echo hello; sleep 30'), { text: 'started' }])
    const id = startedId(toolTexts(server, session, mark)[0])
    const followPath = (from) => `/api/jobs/follow?session=${encodeURIComponent(session)}&job=${encodeURIComponent(id)}&from=${from}`
    const first = await waitFor(async () => {
      const read = await api(server, followPath(0))
      return read.status === 200 && read.body.chunks?.length > 0 ? read : undefined
    }, 10_000, 'the follow route to show the output')
    assert.deepEqual(first.body.chunks.map((chunk) => chunk.text).join(''), 'hello\n')
    assert.equal(first.body.settled, false)
    assert.equal(first.body.job.status, 'running')
    const again = await api(server, followPath(first.body.next))
    assert.deepEqual(again.body.chunks, [], 'following from next answers nothing new')
    const foreign = await api(server, `/api/jobs/follow?session=not-${encodeURIComponent(session)}&job=${encodeURIComponent(id)}`)
    assert.equal(foreign.status, 404)
    assert.equal(foreign.body.code, 'job/not-found')

    mark = events(server, session).length
    await turn(server, session, folder, [{ toolCall: { name: 'job_output', arguments: { job_id: id } } }, { text: 'read it' }])
    assert.equal(toolTexts(server, session, mark)[0], 'hello\n[status: running]', 'the page read nothing away from the model')

    // The page refreshes on the server's `jobs` event; listen before the kill.
    const seen = []
    const events$ = fetch(new URL('/api/events', server.url), { headers: { cookie: server.cookie }, signal: stream.signal })
      .then(async (response) => {
        const decoder = new TextDecoder()
        for await (const chunk of response.body) seen.push(decoder.decode(chunk))
      })
      .catch(() => undefined)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
    steps(server, [{ purpose: 'jobs-notice', text: 'the user stopped it' }])
    const killed = await api(server, '/api/jobs/kill', { method: 'POST', body: JSON.stringify({ session, job: id }) })
    assert.equal(killed.status, 200, `the kill route answers\nsaw: ${JSON.stringify(killed)}`)
    assert.deepEqual(killed.body, { outcome: 'requested' })
    const settled = await waitFor(() => settledEvent(server, session, id), 10_000, 'the job to settle')
    assert.equal(settled.status, 'killed')
    assert.equal(settled.detail, 'signal: SIGTERM; cancelled by the user')
    const notice = await waitFor(() => notices(server, session)[0], 10_000, 'the notice a person’s kill still sends')
    assert.match(textOf(notice), new RegExp(`^background job ${id} \\(bash: echo hello; sleep 30\\) finished \\[status: killed, signal: SIGTERM; cancelled by the user\\]`))
    const listed = await api(server, `/api/jobs?session=${encodeURIComponent(session)}`)
    assert.equal(listed.body.jobs?.find((job) => job.id === id)?.status, 'killed')
    await waitFor(() => seen.join('').includes('event: jobs'), 5_000, 'the jobs event on the page stream')
    stream.abort()
    await events$
  } finally {
    stream.abort()
    await server.close()
  }
})

/** DSH's `tool:jobs` section (dsh-tool-jobs/lib/index.js:257-261), verbatim. */
const JOBS_SECTION =
  "Track every background job id you start. You are notified in-session when a job finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running job's work. Before giving a final answer, collect every still-relevant job with job_output (set wait: true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering."

test('A54 guidance: a request that offers the job tools ends its system prompt with DSH\'s tool:jobs section', async (context) => {
  if (!skipUnless(context, /--turn/.test((await runCli(['--help'])).stdout), 'a one-shot turn')) return
  const home = isolatedHome('jobs-section')
  const work = fixtureDir('jobs-section-work')
  mkdirSync(work, { recursive: true })
  const double = await chatDouble({ content: 'ok' })
  try {
    const config = httpConfig({ home, baseUrl: double.baseUrl, stream: true })
    const run = await runCli(['--config', join(repoRoot, 'cordis.yml'), '--session-root', join(home, 'sessions'), '--turn', 'hello'], {
      env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
      cwd: work,
    })
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)
    const bodies = double.requests.map((entry) => {
      try {
        return JSON.parse(entry.body)
      } catch {
        return undefined
      }
    })
    const body = bodies.find((value) => Array.isArray(value?.tools) && value.tools.some((tool) => (tool.function ?? tool).name === 'job_output'))
    assert.ok(body !== undefined, `a request offered job_output\nsaw tools: ${JSON.stringify(bodies.map((value) => value?.tools?.map((tool) => (tool.function ?? tool).name)))}`)
    const system = body.messages.find((message) => message.role === 'system')
    const text = typeof system?.content === 'string' ? system.content : (system?.content ?? []).map((part) => part.text ?? '').join('')
    // The section ends the system prompt, after a blank line; with no other system text it is the whole prompt.
    assert.ok(text === JOBS_SECTION || text.endsWith(`\n\n${JOBS_SECTION}`), `the system prompt ends with the tool:jobs section\nsaw: ${JSON.stringify(text.slice(-400))}`)
    assert.equal(text.split(JOBS_SECTION).length, 2, 'the section appears once')
  } finally {
    await double.close()
    removeDir(home)
    removeDir(work)
  }
})

const PROMOTED = /^([\s\S]*)\[still running after (\d+)ms; moved to background job (bash-[0-9a-f]{16})\]\nThe command keeps running in the background\. You will be notified when it finishes; read newer output with job_output, stop it with job_kill\.$/

test('A50 promoted: a foreground bash that outlives its wall time moves to a background job instead of being killed', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('promote')
  try {
    const folder = join(server.work, 'promote')
    const session = await openSession(server, folder)
    let mark = events(server, session).length
    await turn(server, session, folder, [{ toolCall: { name: 'bash', arguments: { command: 'echo early; sleep 1.5; echo late', timeoutMs: 500 } } }, { text: 'promoted' }])
    const answer = toolTexts(server, session, mark)[0]
    const match = PROMOTED.exec(answer ?? '')
    assert.ok(match, `the call answers DSH's promoted text, not a timeout\nsaw: ${JSON.stringify(answer)}`)
    assert.equal(match[1], 'early\n', 'the output so far comes first')
    assert.equal(match[2], '500')
    const id = match[3]
    mark = events(server, session).length
    await turn(server, session, folder, [{ toolCall: { name: 'job_output', arguments: { job_id: id, wait: true, timeout_ms: 10_000 } } }, { text: 'read it' }])
    assert.equal(toolTexts(server, session, mark)[0], 'late\n[status: completed, exit code: 0]', 'the command went on, and job_output reads after what the call answered')
  } finally {
    await server.close()
  }
})

test('A51 spill: output that outgrew the ring is named by its spill file in job_output, and the file holds every byte', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  /**
   * DSH's bash provider keeps each stream's complete output in a private spill file once it outgrows the in-memory
   * tail (`dsh-subprocess-local` `OutputCollector`: a 64 000-byte tail, a 64 MiB spill cap). When the model's read
   * fell behind the job's ring, `job_output`'s notice names that file:
   * `[some output was dropped from memory; full output: <path>]` (`renderModelDelta`, dsh-tool-jobs). Before, the
   * notice could only say `(unavailable)`.
   */
  const server = await startServer('spill')
  try {
    const folder = join(server.work, 'spill')
    const session = await openSession(server, folder)
    let mark = events(server, session).length
    const command = "while [ ! -f go ]; do sleep 0.1; done; awk 'BEGIN { for (i = 0; i < 40000; i++) printf \"line %05d\\n\", i }'"
    await turn(server, session, folder, [backgroundBash(command), { text: 'started' }])
    const id = startedId(toolTexts(server, session, mark)[0])
    mark = events(server, session).length
    await turn(server, session, folder, [
      { toolCall: { name: 'bash', arguments: { command: 'touch go' } } },
      { toolCall: { name: 'job_output', arguments: { job_id: id, wait: true, timeout_ms: 20_000 } } },
      { text: 'read it' },
    ])
    const read = toolTexts(server, session, mark)[1] ?? ''
    const named = /\[some output was dropped from memory; full output: ([^\]\n]+)\]/.exec(read)
    assert.ok(named, `the read names where the dropped output is\nsaw: ${JSON.stringify(read.slice(0, 300))}`)
    const path = named[1]
    assert.notEqual(path, '(unavailable)', 'a file, not "(unavailable)"')
    assert.match(path, /heddle-jobs-\d+-\d+-[0-9a-f]{12}-stdout\.log$/, 'a private per-process spill file for stdout')
    const full = readFileSync(path, 'utf8')
    assert.equal(full.length, 440_000, 'the file holds the complete stream (40 000 lines of 11 bytes)')
    assert.ok(full.startsWith('line 00000\nline 00001\n') && full.endsWith('line 39999\n'))
    assert.match(read, /line 39999\n/, 'the read still shows the tail itself')
    assert.match(read, /\[status: completed, exit code: 0\]$/)
  } finally {
    await server.close()
  }
})

test('#129: a background job ended by a server shutdown is settled in its session log', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  /**
   * A restart (SIGTERM) ends every live job's process group, and the job's end is recorded like any other settle:
   * `job/settled` with status `killed`, so the session's history does not keep a job that never ended. DSH's teardown
   * awaits its jobs' settles (LOCAL:831-839). Measured before (developer-four, #129): TS wrote the settle, the binary
   * wrote none, because its teardown only spawned the wait and the process exited first.
   */
  const server = await startServer('shutdown')
  try {
    const folder = join(server.work, 'shutdown')
    const session = await openSession(server, folder)
    const mark = events(server, session).length
    await turn(server, session, folder, [backgroundBash('sleep 63 && touch marker'), { text: 'started' }])
    const id = startedId(toolTexts(server, session, mark)[0])
    const exited = new Promise((resolvePromise) => server.process.once('exit', resolvePromise))
    server.process.kill('SIGTERM')
    const stopped = await Promise.race([exited.then(() => true), new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 15_000))])
    assert.ok(stopped, 'the server exits after SIGTERM')
    const settled = settledEvent(server, session, id)
    assert.ok(settled, `the job's end is in the session log\nsaw: ${JSON.stringify(events(server, session).slice(mark).map((event) => event.type))}`)
    assert.equal(settled.status, 'killed')
    assert.equal(existsSync(join(folder, 'marker')), false, 'the command never got to finish')
  } finally {
    await server.close()
  }
})
