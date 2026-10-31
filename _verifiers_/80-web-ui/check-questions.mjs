import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The question card (`ask_user_question`), judged where a person meets it.
 *
 * DSH's contract, as the parity results record it (C76): the model asks a batch, a card beside the composer offers the
 * choices, free text, Skip and one batch submit; a timed wait counts down and Take time holds it; the question survives
 * a reload and a restart; Stop ends the wait; and the settled tool row reopens the card read-only with the answers. The
 * model's side is read from the transcript: the tool result is DSH's compact `{"answers":[...]}`, and a late answer is
 * the `answer_to_pending_question` user message.
 */

const CAPABILITY = 'a Web UI on localhost with a live stream'

const BATCH = {
  questions: [
    { id: 'color', header: 'Pick', question: 'Which colour?', options: [{ label: 'Blue (Recommended)', description: 'calm' }, { label: 'Red', description: 'loud' }] },
    { id: 'note', question: 'Anything else?' },
  ],
}
const ask = { toolCall: { name: 'ask_user_question', arguments: BATCH } }

/** The project's own plugin profile with the question service switched to timed mode and a short wait. */
function timedPatch(dir, seconds) {
  const source = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8')
  const patched = source.replace(/(- id: questions\n\s+name: [^\n]+\n\s+inject: [^\n]+\n\s+config:\n\s+mode: )legacy(\n\s+timeout: )\d+/, `$1timed$2${seconds}`)
  assert.notEqual(patched, source, 'the profile has a questions row to switch to timed mode')
  const path = join(dir, 'timed.patch.yml')
  writeFileSync(path, patched)
  return path
}

/** Start a scripted server; `home` may be given to restart over the same store. */
function startServer(label, steps, options = {}) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const home = options.home ?? isolatedHome(`questions-${label}`)
      const work = fixtureDir(`questions-${label}-work`)
      const { config } = scriptedConfig({ home, steps })
      const child = spawn(
        ...heddleCommand([
          'web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'),
          ...(options.patch !== undefined ? ['--patch', options.patch] : []),
          '--endpoint', 'scripted', '--session-root', join(home, 'sessions'),
        ]),
        { cwd: work, env: { ...process.env, NO_COLOR: '1', HOME: home, HEDDLE_HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({
            url: match[1],
            home,
            output: () => output,
            stop: () => new Promise((done) => { child.once('exit', () => done()); child.kill('SIGKILL') }),
            close: async () => {
              child.kill('SIGKILL')
              if (options.keepHome !== true) removeDir(home)
              removeDir(work)
            },
          })
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => {
        if (!settled) { settled = true; reject(new Error(`the server exited ${code} before printing a URL\n${output}`)) }
      })
      setTimeout(() => {
        if (!settled) { settled = true; child.kill('SIGKILL'); reject(new Error(`the server printed no URL within 15s\n${output}`)) }
      }, 15_000).unref()
    })()
  })
}

function request(server, path, options = {}) {
  const base = new URL(server.url)
  const target = new URL(path, base)
  target.searchParams.set('token', base.searchParams.get('token') ?? '')
  return fetch(target, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
}

async function sendMessage(browser, text) {
  await browser.evaluate(`(() => {
    const field = document.querySelector('#prompt textarea')
    field.value = ${JSON.stringify(text)}
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    return true
  })()`)
}

const cardState = (browser) =>
  browser.evaluate(`(() => {
    const card = document.getElementById('question-card')
    return JSON.stringify({
      hidden: card.hidden, state: card.dataset.state, readOnly: card.dataset.readOnly,
      title: document.getElementById('question-title').textContent,
      text: document.getElementById('question-text').textContent,
      position: document.getElementById('question-position').textContent,
      badge: document.getElementById('question-badge').hidden ? '' : document.getElementById('question-badge').textContent,
      options: [...document.querySelectorAll('#question-options .q-option')].map((b) => ({ label: b.dataset.label, pressed: b.getAttribute('aria-pressed'), disabled: b.disabled })),
      countdown: document.getElementById('question-countdown').hidden ? '' : document.getElementById('question-countdown').textContent,
      skipped: !document.getElementById('question-skipped').hidden,
      submit: !document.getElementById('question-submit').hidden,
    })
  })()`).then(JSON.parse)
const click = (browser, selector) => browser.evaluate(`(() => { document.querySelector(${JSON.stringify(selector)}).click(); return true })()`)
const typeAnswer = (browser, text) =>
  browser.evaluate(`(() => { const f = document.getElementById('question-custom'); f.value = ${JSON.stringify(text)}; f.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
const logText = (browser) => browser.evaluate('document.getElementById("log").innerText')

/** The session the page opened, and the stored record of its question's tool call. */
async function onlySession(server) {
  const body = await (await request(server, '/api/sessions')).json()
  const sessions = Array.isArray(body) ? body : body.sessions ?? []
  return sessions[0]?.id
}
async function toolResult(server, session) {
  const record = await (await request(server, `/api/sessions/${session}`)).json()
  const tool = (record.turns ?? []).find((turn) => (turn.kind ?? turn.type) === 'tool' && /ask_user_question/.test(JSON.stringify(turn)))
  return tool === undefined ? undefined : JSON.parse(tool.result ?? 'null')
}
async function userTexts(server, session) {
  const record = await (await request(server, `/api/sessions/${session}`)).json()
  return (record.turns ?? []).filter((turn) => (turn.kind ?? turn.type) === 'user').map((turn) => turn.text ?? '')
}

async function withPage(label, steps, options, body) {
  const server = await startServer(label, steps, options)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 20_000)
    await body(server, browser)
  } finally {
    await browser.close()
    await server.close()
  }
}

const capable = async (context) =>
  skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY) && skipUnless(context, browserAvailable(), 'a browser on this machine')

test('the model asks, the card beside the composer takes the answer, and the model receives one batch', async (context) => {
  if (!(await capable(context))) return
  await withPage('answer', [ask, { text: 'thanks for answering' }], {}, async (server, browser) => {
    await sendMessage(browser, 'ask me something')
    assert.ok(await browser.waitFor('document.getElementById("question-card").hidden === false', 20_000), 'the question card appears beside the composer')
    const first = await cardState(browser)
    assert.equal(first.title, 'Pick', 'the header names the question')
    assert.equal(first.text, 'Which colour?')
    assert.equal(first.position, '1 of 2', 'a pager walks the batch')
    assert.deepEqual(first.options.map((option) => option.label), ['Blue (Recommended)', 'Red'])
    assert.equal(first.options[0].pressed, 'true', 'a Recommended first choice starts selected')
    await click(browser, '#question-options .q-option[data-label="Red"]')
    const second = await cardState(browser)
    assert.equal(second.position, '2 of 2', 'a single choice advances to the next question')
    assert.equal(second.text, 'Anything else?')
    await typeAnswer(browser, 'nothing more')
    await click(browser, '#question-submit')
    assert.ok(await browser.waitFor('document.getElementById("question-card").hidden === true', 10_000), 'the card leaves once the batch is accepted')
    assert.ok(await browser.waitFor('document.getElementById("log").innerText.includes("thanks for answering")', 20_000), 'the turn continues')
    const session = await onlySession(server)
    assert.deepEqual(await toolResult(server, session), { answers: [{ id: 'color', selected: ['Red'] }, { id: 'note', selected: [], custom: 'nothing more' }] }, 'the model receives one compact batch')
  })
})

test('Skip sends an empty selection, and the settled tool row reopens the card read-only', async (context) => {
  if (!(await capable(context))) return
  await withPage('skip', [ask, { text: 'thanks for answering' }], {}, async (server, browser) => {
    await sendMessage(browser, 'ask me something')
    assert.ok(await browser.waitFor('document.getElementById("question-card").hidden === false', 20_000))
    await click(browser, '#question-skip')
    assert.equal((await cardState(browser)).position, '2 of 2', 'Skip moves on')
    await click(browser, '#question-submit')
    assert.ok(await browser.waitFor('document.getElementById("log").innerText.includes("thanks for answering")', 20_000))
    const session = await onlySession(server)
    assert.deepEqual(await toolResult(server, session), { answers: [{ id: 'color', selected: [] }, { id: 'note', selected: [] }] }, 'a skipped question is an empty selection with no custom')
    assert.ok(await browser.waitFor('document.querySelector(".turn.tool .question-open") !== null', 10_000), 'the question tool row offers to reopen it')
    await click(browser, '.turn.tool .question-open')
    assert.ok(await browser.waitFor('document.getElementById("question-card").hidden === false', 5_000), 'the tool row reopens the card')
    const settled = await cardState(browser)
    assert.equal(settled.readOnly, 'true', 'read-only')
    assert.equal(settled.badge, 'Answered')
    assert.equal(settled.skipped, true, 'a skipped question says so')
    assert.ok(settled.options.every((option) => option.disabled), 'every choice is disabled')
    assert.equal(settled.submit, false, 'and there is nothing to submit again')
    await click(browser, '#question-close')
    assert.equal((await cardState(browser)).hidden, true)
  })
})

test('a question and its draft survive a reload', async (context) => {
  if (!(await capable(context))) return
  await withPage('reload', [ask, { text: 'thanks for answering' }], {}, async (server, browser) => {
    await sendMessage(browser, 'ask me something')
    assert.ok(await browser.waitFor('document.getElementById("question-card").hidden === false', 20_000))
    await click(browser, '#question-options .q-option[data-label="Red"]')
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 20_000)
    assert.ok(await browser.waitFor('document.getElementById("question-card").hidden === false', 10_000), 'the question is still there after a reload')
    assert.equal((await cardState(browser)).position, '2 of 2', 'and the draft kept its place')
    await click(browser, '#question-prev')
    assert.equal((await cardState(browser)).options.find((option) => option.label === 'Red')?.pressed, 'true', 'and its choice')
    await click(browser, '#question-submit')
    assert.ok(await browser.waitFor('document.getElementById("log").innerText.includes("thanks for answering")', 20_000))
    assert.deepEqual((await toolResult(server, await onlySession(server)))?.answers?.[0], { id: 'color', selected: ['Red'] })
  })
})

test('a timed question counts down, and Take time holds it past its deadline', async (context) => {
  if (!(await capable(context))) return
  const dir = fixtureDir('questions-timed-patch')
  try {
    await withPage('timed', [ask, { text: 'thanks for answering' }], { patch: timedPatch(dir, 5) }, async (server, browser) => {
      await sendMessage(browser, 'ask me something')
      assert.ok(await browser.waitFor('document.getElementById("question-card").hidden === false', 20_000))
      assert.match((await cardState(browser)).countdown, /^Continues without an answer in 0:0[0-5]$/, 'a timed wait shows its countdown')
      await click(browser, '#question-take-time')
      assert.ok(await browser.waitFor('/Taking time/.test(document.getElementById("question-countdown").textContent)', 5_000), 'Take time holds the wait')
      /** Past the 5-second deadline (the wait used to be 2 s, which a click under load could miss). */
      await new Promise((resolve) => setTimeout(resolve, 6000))
      assert.equal((await cardState(browser)).state, 'waiting', 'still waiting after the deadline passed')
      await click(browser, '#question-submit')
      assert.ok(await browser.waitFor('document.getElementById("log").innerText.includes("thanks for answering")', 20_000))
      assert.deepEqual((await toolResult(server, await onlySession(server)))?.answers?.[0], { id: 'color', selected: ['Blue (Recommended)'] })
    })
  } finally {
    removeDir(dir)
  }
})

test('a timed question left unanswered lets the model go on, and the late answer reaches it as a message', async (context) => {
  if (!(await capable(context))) return
  const dir = fixtureDir('questions-late-patch')
  try {
    /**
     * The scripted endpoint numbers its steps by the round **within a turn**, so the turn the late answer starts begins
     * at the first step again: it asks a fresh question. That second question is the evidence that the answer was
     * delivered as a new turn the model answered.
     */
    await withPage('late', [ask, { text: 'went on without it' }], { patch: timedPatch(dir, 1) }, async (server, browser) => {
      await sendMessage(browser, 'ask me something')
      assert.ok(await browser.waitFor('document.getElementById("log").innerText.includes("went on without it")', 20_000), 'the model goes on at the deadline')
      assert.ok(await browser.waitFor('document.getElementById("question-card").dataset.state === "pending"', 10_000), 'the question stays answerable')
      const session = await onlySession(server)
      const pending = await toolResult(server, session)
      assert.equal(pending?.pending, true, 'the tool result says pending, not skipped')
      assert.equal((await cardState(browser)).badge, 'Answer later')
      await click(browser, '#question-options .q-option[data-label="Red"]')
      await click(browser, '#question-submit')
      assert.ok(await browser.waitFor('/Which colour\\?\\n→ Red/.test(document.getElementById("log").innerText)', 20_000), 'the late answer is sent as the next message')
      assert.ok(
        await browser.waitFor(`document.getElementById("question-card").dataset.state === "waiting" && document.getElementById("question-card").dataset.id !== ${JSON.stringify(pending.callId)}`, 20_000),
        'and the model answers that turn (the script asks again)',
      )
      const late = (await userTexts(server, session)).find((text) => text.startsWith('{"kind":"answer_to_pending_question"'))
      assert.ok(late !== undefined, 'the model reads DSH\'s answer_to_pending_question message')
      assert.equal(JSON.parse(late).callId, pending.callId, 'naming the call that asked')
      assert.match(await logText(browser), /Which colour\?\n→ Red/, 'and the page draws it as the question and the answer, not as JSON')
    })
  } finally {
    removeDir(dir)
  }
})

test('Stop ends a turn that is waiting on a question', async (context) => {
  if (!(await capable(context))) return
  await withPage('stop', [ask, { text: 'should not arrive' }], {}, async (server, browser) => {
    await sendMessage(browser, 'ask me something')
    assert.ok(await browser.waitFor('document.getElementById("question-card").hidden === false', 20_000))
    await click(browser, '#stop')
    assert.ok(await browser.waitFor('document.getElementById("question-card").hidden === true && document.getElementById("stop").hidden === true', 10_000), 'Stop ends the wait and the turn')
    const session = await onlySession(server)
    const all = await (await request(server, `/api/questions?session=${session}&all=1`)).json()
    assert.deepEqual(all.requests.map((entry) => entry.state), ['cancelled'], 'the question is cancelled, not left waiting')
  })
})

test('a question asked before a restart is answerable after it, and the answer resumes the session', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const home = isolatedHome('questions-restart')
  try {
    const first = await startServer('restart-a', [ask, { text: 'unused' }], { home, keepHome: true })
    let session
    try {
      void request(first, '/api/turn', { method: 'POST', body: JSON.stringify({ prompt: 'ask me something', new: true }) }).then((response) => response.text()).catch(() => {})
      for (let attempt = 0; attempt < 60 && session === undefined; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        const candidate = await onlySession(first)
        if (candidate === undefined) continue
        const open = await (await request(first, `/api/questions?session=${candidate}`)).json()
        if ((open.requests ?? []).length > 0) session = candidate
      }
      assert.ok(session !== undefined, 'the question is waiting before the restart')
    } finally {
      await first.stop()
      await first.close()
    }
    const second = await startServer('restart-b', [{ text: 'resumed' }], { home, keepHome: true })
    try {
      const open = await (await request(second, `/api/questions?session=${session}`)).json()
      assert.equal(open.requests?.[0]?.state, 'continued', 'the restarted server reads the question back from the session log')
      const answer = await request(second, `/api/questions/${open.requests[0].id}`, {
        method: 'POST',
        body: JSON.stringify({ session, answers: [{ id: 'color', selected: ['Red'] }, { id: 'note', selected: [] }] }),
      })
      const body = await answer.json()
      assert.equal(answer.status, 200)
      assert.equal(body.late, true, 'no turn waits for it any more')
      assert.match(body.message ?? '', /^\{"kind":"answer_to_pending_question","tool":"ask_user_question"/, 'so the answer becomes the user message that resumes the session')
    } finally {
      await second.close()
    }
  } finally {
    removeDir(home)
  }
})
