import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { chatDouble, fixtureDir, isolatedHome, removeDir, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

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
    ...(options.modelList !== undefined ? { modelList: options.modelList } : {}),
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
      const { repoRoot } = await import('../../_tools_/verify-runner/lib.mjs')
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
    /** The owner asked for the reference's composer leading: 14px on a 21px line, not DSH's 24. */
    assert.deepEqual(card.editor, { font: '14px', line: '21px' }, 'the editor is the reference 14/21 type')
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
    /**
     * The chip is a control now, so its `textContent` carries formatting whitespace around the glyph, label and
     * chevron; the **label** is the mode's name, and that is what the page fills in after `/api/status` answers.
     */
    await browser.waitFor('(document.getElementById("access-label")?.textContent ?? "") !== "Access"', 10_000)
    const chip = JSON.parse(
      await browser.evaluate('JSON.stringify({ text: document.getElementById("access-label")?.textContent ?? "", title: document.getElementById("access").title })'),
    )
    assert.match(chip.text, /^(Read Only|Workspace Write|Full access)$/, `the chip names the mode (${chip.text})`)
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
     * The default sits at the ceiling (the owner's 80–85% of the screen, clamped), so the 2× maths is shown by
     * narrowing: 50px inward is 100px narrower, which is what "both edges move" means.
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
/**
 * The composer's bottom statistics are **DSH's dock**, from reported facts only.
 *
 * The reference prints three figures under the card: `{turns} turns {steps} steps · {rate} tok/s`,
 * `{total} tok · Cache hit {percent}%`, and `{percent}%` inside a ring. Its formatters were read from its own
 * client bundle (integer at 100 or above and one decimal below for K/M; integer rate at 10 or above; the cache
 * share as integer text unless that would claim a full 100%; the context share clamped to 100). A provider that
 * reports no usage leaves its phrases blank — the dock never invents a token count.
 */
test('the session-statistics dock prints DSH\u2019s figures, and blanks what was not reported', async (context) => {
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('stats', {
    usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } },
    contextWindow: 2000,
    holdOpenMs: 50,
  })
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("composer-card") !== null', 20_000)
    const dock = () =>
      browser.evaluate(`(() => {
        const status = document.getElementById('composer-status')
        const cell = (name) => (document.querySelector('[data-stat="' + name + '"]') || {}).textContent || ''
        const pill = (name) => document.querySelector('[data-stat-pill="' + name + '"]')
        const box = (node) => { if (!node) return null; const r = node.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) } }
        const style = (node, keys) => node === null ? null : keys.reduce((out, key) => { out[key] = getComputedStyle(node).getPropertyValue(key); return out }, {})
        const card = document.getElementById('composer-card')
        return JSON.stringify({
          hidden: status === null ? null : status.hidden,
          turns: cell('turns'), steps: cell('steps'), tokens: cell('tokens'),
          total: cell('total'), cache: cell('cache'), context: cell('context'),
          usageHidden: pill('usage') === null ? null : pill('usage').hidden,
          contextHidden: pill('context') === null ? null : pill('context').hidden,
          rateSepHidden: (document.querySelector('[data-stat="rate-sep"]') || {}).hidden,
          ring: (document.querySelector('[data-stat="context-ring"]') || {}).getAttribute?.('stroke-dasharray'),
          ringR: (document.querySelector('[data-stat="context-ring"]') || {}).getAttribute?.('r'),
          sepColor: status === null ? null : getComputedStyle(document.querySelector('[data-stat="rate-sep"]')).color,
          /** The dock's own box against its content: the reference's box hugs its items, it does not fill the column. */
          ownWidth: status === null ? null : Math.round(status.getBoundingClientRect().width),
          contentWidth: status === null ? null : Math.round([...status.children].reduce((sum, node) => sum + node.getBoundingClientRect().width, 0) + 12 * 2),
          cardWidth: card === null ? null : Math.round(card.getBoundingClientRect().width),
          dock: box(status), card: box(card),
          pillStyle: style(pill('time'), ['font-size', 'line-height', 'color', 'border-radius', 'padding', 'gap']),
          contextStyle: style(pill('context'), ['font-size', 'line-height', 'color', 'border-radius', 'padding']),
            dockStyle: style(status, ['gap', 'padding-top', 'justify-content']),
        })
      })()`)
    const empty = JSON.parse(await dock())
    assert.equal(empty.hidden, true, 'a new session has nothing to report, so the dock is hidden')

    await type(browser, 'report the cost')
    await press(browser, { key: 'Enter' })
    assert.ok(
      await browser.waitFor('(document.querySelector(\'[data-stat="tokens"]\') || {}).textContent !== ""', 20_000),
      'the dock fills once the turn ended and its usage was reported',
    )
    const first = JSON.parse(await dock())
    assert.equal(first.turns, '1 turns', 'the reference\u2019s label is always plural')
    assert.equal(first.steps, '1 steps', 'one model round is one agent step')
    assert.match(first.tokens, /^\d+(\.\d)? tok\/s$/, `the rate is the turn\u2019s reported output over its duration (${first.tokens})`)
    assert.equal(first.total, '1.1K tok', 'the billed total is uncached + cache read + output, compacted like the reference')
    assert.equal(first.cache, 'Cache hit 80%', 'the cache share is the cache read over that billed input')
    assert.equal(first.context, '50%', 'the context share is the last prompt over the window')
    assert.ok(Number.parseFloat(first.ring) > 0, 'the ring is drawn for the share')
    assert.equal(first.dock.top, first.card.bottom, 'the dock sits flush at the card\u2019s bottom edge')
    assert.equal(first.ownWidth, first.contentWidth, 'the dock\u2019s own box hugs its items, as the reference\u2019s does')
    assert.ok(first.ownWidth < first.cardWidth - 120, `and it is not stretched across the column (${first.ownWidth} vs card ${first.cardWidth})`)
    assert.equal(first.sepColor, 'rgb(173, 178, 184)', 'the separator is the label colour, not a darker border colour')
    assert.equal(first.ringR, '5.5', 'the ring is the reference\u2019s 11px circle')
    assert.equal(first.pillStyle['font-size'], '12px', 'the pills are 12px')
    assert.equal(first.pillStyle['line-height'], '20px', 'on a 20px line')
    assert.equal(first.pillStyle.color, 'rgb(173, 178, 184)', 'in the reference\u2019s tertiary grey')
    assert.equal(first.pillStyle['border-radius'], '999px', 'and pill-shaped')
    assert.equal(first.pillStyle.padding, '1px 8px', 'with the reference\u2019s padding')
    assert.equal(first.contextStyle['font-size'], '13px', 'the context item is one step larger')
    assert.equal(first.dockStyle.gap, '12px', 'the dock spaces its items by 12px')
    assert.equal(first.dockStyle['padding-top'], '4px', 'and its own top padding is the gap to the card')

    /** A second turn accumulates: the numbers are a session total, not the last turn\u2019s. */
    await type(browser, 'again')
    await press(browser, { key: 'Enter' })
    assert.ok(
      await browser.waitFor('(document.querySelector(\'[data-stat="total"]\') || {}).textContent === "2.1K tok"', 20_000),
      'the second turn lands in the cumulative total',
    )
    const second = JSON.parse(await dock())
    assert.equal(second.steps, '2 steps')
    assert.equal(second.total, '2.1K tok', 'the total is cumulative over the session')
    assert.equal(second.cache, 'Cache hit 80%')

    /**
     * A reload prints the durable fold, not whichever transcript rows happened to be drawn first.
     *
     * Measured on the live page: a dock that counted rendered user rows showed `0 turns` beside `31 steps`
     * while history was still arriving. The count now comes from the session's own stats, so it agrees with
     * the backend from the first paint; the live turn is added on top while it runs.
     */
    await browser.goto(server.url)
    assert.ok(await browser.waitFor('(document.querySelector(\'[data-stat="turns"]\') || {}).textContent !== ""', 20_000))
    const reloaded = JSON.parse(await dock())
    const durableTurns = await browser.evaluate(`(async () => {
      const rows = await (await fetch('/api/sessions')).json()
      const id = rows[0]?.id
      const detail = id === undefined ? null : await (await fetch('/api/sessions/' + id)).json()
      return detail?.stats?.turns ?? null
    })()`)
    assert.equal(durableTurns, 2, 'the backend fold counts two turns')
    assert.equal(reloaded.turns, `${durableTurns} turns`, 'and the dock prints that count rather than a row count')
    assert.equal(reloaded.total, '2.1K tok', 'the cumulative total survives the reload')
    assert.equal(reloaded.context, '50%', 'and so does the context share')
  } finally {
    browser.close()
    await server.close()
  }

  /** A provider that reports no usage leaves the token phrases blank rather than inventing them. */
  const bare = await startServer('stats-bare', { holdOpenMs: 50 })
  const browser2 = await openBrowser()
  try {
    await browser2.goto(bare.url)
    await browser2.waitFor('document.getElementById("composer-card") !== null', 20_000)
    await type(browser2, 'no usage reported')
    await press(browser2, { key: 'Enter' })
    assert.ok(await browser2.waitFor('(document.querySelector(\'[data-stat="turns"]\') || {}).textContent !== ""', 20_000))
    await new Promise((resolve) => setTimeout(resolve, 400))
    const blank = JSON.parse(await browser2.evaluate(`(() => {
      const cell = (name) => (document.querySelector('[data-stat="' + name + '"]') || {}).textContent || ''
      const pill = (name) => document.querySelector('[data-stat-pill="' + name + '"]')
      return JSON.stringify({ turns: cell('turns'), tokens: cell('tokens'), total: cell('total'), cache: cell('cache'), context: cell('context'), tokensHidden: (document.querySelector('[data-stat="rate-sep"]') || {}).hidden, usageHidden: pill('usage') === null ? null : pill('usage').hidden, contextHidden: pill('context') === null ? null : pill('context').hidden })
    })()`))
    assert.equal(blank.turns, '1 turns', 'the counts still follow the transcript')
    assert.equal(blank.tokens, '', 'no reported output means no rate')
    assert.equal(blank.tokensHidden, true, 'and its separator is not drawn')
    assert.equal(blank.total, '', 'no reported usage means no total')
    assert.equal(blank.usageHidden, true, 'so the whole usage pill is absent')
    assert.equal(blank.context, '', 'and no prompt means no context share')
    assert.equal(blank.contextHidden, true)
  } finally {
    browser2.close()
    await bare.close()
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

/**
 * The default column is the **owner's** measure, and DSH's clamp is a difference kept on purpose.
 *
 * Measured in DSH at four widths on 2026-10-17, its text column is `clamp(680px, viewArea * .64, 920px)`. The
 * owner's later instruction for this UI was 80–85% of the screen instead, so the reference's rule was tried,
 * reverted, and its reason written into the CSS. This contract pins the choice that was actually made: 82.5%
 * of the window (the midpoint), clamped by the view area's budget and DSH's 640 floor.
 */
test('the default column is the owner\u2019s 80-85% of the screen, clamped', async (context) => {
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('column-default')
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("composer-card") !== null', 20_000)
    const measured = JSON.parse(
      await browser.evaluate(`(() => {
        const main = document.querySelector('main')
        const column = Math.round(Number.parseFloat(getComputedStyle(main).getPropertyValue('--chat-column')))
        const floor = 640
        const ceiling = Math.max(floor, main.clientWidth - 116 - 48)
        const wanted = Math.min(ceiling, Math.max(floor, Math.round(window.innerWidth * 0.825)))
        const card = Math.round(document.getElementById('composer-card').getBoundingClientRect().width)
        return JSON.stringify({ window: window.innerWidth, floor, ceiling, wanted, column, card, delta: card - column })
      })()`),
    )
    assert.equal(measured.column, measured.wanted, `the default is 82.5% of the window, clamped (${measured.column} vs ${measured.wanted})`)
    assert.ok(
      measured.column >= Math.round(measured.window * 0.8) || measured.column === measured.ceiling,
      'and it is inside the owner\u2019s 80-85% band, or at the clamp that makes the band impossible',
    )
    assert.equal(measured.delta, 32, 'the card hangs 16px over each side of the column')
  } finally {
    browser.close()
    await server.close()
  }
})

/**
 * The action controls' **states** are DSH's, measured with a trusted pointer.
 *
 * DSH's own composer, measured 2026-10-17 with `Input.dispatchMouseEvent`:
 *
 * - the editor's caret is the accent colour (`rgb(122,170,255)`), not the text colour;
 * - a disabled Send keeps the accent background at `opacity: .4` instead of turning grey;
 * - an enabled Send **darkens** on hover (`#7aaaff` → `#4176e6`);
 * - the `+` is half-transparent at rest (`opacity: .5`) and fully opaque on hover, with no background
 *   change.
 *
 * Heddle's own accent is its theme's blue, so the states are judged against `--accent` rather than DSH's
 * exact hue: the *behaviour* is the reference, the hue is the palette.
 */
test('the action controls carry DSH\u2019s states', async (context) => {
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('states')
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("composer-card") !== null', 20_000)
    /**
     * Wait for **boot**, not for the markup. Measured under a full suite: the disabled send button was read as
     * `opacity: 1` because `renderComposerState()` had not run — the element existed, so an element wait passed. The
     * page sets `body[data-ready]` as its last boot act for exactly this.
     */
    assert.ok(await browser.waitFor('document.body.dataset.ready === "true"', 20_000), 'the page finished booting')
    const style = (selector, props) =>
      browser.evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)})
        if (node === null) return JSON.stringify(null)
        const s = getComputedStyle(node)
        return JSON.stringify(${JSON.stringify(props)}.reduce((out, key) => { out[key] = s.getPropertyValue(key); return out }, {}))
      })()`)
    const centre = (selector) =>
      browser.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }) })()`)
    const move = async (point) => {
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    const accentValue = await browser.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`)
    const dim = await browser.evaluate(`(() => { const probe = document.createElement('span'); probe.style.background = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(); document.body.append(probe); const value = getComputedStyle(probe).backgroundColor; probe.remove(); return value })()`)
    assert.ok(accentValue.length > 0, `the page declares an accent (${accentValue})`)

    /** The caret is the accent, which is what DSH's editor shows while typing. */
    const editorStyle = JSON.parse(await style('#prompt textarea', ['caret-color']))
    assert.equal(editorStyle['caret-color'], dim, 'the editor cursor is the accent colour')

    /** Empty draft: Send keeps the accent and drops to opacity .4, like DSH's disabled action. */
    const empty = JSON.parse(await style('#send', ['background-color', 'opacity', 'color']))
    assert.equal(empty['background-color'], dim, 'a disabled Send keeps the accent background')
    assert.equal(empty.opacity, '0.4', 'and dims with opacity, as DSH does')
    assert.equal(empty.color, 'rgb(255, 255, 255)', 'with a white glyph')

    /** Typed draft: enabled, and hovering darkens it. */
    await type(browser, 'x')
    const enabled = JSON.parse(await style('#send', ['background-color', 'opacity']))
    assert.equal(enabled.opacity, '1', 'a draft enables the action')
    /**
     * Hover is judged by the **rendered** colour, not its text: `color-mix()` resolves to an `oklab(...)`
     * string in computed style, so both are drawn on a 1×1 canvas and the channel sums compared.
     */
    const colourSum = () =>
      browser.evaluate(`(() => {
        const node = document.querySelector('#send')
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')
        context.fillStyle = getComputedStyle(node).backgroundColor
        context.fillRect(0, 0, 1, 1)
        const [r, g, b] = context.getImageData(0, 0, 1, 1).data
        return r + g + b
      })()`)
    const idleSum = await colourSum()
    const sendPoint = JSON.parse(await centre('#send'))
    await move(sendPoint)
    const hoverSum = await colourSum()
    assert.ok(hoverSum < idleSum, `hover darkens the action (channels ${idleSum} → ${hoverSum})`)
    await move({ x: 2, y: 2 })
    const left = JSON.parse(await style('#send', ['background-color']))
    assert.equal(left['background-color'], enabled['background-color'], 'and moving away restores it')

    /** The `+` is half-transparent at rest and opaque on hover, without changing its background. */
    const attachIdle = JSON.parse(await style('#attach', ['opacity', 'background-color']))
    assert.equal(attachIdle.opacity, '0.5', 'the + rests at half opacity')
    const attachPoint = JSON.parse(await centre('#attach'))
    await move(attachPoint)
    const attachHover = JSON.parse(await style('#attach', ['opacity', 'background-color']))
    assert.equal(attachHover.opacity, '1', 'and is fully opaque under the pointer')
    assert.equal(attachHover['background-color'], attachIdle['background-color'], 'with its background unchanged')
    await move({ x: 2, y: 2 })
    assert.equal(JSON.parse(await style('#attach', ['opacity'])).opacity, '0.5', 'and moving away restores the resting opacity')
  } finally {
    browser.close()
    await server.close()
  }
})

/**
 * When the provider lists its model's context window, the gauge gets a real denominator without configuration.
 *
 * The endpoint below declares no `contextWindow`; its provider's model list reports 500,000. A session that used
 * 250,000 prompt tokens therefore reads 50%, and an endpoint whose provider reports nothing still prints no
 * gauge — the rule that a number appears only when a provider gave the fact behind it.
 */
test('the context gauge uses a window the provider reports, and stays blank when it reports none', async (context) => {
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('context-window', {
    modelList: [{ id: 'held-model', context_window: 500000 }],
    usage: { prompt_tokens: 250000, completion_tokens: 10 },
    holdOpenMs: 50,
  })
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("composer-card") !== null', 20_000)
    await type(browser, 'measure the context')
    await press(browser, { key: 'Enter' })
    assert.ok(
      await browser.waitFor('(document.querySelector(\'[data-stat="context"]\') || {}).textContent !== ""', 20_000),
      'the gauge fills once the provider-reported window is discovered',
    )
    const shown = JSON.parse(await browser.evaluate(`(() => {
      const cell = (name) => (document.querySelector('[data-stat="' + name + '"]') || {}).textContent || ''
      const item = document.querySelector('[data-stat-pill="context"]')
      return JSON.stringify({ context: cell('context'), hidden: item === null ? null : item.hidden })
    })()`))
    assert.equal(shown.context, '50%', 'the share is the last prompt over the provider\'s own window')
    assert.equal(shown.hidden, false, 'and the item is not hidden')
  } finally {
    browser.close()
    await server.close()
  }

  /** A provider that reports no model list leaves the gauge blank rather than borrowing a number. */
  const bare = await startServer('context-window-absent', {
    usage: { prompt_tokens: 250000, completion_tokens: 10 },
    holdOpenMs: 50,
  })
  const browser2 = await openBrowser()
  try {
    await browser2.goto(bare.url)
    await browser2.waitFor('document.getElementById("composer-card") !== null', 20_000)
    await type(browser2, 'measure without a window')
    await press(browser2, { key: 'Enter' })
    assert.ok(await browser2.waitFor('(document.querySelector(\'[data-stat="turns"]\') || {}).textContent !== ""', 20_000))
    await new Promise((resolve) => setTimeout(resolve, 500))
    const absent = JSON.parse(await browser2.evaluate(`(() => {
      const cell = (name) => (document.querySelector('[data-stat="' + name + '"]') || {}).textContent || ''
      const item = document.querySelector('[data-stat-pill="context"]')
      return JSON.stringify({ context: cell('context'), hidden: item === null ? null : item.hidden })
    })()`))
    assert.equal(absent.context, '', 'no window means no percentage')
    assert.equal(absent.hidden, true, 'and the item is hidden')
  } finally {
    browser2.close()
    await bare.close()
  }
})
