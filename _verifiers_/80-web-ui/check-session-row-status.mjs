import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A session row's statuses in the tree, the row's half of DSH's `sessionStatuses` (dsh-client-ui-workspace
 * `lib/client.js:2068-2117`; the row draws the primary dot and names every status, `SessionStatusDots`, `:2118-2123`).
 *
 * - Issue #187: a parent whose background subagent works says `1 subagent running` on its row, even while the parent
 *   itself is idle (`runningChildCount`, `:1056-1058`). Before, its row showed nothing on both builds.
 * - Issue #147: a session waiting on the model's question says `Waiting for answer`, with `Answer` where its time is;
 *   one whose plan waits on review says `Plan awaiting review` / `Plan review` (DSH's `pendingInteraction` covers
 *   questions, plan reviews and approvals; precedence plan review > question > approval, dsh-client-ui-session
 *   `lib/client.js:933-947`). Before, only approvals reached the row, so both read `Running`.
 *
 * The model double and the stored sessions are check-hover-cards' C22 setup (developer-eight's); this judges the rows.
 */

const CAPABILITY = 'the Web UI'

/** Spawn `heddle web` on a free port and resolve with its URL once it prints one. */
function startCli(args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(...heddleCommand(args), {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let settled = false
    const onData = (chunk) => {
      output += chunk.toString()
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match && !settled) {
        settled = true
        resolvePromise({ url: match[1], kill: () => child.kill('SIGKILL') })
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

/** The token in the printed URL, exchanged for the cookie the API calls use. */
async function cookieFor(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')
  if (cookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return cookie.split(';')[0]
}

async function api(url, cookie, path, init = {}) {
  const response = await fetch(new URL(path, url), { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

async function supportsWeb() {
  return /web/.test((await runCli(['--help'])).stdout)
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

/** The prompts that tell the double which session's turn is asking (each session's history carries only its own). */
const HOLD = 'C22-HOLD-THIS-TURN-OPEN'
const ASK = 'C22-ASK-A-QUESTION'
const PLAN = 'C22-PRESENT-A-PLAN'

/**
 * A Chat Completions double for the status card check. A request whose history carries `HOLD` is never answered — its
 * stream stays open with a comment every 2 s — so that turn runs until the double closes; `ASK` and `PLAN` answer the
 * turn's first round with an `ask_user_question` and an `exit_plan_mode` call, whose waits never end (the question
 * service's default legacy mode, and the plan review's `timeout: -1`); anything else is a plain answer.
 */
async function statusDouble() {
  const held = new Set()
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      if (new URL(request.url ?? '/', 'http://x').pathname.endsWith('/models')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }
      let body = {}
      try {
        body = JSON.parse(raw)
      } catch {
        body = {}
      }
      const history = JSON.stringify(body.messages ?? [])
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (history.includes(HOLD)) {
        const beat = setInterval(() => response.write(': still working\n\n'), 2_000)
        const entry = { response, beat }
        held.add(entry)
        response.write(': still working\n\n')
        response.on('close', () => {
          clearInterval(beat)
          held.delete(entry)
        })
        return
      }
      const answered = (body.messages ?? []).some((message) => message?.role === 'tool')
      const call =
        answered ? null
        : history.includes(ASK) ? { name: 'ask_user_question', arguments: { questions: [{ id: 'color', header: 'Pick', question: 'Which colour?', options: [{ label: 'Blue' }, { label: 'Red' }] }] } }
        : history.includes(PLAN) ? { name: 'exit_plan_mode', arguments: { plan: '# Ship it\n\n1. Build\n2. Release' } }
        : null
      const frames =
        call === null
          ? [{ choices: [{ index: 0, delta: { content: history.includes('Create a concise title') ? 'A title' : 'done' }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]
          : [
              { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_c22_1', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, finish_reason: null }] },
              { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
            ]
      for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => {
      for (const { beat } of held) clearInterval(beat)
      server.close()
      server.closeAllConnections()
    },
  }
}

test('#187 #147: a row says "1 subagent running" for a working child, "Waiting for answer" for a question and "Plan awaiting review" for a plan', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('row-statuses')
  const work = fixtureDir('row-statuses-work')
  mkdirSync(work, { recursive: true })
  const root = join(home, 'sessions')
  const provider = await statusDouble()
  const config = join(home, 'heddle.json')
  writeFileSync(config, `${JSON.stringify({ default: 'double', endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: provider.baseUrl, model: 'double-model', apiKey: 'a-test-key' }] }, null, 2)}\n`)
  const { SessionStore } = await import('../../src/session/store.ts')
  const store = new SessionStore(root)
  const pause = () => new Promise((done) => setTimeout(done, 30))
  const conversation = (title) => {
    const handle = store.create({ cwd: work, title })
    store.message(handle, { role: 'user', content: [{ type: 'text', text: `about ${title}` }] })
    store.append(handle, { type: 'assistant/completed', text: 'noted' })
    return handle
  }
  const parent = conversation('parent of a background subagent')
  await pause()
  // A subagent child that takes turns (a teammate, as C22 has); a background delegate child cannot be sent a turn, and the
  // row counts every running \`origin: 'subagent'\` child alike (\`runningChildCount\`).
  const child = store.create({ cwd: work, title: 'the working child', parentSession: parent.id, origin: 'subagent', delegationDepth: 1, teamId: parent.id })
  await pause()
  const questioned = conversation('asks before the page opens')
  await pause()
  const reviewed = conversation('plan under review')
  await pause()
  const later = conversation('asks while the page is open')
  for (const handle of [parent, child, questioned, reviewed, later]) store.release(handle)

  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'double', '--session-root', root],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  let browser = null
  try {
    const cookie = await cookieFor(server.url)
    const added = await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: work }) })
    assert.equal(added.status, 200, `registered the workspace (${JSON.stringify(added.body)})`)
    const start = (handle, prompt) => {
      void fetch(new URL('/api/turn', server.url), {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, folder: work, session: handle.id }),
      })
        .then((response) => response.text())
        .catch(() => {})
    }
    const waitsOn = async (handle, id) =>
      ((await api(server.url, cookie, `/api/questions?session=${encodeURIComponent(handle.id)}`)).body?.requests ?? []).some((request) => request.state === 'waiting' && request.questions?.[0]?.id === id)
    const settle = async (probe, what, ms = 15_000) => {
      const end = Date.now() + ms
      while (!(await probe())) {
        if (Date.now() > end) assert.fail(what)
        await sleep(150)
      }
    }
    // The child works (its turn is held at the model) while its parent is idle; two sessions wait on a person.
    start(child, `${HOLD}: work in the background`)
    const runs = async (handle) => {
      const answer = (await api(server.url, cookie, '/api/sessions')).body
      return (Array.isArray(answer) ? answer : []).some((meta) => meta.id === handle.id && meta.running === true)
    }
    await settle(() => runs(child), "the child's turn runs, held at its model request")
    const planned = await api(server.url, cookie, `/api/sessions/${encodeURIComponent(reviewed.id)}/commands`, { method: 'POST', body: JSON.stringify({ line: '/plan' }) })
    assert.equal(planned.status, 200, `/plan puts the session in plan mode (${JSON.stringify(planned.body)})`)
    start(questioned, `${ASK}: pick a colour`)
    await settle(() => waitsOn(questioned, 'color'), 'the question waits for the person')
    start(reviewed, `${PLAN}: plan the release`)
    await settle(() => waitsOn(reviewed, 'plan-review'), 'the plan waits on its review')

    browser = await openBrowser()
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    const sessionRow = (id) => `#tree li[data-kind="session"][data-session-id="${id}"] > .row`
    const marks = (handle) => `(() => { const row = document.querySelector(${JSON.stringify(sessionRow(handle.id))}); if (row === null) return null; return JSON.stringify({ marks: [...row.querySelectorAll(':scope > .status-dot')].map((mark) => [mark.dataset.state, mark.getAttribute('aria-label')]), age: row.querySelector(':scope > .row-right > .age')?.textContent ?? null }) })()`
    const expectRow = async (handle, wanted, what) => {
      try {
        await browser.waitFor(`(() => { const seen = ${marks(handle)}; if (seen === null) return false; const { marks: m, age } = JSON.parse(seen); return m.length === 1 && m[0][0] === ${JSON.stringify(wanted.state)} && m[0][1] === ${JSON.stringify(wanted.label)} && (${JSON.stringify(wanted.age ?? null)} === null || age === ${JSON.stringify(wanted.age ?? null)}) })()`, 15_000)
      } catch {
        assert.fail(`${what}\nwanted ${JSON.stringify(wanted)}, saw ${await browser.evaluate(marks(handle))}`)
      }
    }
    await expectRow(parent, { state: 'ongoing', label: '1 subagent running' }, '#187: the idle parent of a working background subagent says so on its row')
    await expectRow(questioned, { state: 'warning', label: 'Waiting for answer', age: 'Answer' }, '#147: a question asked before the page opened marks its row')
    await expectRow(reviewed, { state: 'warning', label: 'Plan awaiting review', age: 'Plan review' }, '#147: a plan waiting on review marks its row')

    // A question asked while the page is open reaches its row through the stream.
    start(later, `${ASK}: pick another colour`)
    await settle(() => waitsOn(later, 'color'), 'the second question waits for the person')
    await expectRow(later, { state: 'warning', label: 'Waiting for answer', age: 'Answer' }, '#147: a question asked while the page is open marks its row')

    // Answered, the row goes back to running and then to its turn's end: no stale "Waiting for answer".
    const open = (await api(server.url, cookie, `/api/questions?session=${encodeURIComponent(later.id)}`)).body?.requests?.[0]
    const answered = await api(server.url, cookie, `/api/questions/${encodeURIComponent(open.id)}`, { method: 'POST', body: JSON.stringify({ session: later.id, answers: [{ id: 'color', selected: ['Blue'] }] }) })
    assert.equal(answered.status, 200, `the question was answered (${JSON.stringify(answered.body)})`)
    await browser.waitFor(`(() => { const seen = ${marks(later)}; if (seen === null) return false; return !JSON.parse(seen).marks.some((m) => m[1] === 'Waiting for answer') })()`, 15_000)
  } finally {
    await browser?.close()
    server.kill()
    provider.close()
    removeDir(home)
    removeDir(work)
  }
})
