import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/check-helpers/browser.mjs'
import { chatDouble, fixtureDir, isolatedHome, removeDir, skipUnless, writeJson } from '../../_tools_/check-helpers/lib.mjs'

/**
 * The composer's submission gestures and the queue buffer, judged in a browser.
 *
 * The claim is the one the owner asked for: **Enter sends, and while a turn is running it queues; Ctrl+Enter
 * sends the queued message** — with the queue visible as a buffer above the composer and the primary action
 * drawn as DSH's arrow rather than a `Run` button. Every rule follows DSH's own input bar
 * (`resolveSubmitMode`, `busyEnter` defaulting to `queue`, `QueueDock`, `steerQueue`), and each assertion here
 * is one of those rules rather than a rendering detail:
 *
 * - a submit with nothing running starts its turn immediately — the queue is not a two-step send;
 * - a submit while a turn runs lands in the buffer, drawn as DSH draws it: a count header when several are
 *   waiting, folded closed;
 * - the accelerated chord (Ctrl+Enter) puts its message **ahead of** one queued earlier, which is heddle's
 *   honest form of DSH's `steer`: a session's log takes one writer, so "send this next" is the most a steer
 *   can mean here;
 * - the same chord with an empty draft sends everything still waiting, in FIFO order;
 * - the arrow button submits exactly what Enter would.
 */

const CAPABILITY = 'a Web UI on localhost with a live stream'

/**
 * Wait for a node-side fact — what a double received — to become true.
 *
 * A page-side condition is waited for with `browser.waitFor`, but the double's request count is on this side
 * of the socket and lands a moment **after** the page has marked the message as sent. Asserting it
 * immediately is a race, and one this check lost: measured, the composer drew the queue and the request had
 * not arrived yet.
 */
async function until(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  return predicate()
}

/** A run whose server prints its URL, with a double that holds its terminator open so a turn is observably running. */
async function startServer(label, options = {}) {
  const home = isolatedHome(`composer-${label}`)
  const work = fixtureDir(`composer-${label}-work`)
  const double = await chatDouble({
    content: options.content ?? 'the answer',
    reasoning: 'thinking',
    holdOpenMs: options.holdOpenMs ?? 1200,
    ...(options.usage !== undefined ? { usage: options.usage } : {}),
  })
  const config = writeJson(join(home, 'heddle.json'), {
    default: 'held',
    endpoints: [
      {
        name: 'held',
        kind: 'openai-chat',
        baseUrl: double.baseUrl,
        model: 'held-model',
        stream: true,
        ...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {}),
      },
    ],
  })
  const child = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'held', '--session-root', join(home, 'sessions')],
    /**
     * `HEDDLE_HOME` keeps the workspace store inside the fixture too: the attach test registers a folder, and
     * without it that registration would land in the operator's real `~/.heddle/workspaces.json` — which it
     * did, once, before this line existed.
     */
    { env: { HEDDLE_CONFIG: config, HEDDLE_HOME: home } },
  )
  return {
    double,
    /** The fixture folder, for a test that needs a real file for the attach menu to offer. */
    work,
    url: child.url,
    close: async () => {
      child.kill()
      await double.close()
      removeDir(home)
      removeDir(work)
    },
  }
}

/** Spawn the CLI and resolve once it prints its URL, or reject on exit. */
function startCli(args, options) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { repoRoot } = await import('../../_tools_/check-helpers/lib.mjs')
      const child = spawn(process.execPath, [join(repoRoot, 'dist', 'cli.js'), ...args], {
        cwd: repoRoot,
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
          resolvePromise({ child, url: match[1], output: () => output, kill: () => child.kill('SIGKILL') })
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
      }, 15_000)
    })()
  })
}

/**
 * Type a draft and press a key, the way a person does.
 *
 * The value is written and a **keydown** is dispatched rather than the form being submitted directly: the
 * gesture is the claim, and `requestSubmit()` would judge the handler while skipping the keymap that decides
 * which gesture it is.
 */
const type = (browser, text) =>
  browser.evaluate(`(() => {
    const field = document.querySelector('textarea')
    field.value = ${JSON.stringify(text)}
    // A person's typing fires an input event, and the composer's own rules depend on it: the editor grows
    // with the draft and the send button's disabled state follows it. Writing the value alone is a state the
    // page can never observe, so the helper does what a keyboard does.
    field.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
const press = (browser, init) =>
  browser.evaluate(`(() => {
    const field = document.querySelector('textarea')
    field.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify(init)}))
    return true
  })()`)

test('the composer queues with Enter while a turn runs, and Ctrl+Enter sends what is queued', async (context) => {
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * A longer hold than the others: this test measures the dock's placement while a turn runs, and a turn that
   * ended before the measurement would hide the dock — which is the race that made the flush assertion flaky
   * under load, not a placement bug.
   */
  const server = await startServer('queue', { holdOpenMs: 2500 })
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.goto(server.url)
    assert.ok(await browser.waitFor('document.getElementById("model-trigger") !== null', 20_000), 'the panel is up')

    /**
     * Nothing running: Enter sends. The claim is DSH's `resolveSubmitMode` answer for an idle agent —
     * `queue`, which its host drains at once — so what a person sees is an ordinary send.
     */
    await type(browser, 'first')
    await press(browser, { key: 'Enter' })
    assert.ok(await browser.waitFor('document.getElementById("log").innerText.includes("first")', 10_000), 'the message was sent')
    assert.equal(server.double.requests.length, 1, 'and the endpoint was asked once, without a second gesture')

    /**
     * A turn is running, so plain Enter queues and the dock appears. The header counts what is waiting and
     * starts **closed**, which is DSH's `QueueDock`: a count for more than one row, one row drawn directly.
     *
     * The row **being delivered counts too** — it stays in the dock with a `Sending…` status until its turn
     * ends, which is what DSH does with a local submission whose host row has not arrived yet, and it is why
     * the two presses below read as three.
     */
    assert.ok(await browser.waitFor('document.getElementById("queue").hidden === false', 10_000), 'the queue is shown while the turn runs')
    await type(browser, 'second')
    await press(browser, { key: 'Enter' })
    await type(browser, 'third')
    await press(browser, { key: 'Enter' })
    const dock = JSON.parse(
      await browser.evaluate(`JSON.stringify({
        header: (document.querySelector('#queue .header') || {}).textContent || '',
        status: (document.querySelector('#queue .status') || {}).textContent || '',
        listHidden: (document.querySelector('#queue .list') || {}).hidden,
        label: document.getElementById('send').getAttribute('aria-label')
      })`),
    )
    assert.match(dock.header, /3 queued messages/, `the header says how many are in the dock (${dock.header})`)
    assert.equal(dock.listHidden, true, 'and the rows are folded away until asked for')
    assert.equal(dock.label, 'Queue message', 'the arrow says what pressing it will do while a turn runs')
    /**
     * The dock is **attached** to the composer: what is waiting belongs to the thing it waits for, so the
     * panel's bottom edge meets the card's top edge rather than floating above it.
     */
    const edges = JSON.parse(
      await browser.evaluate(`(() => {
        const queue = document.getElementById('queue')
        const panel = document.querySelector('#queue .panel')
        const card = document.getElementById('composer-card')
        if (queue.hidden || panel === null) return JSON.stringify({ visible: false })
        return JSON.stringify({
          visible: true,
          panel: Math.round(panel.getBoundingClientRect().bottom),
          card: Math.round(card.getBoundingClientRect().top),
        })
      })()`),
    )
    assert.equal(edges.visible, true, 'the dock is still on screen while it is measured')
    assert.ok(Math.abs(edges.panel - edges.card) <= 1, `the dock is flush against the card (${edges.panel} vs ${edges.card})`)

    /** The header is the disclosure, so opening it shows the rows — one per message in the dock. */
    await browser.evaluate('document.querySelector("#queue .header").click()')
    assert.equal(await browser.evaluate('document.querySelectorAll("#queue .row").length'), 3, 'opening the header shows every row')
    assert.equal(
      await browser.evaluate('(document.querySelector("#queue .status") || {}).textContent || ""'),
      'Sending…',
      'and the one being delivered says so',
    )

    /**
     * The accelerated chord goes **next**, not last: DSH resolves Ctrl/Cmd+Enter to the opposite delivery
     * mode, and heddle's opposite of "wait" is "go to the front of the wait". The order in the transcript is
     * the evidence, and it is why this check reads the log rather than counting requests.
     */
    await type(browser, 'urgent')
    await press(browser, { key: 'Enter', ctrlKey: true })
    assert.ok(await browser.waitFor('document.getElementById("queue").hidden === true', 30_000), 'the queue drains on its own')
    const log = await browser.evaluate('document.getElementById("log").innerText')
    const order = ['first', 'urgent', 'second', 'third'].map((text) => log.indexOf(text))
    assert.ok(order.every((at) => at !== -1), `every message was sent (${log})`)
    assert.deepEqual(
      [...order].sort((left, right) => left - right),
      order,
      `the accelerated message went ahead of the ones queued before it (${JSON.stringify(order)})`,
    )
    assert.equal(server.double.requests.length, 4, 'each message was one turn')

    /** The arrow button is the same gesture as Enter, which is DSH's rule for its primary action. */
    await type(browser, 'by button')
    await browser.evaluate('document.getElementById("send").click()')
    assert.ok(await browser.waitFor('document.getElementById("log").innerText.includes("by button")', 15_000), 'the arrow sends the draft')
    assert.equal(server.double.requests.length, 5, 'and that was one more turn')
  } finally {
    browser.close()
    await server.close()
  }
})

test('Ctrl+Enter on an empty draft sends everything still queued, in order', async (context) => {
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('chord', { holdOpenMs: 1500 })
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("model-trigger") !== null', 20_000)

    await type(browser, 'running')
    await press(browser, { key: 'Enter' })
    assert.ok(await browser.waitFor('document.getElementById("queue").hidden === false', 10_000), 'the first turn is running')
    for (const text of ['queued one', 'queued two', 'queued three']) {
      await type(browser, text)
      await press(browser, { key: 'Enter' })
    }
    const waiting = await browser.evaluate('document.querySelector("#queue .header").textContent')
    assert.match(waiting, /4 queued messages/, `three wait behind the one being delivered (${waiting})`)

    /** The empty draft is the point: the chord means "send the queue", not "send this draft". */
    await type(browser, '')
    await press(browser, { key: 'Enter', ctrlKey: true })
    assert.ok(await browser.waitFor('document.getElementById("queue").hidden === true', 40_000), 'the whole queue was delivered')
    const log = await browser.evaluate('document.getElementById("log").innerText')
    const order = ['running', 'queued one', 'queued two', 'queued three'].map((text) => log.indexOf(text))
    assert.ok(order.every((at) => at !== -1), `every queued message was sent (${log})`)
    assert.deepEqual([...order].sort((left, right) => left - right), order, 'in FIFO order')
    /**
     * Every message reached the model, which is the claim — not a request count.
     *
     * A message sent while the turn is still running is **steered into it**, so several share one model call;
     * the count therefore depends on whether the first turn was still open when the chord fired, which is a
     * race this check was previously measuring by accident. What must hold either way is that each queued
     * message was actually asked.
     */
    const asked = server.double.requests.map((entry) => entry.body).join('\n')
    for (const text of ['queued one', 'queued two', 'queued three']) {
      assert.ok(asked.includes(text), `the model was asked '${text}'`)
    }
  } finally {
    browser.close()
    await server.close()
  }
})

test('a steered message is answered by the running turn, and a steer with nothing running is refused', async (context) => {
  /**
   * The half of steering the composer cannot do alone, and the reason it is not just a queue reorder.
   *
   * DSH's agent runtime injects a steered message between steps; heddle appends it to the session and the
   * **loop** has to take another round, because an answer with no tool calls used to end the turn and leave the
   * message sitting in the transcript unanswered. The route's refusal is DSH's too: `session/steer-unavailable`
   * when the turn it would be delivered into has ended.
   */
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('steer', { holdOpenMs: 1500 })
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("model-trigger") !== null', 20_000)

    const refused = await browser.evaluate(`fetch('/api/sessions/session-00000000-0000-0000-0000-000000000000/steer', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'nobody is running' })
    }).then((response) => response.status)`)
    assert.equal(refused, 409, 'a steer with no running turn is refused, as DSH refuses it')

    await type(browser, 'the first question')
    await press(browser, { key: 'Enter' })
    assert.ok(await browser.waitFor('document.getElementById("queue").hidden === false', 10_000), 'the turn is running')
    assert.ok(await until(() => server.double.requests.length === 1), 'one model call is in flight')

    await type(browser, 'answer this too')
    await press(browser, { key: 'Enter', ctrlKey: true })
    assert.ok(
      await browser.waitFor('document.getElementById("log").innerText.includes("answer this too")', 15_000),
      'the steered message reached the transcript',
    )
    assert.ok(await browser.waitFor('document.getElementById("queue").hidden === true', 40_000), 'the turn ends')
    assert.ok(await until(() => server.double.requests.length === 2), 'and the running turn asked the model again for it')
    const log = await browser.evaluate('document.getElementById("log").innerText')
    assert.ok(log.includes('the answer'), 'the steered message was answered inside that turn')
  } finally {
    browser.close()
    await server.close()
  }
})

/**
 * The composer's **shape**, judged in the browser against the values measured from DSH's own page.
 *
 * This is the part a person sees before touching anything, and it is measurable rather than a matter of
 * taste: DSH's card is 712px wide inside the conversation column, `border-radius: 28px`, surface `#2c2c2e`,
 * with a 0.5px light ring instead of a border, and every control **inside** the card. The old composer was a
 * full-width band with the editor in a card and the controls on the page background below it.
 */
test('the composer is one card, and every control lives inside it', async (context) => {
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('card')
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("composer-card") !== null', 20_000)
    const card = JSON.parse(
      await browser.evaluate(`(() => {
        const node = document.getElementById('composer-card')
        const style = getComputedStyle(node)
        const box = node.getBoundingClientRect()
        const inside = ['#prompt textarea', '#attach', '#access', '#model-seat', '#send'].map((selector) => node.contains(document.querySelector(selector)))
        const host = document.getElementById('composer').getBoundingClientRect()
        return JSON.stringify({
          radius: style.borderRadius,
          background: style.backgroundColor,
          ring: style.boxShadow.includes('0.5px'),
          width: Math.round(box.width),
          gutterLeft: Math.round(box.left - host.left),
          gutterRight: Math.round(host.right - box.right),
          inside,
          editor: (() => { const s = getComputedStyle(document.querySelector('#prompt textarea')); return { font: s.fontSize, line: s.lineHeight } })(),
          status: document.getElementById('composer-status') !== null,
        })
      })()`),
    )
    assert.equal(card.radius, '28px', 'the card is DSH\u2019s rounded card')
    assert.equal(card.background, 'rgb(44, 44, 46)', 'on DSH\u2019s card surface')
    assert.equal(card.ring, true, 'with a hairline ring rather than a border')
    /**
     * The card's width is the **column's**, not a constant: DSH's card is the text column plus 32px, and the
     * column is resizable, so a fixed cap is exactly what this composer stopped being.
     */
    assert.ok(card.gutterLeft > 0 && card.gutterLeft === card.gutterRight, `the card is centred in the conversation column (${card.gutterLeft} / ${card.gutterRight})`)
    assert.deepEqual(card.inside, [true, true, true, true, true], 'the editor, +, access mode, model seat and send are all inside the card')
    /** The owner asked for agentcloud's composer leading: 14px on a 21px line, not DSH's 24. */
    assert.deepEqual(card.editor, { font: '14px', line: '21px' }, 'the editor is agentcloud 14/21 type')
    assert.equal(card.status, true, 'and the status line exists under the card')
  } finally {
    browser.close()
    await server.close()
  }
})

/** The editor grows with the draft and stops at 336px, then scrolls — DSH's own cap. */
test('the editor grows with the draft and stops at its cap', async (context) => {
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('grow')
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.querySelector("#prompt textarea") !== null', 20_000)
    const heightOf = () => browser.evaluate('Math.round(document.querySelector("#prompt textarea").getBoundingClientRect().height)')
    const setLines = (count) =>
      browser.evaluate(`(() => {
        const field = document.querySelector('#prompt textarea')
        field.value = Array.from({ length: ${count} }, (_, index) => 'line ' + (index + 1)).join('\\n')
        field.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
    const empty = await heightOf()
    assert.ok(empty >= 36 && empty <= 60, `one line is the resting height (${empty})`)
    await setLines(4)
    const four = await heightOf()
    assert.ok(four > empty, `four lines are taller than one (${four} > ${empty})`)
    await setLines(40)
    const capped = await heightOf()
    assert.equal(capped, 336, 'forty lines stop at DSH\u2019s 336px cap')
    await setLines(0)
    assert.ok((await heightOf()) <= empty + 1, 'and clearing the draft returns the resting height')
  } finally {
    browser.close()
    await server.close()
  }
})

/**
 * One action at a time: Stop takes Send's place while a turn runs, and pressing it ends the turn without
 * drawing a failure. DSH draws the same pair.
 */
test('a running turn offers Stop, and Stop ends it', async (context) => {
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('stop', { holdOpenMs: 60_000 })
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("composer-card") !== null', 20_000)
    assert.equal(await browser.evaluate('document.getElementById("stop").hidden'), true, 'idle: Stop is not offered')
    assert.equal(await browser.evaluate('document.getElementById("send").hidden'), false, 'idle: Send is')

    await type(browser, 'a question that will not finish on its own')
    await press(browser, { key: 'Enter' })
    assert.ok(
      await browser.waitFor('document.getElementById("stop").hidden === false', 15_000),
      'while the turn runs, Stop takes Send\u2019s place',
    )
    assert.equal(await browser.evaluate('document.getElementById("send").hidden'), true, 'and Send is out of the way')
    assert.ok(await until(() => server.double.requests.length === 1), 'the model call is in flight')

    await browser.evaluate('document.getElementById("stop").click()')
    assert.ok(
      await browser.waitFor('document.getElementById("stop").hidden === true', 20_000),
      'pressing Stop ends the turn and hands the action back',
    )
    assert.equal(await browser.evaluate('document.getElementById("send").hidden'), false, 'Send is back')
    assert.equal(
      await browser.evaluate('document.querySelectorAll("#log .turn.denied").length'),
      0,
      'a stopped turn is not drawn as a failure',
    )
  } finally {
    browser.close()
    await server.close()
  }
})

/** The access chip names the sandbox mode the server actually runs under — read, not guessed. */
test('the access chip reports the server\u2019s sandbox mode', async (context) => {
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('access')
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("access") !== null', 20_000)
    /**
     * The mode arrives from `/api/status` after the page boots, so the chip's *text* is what is awaited — the
     * element itself exists before that answer does.
     */
    await browser.waitFor('document.getElementById("access").textContent !== "Access"', 10_000)
    const chip = JSON.parse(
      await browser.evaluate('JSON.stringify({ text: document.getElementById("access").textContent, title: document.getElementById("access").title })'),
    )
    assert.match(chip.text, /^(Read only|Workspace write|Full access)$/, `the chip names the mode (${chip.text})`)
    assert.match(chip.title, /sandbox mode/, 'and says where the name comes from')
  } finally {
    browser.close()
    await server.close()
  }
})

/**
 * The composer is **the text column plus 32px**, and one handle widens both.
 *
 * Measured from DSH's own page: text 680px, composer card 712px (16px overhang each side), in one column a
 * 10px `col-resize` grip resizes. The composer used to be a fixed 712px card under a 872px transcript, which
 * is the mismatch this judges: the input and the text must be one column, not two widths that disagree.
 */
test('the composer is the text column plus 32px, and the handle widens both', async (context) => {
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('column')
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("composer-card") !== null', 20_000)

    /** A turn gives the transcript a row to measure; the double answers it. */
    await type(browser, 'width check')
    await press(browser, { key: 'Enter' })
    await browser.waitFor('document.querySelector("#log .turn.assistant") !== null', 15_000)

    const widths = () =>
      browser.evaluate(`(() => {
        const row = document.querySelector('#log .turn.assistant')
        const card = document.getElementById('composer-card')
        const gutter = document.getElementById('gutter-column')
        return JSON.stringify({
          text: Math.round(row.getBoundingClientRect().width),
          card: Math.round(card.getBoundingClientRect().width),
          cursor: getComputedStyle(gutter).cursor,
          column: Math.round(Number.parseFloat(getComputedStyle(document.querySelector('main')).getPropertyValue('--chat-column'))),
        })
      })()`)
    const before = JSON.parse(await widths())
    assert.ok(before.text > 0, `the transcript has a measurable text column (${before.text})`)
    assert.equal(before.card - before.text, 32, `the composer hangs 16px over each side of the text (${before.card} vs ${before.text})`)
    assert.equal(before.cursor, 'col-resize', 'the handle is a column-resize grip')

    /**
     * DSH's maths, and DSH's floor. Its `WidthHandle` computes
     * `outward = side === "right" ? dx : -dx; width = base + outward * 2` on a `min` of **640**
     * (`ConversationWidthControls`: `CONTENT_MIN = 640`, `CONTENT_EDGE_BUDGET = 176`). So an outward drag of
     * 50px widens the column by 100, and an inward drag clamps at 640 rather than collapsing the text.
     */
    const drag = async (dx) => {
      await browser.evaluate(`(() => {
        const gutter = document.getElementById('gutter-column')
        const box = gutter.getBoundingClientRect()
        const startX = box.x + box.width / 2
        try { gutter.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: startX, clientY: 400, button: 0, pointerId: 1 })) } catch {}
        window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: startX + ${dx}, clientY: 400, pointerId: 1 }))
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: startX + ${dx}, clientY: 400, pointerId: 1 }))
        return true
      })()`)
    }
    /**
     * The default now sits at the ceiling (80–85% of the window, clamped), so the 2× maths is shown by narrowing:
     * 50px inward is 100px narrower, which is what "both edges move" means.
     */
    await drag(-50)
    const dragged = JSON.parse(await widths())
    assert.equal(dragged.column, before.column - 100, 'one pointer pixel moves each side, so 50px narrows the column by 100')
    assert.equal(dragged.card - dragged.text, 32, 'and the card follows the text column exactly')

    await drag(-200)
    const floored = JSON.parse(await widths())
    assert.equal(floored.column, 640, 'the floor is DSH\'s 640, not a collapse')

    /** The chosen width is a preference, so a reload keeps it. */
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("composer-card") !== null', 20_000)
    const reloaded = await browser.evaluate(
      'Math.round(Number.parseFloat(getComputedStyle(document.querySelector("main")).getPropertyValue("--chat-column")))',
    )
    assert.equal(reloaded, floored.column, 'the width survives a reload')
    await browser.evaluate('localStorage.removeItem("heddle.chatColumn")')
  } finally {
    browser.close()
    await server.close()
  }
})

/**
 * The status line prints a token rate and a context share **from numbers the provider reported**, and nothing
 * where it reported none. DSH prints the same two terms under its composer; a numerator here comes from the
 * `usage` frame the double now sends, and a denominator from the endpoint's declared `contextWindow`.
 */
test('the status line derives a token rate and a context share from reported usage', async (context) => {
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('usage', {
    usage: { prompt_tokens: 1000, completion_tokens: 50 },
    contextWindow: 2000,
    holdOpenMs: 50,
  })
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("composer-card") !== null', 20_000)
    const cells = () =>
      browser.evaluate(`(() => {
        const cell = (name) => (document.querySelector('[data-stat="' + name + '"]') || {}).textContent || ''
        return JSON.stringify({ tokens: cell('tokens'), context: cell('context'), turns: cell('turns') })
      })()`)
    const empty = JSON.parse(await cells())
    assert.equal(empty.tokens, '', 'before any usage is reported there is no rate')
    assert.equal(empty.context, '', 'and no context share')

    await type(browser, 'report the cost')
    await press(browser, { key: 'Enter' })
    assert.ok(
      await browser.waitFor('(document.querySelector(\'[data-stat="tokens"]\') || {}).textContent !== ""', 20_000),
      'the rate appears once the provider reports usage',
    )
    const filled = JSON.parse(await cells())
    assert.match(filled.tokens, /^\d+ tok\/s$/, `the rate is output tokens over the turn's duration (${filled.tokens})`)
    assert.equal(filled.context, '50% context', 'the share is reported input tokens over the declared window')
    assert.equal(filled.turns, '1 turn', 'and the turn count still follows the transcript')
  } finally {
    browser.close()
    await server.close()
  }
})

/**
 * The `+` menu is the composer's file entry: it opens the workspace tree, descends one level at a time, and
 * inserts a file's path at the cursor — DSH's `+`, reduced to what this harness has (files, not commands).
 */
test('the + menu inserts a workspace file path into the draft', async (context) => {
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('attach')
  const browser = await openBrowser()
  try {
    /** A real folder with a real file, registered through the API the page's own controls call. */
    writeFileSync(join(server.work, 'note.md'), '# a note\n')
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("attach") !== null', 20_000)
    const registered = await browser.evaluate(`(async () => {
      const response = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: ${JSON.stringify(server.work)} }),
      })
      return response.status
    })()`)
    assert.equal(registered, 200, 'the fixture folder is a workspace root')

    await browser.evaluate('document.getElementById("attach").click()')
    assert.ok(await browser.waitFor('document.getElementById("attach-menu").hidden === false', 10_000), 'the menu opens')
    const rootLabel = server.work.split('/').filter(Boolean).pop() + '/'
    assert.ok(
      await browser.waitFor(`Array.from(document.querySelectorAll('#attach-menu button')).some((item) => item.textContent === ${JSON.stringify(rootLabel)})`, 10_000),
      `the workspace root is listed (${rootLabel})`,
    )
    await browser.evaluate(`Array.from(document.querySelectorAll('#attach-menu button')).find((item) => item.textContent === ${JSON.stringify(rootLabel)}).click()`)
    assert.ok(
      await browser.waitFor(`Array.from(document.querySelectorAll('#attach-menu button')).some((item) => item.textContent === 'note.md')`, 10_000),
      'descending one level lists the folder\'s files',
    )
    await browser.evaluate(`Array.from(document.querySelectorAll('#attach-menu button')).find((item) => item.textContent === 'note.md').click()`)
    const after = JSON.parse(
      await browser.evaluate(`JSON.stringify({
        value: document.querySelector('#prompt textarea').value,
        hidden: document.getElementById('attach-menu').hidden,
      })`),
    )
    assert.equal(after.value, join(server.work, 'note.md'), 'the file path lands in the draft')
    assert.equal(after.hidden, true, 'and choosing it closes the menu')
  } finally {
    browser.close()
    await server.close()
  }
})
