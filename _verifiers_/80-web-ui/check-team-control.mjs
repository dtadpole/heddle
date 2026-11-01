import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A person talks to a teammate and stops it from the page (inventory S134: DSH's `subagents/prompt` and
 * `subagents/interruptByParent`, dsh-subagent lib/index.js:3187-3256).
 *
 * The team panel's teammate row carries Stop and Message. Stop interrupts the teammate's running turn; DSH's
 * interruptByParent cancels the child's live turn and acknowledges at once. Message sends a person's follow-up, which
 * runs as the teammate's next turn; DSH's prompt delivers a user message to a continuable child. Before, the panel was
 * read-only (roster, board, mailbox), so neither could be done from the page.
 *
 * The team is written before the server starts, as check-team-view writes it. A Chat Completions double holds a turn
 * whose history carries HOLD open, and answers anything else at once.
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

const HOLD = 'S134-HOLD-THIS-TURN-OPEN'
const FOLLOW_UP = 'S134 please summarise what you have'

/** A double that keeps a HOLD turn streaming until it is stopped, and answers every other request with `done`. */
async function double() {
  const held = new Set()
  const requests = []
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
      const history = raw
      requests.push(history)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      // The follow-up's turn carries the held turn in its history too: the follow-up's own words decide it.
      if (history.includes(HOLD) && !history.includes(FOLLOW_UP)) {
        // A turn that streams: a token every 500 ms, so no first-token or idle limit ends it before Stop does.
        const token = () => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '.' }, finish_reason: null }] })}\n\n`)
        const beat = setInterval(token, 500)
        const entry = { beat }
        held.add(entry)
        token()
        response.on('close', () => {
          clearInterval(beat)
          held.delete(entry)
        })
        return
      }
      const text = history.includes('Create a concise title') ? 'A title' : 'done'
      for (const frame of [{ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]) response.write(`data: ${JSON.stringify(frame)}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => {
      for (const { beat } of held) clearInterval(beat)
      server.close()
      server.closeAllConnections()
    },
  }
}

test('S134: a teammate row stops the teammate’s running turn, and sends it a person’s follow-up as its next turn', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('team-control')
  const work = fixtureDir('team-control-work')
  mkdirSync(work, { recursive: true })
  const root = join(home, 'sessions')
  const provider = await double()
  const config = join(home, 'heddle.json')
  writeFileSync(config, `${JSON.stringify({ default: 'double', endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: provider.baseUrl, model: 'double-model', apiKey: 'a-test-key' }] }, null, 2)}\n`)
  const { SessionStore } = await import('../../src/session/store.ts')
  const { TEAM_EVENT_VERSION: version } = await import('../../src/team/state.ts')
  const store = new SessionStore(root)
  const lead = store.create({ cwd: work, title: 'the lead' })
  store.message(lead, { role: 'user', content: [{ type: 'text', text: 'lead the team' }] })
  store.append(lead, { type: 'assistant/completed', text: 'noted' })
  const member = store.create({ cwd: work, title: 'alpha', parentSession: lead.id, origin: 'subagent', delegationDepth: 1, teamId: lead.id })
  store.append(lead, { type: 'team/member', version, teamId: lead.id, member: { id: member.id, name: 'alpha', description: 'the teammate', context: 'fresh', phase: 'provisioning' } })
  store.append(lead, { type: 'team/member', version, teamId: lead.id, member: { id: member.id, name: 'alpha', description: 'the teammate', context: 'fresh', phase: 'active' } })
  for (const handle of [lead, member]) store.release(handle)

  const server = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'double', '--session-root', root],
    { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
  )
  let browser = null
  try {
    const cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: work }) })
    const running = async (id) => {
      const listed = (await api(server.url, cookie, '/api/sessions')).body
      return (Array.isArray(listed) ? listed : []).some((meta) => meta.id === id && meta.running === true)
    }
    const settle = async (probe, what, ms = 15_000) => {
      const end = Date.now() + ms
      while (!(await probe())) {
        if (Date.now() > end) assert.fail(what)
        await sleep(150)
      }
    }
    void fetch(new URL('/api/turn', server.url), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: `${HOLD}: work on the task`, folder: work, session: member.id }) })
      .then((response) => response.text())
      .catch(() => {})
    await settle(() => running(member.id), "the teammate's turn runs, held at its model request")

    browser = await openBrowser()
    // The printed URL's token sets the page's cookie; the team panel is then opened by its deep link to the lead.
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    await browser.goto(new URL(`/?session=${encodeURIComponent(lead.id)}`, server.url).href)
    await browser.waitFor('document.body.dataset.ready === "true"', 15_000)
    const row = `document.querySelector('#team-roster li.team-member[data-name="alpha"]')`
    try {
      await browser.waitFor(`${row} !== null && ${row}.dataset.status === 'running' && ${row}.querySelector('.team-stop')?.disabled === false`, 15_000)
    } catch {
      const team = (await api(server.url, cookie, `/api/team?session=${encodeURIComponent(lead.id)}`)).body
      assert.fail(`the teammate row shows it running, with Stop enabled\nroster: ${await browser.evaluate(`document.getElementById('team-panel')?.outerHTML?.slice(0, 900) ?? null`)}\nteam: ${JSON.stringify(team?.members ?? team).slice(0, 400)}\nlisted running: ${await running(member.id)}; double saw ${provider.requests.length} request(s): ${JSON.stringify(provider.requests.map((r) => r.includes(HOLD)))}\nmember log tail: ${(await import('../../_tools_/verify-runner/lib.mjs')).readTranscript(join(root, member.id)).slice(-4).map((event) => JSON.stringify(event).slice(0, 300)).join('\n')}`)
    }
    assert.equal(await browser.evaluate(`${row}.querySelector('.team-stop').getAttribute('aria-label')`), 'Stop alpha')

    // Stop: the teammate's turn ends, and the row says it is no longer running.
    await browser.evaluate(`${row}.querySelector('.team-stop').click()`)
    await settle(async () => !(await running(member.id)), "Stop ended the teammate's turn")
    await browser.waitFor(`${row}?.dataset.status !== 'running' && ${row}.querySelector('.team-stop').disabled === true`, 15_000)

    // Message: a follow-up typed on the row runs as the teammate's next turn, and the draft clears once accepted.
    await browser.evaluate(`${row}.querySelector('.team-open-message').click()`)
    await browser.waitFor(`${row}.querySelector('.team-message').hidden === false`, 5_000)
    await browser.evaluate(`(() => { const input = ${row}.querySelector('.team-message input'); input.value = ${JSON.stringify(FOLLOW_UP)}; ${row}.querySelector('.team-message').requestSubmit() })()`)
    await browser.waitFor(`${row}.querySelector('.team-message input').value === ''`, 15_000)
    await settle(() => provider.requests.some((request) => request.includes(FOLLOW_UP)), 'the follow-up reached the model as the teammate’s turn')
    const read = await api(server.url, cookie, `/api/sessions/${encodeURIComponent(member.id)}`)
    const transcript = JSON.stringify(read.body)
    assert.ok(transcript.includes(FOLLOW_UP), 'the follow-up is in the teammate’s own conversation')
    await settle(async () => !(await running(member.id)), "the follow-up turn ended")
    const lastRead = JSON.stringify((await api(server.url, cookie, `/api/sessions/${encodeURIComponent(member.id)}`)).body)
    assert.ok(lastRead.includes('done'), 'and the teammate answered it')
  } finally {
    await browser?.close()
    server.kill()
    provider.close()
    removeDir(home)
    removeDir(work)
  }
})
