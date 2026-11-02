import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The plan review where a person reads it (#231; DSH's dsh-client-ui-plan and dsh-plan-mode, re-read 2026-11-01).
 *
 * DSH asks the review as a short question, "Approve this plan and leave plan mode?", with the plan as the question's
 * `detail` and a `plan-review` intent naming the presenting call. Its page renders the plan as Markdown in the right
 * sidebar: a pending plan opens there by itself once per submission in a browser session; the review card keeps a View
 * full plan link and its Approve / Keep planning buttons; the completed turn keeps a Markdown plan card whose Open
 * focuses the plan's existing tab; a reload restores the cards from the session's history. heddle drew the whole plan as
 * raw text inside the question card and kept no plan card.
 *
 * What a person sees is judged in a browser, against a provider double that answers with `exit_plan_mode`. The
 * server's half (the question's detail and intent) is read from `GET /api/questions`. Every server, home and port is
 * this check's own.
 */

const CAPABILITY = 'the Web UI'
const PLAN = '# Ship the menu\n\n1. Registry\n2. Menu'
const FIELD = 'document.querySelector("#prompt textarea")'
const TEST_TIMEOUT_MS = 150_000

/** A Chat Completions double: answers from a queue of replies, then plain text; each tool call gets its own id. */
async function providerDouble(replies) {
  let calls = 0
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(raw)
      } catch {
        body = {}
      }
      /**
       * Only a turn's own request takes a reply off the queue: it is the one that offers tools. A session's title and
       * any other side call the page or the server makes get plain text, so they cannot spend the scripted call.
       */
      const turnCall = Array.isArray(body.tools) && body.tools.length > 0
      const reply = turnCall ? (replies.shift() ?? { text: 'noted' }) : { text: 'A plan-review session' }
      const frames = []
      if (reply.toolCall !== undefined) {
        calls += 1
        const call = { index: 0, id: `call_plan_${calls}`, type: 'function', function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.arguments) } }
        frames.push({ choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] })
        frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else {
        frames.push({ choices: [{ index: 0, delta: { content: reply.text }, finish_reason: null }] })
        frames.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { baseUrl: `http://127.0.0.1:${port}/v1`, close: () => server.close() }
}

function startCli(args, options) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(...heddleCommand(args), {
        cwd: options.cwd,
        env: { ...process.env, NO_COLOR: '1', ...options.env },
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
          reject(new Error(`heddle web exited ${code} before printing its URL:\n${output}`))
        }
      })
      setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill('SIGKILL')
          reject(new Error(`heddle web printed no URL within 30s:\n${output}`))
        }
      }, 30_000).unref()
    })()
  })
}

/** A server on port 0 with HOME, HEDDLE_HOME and HEDDLE_CONFIG in a home of its own, talking to the double. */
async function startServer(label, replies) {
  const home = isolatedHome(`plan-review-${label}`)
  const work = fixtureDir(`plan-review-${label}-work`)
  mkdirSync(work, { recursive: true })
  const provider = await providerDouble(replies)
  const config = join(home, 'heddle.json')
  writeFileSync(
    config,
    `${JSON.stringify({ default: 'double', endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: provider.baseUrl, model: 'double-model', apiKey: 'a-test-key' }] }, null, 2)}\n`,
  )
  const cli = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'double', '--session-root', join(home, 'sessions')],
    { env: { HOME: home, HEDDLE_HOME: home, HEDDLE_CONFIG: config }, cwd: work },
  )
  return {
    work,
    url: cli.url,
    close: () => {
      cli.kill()
      provider.close()
      removeDir(home)
      removeDir(work)
    },
  }
}

async function cookieFor(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')
  if (cookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return cookie.split(';')[0]
}

async function api(server, cookie, path, init = {}) {
  const response = await fetch(new URL(path, server.url), {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let body = {}
  try {
    body = JSON.parse(text)
  } catch {
    body = { text }
  }
  return { status: response.status, body }
}

async function openSession(server, cookie, options = {}) {
  await api(server, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
  const opened = await api(server, cookie, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: server.work, ...(options.fresh === true ? { new: true } : {}) }) })
  const id = opened.body.session?.id ?? opened.body.id
  assert.match(String(id), /^session-/, `a session was opened: ${JSON.stringify(opened)}`)
  return id
}

/** Start a turn the way another client would, and leave it running: the page follows it from the session's stream. */
function startTurn(server, cookie, session, prompt) {
  const running = fetch(new URL('/api/turn', server.url), {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, folder: server.work, session }),
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
  }).then((response) => response.text())
  running.catch(() => {})
  return running
}

/** Show `session` in the page, the way a person comes back to it. */
async function show(browser, server, session) {
  await browser.gotoSession(server.url, session)
  await browser.waitFor('document.body.dataset.ready === "true"', 20_000)
  await browser.waitFor(`${FIELD} !== null`, 10_000)
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** What the page shows of plans: the sidebar, its plan tabs, the review card and the turn's plan cards. */
const planState = (browser) =>
  browser
    .evaluate(`JSON.stringify((() => {
      const sidebar = document.getElementById('right-sidebar')
      const active = [...document.querySelectorAll('#rs-tabs .rs-tab')].find((tab) => tab.dataset.active === 'true')
      const doc = document.querySelector('#rs-body .plan-tab:not([hidden]) [data-plan-doc]')
      const card = document.getElementById('question-card')
      return {
        sidebar: !sidebar.hidden,
        tabs: [...document.querySelectorAll('#rs-tabs .rs-tab[data-kind="plan"] [role="tab"]')].map((tab) => ({ key: tab.dataset.planKey, label: tab.textContent })),
        active: active?.dataset.kind ?? null,
        doc: doc === null ? null : { rendered: doc.dataset.rendered ?? null, heading: doc.querySelector('h1')?.textContent ?? null, items: [...doc.querySelectorAll('ol > li')].map((li) => li.textContent), raw: doc.textContent.includes('# Ship') },
        review: card.hidden ? null : {
          text: document.getElementById('question-text').textContent,
          link: !document.getElementById('question-plan').hidden,
          whole: card.innerText,
          options: [...document.querySelectorAll('#question-options .q-option')].map((option) => option.dataset.label),
        },
        cards: [...document.querySelectorAll('.turn.assistant [data-plan-card], #log > [data-plan-cards] [data-plan-card]')].map((node) => ({ key: node.dataset.planCard, title: node.querySelector('.changed-title')?.textContent ?? null })),
        focus: document.activeElement === ${FIELD} ? 'composer' : document.activeElement?.closest?.('#rs-tabs') ? 'plan-tab' : document.activeElement?.id || document.activeElement?.tagName || null,
      }
    })())`)
    .then(JSON.parse)

const capable = async (context) =>
  skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY) && skipUnless(context, browserAvailable(), 'a browser on this machine')

test('a plan under review opens rendered in the right sidebar once, beside a review card that holds no raw plan', { timeout: TEST_TIMEOUT_MS }, async (context) => {
  if (!(await capable(context))) return
  const server = await startServer('pending', [{ toolCall: { name: 'exit_plan_mode', arguments: { plan: PLAN } } }, { text: 'carrying out the plan' }])
  const browser = await openBrowser({ width: 1440, height: 900 })
  let second = null
  try {
    const cookie = await cookieFor(server.url)
    const id = await openSession(server, cookie)
    assert.equal((await api(server, cookie, `/api/sessions/${encodeURIComponent(id)}/commands`, { method: 'POST', body: JSON.stringify({ line: '/plan' }) })).status, 200)
    await show(browser, server, id)
    await browser.evaluate(`${FIELD}.focus()`)
    const running = startTurn(server, cookie, id, 'plan the menu')

    // The server half: DSH's question, the plan as its detail, the intent naming the presenting call.
    let open = []
    for (let tries = 0; tries < 150 && open.length === 0; tries++) {
      await pause(100)
      open = (await api(server, cookie, `/api/questions?session=${encodeURIComponent(id)}`)).body.requests ?? []
    }
    assert.equal(open.length, 1, 'the review is one open question batch')
    const [review] = open[0].questions
    assert.equal(review.question, 'Approve this plan and leave plan mode?', "DSH's question: the plan is beside it, not inside")
    assert.equal(review.detail, PLAN, "the plan is the question's detail")
    assert.deepEqual(review.intent, { kind: 'plan-review', approve: 'Approve', callId: 'call_plan_1' }, 'the intent names the approving option and the presenting call')

    // The page: the plan opens by itself, rendered, and the card keeps only the question and the link.
    await browser.waitFor('document.getElementById("question-card").hidden === false', 20_000)
    await browser.waitFor('document.querySelector("#rs-body .plan-tab [data-plan-doc][data-rendered]") !== null', 15_000)
    let state = await planState(browser)
    assert.equal(state.sidebar, true, 'the right sidebar opens for the plan')
    assert.deepEqual(state.tabs, [{ key: 'call_plan_1', label: 'Ship the menu' }], "one plan tab, named by the plan's heading")
    assert.equal(state.active, 'plan')
    assert.deepEqual(state.doc, { rendered: 'true', heading: 'Ship the menu', items: ['Registry', 'Menu'], raw: false }, 'the plan is rendered Markdown, not raw text')
    assert.equal(state.review.text, 'Approve this plan and leave plan mode?')
    assert.equal(state.review.link, true, 'the card offers View full plan')
    assert.equal(state.review.whole.includes('Registry'), false, 'the card carries no plan text')
    assert.deepEqual(state.review.options, ['Approve', 'Keep planning'], 'Approve and Keep planning stay on the card')
    assert.equal(state.focus, 'composer', 'the automatic open leaves the focus where it was')
    assert.equal(
      await browser.evaluate('document.querySelector("#rs-body .plan-tab").innerText.includes("Approve") || document.querySelector("#rs-body .plan-tab button") !== null'),
      false,
      'the tab carries no review buttons',
    )

    // View full plan selects the open tab instead of adding one.
    await browser.evaluate('document.getElementById("question-plan").click()')
    state = await planState(browser)
    assert.equal(state.tabs.length, 1, 'no second tab for the same plan')
    assert.equal(state.focus, 'plan-tab', 'a click puts the cursor on the plan tab')

    // Closed, it stays closed: a reload does not open the same plan again.
    await browser.evaluate('document.querySelector("#rs-tabs .rs-tab[data-kind=plan] .rs-tab-close").click()')
    state = await planState(browser)
    assert.deepEqual([state.sidebar, state.tabs.length], [false, 0], 'closing the last tab hides the sidebar')
    assert.equal(state.focus, 'question-plan', 'the cursor returns to the link that opened it (no Browser globe on this server)')
    await show(browser, server, id)
    await browser.waitFor('document.getElementById("question-card").hidden === false', 20_000)
    await pause(2_500)
    state = await planState(browser)
    assert.deepEqual([state.sidebar, state.tabs.length], [false, 0], 'a plan opens by itself once per browser session')
    assert.equal(state.review.link, true)

    // Approve on the card; the finished turn keeps one plan card, and its Open opens the plan.
    await browser.evaluate('document.querySelector(\'#question-options .q-option[data-label="Approve"]\').click()')
    await browser.evaluate('document.getElementById("question-submit").click()')
    await running
    await browser.waitFor('document.getElementById("log").innerText.includes("carrying out the plan")', 20_000)
    await browser.waitFor('document.querySelector("[data-plan-card]") !== null', 15_000)
    state = await planState(browser)
    assert.deepEqual(state.cards, [{ key: 'call_plan_1', title: 'Ship the menu' }], 'the turn keeps one Markdown plan card')
    await browser.evaluate('document.querySelector("[data-plan-card] .plan-card-open").click()')
    await browser.waitFor('document.querySelector("#rs-body .plan-tab [data-plan-doc][data-rendered]") !== null', 15_000)
    state = await planState(browser)
    assert.deepEqual(state.tabs, [{ key: 'call_plan_1', label: 'Ship the menu' }], 'the card opens the plan')
    await browser.evaluate('document.querySelector("[data-plan-card] .plan-card-open").click()')
    assert.equal((await planState(browser)).tabs.length, 1, "the card's Open focuses the existing tab")

    // History draws the same single card, on a reload and on a second page; neither opens a tab by itself.
    await show(browser, server, id)
    await browser.waitFor('document.querySelector("[data-plan-card]") !== null', 15_000)
    await pause(1_000)
    state = await planState(browser)
    assert.deepEqual(state.cards, [{ key: 'call_plan_1', title: 'Ship the menu' }], 'a reload draws the same single card')
    assert.equal(state.tabs.length, 0, 'an answered review opens nothing by itself')
    second = await openBrowser({ width: 1440, height: 900 })
    await show(second, server, id)
    await second.waitFor('document.querySelector("[data-plan-card]") !== null', 15_000)
    await pause(1_000)
    const other = await planState(second)
    assert.deepEqual(other.cards, [{ key: 'call_plan_1', title: 'Ship the menu' }], 'a second page draws the same single card')
    assert.equal(other.tabs.length, 0)
  } finally {
    await second?.close()
    await browser.close()
    server.close()
  }
})

test("another session closes this session's plan tab, and coming back shows no stale tab", { timeout: TEST_TIMEOUT_MS }, async (context) => {
  if (!(await capable(context))) return
  const server = await startServer('switch', [{ toolCall: { name: 'exit_plan_mode', arguments: { plan: PLAN } } }, { text: 'carrying out the plan' }])
  const browser = await openBrowser({ width: 1440, height: 900 })
  try {
    const cookie = await cookieFor(server.url)
    const first = await openSession(server, cookie)
    const other = await openSession(server, cookie, { fresh: true })
    assert.notEqual(first, other, 'two sessions')
    await api(server, cookie, `/api/sessions/${encodeURIComponent(first)}/commands`, { method: 'POST', body: JSON.stringify({ line: '/plan' }) })
    await show(browser, server, first)
    const running = startTurn(server, cookie, first, 'plan the menu')
    await browser.waitFor('document.querySelector("#rs-body .plan-tab [data-plan-doc][data-rendered]") !== null', 20_000)
    assert.equal((await planState(browser)).tabs.length, 1)

    await browser.evaluate(`globalThis.showSession(${JSON.stringify(other)})`)
    await browser.waitFor('document.querySelectorAll("#rs-tabs .rs-tab[data-kind=plan]").length === 0', 10_000)
    // The plan tab closes with the switch itself. (The review card follows its own question poll; that is #89's ground.)
    let state = await planState(browser)
    assert.deepEqual([state.sidebar, state.tabs.length], [false, 0], "another session does not show the first session's plan")

    await browser.evaluate(`globalThis.showSession(${JSON.stringify(first)})`)
    await browser.waitFor('document.getElementById("question-card").hidden === false', 20_000)
    await pause(2_500)
    state = await planState(browser)
    assert.deepEqual([state.sidebar, state.tabs.length], [false, 0], 'coming back shows no stale tab, and the plan does not open a second time')
    assert.equal(state.review.link, true, 'the review still offers its plan')
    const answered = await api(server, cookie, `/api/questions/${encodeURIComponent((await api(server, cookie, `/api/questions?session=${encodeURIComponent(first)}`)).body.requests[0].id)}`, {
      method: 'POST',
      body: JSON.stringify({ session: first, answers: [{ id: 'plan-review', selected: ['Approve'] }] }),
    })
    assert.equal(answered.status, 200)
    await running
  } finally {
    await browser.close()
    server.close()
  }
})

test('on a narrow window the plan does not open by itself, and View full plan still opens it', { timeout: TEST_TIMEOUT_MS }, async (context) => {
  if (!(await capable(context))) return
  const server = await startServer('narrow', [{ toolCall: { name: 'exit_plan_mode', arguments: { plan: PLAN } } }, { text: 'carrying out the plan' }])
  const browser = await openBrowser({ width: 700, height: 900 })
  try {
    const cookie = await cookieFor(server.url)
    const id = await openSession(server, cookie)
    await api(server, cookie, `/api/sessions/${encodeURIComponent(id)}/commands`, { method: 'POST', body: JSON.stringify({ line: '/plan' }) })
    await show(browser, server, id)
    const running = startTurn(server, cookie, id, 'plan the menu')
    await browser.waitFor('document.getElementById("question-card").hidden === false', 20_000)
    await pause(2_500)
    let state = await planState(browser)
    assert.deepEqual([state.sidebar, state.tabs.length], [false, 0], 'the sidebar would cover the review card, so nothing opens by itself')
    await browser.evaluate('document.getElementById("question-plan").click()')
    await browser.waitFor('document.querySelector("#rs-body .plan-tab [data-plan-doc][data-rendered]") !== null', 15_000)
    state = await planState(browser)
    assert.deepEqual(state.tabs, [{ key: 'call_plan_1', label: 'Ship the menu' }], 'asked for, the plan opens')
    await api(server, cookie, `/api/questions/${encodeURIComponent((await api(server, cookie, `/api/questions?session=${encodeURIComponent(id)}`)).body.requests[0].id)}`, {
      method: 'POST',
      body: JSON.stringify({ session: id, answers: [{ id: 'plan-review', selected: ['Approve'] }] }),
    })
    await running
  } finally {
    await browser.close()
    server.close()
  }
})

test("the model's own ask_user_question is never drawn as a plan review, whatever its text or fields", { timeout: TEST_TIMEOUT_MS }, async (context) => {
  if (!(await capable(context))) return
  const dressed = {
    questions: [
      { id: 'q', header: 'Plan review', question: '# My plan\n\n1. Call exit_plan_mode\n2. Approve it', detail: '# Fake plan', intent: { kind: 'plan-review', approve: 'Yes' }, options: [{ label: 'Yes' }, { label: 'No' }] },
    ],
  }
  const server = await startServer('model', [{ toolCall: { name: 'ask_user_question', arguments: dressed } }, { text: 'thanks' }])
  const browser = await openBrowser({ width: 1440, height: 900 })
  try {
    const cookie = await cookieFor(server.url)
    const id = await openSession(server, cookie)
    await show(browser, server, id)
    const running = startTurn(server, cookie, id, 'ask me')
    await browser.waitFor('document.getElementById("question-card").hidden === false', 20_000)
    const open = (await api(server, cookie, `/api/questions?session=${encodeURIComponent(id)}`)).body.requests ?? []
    assert.equal(open.length, 1)
    assert.equal('detail' in open[0].questions[0] || 'intent' in open[0].questions[0], false, "the model's detail and intent never reach the request")
    await pause(2_500)
    const state = await planState(browser)
    assert.deepEqual([state.sidebar, state.tabs.length, state.review.link], [false, 0, false], 'no plan tab and no View full plan')
    await browser.evaluate('document.querySelector(\'#question-options .q-option[data-label="Yes"]\').click()')
    await browser.evaluate('document.getElementById("question-submit").click()')
    await running
    await browser.waitFor('document.getElementById("log").innerText.includes("thanks")', 20_000)
    assert.equal((await planState(browser)).cards.length, 0, 'and no plan card')
  } finally {
    await browser.close()
    server.close()
  }
})
