import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * DSH's `/goal`, judged through the page (parity rows A12 and A13; R-developer-nine-5, the durable command input).
 *
 * A12: a person types `/goal …` in the composer and sends it. DSH runs it on the host and shows two things: the
 * person's line as a right-aligned `Command input` bubble (dsh-client-ui-goal's GoalCommandInputView —
 * `div[data-command-input][role=group][aria-label="Command input"]`, text `/goal` + the recorded remainder with
 * trailing whitespace removed, no time, copy or branch actions), and the command's result as the generic command row,
 * here developer-three's `.hc-command` card (`.hc-title`, `.hc-state` "Completed" / "Command failed", `.hc-text`
 * holding dsh-command-goal's own words). A13: both are durable — a reload rebuilds every bubble and card from the
 * session's log, in order.
 *
 * Each step reads the goal service back (`GET /api/goal` from Node, with the cookie) as well as the page, because the
 * failure this exists for is a card that says "Goal paused" over a goal that is still active, or a bubble that only
 * lived in the page that typed it.
 *
 * The server runs the project profile without the round driver: an armed goal would otherwise start being driven the
 * moment the session is idle, and the cards would be judged against a goal the scripted model keeps moving. `--patch`
 * replaces the project's heddle.patch.yml, so heddle.patch.yml is named first and the removal second.
 *
 * Selectors: the bubble by DSH's own markup (`[role="group"][aria-label="Command input"]` inside `#log`); the card by
 * `#log .hc-command` (src/commands/menu.js, `rowFor`). The composer is `#prompt textarea`, as check-slash-commands
 * reads it.
 */

const CAPABILITY = 'the Web UI'

const OBJECTIVE = 'ship the release'
const ALREADY_PAUSED = 'A goal is already paused. Use /goal edit <objective> to change it or /goal clear before replacing it.'
const HINT_STOPPED = 'Commands: /goal edit <objective>, /goal resume, /goal clear'
const HINT_ARMED = 'Commands: /goal edit <objective>, /goal pause, /goal clear'

async function startServer(label) {
  const home = isolatedHome(`goal-command-${label}`)
  const work = fixtureDir(`goal-command-${label}-work`)
  mkdirSync(work, { recursive: true })
  /** Any turn that did run would answer this, which is how a line that reached the model would show. */
  const { config } = scriptedConfig({ home, steps: [{ text: 'the model answered' }] })
  const noDriver = join(home, 'no-goal-driver.yml')
  writeFileSync(noDriver, '- remove:\n    - goal-driver\n')
  const child = await startCli(
    [
      'web',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--config',
      join(repoRoot, 'cordis.yml'),
      '--patch',
      join(repoRoot, 'heddle.patch.yml'),
      '--patch',
      noDriver,
      '--endpoint',
      'scripted',
      '--session-root',
      join(home, 'sessions'),
    ],
    { env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config }, cwd: work },
  )
  return {
    work,
    url: child.url,
    close: () => {
      child.kill()
      removeDir(home)
      removeDir(work)
    },
  }
}

function startCli(args, options) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(...heddleCommand(args), {
        cwd: options.cwd ?? repoRoot,
        env: { ...process.env, NO_COLOR: '1', ...(options.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ child, url: match[1], kill: () => child.kill('SIGKILL') })
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => {
        if (!settled) reject(new Error(`heddle web exited ${code} before printing its URL:\n${output}`))
      })
      setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL')
          reject(new Error(`heddle web printed no URL within 30s:\n${output}`))
        }
      }, 30_000)
    })()
  })
}

async function cookieFor(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')
  if (cookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return cookie.split(';')[0]
}

async function api(url, cookie, path, init = {}) {
  const response = await fetch(new URL(path, url), {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
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

/** A session in the server's own workspace, as the page opens one. */
async function openSession(server, cookie) {
  await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
  const opened = await api(server.url, cookie, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: server.work }) })
  const id = opened.body.session?.id ?? opened.body.id
  assert.match(String(id), /^session-/, `a session was opened: ${JSON.stringify(opened)}`)
  return id
}

/** The goal as the goal service holds it, read from Node rather than from the page. */
async function goalOf(server, cookie, id) {
  const answer = await api(server.url, cookie, `/api/goal?session=${encodeURIComponent(id)}`)
  assert.equal(answer.status, 200, `GET /api/goal answers: ${JSON.stringify(answer.body).slice(0, 200)}`)
  return answer.body.goal
}

/** The session's log as the Download log route serves it. */
async function sessionEvents(server, cookie, id) {
  const response = await fetch(new URL(`/api/sessions/${encodeURIComponent(id)}/log`, server.url), { headers: { cookie } })
  assert.equal(response.status, 200, 'the session log downloads')
  return (await response.text())
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

const KEY_CODES = { Enter: 13 }

/** A real key press through the browser's input pipeline, so the page's own listeners decide what it does. */
async function press(browser, key) {
  const code = KEY_CODES[key]
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, ...(key === 'Enter' ? { text: '\r' } : {}) })
  await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code })
}

const FIELD = 'document.querySelector("#prompt textarea")'
const MENU_OPEN = 'document.getElementById("slash-menu") !== null && document.getElementById("slash-menu").hidden === false'
/** DSH's bubble, by its own markup. */
const BUBBLES = '[...document.querySelectorAll(\'#log [role="group"][aria-label="Command input"]\')]'
/** developer-three's command card. */
const CARDS = '[...document.querySelectorAll("#log .hc-command")]'
const SETTLED = `${CARDS}.filter((card) => card.dataset.state === "done" || card.dataset.state === "error")`

async function typeInto(browser, text) {
  await browser.evaluate(`(() => { const field = ${FIELD}; field.focus(); field.value = ''; field.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await browser.send('Input.insertText', { text })
}

/**
 * Type a line in the composer and send it, as a person does, and wait for its card to settle.
 *
 * A bare `/goal` is a slash token at the caret, so the menu is open: the first Enter picks Goal from it (leaving
 * `/goal ` and DSH's hint), the second sends — what a person's two presses do. A line with an argument closes the
 * menu, so one Enter sends it.
 */
async function send(browser, line) {
  const before = await browser.evaluate(`${SETTLED}.length`)
  await typeInto(browser, line)
  if (!/\s/.test(line)) {
    await browser.waitFor(MENU_OPEN, 10_000)
    await press(browser, 'Enter')
    assert.equal(await browser.evaluate(`${FIELD}.value`), `${line} `, `picking ${line} from the menu leaves it and a space`)
  }
  await press(browser, 'Enter')
  await browser.waitFor(`${SETTLED}.length > ${before}`, 15_000)
  assert.equal(await browser.evaluate(`${FIELD}.value`), '', `the draft is cleared once ${line} is sent`)
}

/** Every bubble and card in the transcript, in order, and whether each bubble sits before its card. */
async function transcript(browser) {
  return JSON.parse(
    await browser.evaluate(`JSON.stringify((() => {
      const bubbles = ${BUBBLES}
      const cards = ${CARDS}
      const follows = (first, second) => first !== undefined && second !== undefined && (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      return {
        bubbles: bubbles.map((bubble) => ({
          text: bubble.textContent,
          marked: bubble.hasAttribute('data-command-input'),
          actions: bubble.querySelectorAll('button, a, time, [role="button"]').length,
        })),
        cards: cards.map((card) => ({
          state: card.dataset.state ?? null,
          title: card.querySelector('.hc-title')?.textContent ?? null,
          status: card.querySelector('.hc-state')?.textContent ?? null,
          text: card.querySelector('.hc-text')?.textContent ?? null,
        })),
        // Bubble i comes before card i, and after card i - 1: each line sits just above its own result.
        paired: bubbles.length === cards.length && bubbles.every((bubble, index) => follows(bubble, cards[index]) && (index === 0 || follows(cards[index - 1], bubble))),
      }
    })())`),
  )
}

/** What the transcript holds after the four runs before the reload, live or rebuilt. */
function assertFourRuns(seen, when) {
  assert.deepEqual(
    seen.bubbles.map((bubble) => bubble.text),
    [`/goal ${OBJECTIVE}`, '/goal pause', '/goal', '/goal frobnicate'],
    `${when}: one Command input bubble per /goal, in order`,
  )
  assert.ok(seen.paired, `${when}: each bubble sits just before its own card (${JSON.stringify(seen)})`)
  assert.ok(seen.bubbles.every((bubble) => bubble.marked), `${when}: each bubble carries DSH's data-command-input`)
  assert.ok(seen.bubbles.every((bubble) => bubble.actions === 0), `${when}: no time, copy or branch actions on a command input`)
  const [created, paused, shown, refused] = seen.cards
  assert.deepEqual([created.title, created.status], ['/goal', 'Completed'], `${when}: the create's card`)
  assert.ok(created.text.startsWith(`Goal created\nStatus: active\nObjective: ${OBJECTIVE}\n`), `${when}: ${created.text}`)
  assert.ok(created.text.endsWith(HINT_ARMED), `${when}: ${created.text}`)
  assert.equal(paused.status, 'Completed', `${when}: the pause's card`)
  assert.ok(paused.text.startsWith(`Goal paused\nStatus: paused\nObjective: ${OBJECTIVE}\n`), `${when}: ${paused.text}`)
  assert.equal(shown.status, 'Completed', `${when}: the show's card`)
  assert.equal(shown.text.split('\n')[0], 'Goal', `${when}: /goal shows a card titled Goal: ${shown.text}`)
  assert.ok(shown.text.includes('\nStatus: paused\n'), `${when}: ${shown.text}`)
  assert.ok(shown.text.endsWith(HINT_STOPPED), `${when}: ${shown.text}`)
  assert.deepEqual([refused.state, refused.status, refused.text], ['error', 'Command failed', ALREADY_PAUSED], `${when}: the refused create's card`)
}

test("a /goal typed in the composer shows DSH's Command input bubble and result card, and both survive a reload", async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('page')
  const browser = await openBrowser()
  try {
    const cookie = await cookieFor(server.url)
    const id = await openSession(server, cookie)
    const showSession = async () => {
      await browser.waitFor('typeof globalThis.showSession === "function"', 20_000)
      await browser.evaluate(`globalThis.showSession(${JSON.stringify(id)})`)
      await browser.waitFor(`${FIELD} !== null`, 10_000)
    }
    await browser.goto(server.url)
    await showSession()

    // A12: the create. The person's line is a bubble, the result is DSH's goal card, and the goal service holds it.
    await send(browser, `/goal ${OBJECTIVE}`)
    let seen = await transcript(browser)
    assert.deepEqual(seen.bubbles.map((bubble) => bubble.text), [`/goal ${OBJECTIVE}`], 'the create shows its Command input bubble')
    assert.ok(seen.paired, `the bubble sits just before the card: ${JSON.stringify(seen)}`)
    assert.ok(seen.cards[0].text.startsWith('Goal created\nStatus: active\n'), seen.cards[0].text)
    let goal = await goalOf(server, cookie, id)
    assert.equal(goal?.objective, OBJECTIVE, 'GET /api/goal holds the goal the command created')
    assert.equal(goal?.phase, 'active')

    // Pause: the card says so and so does the service.
    await send(browser, '/goal pause')
    seen = await transcript(browser)
    assert.ok(seen.cards[1].text.startsWith('Goal paused\n'), seen.cards[1].text)
    goal = await goalOf(server, cookie, id)
    assert.equal(goal?.phase, 'paused', 'GET /api/goal reads the pause')

    // A bare /goal shows the goal under the title Goal, with the commands that mean something now.
    await send(browser, '/goal')
    seen = await transcript(browser)
    assert.equal(seen.cards[2].text.split('\n')[0], 'Goal', seen.cards[2].text)
    assert.ok(seen.cards[2].text.endsWith(HINT_STOPPED), seen.cards[2].text)

    // Anything else is an objective, and a goal already exists: DSH's refusal, as an error card.
    await send(browser, '/goal frobnicate')
    seen = await transcript(browser)
    assertFourRuns(seen, 'live')
    goal = await goalOf(server, cookie, id)
    assert.deepEqual([goal?.objective, goal?.phase], [OBJECTIVE, 'paused'], 'the refused create changed nothing')

    // None of the lines reached the model as a message.
    const events = await sessionEvents(server, cookie, id)
    for (const line of [`/goal ${OBJECTIVE}`, '/goal pause', '/goal frobnicate']) {
      assert.equal(
        events.some((event) => event.type === 'message' && JSON.stringify(event).includes(line)),
        false,
        `${line} never became a message`,
      )
    }

    // A13: a reload rebuilds every bubble and card from the session's log, in place.
    await browser.goto(server.url)
    await showSession()
    await browser.waitFor(`${BUBBLES}.length === 4 && ${SETTLED}.length === 4`, 15_000)
    assertFourRuns(await transcript(browser), 'after a reload')

    // Clear, from the reloaded page.
    await send(browser, '/goal clear')
    seen = await transcript(browser)
    assert.equal(seen.bubbles.at(-1)?.text, '/goal clear')
    assert.deepEqual([seen.cards.at(-1)?.status, seen.cards.at(-1)?.text], ['Completed', 'Goal cleared.'])
    assert.ok(seen.paired, `the clear's bubble sits just before its card: ${JSON.stringify(seen)}`)
    assert.equal(await goalOf(server, cookie, id), null, 'GET /api/goal answers no goal once it is cleared')
  } finally {
    await browser.close()
    server.close()
  }
})
