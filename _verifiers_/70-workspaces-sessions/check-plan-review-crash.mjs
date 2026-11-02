import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isTitleRequest, readTranscript, refuseTitleRequest, removeDir, repoRoot, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A plan review left open by a crash fails closed after the restart; a live approval leaves plan mode without a user-switch notice (#228).
 *
 * Measured live before the fix, on both builds (developer-four's J194): a server killed while `exit_plan_mode`'s
 * `plan-review` question waited came back with the request still answerable, in state `continued`. An Approve was taken
 * as a late `ask_user_question` answer and the session stayed in plan mode. The model was told "Approve" while every
 * request still carried the plan-mode policy. A clean SIGTERM already failed closed (`question/cancelled {stopped}`).
 *
 * DSH: "after a service reload while the review is pending, the call fails closed and `/plan off` remains the manual
 * escape" (dsh-plan-mode README). Its question fold keeps only `ask_user_question` calls answerable past their turn
 * (dsh-user-questions `applyUserQuestionEvent`), so a review asked by `exit_plan_mode` is gone after a reload. And DSH's
 * controller does not narrate the exit tool's transition: `narrate` is "false for the exit tool, whose result already
 * narrates the transition". Both builds appended "The user switched this session back to the default mode." after a
 * live approval.
 *
 * The model's side is read from what a provider double received.
 */

const CAPABILITY = 'a Web UI with plan mode and the question routes'
const PLAN = '# Plan crash-228\n\n- write hello.txt\n- verify it'
const OFF_NOTICE = 'The user switched this session back to the default mode.'
const POLICY_OPENING = 'You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode'

/** The text of a Chat Completions message, whatever its content shape. */
function textOf(message) {
  return typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '')
}

/**
 * A Chat Completions double. A request whose last message is the user's `EXITPLAN …` is answered with one
 * `exit_plan_mode` call; anything else, a tool result included, with plain text. Every turn request body is kept.
 */
async function planDouble() {
  const bodies = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      if (new URL(request.url ?? '/', 'http://x').pathname.endsWith('/models')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'no model list' }))
        return
      }
      if (isTitleRequest(raw)) return refuseTitleRequest(response)
      let body = {}
      try {
        body = JSON.parse(raw)
      } catch {
        body = {}
      }
      bodies.push(body)
      const last = (body.messages ?? []).at(-1)
      const exit = last?.role === 'user' && textOf(last).includes('EXITPLAN')
      const frames = exit
        ? [
            {
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: [{ index: 0, id: `call_exit_${bodies.length}`, type: 'function', function: { name: 'exit_plan_mode', arguments: JSON.stringify({ plan: PLAN }) } }] },
                  finish_reason: null,
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          ]
        : [{ choices: [{ index: 0, delta: { role: 'assistant', content: 'noted' }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    bodies,
    close: () =>
      new Promise((done) => {
        server.close(done)
        server.closeAllConnections()
      }),
  }
}

/** Start the Web UI and resolve once it prints its URL. */
function startServer(args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(...heddleCommand(args), { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let settled = false
    const onData = (chunk) => {
      output += chunk.toString()
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match && !settled) {
        settled = true
        resolvePromise({ child, url: match[1] })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => {
      if (!settled) {
        settled = true
        reject(new Error(`the server exited ${code} before printing a URL\n${output}`))
      }
    })
    setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGKILL')
        reject(new Error(`the server printed no URL within 15s\n${output}`))
      }
    }, 15_000).unref()
  })
}

/** Kill a server outright, as a crash does, and wait for it to be gone. */
function killServer(server) {
  return new Promise((resolve) => {
    if (server.child.exitCode !== null || server.child.signalCode !== null) return resolve()
    server.child.once('exit', () => resolve())
    server.child.kill('SIGKILL')
  })
}

/** The printed URL's token, attached to every API request as the page's cookie is. */
function request(server, path, options = {}) {
  const base = new URL(server.url)
  const target = new URL(path, base)
  target.searchParams.set('token', base.searchParams.get('token') ?? '')
  return fetch(target, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
}

async function json(server, path, options = {}) {
  const response = await request(server, path, { ...options, signal: AbortSignal.timeout(30_000) })
  const text = await response.text()
  let body = {}
  try {
    body = JSON.parse(text)
  } catch {
    body = { text }
  }
  return { status: response.status, body }
}

/** Post a turn and read it to its end; the session it ran in, and the streamed body. */
async function turn(server, body) {
  const response = await request(server, '/api/turn', { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
  const text = await response.text()
  assert.equal(response.status, 200, `the turn was accepted (${String(body.prompt).slice(0, 40)})\n${text.slice(0, 400)}`)
  const named = /event: session\ndata: (\{.*\})/.exec(text)
  return { session: named ? JSON.parse(named[1]).session : body.session, text }
}

const command = (server, session, line) => json(server, `/api/sessions/${encodeURIComponent(session)}/commands`, { method: 'POST', body: JSON.stringify({ line }) })
const planState = async (server, session) => (await json(server, `/api/sessions/${encodeURIComponent(session)}/plan`)).body.active
const questions = async (server, session, all = false) => (await json(server, `/api/questions?session=${encodeURIComponent(session)}${all ? '&all=1' : ''}`)).body.requests ?? []

/** Wait until the session's plan review is open and a turn waits on it. */
async function waitingReview(server, session) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const open = await questions(server, session)
    const review = open.find((one) => one.questions?.[0]?.id === 'plan-review')
    if (review?.state === 'waiting') return review
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(`the plan review never opened (none means exit_plan_mode found no channel)\n${JSON.stringify(await questions(server, session, true))}`)
}

async function supportsWeb() {
  return /web/.test((await runCli(['--help'])).stdout)
}

/** A server over a fresh home and session root, restartable over the same ones. */
async function fixture(label) {
  const double = await planDouble()
  const home = fixtureDir(label)
  writeJson(join(home, 'heddle.json'), { default: 'double', endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: double.url, model: 'double', stream: true }] })
  const sessions = join(home, 'sessions')
  const servers = []
  const start = async () => {
    const server = await startServer(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', sessions], { HEDDLE_HOME: home, HEDDLE_CONFIG: join(home, 'heddle.json') })
    servers.push(server)
    return server
  }
  const close = async () => {
    for (const one of servers) await killServer(one)
    await double.close()
    removeDir(home)
  }
  return { double, sessions, start, close }
}

/** A session the model has answered in once, put in plan mode, with `exit_plan_mode`'s review waiting. */
async function reviewWaiting(server) {
  const first = await turn(server, { prompt: 'hello' })
  const session = first.session
  assert.ok(typeof session === 'string', `the first turn named its session\n${first.text.slice(-300)}`)
  const on = await command(server, session, '/plan')
  assert.equal(on.body.text, 'Plan mode on. Use /plan off to leave.', JSON.stringify(on.body))
  const running = turn(server, { session, prompt: 'EXITPLAN write hello.txt' }).catch((error) => error)
  const review = await waitingReview(server, session)
  return { session, review, running }
}

test('a plan review left open by a crash reads as cancelled after the restart: Approve is refused, plan mode stays on, /plan off escapes (#228)', { timeout: 120_000 }, async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const setup = await fixture('plan-review-crash')
  try {
    let server = await setup.start()
    const { session, review, running } = await reviewWaiting(server)
    await killServer(server)
    await running

    server = await setup.start()
    assert.equal(await planState(server, session), true, 'after the restart the session is still in plan mode')
    const [after] = (await questions(server, session, true)).filter((one) => one.id === review.id)
    assert.equal(after?.state, 'cancelled', `the review reads as cancelled, not answerable (${JSON.stringify(after)})`)
    assert.equal(after?.reason, 'interrupted', 'because the turn that asked it is gone')
    assert.deepEqual(
      (await questions(server, session)).map((one) => one.id),
      [],
      'the page has nothing to approve',
    )
    const approved = await json(server, `/api/questions/${encodeURIComponent(review.id)}`, {
      method: 'POST',
      body: JSON.stringify({ session, answers: [{ id: 'plan-review', selected: ['Approve'] }] }),
    })
    assert.equal(approved.status, 409, `an Approve is refused (${JSON.stringify(approved.body)})`)
    assert.match(String(approved.body.error), /already cancelled/)
    assert.equal(approved.body.message, undefined, 'and no late message is handed back to deliver')
    assert.equal(await planState(server, session), true, 'plan mode stays on')
    const log = readTranscript(join(setup.sessions, session))
    assert.ok(!log.some((event) => event.type === 'question/answered' && event.requestId === review.id), 'the refusal wrote no answer')

    const off = await command(server, session, '/plan off')
    assert.equal(off.body.text, 'Plan mode off.', `/plan off remains the escape (${JSON.stringify(off.body)})`)
    assert.equal(await planState(server, session), false)
  } finally {
    await setup.close()
  }
})

test('a live Approve leaves plan mode in the tool result\'s words, without the user-switch notice (#228)', { timeout: 120_000 }, async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const setup = await fixture('plan-review-live')
  try {
    const server = await setup.start()
    const { session, review, running } = await reviewWaiting(server)
    const approved = await json(server, `/api/questions/${encodeURIComponent(review.id)}`, {
      method: 'POST',
      body: JSON.stringify({ session, answers: [{ id: 'plan-review', selected: ['Approve'] }] }),
    })
    assert.equal(approved.status, 200, `the answer is taken (${JSON.stringify(approved.body)})`)
    assert.equal(approved.body.late, false, 'by the waiting turn')
    const ended = await running
    assert.ok(!(ended instanceof Error), `the turn ran to its end (${ended})`)
    assert.equal(await planState(server, session), false, 'plan mode is off')

    const next = setup.double.bodies.find((body) => (body.messages ?? []).some((message) => message.role === 'tool'))
    assert.ok(next !== undefined, 'the tool result went back to the model')
    const words = (next.messages ?? []).map(textOf).join('\n')
    assert.match(words, /Plan approved — plan mode exited; carry out the plan starting with your next step\./, "DSH's sentence for an approved plan")
    assert.ok(!words.includes(OFF_NOTICE), `the request after the approval does not say the user switched modes\n${words.slice(-600)}`)
    assert.ok(!words.includes(POLICY_OPENING), 'and no longer carries the plan-mode policy')
    const log = readTranscript(join(setup.sessions, session))
    const leave = log.findIndex((event) => event.type === 'plan/mode' && event.active === false)
    assert.ok(leave >= 0, 'the log records the mode change')
    assert.ok(!log.slice(leave).some((event) => event.type === 'context/note' && event.origin === 'plan-mode'), 'with no plan-mode notice after it')
  } finally {
    await setup.close()
  }
})
