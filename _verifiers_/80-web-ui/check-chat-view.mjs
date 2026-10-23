import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { fixtureDir, heddleCommand, httpConfig, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The chat view: one element per tool **call**, carrying its result.
 *
 * This is the claim the owner asked for, and it is a claim about what a reader sees rather than about what
 * the log holds: the log has always had the call and the result as two events, and the page used to draw
 * them as two rows a person had to match up by eye. DSH draws one element per call, with the result inside
 * it, and so does this now — the fold pairs them by call id, and the element is what the page shows.
 *
 * Judged at both layers, because each can be wrong while the other looks right: the API fold can merge
 * while the client draws two rows, and the client can draw one row while the fold never paired anything.
 */

const CAPABILITY = 'the Web UI'

async function startServer(label, steps, options = {}) {
  const home = isolatedHome(`chat-${label}`)
  const work = fixtureDir(`chat-${label}-work`)
  /**
   * A failing endpoint, for the turn-failure path: a listening address nothing answers on is the cheapest way to make
   * the provider call throw, which is the case where a page used to keep a session looking active forever.
   */
  const { config } = options.failing === true
    ? { config: httpConfig({ home, name: 'bad', baseUrl: 'http://127.0.0.1:9', stream: true }) }
    : options.doubleUrl !== undefined
    ? { config: httpConfig({ home, name: 'stream', baseUrl: String(options.doubleUrl), stream: true }) }
    : scriptedConfig({
        home,
        steps: typeof steps === 'function' ? steps(work) : steps ?? [{ toolCall: { name: 'list_dir', arguments: { path: work } } }, { text: 'it listed the folder' }],
      })
  const child = await startCli(
    /**
     * `HEDDLE_CHECK_PATCH` names a patch layer to use **instead of** the project's, so this check can run while
     * `heddle.patch.yml` itself is being edited by someone else: the committed profile is a stable reference, and a
     * check that fails because the tree is mid-write says nothing about the page. Unset, the project's own patch is
     * used, which is what a normal run wants.
     */
    [
      'web',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--config',
      join(repoRoot, 'cordis.yml'),
      ...(process.env.HEDDLE_CHECK_PATCH ? ['--patch', process.env.HEDDLE_CHECK_PATCH] : []),
      '--endpoint',
      options.failing === true ? 'bad' : options.doubleUrl !== undefined ? 'stream' : 'scripted',
      '--session-root',
      join(home, 'sessions'),
      ...(options.maxRounds !== undefined ? ['--max-rounds', String(options.maxRounds)] : []),
      ...(options.sandboxRoot === true ? ['--sandbox-root', work] : []),
    ],
    { env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config }, cwd: work },
  )
  return {
    home,
    work,
    url: child.url,
    close: async () => {
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
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

test('a tool call and its result fold into one turn, and the page draws them as one element', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('tool')
  const browser = await openBrowser()
  try {
    mkdirSync(server.work, { recursive: true })
    writeFileSync(join(server.work, 'a.txt'), 'one\n')
    writeFileSync(join(server.work, 'b.txt'), 'two\n')
    const cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
    const opened = await api(server.url, cookie, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: server.work }) })
    const session = opened.body.session?.id ?? opened.body.id

    // One turn that asks for a tool, which the loop runs, and then says what it did.
    const turn = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'what is in here', folder: server.work, session }),
    })
    assert.equal(turn.status, 200, `the turn ran (${turn.status})`)
    await turn.text()

    const view = await api(server.url, cookie, `/api/sessions/${encodeURIComponent(session)}`)
    assert.equal(view.status, 200, 'the session reads back')
    const tools = (view.body.turns ?? []).filter((entry) => entry.kind === 'tool')
    assert.equal(tools.length, 1, `the call and its result are one turn, not two\nsaw: ${JSON.stringify(view.body.turns ?? [])}`.slice(0, 400))
    const tool = tools[0]
    assert.equal(tool.name, 'list_dir', 'the turn names the tool it called')
    assert.match(String(tool.text), /a\.txt|"path"/, 'and carries the arguments')
    assert.match(String(tool.result), /a\.txt/, 'and the result, on the same turn')
    assert.equal(tool.state, 'ok', 'with a state that says it worked')
    assert.ok(
      (view.body.turns ?? []).some((entry) => entry.kind === 'user') && (view.body.turns ?? []).some((entry) => entry.kind === 'assistant'),
      'and the person and the model still have their own turns',
    )

    await browser.goto(server.url)
    await browser.waitFor('document.querySelectorAll("#log .turn").length > 0', 20_000)
    const drawn = JSON.parse(
      await browser.evaluate(`JSON.stringify({
        tools: document.querySelectorAll('#log .turn.tool').length,
        state: document.querySelector('#log .turn.tool')?.dataset.state ?? null,
        summary: document.querySelector('#log .turn.tool summary')?.textContent ?? '',
        args: document.querySelector('#log .turn.tool [data-args]')?.textContent ?? '',
        result: document.querySelector('#log .turn.tool [data-result]')?.textContent ?? '',
        kinds: [...document.querySelectorAll('#log .turn')].map((node) => node.dataset.kind),
        notes: [...document.querySelectorAll('#log .turn.denied')].map((node) => node.textContent).slice(0, 2),
        log: document.getElementById('log').innerText.slice(0, 240),
      })`),
    )
    assert.equal(drawn.tools, 1, `the page draws one element for the call, not one for the call and one for the result\nDIAG ${JSON.stringify(drawn)}`)
    assert.equal(drawn.state, 'ok', 'and the element says the call succeeded')
    assert.match(drawn.summary, /list_dir/, 'its closed one-liner names the tool')
    assert.match(drawn.args, /path/, 'the arguments are inside that element')
    assert.match(drawn.result, /a\.txt/, 'and so is what the tool answered')
    assert.ok(drawn.kinds.includes('user') && drawn.kinds.includes('assistant'), `the person and the model are drawn too\nsaw: ${drawn.kinds.join(', ')}`)
  } finally {
    browser.close()
    await server.close()
  }
})

test('a settled answer is drawn as the document it is, and the renderer is the server’s', async (context) => {
  /**
   * DSH's assistant row renders markdown, and its `finalNode` exists only once the row is **settled** — which
   * is the same place heddle draws the document, for the same reason and with one difference: the renderer is
   * the server's, because that is where the escaping and the allow-list live (`src/server/markdown.ts`), while
   * while the answer is still arriving the row is the plain text the deltas are.
   *
   * Both halves are judged: an answer with emphasis and a fenced block comes out as markup after the turn, and
   * the render route drops what the allow-list does not want — a `<script>` in the answer is text, not code.
   */
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('chat-markdown')
  const work = fixtureDir('chat-markdown-work')
  const { config } = scriptedConfig({ home, steps: [{ text: 'a **bold** word\n\n```js\nconst x = 1\n```' }] })
  const child = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config }, cwd: work },
  )
  const browser = await openBrowser()
  try {
    await browser.goto(child.url)
    assert.ok(await browser.waitFor('document.getElementById("log") !== null', 20_000), 'the panel is up')
    const cookie = await cookieFor(child.url)

    const turn = await fetch(new URL('/api/turn', child.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ prompt: 'show me markdown' }),
    })
    assert.equal(turn.status, 200, 'the turn ran')
    await turn.text()

    assert.ok(await browser.waitFor('document.querySelector("#log .turn.assistant") !== null', 20_000), 'the answer is drawn')
    assert.ok(
      await browser.waitFor('document.querySelector("#log .turn.assistant strong") !== null', 20_000),
      'and a settled answer is markup rather than the raw text',
    )
    const drawn = JSON.parse(
      await browser.evaluate(`JSON.stringify({
        rendered: document.querySelector('#log .turn.assistant')?.dataset.rendered ?? null,
        bold: document.querySelector('#log .turn.assistant strong')?.textContent ?? null,
        code: document.querySelector('#log .turn.assistant pre code')?.textContent ?? null,
        text: document.querySelector('#log .turn.assistant')?.textContent ?? ''
      })`),
    )
    assert.equal(drawn.rendered, 'true', 'the row says the document was drawn')
    assert.equal(drawn.bold, 'bold', 'the emphasis is an element')
    assert.match(String(drawn.code), /const x = 1/, 'and the fenced block is code')
    assert.doesNotMatch(drawn.text, /\*\*/, 'with no markdown left showing as characters')

    /**
     * The row's actions, which is DSH's `MessageIconActions` reduced to the one this harness has: copy. What
     * would be copied is judged — and it is the **drawn** answer rather than its markdown source, which is what
     * a person pasting it somewhere expects. The clipboard itself is the browser's, so the check reads the
     * snapshot the button copies from rather than asserting what the platform did with it.
     */
    const actions = JSON.parse(
      await browser.evaluate(`JSON.stringify({
        buttons: document.querySelectorAll('#log .turn.assistant .action').length,
        label: (document.querySelector('#log .turn.assistant .action') || {}).getAttribute?.('aria-label') ?? null,
        copyText: (document.querySelector('#log .turn.assistant') || {}).dataset?.copyText ?? null
      })`),
    )
    assert.equal(actions.buttons, 1, 'a settled answer offers exactly one action')
    assert.equal(actions.label, 'Copy this answer', 'and it says what it does')
    assert.match(String(actions.copyText), /bold word/, 'what it copies is the answer')
    assert.doesNotMatch(String(actions.copyText), /\*\*/, 'as it reads rather than as its source')
  } finally {
    browser.close()
    child.kill()
    removeDir(home)
    removeDir(work)
  }
})

test('the chat is drawn in DSH\'s own numbers, folds by default, and swaps its affordance on hover', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * The claim is **parity with the reference**, so the numbers in it were read out of DSH's own running GUI
   * through the browser rather than chosen: the column, the text size and leading, the 20px-radius
   * bubble on `#2c2c2e` with 10px/16px padding, a reasoning row exactly 24px tall whose **kind icon gives way
   * to a chevron on hover** (`O_Ebla_activityIcon` → `O_Ebla_chevron` by opacity), and a summary that goes
   * **sticky** over its own body once open.
   *
   * Judged by computed style rather than by screenshots: a screenshot shows that today looks right, while the
   * computed value is the thing a later stylesheet can break without anyone noticing.
   *
   * The reading scale is the reference's, not DSH's: its answer paragraphs measure 14px / **22.75px** (a 1.625 ratio),
   * its list items 14/21 with a 4px top margin, its paragraphs `0 0 12px`, and its composer 14/21. The owner asked
   * for it after finding DSH's 24px leading looser than the reference's.
   */
  const server = await startServer('style', (work) => [
    /**
     * One step, because a round that produces only reasoning **ends the turn**: the loop sees no tool call
     * and no text to continue with. Measured here first, as two turns instead of four.
     */
    { reasoning: 'I should look at the folder before answering.', toolCall: { name: 'list_dir', arguments: { path: work } } },
    /** A list and a fence, because the reference's own rhythm is part of the claim being judged. */
    { text: 'A **bold** answer.\n\n- first item\n- second item\n\n```js\nconst x = 1\n```\n' },
  ])
  const browser = await openBrowser()
  try {
    mkdirSync(server.work, { recursive: true })
    writeFileSync(join(server.work, 'a.txt'), 'one\n')
    const cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
    const opened = await api(server.url, cookie, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: server.work }) })
    const session = opened.body.session?.id ?? opened.body.id
    const turn = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'what is in here', folder: server.work, session }),
    })
    assert.equal(turn.status, 200, `the turn ran (${turn.status})`)
    await turn.text()

    await browser.goto(server.url)
    await browser.waitFor('document.querySelector("#log .turn.reasoning") !== null && document.querySelector("#log .turn.tool") !== null', 20_000)

    const diag = JSON.parse(
      await browser.evaluate(`JSON.stringify({
        turns: document.querySelectorAll('#log .turn').length,
        user: !!document.querySelector('#log .turn.user'),
        assistant: !!document.querySelector('#log .turn.assistant'),
        reasoning: !!document.querySelector('#log .turn.reasoning'),
        tool: !!document.querySelector('#log .turn.tool'),
        kinds: [...document.querySelectorAll('#log .turn')].map((n) => n.dataset.kind),
        note: (document.getElementById('tree-note') || {}).textContent || null,
      })`),
    )
    assert.ok(diag.reasoning && diag.tool && diag.user, `the fixture drew its turns\nDIAG ${JSON.stringify(diag)}`)
    const measured = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const log = document.getElementById('log')
        const logStyle = getComputedStyle(log)
        const assistant = document.querySelector('#log .turn.assistant')
        const user = document.querySelector('#log .turn.user')
        const bubble = user ? user.querySelector('.bubble') : null
        const userStyle = bubble ? getComputedStyle(bubble) : null
        const rowStyle = user ? getComputedStyle(user) : null
        const assistantStyle = assistant ? getComputedStyle(assistant) : null
        const mainStyle = getComputedStyle(document.querySelector('main'))
        const reasoning = document.querySelector('#log .turn.reasoning')
        const tool = document.querySelector('#log .turn.tool')
        const reasoningLine = reasoning.querySelector('summary')
        const toolLine = tool.querySelector('summary')
        const chevron = reasoningLine.querySelector('.chevron')
        const kind = reasoningLine.querySelector('.kind')
        return {
          column: mainStyle.getPropertyValue('--chat-column').trim(),
          logFont: logStyle.fontSize, logLine: logStyle.lineHeight, logGap: logStyle.rowGap,
          assistantFont: assistantStyle ? assistantStyle.fontSize : null,
          assistantLine: assistantStyle ? assistantStyle.lineHeight : null,
          userFont: userStyle ? userStyle.fontSize : null,
          userLine: userStyle ? userStyle.lineHeight : null,
          userRadius: userStyle ? userStyle.borderRadius : null,
          userBg: userStyle ? userStyle.backgroundColor : null,
          userPadding: userStyle ? userStyle.padding : null,
          userAlign: rowStyle ? rowStyle.alignSelf : null,
          /** Alignment is not enough: a **stretched** block has the same right edge. Measure the box itself. */
          userWidth: bubble ? Math.round(bubble.getBoundingClientRect().width) : null,
          userRight: bubble ? Math.round(bubble.getBoundingClientRect().right) : null,
          logContentRight: (() => { const log = document.getElementById('log'); const cs = getComputedStyle(log); return Math.round(log.getBoundingClientRect().right - Number.parseFloat(cs.paddingRight)) })(),
          logContentWidth: (() => { const log = document.getElementById('log'); const cs = getComputedStyle(log); return Math.round(log.clientWidth - Number.parseFloat(cs.paddingLeft) - Number.parseFloat(cs.paddingRight)) })(),
          reasoningClosed: reasoning.open === false,
          reasoningHeight: Math.round(reasoningLine.getBoundingClientRect().height),
          reasoningTitle: reasoningLine.querySelector('.title').textContent,
          reasoningGlyphs: reasoningLine.querySelectorAll('svg').length,
          chevronAtRest: getComputedStyle(chevron).opacity,
          kindAtRest: getComputedStyle(kind).opacity,
          toolClosed: tool.open === false,
          toolSummary: toolLine.textContent,
          toolGlyphs: toolLine.querySelectorAll('svg').length,
          paragraphMargin: (() => { const p = document.querySelector('#log .turn.assistant.markdown p'); return p ? getComputedStyle(p).margin : null })(),
          listLine: (() => { const li = document.querySelector('#log .turn.assistant.markdown li'); return li ? getComputedStyle(li).lineHeight : null })(),
          listFont: (() => { const li = document.querySelector('#log .turn.assistant.markdown li'); return li ? getComputedStyle(li).fontSize : null })(),
          codeFont: (() => { const code = document.querySelector('#log .turn.assistant.markdown pre code'); return code ? getComputedStyle(code).fontSize : null })(),
          codeLine: (() => { const code = document.querySelector('#log .turn.assistant.markdown pre code'); return code ? getComputedStyle(code).lineHeight : null })(),
          composerFont: getComputedStyle(document.querySelector('#prompt textarea')).fontSize,
          composerLine: getComputedStyle(document.querySelector('#prompt textarea')).lineHeight,
        }
      })())`),
    )

    // Typography and the column, against DSH's measured values.
    assert.ok(Number.parseFloat(measured.column) >= 640, 'the conversation column is at least its 640 floor')
    assert.equal(measured.logFont, '14px', `the chat is 14px, as DSH\\'s content font is — MEASURED ${JSON.stringify(measured)}`)
    assert.equal(measured.logLine, '22.75px', 'on the 22.75px line the reference measures')
    assert.equal(measured.logGap, '6px', 'with DSH\'s 6px flow gap')
    assert.equal(measured.assistantFont, '14px', 'the answer is 14px')
    assert.equal(measured.assistantLine, '22.75px', 'the answer leads at the same 22.75px')
    assert.match(measured.paragraphMargin, /^0px 0px 12px/, `paragraphs carry the reference's bottom-only 12px (${measured.paragraphMargin})`)
    assert.equal(measured.listFont, '14px', 'a list item is 14px')
    assert.equal(measured.listLine, '21px', 'leading at the reference 21px, not the paragraph leading')
    assert.equal(measured.codeFont, '12.5px', 'a code block keeps its code size')
    assert.equal(measured.codeLine, '19px', 'and its code leading')
    assert.equal(measured.composerFont, '14px', 'the composer is 14px, as the reference composer is')
    assert.equal(measured.composerLine, '21px', 'on its 21px line')
    assert.equal(measured.userFont, '14px', 'the person\'s message is 14px')
    assert.equal(measured.userLine, '22px', 'on DSH\'s 22px bubble line')
    assert.equal(measured.userRadius, '20px', 'its bubble radius is DSH\'s 20px')
    assert.equal(measured.userBg, 'rgb(44, 44, 46)', 'on DSH\'s specific-bubble surface')
    assert.equal(measured.userPadding, '10px 16px', 'with its 10px/16px padding')
    assert.equal(measured.userAlign, 'flex-end', 'sitting against the right edge')
    /**
     * The owner's report was exactly this: a full-width block can look "right aligned" because its right edge is on
     * the column's edge, while its text is left-aligned across the whole column. So the claim has two halves — the
     * bubble's **own width** must be smaller than the column for a short prompt, and its right edge must sit on the
     * column's right edge.
     */
    assert.ok(
      measured.userWidth <= measured.logContentWidth - 20,
      `the bubble hugs its text rather than filling the column (${measured.userWidth} of ${measured.logContentWidth})`,
    )
    assert.ok(
      Math.abs(measured.userRight - measured.logContentRight) <= 1,
      `and it ends on the column's right edge (${measured.userRight} vs ${measured.logContentRight})`,
    )

    /**
     * The person's message carries DSH's `MessageIconActions` row **below the bubble**: the sent time, then the
     * copy button. The time is the recorded event's own `at`, not the render clock — a reload must show when the
     * message was sent — and it reads `HH:mm` on the 24-hour clock (DSH's `formatMessageClock` for today).
     */
    const detail = await api(server.url, cookie, `/api/sessions/${encodeURIComponent(session)}`)
    const recorded = (detail.body.turns ?? []).find((entry) => entry.kind === 'user')
    assert.ok(recorded && typeof recorded.time === 'string', `the session payload carries the user turn's event time (${JSON.stringify(recorded && recorded.time)})`)
    const when = new Date(recorded.time)
    const pad = (value) => String(value).padStart(2, '0')
    const expectedClock = `${pad(when.getHours())}:${pad(when.getMinutes())}`
    const actions = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const user = document.querySelector('#log .turn.user')
        const bubble = user.querySelector('.bubble')
        const row = user.querySelector('.actions')
        const time = row ? row.querySelector('time') : null
        const button = row ? row.querySelector('button') : null
        const timeStyle = time ? getComputedStyle(time) : null
        const buttonStyle = button ? getComputedStyle(button) : null
        return {
          hasRow: row !== null,
          rightAligned: row !== null && Math.abs(row.getBoundingClientRect().right - bubble.getBoundingClientRect().right) <= 1,
          rowHeight: row ? Math.round(row.getBoundingClientRect().height) : null,
          timeText: time ? time.textContent : null,
          timeDateTime: time ? time.getAttribute('datetime') : null,
          timeFont: timeStyle ? timeStyle.fontSize : null,
          timeLine: timeStyle ? timeStyle.lineHeight : null,
          timeColor: timeStyle ? timeStyle.color : null,
          buttonLabel: button ? button.getAttribute('aria-label') : null,
          buttonArt: button !== null && button.querySelector('svg rect') !== null,
          svgWidth: button && button.querySelector('svg') ? Math.round(button.querySelector('svg').getBoundingClientRect().width) : null,
          buttonWidth: button ? Math.round(button.getBoundingClientRect().width) : null,
          buttonHeight: button ? Math.round(button.getBoundingClientRect().height) : null,
        }
      })())`),
    )
    assert.equal(actions.hasRow, true, 'the user message has an actions row')
    assert.equal(actions.rightAligned, true, 'it sits under the bubble, flush with its right edge')
    assert.equal(actions.rowHeight, 28, `the actions row is DSH's 28px tall (${actions.rowHeight})`)
    assert.equal(actions.timeText, expectedClock, `the clock is the recorded event time, HH:mm (${actions.timeText} vs ${expectedClock})`)
    assert.equal(actions.timeDateTime, recorded.time, 'and carries that instant as its datetime')
    assert.equal(actions.timeFont, '13px', 'the clock is 13px')
    assert.equal(actions.timeLine, '24px', 'on a 24px line')
    assert.equal(actions.timeColor, 'rgb(129, 133, 140)', "in the caption ink DSH uses for a message's clock")
    assert.equal(actions.buttonLabel, 'Copy', 'the button says what it does')
    assert.equal(actions.buttonArt, true, "its mark is DSH's copy artwork")
    assert.equal(actions.svgWidth, 15, "at DSH's 15px")
    assert.equal(actions.buttonWidth, 28, 'and is 28px wide')
    assert.equal(actions.buttonHeight, 28, 'by 28px tall')

    /**
     * Clicking copies the message's own text, then says so: DSH flips the label to `Copied` and the glyph to a
     * check for one second. The clipboard write is captured rather than read back, because a headless browser's
     * clipboard needs a permission grant on the browser target, and the claim here is that the button writes
     * exactly this text — which the captured argument shows directly.
     */
    const copied = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const button = document.querySelector('#log .turn.user .actions button')
        window.__copied = null
        const real = navigator.clipboard.writeText.bind(navigator.clipboard)
        navigator.clipboard.writeText = async (text) => { window.__copied = text; try { await real(text) } catch {} }
        button.click()
        return true
      })())`),
    )
    assert.equal(copied, true, 'the copy button can be clicked')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const afterCopy = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const button = document.querySelector('#log .turn.user .actions button')
        const svg = button.querySelector('svg')
        const path = svg ? svg.querySelector('path') : null
        return {
          text: window.__copied,
          label: button.getAttribute('aria-label'),
          feedback: button.dataset.copied === 'true',
          /* DSH's IconCheckOutlineRegular artwork, not a text glyph. */
          checkArt: path !== null && String(path.getAttribute('d')).startsWith('M2.25 8.5'),
          svgWidth: svg ? Math.round(svg.getBoundingClientRect().width) : null,
        }
      })())`),
    )
    assert.equal(afterCopy.text, 'what is in here', `the button writes the message's own text (${JSON.stringify(afterCopy.text)})`)
    assert.equal(afterCopy.label, 'Copied', 'the label says it copied')
    assert.equal(afterCopy.feedback, true, 'and the row marks the state')
    assert.equal(afterCopy.checkArt, true, "the success mark is DSH's check artwork, not a text glyph")
    assert.equal(afterCopy.svgWidth, 15, "and the artwork renders at DSH's 15px")
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const restored = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const button = document.querySelector('#log .turn.user .actions button')
        const svg = button.querySelector('svg')
        return { label: button.getAttribute('aria-label'), hasCopyArt: svg !== null && svg.querySelector('rect') !== null }
      })())`),
    )
    assert.equal(restored.label, 'Copy', 'the label returns after the reference\'s one second')
    assert.equal(restored.hasCopyArt, true, 'and so does the copy artwork')

    /** The keyboard reaches the button and activates it, as a button must. */
    const viaKeyboard = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const button = document.querySelector('#log .turn.user .actions button')
        window.__copied = null
        button.focus()
        button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        button.click()
        return { focused: document.activeElement === button }
      })())`),
    )
    assert.equal(viaKeyboard.focused, true, 'the copy button is focusable')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const keyboardCopy = await browser.evaluate('window.__copied')
    assert.equal(keyboardCopy, 'what is in here', 'and keyboard activation copies the same text')

    // The reasoning row: 24px tall, folded, titled, with two glyphs ready to swap.
    assert.equal(measured.reasoningClosed, true, 'reasoning is folded by default')
    assert.equal(measured.reasoningTitle, 'Think', 'its title is DSH\'s "Think"')
    assert.equal(measured.reasoningGlyphs, 2, 'it carries a kind icon and a chevron')
    assert.ok(
      measured.reasoningHeight >= 23 && measured.reasoningHeight <= 25,
      `the folded row is DSH\'s 24px (measured ${measured.reasoningHeight}px)`,
    )
    assert.equal(measured.chevronAtRest, '0', 'the chevron is hidden at rest')
    assert.equal(measured.kindAtRest, '1', 'and the kind icon is what shows')

    // The tool row: folded, DSH\'s phrase first, the tool's name as the hint.
    assert.equal(measured.toolClosed, true, 'a tool row is folded by default')
    assert.match(measured.toolSummary, /list_dir/, 'its title is the tool\'s own name, as DSH\'s "Bash" is')
    assert.match(measured.toolSummary, /shot-style-work|work/, 'and its hint is what the call acted on, as DSH\'s "Read · ~/.dsh/AGENTS.md"')
    assert.equal(measured.toolGlyphs, 2, 'it too carries a kind icon and a chevron')

    /**
     * The affordance swap, judged with a real mouse move rather than by reading the stylesheet: DSH shows the
     * chevron only while a person is on the row.
     */
    const point = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const el = document.querySelector('#log .turn.reasoning summary')
        const rect = el.getBoundingClientRect()
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
      })())`),
    )
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' })
    await new Promise((resolve) => setTimeout(resolve, 250))
    const hovered = JSON.parse(
      await browser.evaluate(`JSON.stringify({
        chevron: getComputedStyle(document.querySelector('#log .turn.reasoning summary .chevron')).opacity,
        kind: getComputedStyle(document.querySelector('#log .turn.reasoning summary .kind')).opacity,
      })`),
    )
    assert.equal(hovered.chevron, '1', 'hovering the row reveals the chevron')
    assert.equal(hovered.kind, '0', 'and puts the kind icon away')

    // Clicking the row opens it: the body arrives, the chevron stays and the summary becomes sticky.
    await browser.evaluate('document.querySelector("#log .turn.reasoning summary").click()')
    await browser.waitFor('document.querySelector("#log .turn.reasoning").open === true', 5_000)
    const openedState = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const reasoning = document.querySelector('#log .turn.reasoning')
        const line = reasoning.querySelector('summary')
        const body = reasoning.querySelector('[data-body]')
        return {
          open: reasoning.open,
          chevron: getComputedStyle(line.querySelector('.chevron')).opacity,
          bodyHeight: Math.round(body.getBoundingClientRect().height),
          sticky: getComputedStyle(line).position,
          bodyFont: getComputedStyle(body).fontSize,
          bodyLine: getComputedStyle(body).lineHeight,
        }
      })())`),
    )
    assert.equal(openedState.open, true, 'a click opens the folded row')
    assert.equal(openedState.chevron, '1', 'the chevron stays visible while open')
    assert.ok(openedState.bodyHeight > 0, 'the reasoning body is on screen')
    assert.equal(openedState.sticky, 'sticky', 'and the summary is sticky above its own body, as DSH\'s is')
    assert.equal(openedState.bodyFont, '13px', 'the reasoning body is 13px')
    assert.equal(openedState.bodyLine, '20px', 'on DSH\'s 20px reasoning line')

    await browser.evaluate('document.querySelector("#log .turn.reasoning summary").click()')
    await browser.waitFor('document.querySelector("#log .turn.reasoning").open === false', 5_000)

    // The tool row opens onto its two halves, in the answer's code surface.
    await browser.evaluate('document.querySelector("#log .turn.tool summary").click()')
    await browser.waitFor('document.querySelector("#log .turn.tool").open === true', 5_000)
    const toolOpened = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const tool = document.querySelector('#log .turn.tool')
        const args = tool.querySelector('[data-args]')
        const result = tool.querySelector('[data-result]')
        const argsStyle = args ? getComputedStyle(args) : null
        return {
          args: args ? args.textContent : null,
          result: result ? result.textContent : null,
          argsVisible: args ? Math.round(args.getBoundingClientRect().height) > 0 : false,
          radius: argsStyle ? argsStyle.borderRadius : null,
          preBg: argsStyle ? argsStyle.backgroundColor : null,
          preFont: argsStyle ? argsStyle.fontSize : null,
        }
      })())`),
    )
    assert.ok(toolOpened.argsVisible && toolOpened.args, 'the call\'s arguments are inside the opened row')
    assert.ok(toolOpened.result && toolOpened.result.includes('a.txt'), 'and so is what the tool answered')
    assert.equal(toolOpened.radius, '8px', 'a tool\'s halves sit on a rounded code surface')
    assert.equal(toolOpened.preFont, '12.5px', 'in the code size the answers use')

    /**
     * The same claim at a second width, because an alignment can be a width accident: a stretched block passes an
     * edge test at one width too. The reference is measured the same way — the bubble's shape must not depend on
     * the window — so this re-checks hug + flush edge at 1000px and 1600px.
     */
    const alignmentAt = async (width) => {
      await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
      await browser.waitFor(`window.innerWidth === ${width}`, 5_000)
      await new Promise((resolve) => setTimeout(resolve, 300))
      return JSON.parse(
        await browser.evaluate(`JSON.stringify((() => {
          const log = document.getElementById('log')
          const user = document.querySelector('#log .turn.user')
          const cs = getComputedStyle(log)
          const box = log.getBoundingClientRect()
          const ub = user.getBoundingClientRect()
          return {
            window: window.innerWidth,
            width: Math.round(ub.width),
            right: Math.round(ub.right),
            contentRight: Math.round(box.right - Number.parseFloat(cs.paddingRight)),
            contentWidth: Math.round(log.clientWidth - Number.parseFloat(cs.paddingLeft) - Number.parseFloat(cs.paddingRight)),
          }
        })())`),
      )
    }
    for (const width of [1000, 1600]) {
      const state = await alignmentAt(width)
      assert.equal(state.window, width, `the viewport is ${width}px`)
      assert.ok(
        state.width <= state.contentWidth - 20,
        `at ${width}px the bubble still hugs its text (${state.width} of ${state.contentWidth})`,
      )
      assert.ok(
        Math.abs(state.right - state.contentRight) <= 1,
        `at ${width}px it still ends on the column's right edge (${state.right} vs ${state.contentRight})`,
      )
    }
    await browser.send('Emulation.clearDeviceMetricsOverride')
  } finally {
    browser.close()
    await server.close()
  }
})

test('the column resizes like DSH: two grips, its default rule, a line that follows the pointer, and its floor', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH's resize is read from `ConversationWidthControls` and its CSS, not guessed: **two** 10px `col-resize`
   * handles, one 24px outside each edge of the text column; a 2px line that appears on hover, drawn around the
   * **pointer's Y**; `outward = side === "right" ? dx : -dx; width = base + outward * 2`; a floor of **640**; and
   * a default of `clamp(area × .64, 680, 920)`. The composer is the same column plus 32px, which part 9's
   * composer check already owns, so this test judges the grips themselves.
   */
  const server = await startServer('resize', (work) => [{ text: 'a wide answer so the column has a measurable row' }])
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    mkdirSync(server.work, { recursive: true })
    const cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
    const opened = await api(server.url, cookie, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: server.work }) })
    const turn = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a question', folder: server.work, session: opened.session?.id ?? opened.id }),
    })
    assert.equal(turn.status, 200, `the turn ran (${turn.status})`)
    await turn.text()

    await browser.goto(server.url)
    await browser.waitFor('document.querySelectorAll(".column-grip").length === 2', 20_000)

    const grips = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const area = document.querySelector('main')
        const column = Math.round(Number.parseFloat(getComputedStyle(area).getPropertyValue('--chat-column')))
        return {
          column,
          area: area.clientWidth,
          expectedDefault: Math.min(Number(document.querySelector('.column-grip').getAttribute('aria-valuemax')), Math.max(640, Math.round(window.innerWidth * 0.825))),
          grips: [...document.querySelectorAll('.column-grip')].map((grip) => ({
            side: grip.dataset.side, cursor: getComputedStyle(grip).cursor,
            width: Math.round(grip.getBoundingClientRect().width),
            line: getComputedStyle(grip, '::after').opacity,
            lineWidth: getComputedStyle(grip, '::after').width,
            aria: grip.getAttribute('role'), now: grip.getAttribute('aria-valuenow'),
          })),
        }
      })())`),
    )

    // DSH's pair: one grip on each side, both col-resize, both 10px-ish, both a separator.
    assert.deepEqual(grips.grips.map((grip) => grip.side).sort(), ['left', 'right'], 'there is a grip on each side of the column')
    for (const grip of grips.grips) {
      assert.equal(grip.cursor, 'col-resize', `the ${grip.side} grip is a column-resize grip`)
      assert.ok(grip.width >= 4 && grip.width <= 10, `it is a thin strip (${grip.width}px)`)
      assert.equal(grip.lineWidth, '2px', 'and its line is DSH\'s 2px')
      assert.equal(grip.line, '0', 'hidden at rest')
      assert.equal(grip.aria, 'separator', 'announced as a separator')
      assert.equal(grip.now, String(grips.column), 'and it reports the width in force')
    }
    assert.equal(grips.column, grips.expectedDefault, 'the default is 80–85% of the window, clamped to the view area')

    // The line appears under the pointer: DSH sets `--dsh-width-handle-pointer-y` while the pointer is on it.
    const point = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const grip = document.querySelector('.column-grip[data-side="right"]')
        const box = grip.getBoundingClientRect()
        return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + 120) }
      })())`),
    )
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const hovered = await browser.evaluate(`getComputedStyle(document.querySelector('.column-grip[data-side="right"]'), '::after').opacity`)
    assert.equal(hovered, '1', 'hovering the grip shows its line')
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, button: 'none' })

    /**
     * The left grip drags **outward**: pulling it left widens the column, which is DSH's `-dx` branch. A drag
     * that grew when pulled left would be the sign the side was not read.
     */
    const drag = async (side, dx) =>
      JSON.parse(
        await browser.evaluate(`JSON.stringify((() => {
          const grip = document.querySelector('.column-grip[data-side="${side}"]')
          const box = grip.getBoundingClientRect()
          const startX = box.x + box.width / 2
          grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: startX, clientY: 400, button: 0, pointerId: 3 }))
          window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: startX + ${dx}, clientY: 400, pointerId: 3 }))
          const during = { gripY: grip.style.getPropertyValue('--grip-y'), dragging: grip.dataset.dragging }
          window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: startX + ${dx}, clientY: 400, pointerId: 3 }))
          const area = document.querySelector('main')
          return {
            during,
            column: Math.round(Number.parseFloat(getComputedStyle(area).getPropertyValue('--chat-column'))),
            stored: Number.parseInt(localStorage.getItem('heddle.chatColumn') ?? '0', 10),
          }
        })())`),
      )
    /** Narrow first: the default now sits at the ceiling, so there has to be room before widening proves anything. */
    const narrowed = await drag('right', -60)
    assert.equal(narrowed.column, grips.column - 120, 'an inward drag narrows by twice the travel, both edges moving')
    assert.match(narrowed.during.gripY, /^\d+px$/, 'and the grip line follows the pointer while dragging')
    assert.equal(narrowed.during.dragging, 'true', 'the grip says it is being dragged')
    assert.equal(narrowed.stored, narrowed.column, 'the width is committed on release')

    const widened = await drag('left', -30)
    assert.equal(widened.column, narrowed.column + 60, 'pulling the left grip left widens by twice the travel, as DSH does')

    const floored = await drag('right', -400)
    assert.equal(floored.column, 640, 'and the floor is DSH\'s 640')

    /**
     * The owner asked for the size to be remembered in the browser. It is a `localStorage` preference committed on
     * release, so this is judged where a person would notice it: reload and read the column back.
     */
    await browser.goto(server.url)
    await browser.waitFor('document.querySelectorAll(".column-grip").length === 2', 20_000)
    const remembered = await browser.evaluate(
      'Math.round(Number.parseFloat(getComputedStyle(document.querySelector("main")).getPropertyValue("--chat-column")))',
    )
    assert.equal(remembered, 640, 'and the chosen width survives a reload')

    /**
     * A remembered width **below the floor** is raised to it, which is DSH's own rule for a persisted preference:
     * `resolveContentWidth` returns `Math.min(Math.max(preference, CONTENT_MIN), max)`. Measured on DSH's live page:
     * a stored 500px came back as `--dsh-chat-content-width: 640px` (and its markdown block measured 640). Heddle
     * shares that floor, and this is the path that would silently differ if someone lowered the clamp later.
     */
    await browser.evaluate('localStorage.setItem("heddle.chatColumn", "300")')
    await browser.goto(server.url)
    await browser.waitFor('document.querySelectorAll(".column-grip").length === 2', 20_000)
    const raised = await browser.evaluate(
      'Math.round(Number.parseFloat(getComputedStyle(document.querySelector("main")).getPropertyValue("--chat-column")))',
    )
    assert.equal(raised, 640, 'a stored width below the floor is raised to DSH\'s 640')

    /**
     * The owner asked for the rail to have room rather than the conversation crowding against it on a wide chat.
     * At the column's **maximum** the transcript's margin from the log's right edge must exceed what the rail
     * occupies (its 30px width plus its 4px inset) by the reserved gutter — that is what `columnMax` subtracts in
     * addition to the grips' budget. Measured arithmetically rather than from the rail's box, because the rule holds
     * whether or not the rail is currently shown, and a hidden rail would measure as an empty box.
     */
    await browser.evaluate('localStorage.setItem("heddle.chatColumn", "9999")')
    await browser.goto(server.url)
    await browser.waitFor('document.querySelector("#log .turn") !== null', 20_000)
    const gutter = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const log = document.getElementById('log')
        const area = document.querySelector('main')
        const railStyle = getComputedStyle(document.getElementById('minimap'))
        const column = Math.round(Number.parseFloat(getComputedStyle(area).getPropertyValue('--chat-column')))
        const max = Number(document.querySelector('.column-grip').getAttribute('aria-valuemax'))
        const railOccupy = Number.parseFloat(railStyle.width) + Number.parseFloat(railStyle.right)
        return {
          column,
          max,
          reservedGap: Math.round((log.clientWidth - column) / 2 - railOccupy),
          railOccupy: Math.round(railOccupy),
        }
      })())`),
    )
    assert.equal(gutter.column, gutter.max, 'the stored width above the maximum lands at it')
    assert.ok(
      gutter.reservedGap >= 40,
      `at the maximum the transcript keeps a gap before the rail (${gutter.reservedGap}px beyond the rail's ${gutter.railOccupy}px)`,
    )
    await browser.evaluate('localStorage.removeItem("heddle.chatColumn")')
  } finally {
    browser.close()
    await server.close()
  }
})

test('the conversation minimap follows the reference: rows, a bright window, a hover swell and a jump', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * The measured element is `nav[aria-label="Conversation minimap"]` on the reference, read while it ran: one 12px row per
   * message, a 12px bar whose thickness encodes the message's size, resting opacities of 0.33 (user) and 0.267
   * (assistant), the visible window brightened with feathered edges, and on hover a ±4-row swell reaching opacity 1
   * and `scaleX` 2.1 / `scaleY` 1.5, with a 300×81 `#242424` preview card to the left of the rail.
   *
   * The conversation is made long on purpose, because the scroll window is only observable when the transcript
   * actually scrolls; a fixture that fits on one screen would let a broken scrollspy pass.
   */
  const answer = 'word '.repeat(140)
  /**
   * Four exchanges use a reasoning step and a tool call, four do not. The rail's unit is the **section** (the
   * person's message and the answer), so this fixture has 24 `.turn` elements but must produce 16 rows: a rail built
   * per turn would show 24, which is the tool-grained structure the owner reported.
   */
  const server = await startServer('minimap', (work) => [
    { reasoning: 'I should look before answering.', toolCall: { name: 'list_dir', arguments: { path: work } } },
    { text: 'first answer ' + answer },
    { reasoning: 'I should look before answering.', toolCall: { name: 'list_dir', arguments: { path: work } } },
    { text: 'second answer ' + answer },
    { reasoning: 'I should look before answering.', toolCall: { name: 'list_dir', arguments: { path: work } } },
    { text: 'third answer ' + answer },
    { reasoning: 'I should look before answering.', toolCall: { name: 'list_dir', arguments: { path: work } } },
    { text: 'fourth answer ' + answer },
    { text: 'fifth answer ' + answer },
    { text: 'sixth answer ' + answer },
    { text: 'seventh answer ' + answer },
    { text: 'eighth answer ' + answer },
  ])
  const browser = await openBrowser({ width: 1400, height: 900 })
  try {
    mkdirSync(server.work, { recursive: true })
    const cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
    const opened = await api(server.url, cookie, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: server.work }) })
    const session = opened.session?.id ?? opened.id
    for (let turn = 0; turn < 8; turn += 1) {
      const response = await fetch(new URL('/api/turn', server.url), {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: `question ${turn + 1}`, folder: server.work, session }),
      })
      assert.equal(response.status, 200, `turn ${turn + 1} ran (${response.status})`)
      await response.text()
    }

    await browser.goto(server.url)
    await browser.waitFor('document.querySelectorAll("#log > .turn").length >= 24', 25_000)
    await browser.waitFor('document.getElementById("minimap") !== null && !document.getElementById("minimap").hidden', 10_000)
    await browser.waitFor('document.querySelectorAll("#minimap .mm-row").length > 0', 10_000)
    /** The rail fades in over .24s — a state that exists before the animation has run is not "faded in". */
    await browser.waitFor('document.getElementById("minimap").dataset.visible === "true"', 10_000)
    await new Promise((resolve) => setTimeout(resolve, 400))

    const shape = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const bars = [...document.querySelectorAll('#minimap .mm-bar')]
        const rail = document.getElementById('minimap')
        const rows = [...document.querySelectorAll('#minimap .mm-row')]
        return {
          turns: document.querySelectorAll('#log > .turn').length,
          rows: rows.length,
          bars: bars.length,
          roleCounts: bars.reduce((all, bar) => { all[bar.dataset.role] = (all[bar.dataset.role] || 0) + 1; return all }, {}),
          heights: bars.map((bar) => Number.parseFloat(getComputedStyle(bar).height)),
          visible: rail.dataset.visible,
          opacity: getComputedStyle(rail).opacity,
          label: document.getElementById('minimap-hit').getAttribute('aria-label'),
          railBox: { w: Math.round(rail.getBoundingClientRect().width), right: Math.round(document.getElementById('log').getBoundingClientRect().right - rail.getBoundingClientRect().right) },
          rowHeights: [...new Set(rows.map((row) => getComputedStyle(row).height))],
        }
      })())`),
    )
    /**
     * Section level, as the reference is: 8 exchanges make 16 rows (8 user + 8 answer) even though the transcript
     * holds 24 turns because four exchanges also have a reasoning row and a tool row. A per-turn rail would report
     * 24 rows and two tool/role keys.
     */
    assert.ok(shape.turns >= 24, `the transcript has more turns than sections once the tool steps are in (${shape.turns})`)
    assert.equal(shape.rows, 16, `but the rail has one row per section (${shape.rows})`)
    /**
     * The server marks the page with the hash of the document's original bytes, computed when it serves it.
     * The source has an `unbuilt` placeholder, not a rail-specific version label. Compare with the exact build
     * this fixture starts — `src/server/page.html`, the source of the one page both builds serve (`dist/` holds
     * the TypeScript build's copy); accepting any hash would not distinguish a current page from a stale one.
     */
    const pageBuild = createHash('sha256')
      .update(readFileSync(join(repoRoot, 'src', 'server', 'page.html')))
      .digest('hex')
      .slice(0, 12)
    assert.equal(
      await browser.evaluate('document.querySelector(\'meta[name="heddle-page"]\')?.content ?? ""'),
      pageBuild,
      'the page states the exact build served by the fixture, so a stale page cannot pass silently',
    )
    assert.deepEqual(shape.roleCounts, { user: 8, assistant: 8 }, `and only the person's and the answer's roles (${JSON.stringify(shape.roleCounts)})`)
    /**
     * **No chat scrollbar.** The reference's transcript paints its scrollbar transparent (6px in the box model, stable
     * gutter) so nothing slides over the text; heddle was on the platform overlay bar, which appeared on every
     * scroll — the owner's distraction. The rail scrubs, so the bar is redundant: measure that the scroller reports
     * no scrollbar at rest, and the same after a scroll.
     */
    const scrollbar = async () =>
      JSON.parse(
        await browser.evaluate(`JSON.stringify((() => {
          const log = document.getElementById('log')
          const pseudo = getComputedStyle(log, '::-webkit-scrollbar')
          return {
            scrollbarWidth: getComputedStyle(log).scrollbarWidth,
            gutter: log.offsetWidth - log.clientWidth,
            display: pseudo.display,
            scrollTop: Math.round(log.scrollTop),
          }
        })())`),
      )
    const scrollbarAtRest = await scrollbar()
    assert.equal(scrollbarAtRest.scrollbarWidth, 'none', 'the chat scroller declares no scrollbar')
    assert.equal(scrollbarAtRest.gutter, 0, `and reserves no scrollbar gutter (${scrollbarAtRest.gutter}px)`)
    assert.equal(scrollbarAtRest.display, 'none', 'its webkit scrollbar is not displayed')
    await browser.evaluate('document.getElementById("log").scrollTop = 400')
    await new Promise((resolve) => setTimeout(resolve, 250))
    const scrollbarScrolled = await scrollbar()
    assert.ok(scrollbarScrolled.scrollTop > 0, `the transcript still scrolls without a visible bar (${scrollbarScrolled.scrollTop})`)
    assert.equal(scrollbarScrolled.gutter, 0, 'and the gutter stays at zero while scrolled')
    await browser.evaluate('document.getElementById("log").scrollTop = 0')
    await new Promise((resolve) => setTimeout(resolve, 200))
    /**
     * The unit is the **section**, not the turn: the old assertion pinned "one row per displayed turn", which is
     * exactly the tool-grained structure the owner reported. The reference's unit is the user message and the
     * answer (measured 5 user + 5 assistant rows over a 27-row conversation with no tool or reasoning rows).
     */
    assert.ok(shape.rows < shape.turns, `the rail is coarser than the turn list (${shape.rows} rows for ${shape.turns} turns)`)
    assert.equal(shape.bars, shape.rows, 'one bar per row')
    assert.ok(shape.roleCounts.user > 0 && shape.roleCounts.assistant > 0, 'the person and the answer are both on the rail')
    assert.equal(shape.visible, 'true', 'the rail says it is visible')
    assert.ok(Number(shape.opacity) > 0.9, `and it has faded in (${shape.opacity})`)
    assert.equal(shape.railBox.w, 30, 'the rail is 30px wide, as measured')
    assert.equal(shape.railBox.right, 4, 'and 4px from the chat log\'s right edge')
    assert.deepEqual(shape.rowHeights, ['12px'], 'each row is 12px, as measured')
    for (const height of shape.heights) assert.ok(height >= 1.5 && height <= 6.5, `a bar's thickness encodes its message (${height})`)
    assert.match(shape.label, new RegExp(`Conversation minimap, ${shape.rows} messages`), 'the label counts the rows, as the reference does')
    assert.match(shape.label, /arrow keys/, 'and teaches the keyboard shortcut')
    assert.ok(new Set(shape.heights.map((height) => height.toFixed(1))).size > 1, 'thickness varies with the turn')

    /** The scroll window: some rows bright, some at rest — and the bright set moves when the transcript scrolls. */
    const litAt = async () => JSON.parse(await browser.evaluate(`JSON.stringify([...document.querySelectorAll('#minimap .mm-bar')].map((bar) => Number.parseFloat(getComputedStyle(bar).opacity)))`))
    const topLit = await litAt()
    assert.ok(topLit.some((value) => value > 0.9), 'turns on screen are bright')
    assert.ok(topLit.some((value) => value < 0.4), 'turns off screen are at rest')
    await browser.evaluate('document.getElementById("log").scrollTop = document.getElementById("log").scrollHeight')
    await new Promise((resolve) => setTimeout(resolve, 350))
    const bottomLit = await litAt()
    assert.ok(bottomLit.slice(-3).some((value) => value > 0.9), 'after scrolling, the bright window is at the end')
    assert.ok(bottomLit.slice(0, 3).some((value) => value < 0.4), 'and the start has gone quiet')

    /**
     * No hover means **no fat bars**. This is the regression the owner caught: the no-hover sentinel used to be
     * `MM_HOVER_SPAN + 1`, which the painter could not tell from a hover at that row, so a fresh page drew a
     * permanent fat band around the rail's middle and it never moved with the scroll. The reference behaves the
     * other way — reloaded, with no pointer on the rail, its scrolled states at 0/25/50/75/100% all keep every
     * bar's `scaleX` at 1 (measured 2026-10-17).
     */
    const barScales = async () =>
      JSON.parse(
        await browser.evaluate(
          `JSON.stringify([...document.querySelectorAll('#minimap .mm-bar')].map((bar) => { const m = /matrix\\(([-\\d.]+)/.exec(getComputedStyle(bar).transform); return m ? Number(Number(m[1]).toFixed(2)) : 1 }))`,
        ),
      )
    for (const fraction of [0, 0.5, 1]) {
      await browser.evaluate(
        `document.getElementById('log').scrollTop = (document.getElementById('log').scrollHeight - document.getElementById('log').clientHeight) * ${fraction}`,
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
      const scales = await barScales()
      assert.ok(
        scales.every((sx) => sx === 1),
        `no fat band without a hover, at scroll ${fraction} (${scales.map((sx) => sx.toFixed(1)).join(',')})`,
      )
    }
    await browser.evaluate('document.getElementById("log").scrollTop = 0')
    await new Promise((resolve) => setTimeout(resolve, 200))

    /**
     * Synced scroll, the owner's new request: scrolling the **main chat** must move the rail's bright window too,
     * the same way the reference's does (measured there by setting its scroller to 0 / 35% / 70% / 100% and reading the
     * opacity window move each time). Programmatic `scrollTop` is not enough to judge it — the report was about the
     * wheel — so this uses a **trusted wheel event** through the browser's input pipeline at a point over the
     * transcript, then checks both that the chat scrolled and that the window moved.
     */
    await browser.evaluate('document.getElementById("log").scrollTop = 0')
    await new Promise((resolve) => setTimeout(resolve, 250))
    const litStart = await litAt()
    const logBox = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => { const box = document.getElementById('log').getBoundingClientRect(); return { x: Math.round(box.left + box.width / 3), y: Math.round(box.top + box.height / 2) } })())`),
    )
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: logBox.x, y: logBox.y, deltaX: 0, deltaY: 900 })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const wheelState = JSON.parse(
      await browser.evaluate(`JSON.stringify({ scrollTop: Math.round(document.getElementById('log').scrollTop), lit: [...document.querySelectorAll('#minimap .mm-bar')].map((bar) => Number.parseFloat(getComputedStyle(bar).opacity)) })`),
    )
    assert.ok(wheelState.scrollTop > 0, `the wheel scrolled the transcript (${wheelState.scrollTop})`)
    assert.ok(
      wheelState.lit.some((value, index) => value > 0.9 && litStart[index] <= 0.35),
      `and the rail's bright window moved with it (before ${litStart.map((v) => v.toFixed(2)).join(',')} / after ${wheelState.lit.map((v) => v.toFixed(2)).join(',')})`,
    )
    await browser.evaluate('document.getElementById("log").scrollTop = 0')
    await new Promise((resolve) => setTimeout(resolve, 200))

    /** Hover: the neighbourhood swells, the hovered bar reaches scaleX > 1.5 and opacity 1, and a preview appears. */
    const rowPoint = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const rows = [...document.querySelectorAll('#minimap .mm-row')]
        const row = rows[Math.min(3, rows.length - 1)]
        const box = row.getBoundingClientRect()
        return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2), index: rows.indexOf(row) }
      })())`),
    )
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowPoint.x, y: rowPoint.y, button: 'none' })
    /**
     * The expansion is **instant** in the reference — its bars compute `transition: all 0s` — so reading the swell
     * immediately after the pointer arrives must already show the final ramp. An eased swell (heddle was .18s) reads
     * ~1.0-1.3 here, which is the sluggishness the owner reported.
     */
    const instant = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const bars = [...document.querySelectorAll('#minimap .mm-bar')]
        const bar = bars[${rowPoint.index}]
        const cs = getComputedStyle(bar)
        const m = /matrix\\(([-\\d.]+)/.exec(cs.transform)
        return { scale: m ? Number(Number(m[1]).toFixed(2)) : 1, transitionProperty: cs.transitionProperty, transitionDuration: cs.transitionDuration }
      })())`),
    )
    assert.ok(instant.scale >= 1.95, `the swell is already at its ramp in the frame the pointer arrives (${instant.scale})`)
    assert.ok(!instant.transitionProperty.includes('transform'), `and the bar carries no transform transition (${instant.transitionProperty})`)
    await new Promise((resolve) => setTimeout(resolve, 320))
    const hovered = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const bars = [...document.querySelectorAll('#minimap .mm-bar')]
        const index = ${rowPoint.index}
        const preview = document.getElementById('minimap-preview')
        const read = (bar) => ({ o: Number.parseFloat(getComputedStyle(bar).opacity), t: getComputedStyle(bar).transform })
        return {
          hovered: read(bars[index]),
          near: read(bars[Math.min(bars.length - 1, index + 1)]),
          far: read(bars[Math.max(0, index - 4)]),
          previewVisible: !preview.hidden && preview.dataset.visible === 'true',
          previewText: (preview.textContent || '').trim().slice(0, 80),
          previewWidth: Math.round(preview.getBoundingClientRect().width),
          previewBg: getComputedStyle(preview).backgroundColor,
          previewRadius: getComputedStyle(preview).borderRadius,
        }
      })())`),
    )
    assert.ok(hovered.hovered.o > 0.9, `the hovered bar is at full strength (${hovered.hovered.o})`)
    assert.match(hovered.hovered.t, /matrix\(2\.0|matrix\(2\.1/, `it swells horizontally to about 2.1x (${hovered.hovered.t})`)
    assert.ok(hovered.near.o > hovered.far.o, 'the swell falls off with distance')
    /**
     * The ramp is **linear over five rows** on the reference: the hovered bar 2.1, then 1.88 / 1.66 / 1.44 / 1.22,
     * and the sixth row back at 1. Heddle's floored falloff used to keep the fourth row at 1.53, a visibly wider
     * band; this measures every offset so a changed formula cannot pass on the peak alone.
     */
    const ramp = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const bars = [...document.querySelectorAll('#minimap .mm-bar')]
        const peak = ${rowPoint.index}
        const scale = (bar) => { const m = /matrix\\(([-\\d.]+)/.exec(getComputedStyle(bar).transform); return m ? Number(Number(m[1]).toFixed(2)) : 1 }
        const at = (offset) => { const bar = bars[peak + offset]; return bar ? scale(bar) : 1 }
        return { m4: at(-4), m3: at(-3), m2: at(-2), m1: at(-1), peak: at(0), p1: at(1), p2: at(2), p3: at(3), p4: at(4), p5: at(5) }
      })())`),
    )
    for (const [key, expected] of [['m1', 1.88], ['p1', 1.88], ['m2', 1.66], ['p2', 1.66], ['m3', 1.44], ['p3', 1.44], ['m4', 1.22], ['p4', 1.22]]) {
      if (key.startsWith('m') && ramp[key] === 1) continue // the row may not exist at the rail's top edge
      assert.ok(Math.abs(ramp[key] - expected) <= 0.02, `the ${key} row swells to ${expected}x, the reference's linear ramp (${ramp[key]})`)
    }
    assert.equal(ramp.peak, 2.1, 'and the hovered row is the reference\'s 2.1x')
    if (ramp.p5 !== 1) assert.ok(Math.abs(ramp.p5 - 1) <= 0.02, `the row five away is back at 1x (${ramp.p5})`)
    assert.equal(hovered.previewVisible, true, 'a preview card appears')
    assert.ok(hovered.previewText.length > 2, `with the turn's text (${hovered.previewText})`)
    assert.equal(hovered.previewWidth, 300, 'at the reference width of 300px')
    assert.equal(hovered.previewBg, 'rgb(36, 36, 36)', 'on the reference surface')
    assert.equal(hovered.previewRadius, '8px', 'at the reference radius')
    /**
     * Presence without movement does **not** expand on the reference: the reference was measured with a
     * `pointerover` + `pointerenter` and no `pointermove`, and every bar stayed at scale 1; the swell arrives with
     * the first move. Heddle painted on entry for a while, which was a deviation from the reference, so this now
     * asserts the reference's behaviour.
     */
    await browser.evaluate('document.getElementById("minimap-hit").dispatchEvent(new PointerEvent("pointerleave", { bubbles: true, pointerId: 31, pointerType: "mouse" }))')
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 300, button: 'none' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const presenceScales = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const rows = [...document.querySelectorAll('#minimap .mm-row')]
        const row = rows[5]
        const box = row.getBoundingClientRect()
        const hit = document.getElementById('minimap-hit')
        for (const type of ['pointerover', 'pointerenter', 'mouseover']) hit.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: Math.round(box.left + 6), clientY: Math.round(box.top + box.height / 2), pointerId: 31, pointerType: 'mouse', isPrimary: true }))
        return [...document.querySelectorAll('#minimap .mm-bar')].map((bar) => { const m = /matrix\\(([-\\d.]+)/.exec(getComputedStyle(bar).transform); return m ? Number(Number(m[1]).toFixed(2)) : 1 })
      })())`),
    )
    assert.ok(presenceScales.every((scale) => scale === 1), `presence alone does not expand the rail (${presenceScales.map((scale) => scale.toFixed(1)).join(',')})`)
    await browser.evaluate('document.getElementById("minimap-hit").dispatchEvent(new PointerEvent("pointerleave", { bubbles: true, pointerId: 31, pointerType: "mouse" }))')

    /**
     * The fat band's driver is the **pointer**, not the scroll position; the bright window's driver is the scroll.
     * Measured on the reference: hovering row 6 swells rows 2-10 and a programmatic scroll leaves that swelling
     * where the pointer is, while the opacity window moves. Heddle now has to show the same split — the owner's
     * report was precisely "the highlight follows, the fat does not", which is correct when a pointer holds it.
     */
    const rail = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => { const box = document.getElementById('minimap-rows').getBoundingClientRect(); return { x: Math.round(box.left + 15), top: Math.round(box.top), height: Math.round(box.height) } })())`),
    )
    const yOfRow = (index) => rail.top + 4 + index * 12 + 6
    const farIndex = Math.max(0, 16 - 1)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rail.x, y: yOfRow(farIndex), button: 'none' })
    await new Promise((resolve) => setTimeout(resolve, 320))
    const movedFat = await browser.evaluate(
      `JSON.stringify((() => { const bars = [...document.querySelectorAll('#minimap .mm-bar')]; const scale = (bar) => { const m = /matrix\\(([-\\d.]+)/.exec(getComputedStyle(bar).transform); return m ? Number(Number(m[1]).toFixed(2)) : 1 }; return { old: scale(bars[3]), far: scale(bars[${farIndex}]) } })())`,
    )
    assert.equal(JSON.parse(movedFat).old, 1, 'the row the pointer left is no longer fat')
    assert.ok(JSON.parse(movedFat).far > 1.5, `the row the pointer moved to swells (${JSON.parse(movedFat).far})`)

    /** Leaving the rail puts every bar back: the band is the pointer's, and it goes away with the pointer. */
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rail.x - 200, y: 300, button: 'none' })
    await new Promise((resolve) => setTimeout(resolve, 320))
    const afterLeave = await barScales()
    assert.ok(afterLeave.every((sx) => sx === 1), `and leaving the rail clears the band (${afterLeave.map((sx) => sx.toFixed(1)).join(',')})`)

    /** A hover held while the transcript scrolls: the band stays where the pointer is, the window moves. */
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rail.x, y: yOfRow(3), button: 'none' })
    await new Promise((resolve) => setTimeout(resolve, 320))
    const heldBefore = JSON.parse(
      await browser.evaluate(`JSON.stringify({ fat: (() => { const bar = document.querySelectorAll('#minimap .mm-bar')[3]; const m = /matrix\\(([-\\d.]+)/.exec(getComputedStyle(bar).transform); return m ? Number(Number(m[1]).toFixed(2)) : 1 })(), lit: [...document.querySelectorAll('#minimap .mm-bar')].map((bar) => Number.parseFloat(getComputedStyle(bar).opacity)) })`),
    )
    await browser.evaluate('document.getElementById("log").scrollTop = (document.getElementById("log").scrollHeight - document.getElementById("log").clientHeight) * 0.6')
    await new Promise((resolve) => setTimeout(resolve, 400))
    const heldAfter = JSON.parse(
      await browser.evaluate(`JSON.stringify({ fat: (() => { const bar = document.querySelectorAll('#minimap .mm-bar')[3]; const m = /matrix\\(([-\\d.]+)/.exec(getComputedStyle(bar).transform); return m ? Number(Number(m[1]).toFixed(2)) : 1 })(), lit: [...document.querySelectorAll('#minimap .mm-bar')].map((bar) => Number.parseFloat(getComputedStyle(bar).opacity)) })`),
    )
    assert.equal(heldAfter.fat, heldBefore.fat, 'a held pointer keeps its swelling while the transcript scrolls')
    assert.ok(
      heldAfter.lit.some((value, index) => value > 0.9 && heldBefore.lit[index] <= 0.35),
      'and the bright window still moved with the scroll',
    )
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rail.x - 200, y: 300, button: 'none' })
    await browser.evaluate('document.getElementById("log").scrollTop = 0')
    await new Promise((resolve) => setTimeout(resolve, 250))


    /**
     * Scrubbing, which is the difference the owner spotted: on the reference, moving the pointer over the rail
     * **scrolls the transcript**, continuously rather than snapped to messages. Measured there: two points inside
     * one 12px row (y 506 / 510 / 515) landed on 3443 / 3552 / 3689 — about 27.3 scroll pixels per rail pixel — and
     * `maxScroll / railHeight` is 9072 / 332 = 27.3, so the mapping is
     * `scrollTop = ((y − railTop) / railHeight) × maxScroll`. It applies on pointermove only, is final in the same
     * tick (no easing), and the transcript stays where the pointer left it.
     *
     * The check reads `scrollTop` in the same task as the event, which is what makes "instant" falsifiable — an
     * animated scrub would still be at the old offset here.
     */
    const scrubTo = async (fraction) =>
      JSON.parse(
        await browser.evaluate(`JSON.stringify((() => {
          const rail = document.getElementById('minimap-rows')
          const box = rail.getBoundingClientRect()
          const log = document.getElementById('log')
          const max = log.scrollHeight - log.clientHeight
          const y = box.top + box.height * ${fraction}
          const before = Math.round(log.scrollTop)
          document.getElementById('minimap-hit').dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: box.left + 6, clientY: Math.round(y), pointerId: 7, pointerType: 'mouse', isPrimary: true }))
          const immediate = Math.round(log.scrollTop)
          return { before, immediate, max, railHeight: Math.round(box.height), expected: Math.round(((Math.round(y) - box.top) / box.height) * max) }
        })())`),
      )
    const scrubLow = await scrubTo(0.15)
    const scrubHigh = await scrubTo(0.85)
    assert.ok(scrubHigh.immediate > scrubLow.immediate + 100, `moving down the rail scrolls the transcript down (${scrubLow.immediate} -> ${scrubHigh.immediate})`)
    /**
     * Proportional to the pointer, with the expectation computed from the **rounded** Y the handler received —
     * comparing against the intended fraction was off by a few pixels, which is the test being wrong, not the scrub.
     */
    assert.ok(
      Math.abs(scrubLow.immediate - scrubLow.expected) <= 1 && Math.abs(scrubHigh.immediate - scrubHigh.expected) <= 1,
      `the scroll is proportional to the pointer (15% -> ${scrubLow.immediate}, expected ${scrubLow.expected}; 85% -> ${scrubHigh.immediate}, expected ${scrubHigh.expected})`,
    )

    /** Continuous, not row-snapped: two points 4px apart **inside one row** must move the transcript. */
    const withinRow = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const rail = document.getElementById('minimap-rows')
        const box = rail.getBoundingClientRect()
        const log = document.getElementById('log')
        const hit = document.getElementById('minimap-hit')
        const fire = (y) => hit.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: box.left + 6, clientY: Math.round(y), pointerId: 7, pointerType: 'mouse', isPrimary: true }))
        const y0 = box.top + box.height * 0.5
        fire(y0)
        const first = Math.round(log.scrollTop)
        fire(y0 + 4)
        const second = Math.round(log.scrollTop)
        const max = log.scrollHeight - log.clientHeight
        return { first, second, max, railHeight: Math.round(box.height) }
      })())`),
    )
    assert.ok(withinRow.second > withinRow.first, `4px inside the same row moves the scroll (${withinRow.first} -> ${withinRow.second}), so it is continuous not snapped`)
    const ratio = (withinRow.second - withinRow.first) / 4
    const expectedRatio = withinRow.max / withinRow.railHeight
    assert.ok(
      Math.abs(ratio - expectedRatio) <= expectedRatio * 0.25,
      `and by the rail-to-scroll ratio (${ratio.toFixed(1)} vs ${expectedRatio.toFixed(1)} pixels per rail pixel)`,
    )

    /** It stays where the pointer left it, as the reference does. */
    await browser.evaluate(`document.getElementById('minimap-hit').dispatchEvent(new PointerEvent('pointerleave', { bubbles: true, pointerId: 7, pointerType: 'mouse' }))`)
    await new Promise((resolve) => setTimeout(resolve, 120))
    const afterScrubLeave = await browser.evaluate('Math.round(document.getElementById("log").scrollTop)')
    assert.equal(afterScrubLeave, withinRow.second, 'and the transcript stays where the pointer left it')

    /** A click jumps: the first row takes the transcript to the top, the last row takes it down. */
    await browser.evaluate('document.getElementById("log").scrollTop = 0')
    await new Promise((resolve) => setTimeout(resolve, 200))
    const clickRow = async (index) => {
      await browser.evaluate(`(() => {
        const rows = [...document.querySelectorAll('#minimap .mm-row')]
        const row = rows[${index}]
        const box = row.getBoundingClientRect()
        document.getElementById('minimap-hit').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: box.left + 6, clientY: box.top + box.height / 2 }))
      })()`)
      await new Promise((resolve) => setTimeout(resolve, 700))
      return browser.evaluate('Math.round(document.getElementById("log").scrollTop)')
    }
    const jumpedDown = await clickRow(7)
    assert.ok(jumpedDown > 100, `clicking the last row scrolls the transcript down (${jumpedDown})`)
    const jumpedUp = await clickRow(0)
    assert.ok(jumpedUp < jumpedDown / 2, `clicking the first row takes it back to the top (${jumpedUp})`)

    /** The keyboard, as its label promises: an arrow previews, Enter jumps. */
    await browser.evaluate('document.getElementById("log").scrollTop = 0; document.getElementById("minimap-hit").focus()')
    await browser.evaluate(`document.getElementById('minimap-hit').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`)
    await new Promise((resolve) => setTimeout(resolve, 250))
    const keyboardPreview = await browser.evaluate('!document.getElementById("minimap-preview").hidden')
    assert.equal(keyboardPreview, true, 'an arrow key previews a message')
    await browser.evaluate(`document.getElementById('minimap-hit').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
    await new Promise((resolve) => setTimeout(resolve, 700))
    const afterEnter = await browser.evaluate('Math.round(document.getElementById("log").scrollTop)')
    assert.ok(afterEnter >= 0, 'and Enter jumps without error')
  } finally {
    browser.close()
    await server.close()
  }
})

test('a finished turn shows the edited files as one summary: single name, or a folded list of four', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * The reference is DSH's `ChangedFiles` card (`dsh-client-ui-deliverables`), measured from its own module CSS and
   * component: a single edited file renders only the header, titled `Edited {name}`; several render
   * `Edited {count} files`, then the first **four** rows, then a toggle labelled `All {count} files`; the header
   * opens the first change and a row opens that file. Heddle's files come from its own log — a `write_file` call's
   * path and the lines its content carried — so the card is output-complete, not a host-side before/after snapshot.
   *
   * The scripted fixture replays its steps for each turn, so each case gets its own server rather than a second
   * exchange inside one: the multi-file case, the single-file case, and the no-writes case.
   */
  const multi = await startServer('edits-many', (work) => [
    ...['a', 'b', 'c', 'd', 'e', 'f'].map((letter) => ({
      toolCall: { name: 'write_file', arguments: { path: join(work, `${letter}.txt`), content: 'x\n' } },
      reasoning: `writing ${letter}.txt`,
    })),
    { text: 'wrote six files' },
  ])
  const single = await startServer('edits-one', (work) => [
    { toolCall: { name: 'write_file', arguments: { path: join(work, 'a.txt'), content: 'one\ntwo\nthree\n' } }, reasoning: 'writing a.txt' },
    { text: 'wrote one file' },
  ])
  const plain = await startServer('edits-none', () => [{ text: 'just an answer, no files' }])
  const browser = await openBrowser()
  const runTurn = async (server, prompt) => {
    mkdirSync(server.work, { recursive: true })
    const cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
    const opened = await api(server.url, cookie, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: server.work }) })
    const session = opened.body.session?.id ?? opened.body.id
    const turn = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, folder: server.work, session }),
    })
    assert.equal(turn.status, 200, `the ${prompt} turn ran (${turn.status})`)
    await turn.text()
    await browser.goto(server.url)
    await browser.waitFor('document.querySelector("#log .turn.assistant") !== null', 25_000)
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  try {
    await runTurn(multi, 'write six files')
    const card = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const answer = document.querySelector('#log .turn.assistant')
        const panel = answer.querySelector('[data-changed-files]')
        const rows = panel ? [...panel.querySelectorAll('.changed-row')] : []
        const toggle = panel ? panel.querySelector('.changed-toggle') : null
        return {
          hasCard: panel !== null,
          title: panel ? panel.querySelector('.changed-title').textContent : null,
          counts: panel ? panel.querySelector('.changed-counts').textContent : null,
          rows: rows.length,
          firstPath: rows[0] ? rows[0].querySelector('.changed-path').textContent : null,
          firstPlus: rows[0] ? rows[0].querySelector('.changed-plus').textContent : null,
          toggleText: toggle ? toggle.textContent : null,
          toggleExpanded: toggle ? toggle.getAttribute('aria-expanded') : null,
          headHeight: panel ? Math.round(panel.querySelector('.changed-head').getBoundingClientRect().height) : null,
          tile: panel ? Math.round(panel.querySelector('.changed-tile').getBoundingClientRect().width) : null,
        }
      })())`),
    )
    assert.equal(card.hasCard, true, 'a finished turn with writes shows the edited-files card')
    assert.equal(card.title, 'Edited 6 files', `the title counts the files the reference's way (${card.title})`)
    assert.match(String(card.counts), /^\+6$/, `the stat is the added lines it knows (${card.counts})`)
    assert.equal(card.rows, 4, `the card folds at the reference's four rows (${card.rows})`)
    assert.equal(card.firstPath, join(multi.work, 'a.txt'), `the first row is the first file written (${card.firstPath})`)
    assert.equal(card.firstPlus, '+1', 'with its own added-line count')
    assert.equal(card.toggleText, 'All 6 files', `the toggle says All {count} files (${card.toggleText})`)
    assert.equal(card.toggleExpanded, 'false', 'and starts collapsed')
    assert.equal(card.headHeight, 60, `the header is the reference's 60px (${card.headHeight})`)
    assert.equal(card.tile, 40, `the tile is its 40px (${card.tile})`)

    /** The toggle reveals the rest, and says what it did. */
    await browser.evaluate(`document.querySelector('[data-changed-files] .changed-toggle').click()`)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const expanded = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const panel = document.querySelector('[data-changed-files]')
        const toggle = panel.querySelector('.changed-toggle')
        return { rows: panel.querySelectorAll('.changed-row').length, text: toggle.textContent, aria: toggle.getAttribute('aria-expanded') }
      })())`),
    )
    assert.equal(expanded.rows, 6, `expanding shows every file (${expanded.rows})`)
    assert.equal(expanded.text, 'Collapse changed files', `and the toggle offers the collapse (${expanded.text})`)
    assert.equal(expanded.aria, 'true', 'with aria-expanded true')

    /** A row opens that file in the file panel; the header opens the first change. */
    await browser.evaluate(`document.querySelectorAll('[data-changed-files] .changed-row')[1].click()`)
    await browser.waitFor('document.getElementById("file-head").textContent.includes("b.txt")', 10_000)
    const fileView = await browser.evaluate('document.getElementById("file-head").textContent')
    assert.match(fileView, /b\.txt/, 'clicking a row opens that file in the file panel')
    await browser.evaluate(`document.querySelector('[data-changed-files] .changed-head').click()`)
    await browser.waitFor('document.getElementById("file-head").textContent.includes("a.txt")', 10_000)
    const headText = await browser.evaluate('document.getElementById("file-head").textContent')
    assert.match(headText, /a\.txt/, 'and the header opens the first changed file')

    /** One file is only the header, titled with its name — the reference's single-file shape. */
    await runTurn(single, 'write one file')
    const one = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const panel = document.querySelector('[data-changed-files]')
        return {
          hasCard: panel !== null,
          title: panel ? panel.querySelector('.changed-title').textContent : null,
          rows: panel ? panel.querySelectorAll('.changed-row').length : null,
          toggle: panel ? panel.querySelector('.changed-toggle') !== null : null,
          counts: panel ? panel.querySelector('.changed-counts').textContent : null,
        }
      })())`),
    )
    assert.equal(one.hasCard, true, 'a single edited file still shows the card')
    assert.equal(one.title, 'Edited a.txt', `titled Edited {name} (${one.title})`)
    assert.equal(one.rows, 0, 'with no list, as the reference does for one file')
    assert.equal(one.toggle, false, 'and no toggle')
    assert.match(String(one.counts), /^\+3$/, `the stat counts the lines it wrote (${one.counts})`)

    /** A turn that edited nothing shows no card at all. */
    await runTurn(plain, 'now only answer')
    const none = await browser.evaluate('document.querySelectorAll("#log [data-changed-files]").length')
    assert.equal(none, 0, `a turn that edited nothing shows no card (${none})`)
  } finally {
    browser.close()
    await multi.close()
    await single.close()
    await plain.close()
  }
})

test('a long turn is not cut at eight rounds, and a turn the loop does stop says why', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * The owner's report: a complex prompt (more than twenty steps) made the server stop responding. The Web UI was
   * calling `runTurn` without a round budget, so it inherited the loop's **one-shot default of eight**, and the
   * reason ("stopped after the round limit of 8") lived only in a local list — no answer, no notice.
   *
   * The reference's rule is measured, not chosen: DSH's agent loop has no step cap, and its own session logs across
   * 266 sessions and 1,617 turns hold a largest turn of **436 steps**, with 283 turns over 32 and 59 over 100 — the
   * bound is context compaction (333 `compaction/prune` events), not a cut. Interactive turns are therefore uncapped
   * by default, a **40-round** fixture must reach its answer, and only an explicit `--max-rounds 3` may stop a turn
   * (with the reason carried into the transcript and the page).
   */
  const fortySteps = (work) => [
    ...Array.from({ length: 40 }, (_, index) => ({ toolCall: { name: 'list_dir', arguments: { path: work } }, reasoning: `step ${index + 1}` })),
    { text: 'the long task finished' },
  ]
  const long = await startServer('rounds-long', fortySteps)
  const short = await startServer('rounds-short', fortySteps, { maxRounds: 3 })
  const browser = await openBrowser()
  const runTurn = async (server) => {
    mkdirSync(server.work, { recursive: true })
    const cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
    const opened = await api(server.url, cookie, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: server.work }) })
    const session = opened.body.session?.id ?? opened.body.id
    const turn = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'run the long task', folder: server.work, session }),
    })
    assert.equal(turn.status, 200, `the long turn was accepted (${turn.status})`)
    const stream = await turn.text()
    const detail = await api(server.url, cookie, `/api/sessions/${encodeURIComponent(session)}`)
    return { stream, session, turns: detail.body.turns ?? [] }
  }
  try {
    /** Ten rounds finish, because the interactive budget is 32 rather than the one-shot eight. */
    const done = await runTurn(long)
    assert.match(done.stream, /the long task finished/, 'a forty-round turn reaches its answer, because interactive turns are uncapped')
    await browser.goto(long.url)
    await browser.waitFor('document.querySelector("#log .turn.assistant") !== null', 25_000)
    await browser.waitFor('document.getElementById("log").innerText.includes("the long task finished")', 10_000)
    const noticeOnLong = await browser.evaluate('document.querySelectorAll("#log .turn-notice").length')
    assert.equal(noticeOnLong, 0, 'and carries no stop notice')

    /** Three rounds under an explicit budget stop, and the reason travels: API, transcript, page. */
    const stopped = await runTurn(short)
    const answer = stopped.turns.find((entry) => entry.kind === 'assistant')
    assert.ok(answer !== undefined, 'a row exists for the stopped turn')
    assert.ok(Array.isArray(answer.ended) && answer.ended.some((entry) => /round limit of 3/.test(entry)), `the transcript carries the reason (${JSON.stringify(answer && answer.ended)})`)
    await browser.goto(short.url)
    await browser.waitFor('document.querySelectorAll("#log .turn-notice").length >= 1', 25_000)
    const noticeText = await browser.evaluate('document.getElementById("log").innerText')
    assert.match(noticeText, /Stopped after the round limit of 3/, `the page says why (${noticeText.slice(-120)})`)
  } finally {
    browser.close()
    await long.close()
    await short.close()
  }
})

test('the live state is a shimmer on the words, not a band across the row', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH's `TextShimmer` (`dsh-client-ui-primitives/TextShimmer.module.css`) tints a **copy of the text**: a 105° mask
   * with a 40%–60% band, 1.5s, a 0.3s delay, `steps(48, end)`, holding its end position for the last third. A first
   * pass here reproduced the mask as a full-row overlay, which painted a bright horizontal ribbon sweeping across a
   * streaming answer — the owner saw it as a flashing band. This pins the corrected shape: the answer row carries no
   * sweep pseudo-element, and a running process row's title is what shimmers.
   */
  const server = await startServer('shimmer-live')
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 20_000)
    const state = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        document.getElementById('log').insertAdjacentHTML('beforeend', '<div class="turn assistant" data-kind="assistant" data-state="running"><div class="markdown">a streaming answer</div></div><details class="turn tool" data-kind="tool" data-state="running"><summary><span class="title">bash</span><span class="hint">running</span></summary></details>')
        const answer = document.querySelector('.turn.assistant[data-state="running"]')
        const title = document.querySelector('details.turn.tool[data-state="running"] > summary .title')
        const before = getComputedStyle(answer, '::before')
        const shimmer = getComputedStyle(title)
        return {
          ribbon: before.content,
          ribbonAnimation: before.animationName,
          caret: getComputedStyle(answer, '::after').content,
          titleAnimation: shimmer.animationName,
          duration: shimmer.animationDuration,
          timing: shimmer.animationTimingFunction,
          clip: shimmer.backgroundClip || shimmer.webkitBackgroundClip,
        }
      })())`),
    )
    assert.equal(state.ribbon, 'none', 'the streaming answer has no row-wide sweep')
    assert.equal(state.ribbonAnimation, 'none', 'and nothing animates across it')
    assert.equal(state.caret, '"▍"', 'the caret alone marks the arriving answer, as the reference keeps for reduced motion')
    assert.equal(state.titleAnimation, 'heddle-row-shimmer', 'the running process row’s title is what shimmers')
    assert.equal(state.duration, '1.5s', 'at the reference’s duration')
    assert.match(state.timing, /^steps\(48/, `with its stepped timing (${state.timing})`)
    assert.equal(state.clip, 'text', 'through a text clip, so the band moves under the glyphs and nowhere else')
  } finally {
    browser.close()
    await server.close()
  }
})

/**
 * Speak into the composer the way a person does: the textarea's input handler, then Enter.
 *
 * Copied from the approval check's helper; this file's other tests settle turns through `/api/turn` and then reload,
 * which cannot see a **live** row's state mid-turn.
 */
async function sendMessage(browser, text) {
  await browser.evaluate(`(() => {
    const field = document.querySelector('textarea')
    field.value = ${JSON.stringify(text)}
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    return true
  })()`)
}

test('a thinking row shimmers only while it is thinking, and turns solid when the thought ends', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * The owner liked the running shimmer but asked why "thinking" kept shimmering after the model had moved on: a tool
   * row settles when its result lands, while a reasoning row only settled at the **end of the turn** — on a long turn,
   * minutes of a title that never became solid. The model's next content is the end of the thought, so a text or
   * tool-call chunk settles it. This drives a multi-round turn and watches the live rows: at least one moment has a
   * settled thinking row while the turn is still running, and after the turn nothing is running or animating.
   */
  const steps = () => [
    /**
     * Each round sleeps in the shell, which makes the turn long enough to observe **deterministically**: a turn of
     * twenty instant rounds can finish before one poll, and a check that observes nothing cannot say the thinking
     * row settled mid-turn.
     */
    ...Array.from({ length: 12 }, (_, index) => ({
      reasoning: `thinking about round ${index + 1}`,
      toolCall: { name: 'bash', arguments: { command: 'sleep 0.2' } },
    })),
    { text: 'all rounds done' },
  ]
  const server = await startServer('reasoning-settle', steps, { sandboxRoot: true })
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 25_000)
    await sendMessage(browser, 'run a long task')
    const snapshots = []
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      const snapshot = JSON.parse(
        await browser.evaluate(`JSON.stringify({
          running: document.getElementById('send').hidden,
          rows: document.querySelectorAll('#log .turn').length,
          reasoning: [...document.querySelectorAll('#log .turn.reasoning')].map((node) => node.dataset.state),
          runningRows: document.querySelectorAll('#log .turn[data-state="running"]').length,
        })`),
      )
      snapshots.push(snapshot)
      if (!snapshot.running && snapshot.rows > 0 && snapshot.tools > 0) break
      if (!snapshot.running && snapshot.reasoning.length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const during = snapshots.filter((snapshot) => snapshot.running)
    assert.ok(during.length > 0, 'the turn was observed while it was running')
    assert.ok(
      during.some((snapshot) => snapshot.reasoning.includes('settled')),
      `a thinking row became solid before the turn ended (${JSON.stringify(during.map((snapshot) => snapshot.reasoning))})`,
    )
    const settled = snapshots[snapshots.length - 1]
    assert.equal(settled.running, false, 'the turn ended')
    assert.equal(settled.runningRows, 0, `no row is left shimmering (${JSON.stringify(settled)})`)
    const animated = await browser.evaluate(`JSON.stringify([...document.querySelectorAll('#log .turn.reasoning summary .title')].map((node) => getComputedStyle(node).animationName))`)
    assert.deepEqual(JSON.parse(animated).filter((name) => name !== 'none'), [], 'and no thinking title keeps the shimmer')
  } finally {
    browser.close()
    await server.close()
  }
})

test('a running turn says Weaving, and the row leaves with the turn', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH's `RunningStatus` (`dsh-client-ui-chat`) is the reference: while the session runs, the chat ends with a row
   * whose divider is 100% wide and 0.5px tall (`margin: 8px 0 10px`, shown only after non-user content), whose
   * content is an inline-flex pair at a 6px gap — a 14×14 brand mark and a label at 12px/22px with tabular numerals
   * and the text shimmer — and whose hidden `role=status aria-live=polite` element announces the phrase while the
   * visible ticks stay unannounced. Its label reads `Deep diving` and then `Deep diving for {duration} ···` on a 1s
   * clock. Heddle's verb is **Weaving**: a heddle is the loom's warp-lifting part, and a harness that weaves sessions
   * is what this product is. The row arrives with the turn and leaves with it.
   */
  const steps = () => [
    ...Array.from({ length: 12 }, (_, index) => ({
      reasoning: `thinking ${index + 1}`,
      toolCall: { name: 'bash', arguments: { command: 'sleep 0.2' } },
    })),
    { text: 'all done' },
  ]
  const server = await startServer('weaving-row', steps, { sandboxRoot: true })
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 25_000)
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-chat-running]").length'), 0, 'no running row while the session is idle')
    await sendMessage(browser, 'weave something')
    await browser.waitFor('document.querySelector("[data-chat-running]") !== null', 20_000)
    /** The clock's first reading is clamped to a second, the reference's `Math.max(1000, now - startTime)`. */
    const row = JSON.parse(
      await browser.evaluate(`JSON.stringify((() => {
        const row = document.querySelector('[data-chat-running]')
        const label = row.querySelector('.label')
        const divider = row.querySelector('.divider')
        const glyph = row.querySelector('.glyph')
        const status = row.querySelector('[role="status"]')
        return {
          label: label.textContent,
          status: status === null ? null : { text: status.textContent, live: status.getAttribute('aria-live'), atomic: status.getAttribute('aria-atomic') },
          animation: getComputedStyle(label).animationName,
          shimmer: getComputedStyle(label).backgroundImage,
          fill: getComputedStyle(label).webkitTextFillColor,
          glyph: getComputedStyle(glyph).width + '×' + getComputedStyle(glyph).height,
          font: getComputedStyle(label).fontSize + '/' + getComputedStyle(row).lineHeight,
          dividerHeight: getComputedStyle(divider).height,
          dividerMargin: getComputedStyle(divider).marginTop + ' ' + getComputedStyle(divider).marginBottom,
        }
      })())`),
    )
    assert.match(row.label, /^Weaving for \d+s ···$/, `the row states the working verb and its duration (${row.label})`)
    assert.ok(row.status !== null && row.status.text === 'Weaving', `the hidden status announces the verb (${JSON.stringify(row.status)})`)
    assert.equal(row.status.live, 'polite', 'politely')
    assert.equal(row.status.atomic, 'true', 'atomically')
    /**
     * The label holds still: the reference sweeps it, but on this dark surface the travelling band over a 12px phrase
     * read as "shuttling" and made the duration hard to read (the owner's report), so only the process rows keep the
     * shimmer.
     */
    assert.equal(row.animation, 'none', 'the running label does not animate, so the duration stays readable')
    assert.equal(row.shimmer, 'none', 'and paints no moving gradient')
    assert.notEqual(row.fill, 'transparent', 'its text is filled with the readable ink rather than a clipped gradient')
    assert.equal(row.glyph, '14px×14px', 'the mark is the reference’s 14px box')
    assert.equal(row.font, '12px/22px', 'the label is 12px on the reference’s 22px line')
    assert.equal(row.dividerHeight, '0.5px', 'the divider is the reference’s half-pixel rule')
    assert.equal(row.dividerMargin, '8px 10px', 'with its 8px over 10px margins')
    /** The clock ticks: the duration grows while the turn runs. */
    assert.ok(
      await browser.waitFor('(document.querySelector("[data-chat-running] .label")?.textContent ?? "").includes("for 2s")', 15_000),
      'the duration ticks once a second',
    )
    /** Once a process row precedes it, the divider is drawn (the reference hides it only after a user row). */
    assert.ok(
      await browser.waitFor('document.querySelector("[data-chat-running]") !== null && getComputedStyle(document.querySelector("[data-chat-running] .divider")).display !== "none"', 15_000),
      'the divider is drawn under the turn’s process rows',
    )
    await browser.waitFor('document.querySelector("[data-chat-running]") === null', 30_000)
    assert.ok(await browser.waitFor('document.getElementById("log").innerText.includes("all done")', 15_000), 'and the answer arrives after the row is gone')
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-chat-running]").length'), 0, 'the running row leaves with the turn')
  } finally {
    browser.close()
    await server.close()
  }
})

test('the transcript follows its tail, and never yanks a reader who scrolled back', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * DSH's chat keeps one `ScrollFollow` per scrollport with a **25px** tolerance (`useScrollFollow(state.followingTail,
   * 25)`): the floor is followed while the reader is within it, a reader's own movement away turns the follow off,
   * and content that grows **after** an append — the settled answer's document, a tool's result, an edited-files
   * card — is covered by observing the element rather than by scrolling at each append site. Its `sample(metrics,
   * movedByReader)` distinction matters as much: a layout shift is not a reader movement, or a brief shrink would
   * silently stop the follow. That last part is what this page lacked: it set `scrollTop = scrollHeight` at a few
   * append points only, so the view sometimes sat above the bottom while the answer was still growing (the owner's
   * "sometimes it does not follow").
   */
  const longText = Array.from({ length: 40 }, (_, index) => `line ${index + 1} of an answer long enough to scroll`).join('\n')
  const steps = () => [
    ...Array.from({ length: 8 }, (_, index) => ({ reasoning: `thinking ${index + 1}`, toolCall: { name: 'bash', arguments: { command: 'sleep 0.2' } } })),
    { toolCall: { name: 'write_file', arguments: { path: join(fixtureDir('unused'), 'never.txt'), content: 'x\n' } } },
    { text: longText },
  ]
  const server = await startServer('follow-tail', steps, { sandboxRoot: true })
  const browser = await openBrowser({ width: 1100, height: 700 })
  const distance = () => browser.evaluate('Math.round((() => { const log = document.getElementById("log"); return log.scrollHeight - log.scrollTop - log.clientHeight })())')
  const rows = () => browser.evaluate('document.querySelectorAll("#log .turn").length')
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 25_000)
    await sendMessage(browser, 'a long answer please')

    /** At the floor, growth is followed: sampled while the turn is still arriving, where the old page slipped. */
    let followed = 0
    let observed = 0
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const running = await browser.evaluate('document.getElementById("send").hidden')
      if ((await rows()) > 6) {
        observed += 1
        if ((await distance()) <= 1) followed += 1
      }
      if (!running && observed > 0) break
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    assert.ok(observed > 2, `the turn was observed growing (${observed} samples)`)
    /** A sample can land between a growth and its animation frame, so the claim is "follows", not "every 100ms". */
    assert.ok(followed >= Math.ceil(observed * 0.8), `the transcript followed the floor as it grew (${followed}/${observed} samples at the bottom)`)
    assert.ok(await browser.waitFor('document.getElementById("log").innerText.includes("line 40 of an answer")', 20_000), 'the long answer arrived')
    /** The settled document and the final layout land after the last append — still at the floor. */
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.ok((await distance()) <= 1, `the settled answer is still at the floor (${await distance()}px away)`)

    /**
     * A reader who scrolls back is not yanked, and a second turn keeps growing above them. The wheel is what
     * attributes the movement to the reader, which is DSH's `movedByReader`; a bare scrollTop change is a layout
     * consequence rather than a reader's decision.
     */
    await sendMessage(browser, 'one more')
    assert.ok(await browser.waitFor('document.getElementById("send").hidden === true', 10_000), 'the second turn is running')
    const markAway = await rows()
    await browser.evaluate('(() => { const log = document.getElementById("log"); log.dispatchEvent(new Event("wheel")); log.scrollTop = 0 })()')
    await new Promise((resolve) => setTimeout(resolve, 250))
    const awayFrom = await distance()
    assert.ok(awayFrom > 100, `scrolling up leaves the reader away from the floor (${awayFrom}px)`)
    assert.ok(
      await browser.waitFor(`document.querySelectorAll("#log .turn").length > ${markAway}`, 15_000),
      'content still arrives while the reader is away',
    )
    assert.ok((await distance()) >= awayFrom - 2, `and it does not pull the reader back (${await distance()} vs ${awayFrom})`)

    /** Scrolling back to the floor re-engages following, as the reference's near-bottom test does. */
    await browser.evaluate('(() => { const log = document.getElementById("log"); log.dispatchEvent(new Event("wheel")); log.scrollTop = log.scrollHeight })()')
    assert.ok(
      await browser.waitFor('Math.round((() => { const log = document.getElementById("log"); return log.scrollHeight - log.scrollTop - log.clientHeight })()) <= 1', 10_000),
      'the floor is reachable again',
    )
    const markFollow = await rows()
    assert.ok(
      await browser.waitFor(`document.querySelectorAll("#log .turn").length > ${markFollow}`, 15_000),
      'and more content arrives',
    )
    assert.ok(
      await browser.waitFor('Math.round((() => { const log = document.getElementById("log"); return log.scrollHeight - log.scrollTop - log.clientHeight })()) <= 1', 15_000),
      `and the follow is re-engaged (${await distance()}px away)`,
    )
  } finally {
    browser.close()
    await server.close()
  }
})

test('a turn this page did not start still says Weaving', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * The owner's "missing again": every goal round, CLI turn and other window's turn starts without this page's send,
   * and the running row was only refreshed from the page's **own** submission. `model/request` is DSH's start signal
   * for any turn, so the row must appear for a turn the page merely watched — and still leave when it ends.
   */
  const steps = () => [
    ...Array.from({ length: 6 }, (_, index) => ({ reasoning: `thinking ${index + 1}`, toolCall: { name: 'bash', arguments: { command: 'sleep 0.25' } } })),
    { text: 'a watched answer' },
  ]
  const server = await startServer('weaving-external', steps, { sandboxRoot: true })
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 25_000)
    /** One page-owned turn first, so the page has a session and the following turn is genuinely external. */
    await sendMessage(browser, 'hello first')
    assert.ok(await browser.waitFor('document.getElementById("send").hidden === false', 25_000), 'the first turn finished')
    assert.ok(await browser.waitFor('document.querySelector("#log .turn.assistant") !== null', 10_000), 'the page shows its session')
    const session = await browser.evaluate("fetch('/api/sessions').then((r) => r.json()).then((list) => list[0]?.id ?? null)")
    assert.ok(typeof session === 'string' && session.startsWith('session-'), `the serving session is known (${session})`)
    /**
     * Start the turn from **outside** the composer: the same request the goal driver posts. The response stream is
     * kept but not read here; the page's event stream is what must paint the row.
     */
    await browser.evaluate(`(() => { window.__externalTurn = fetch('/api/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'a goal round', session: ${JSON.stringify(session)} }) }); return true })()`)
    assert.ok(
      await browser.waitFor('document.querySelector("[data-chat-running]") !== null', 20_000),
      'a turn started elsewhere shows the running row',
    )
    const label = await browser.evaluate('document.querySelector("[data-chat-running] .label")?.textContent ?? null')
    assert.match(String(label), /^Weaving for \d+s ···$/, `with the reference's phrase (${label})`)
    /**
     * The list says the same thing the row does, which is what the page reconciles against: running while the turn
     * runs, not running once it ends.
     */
    const during = await browser.evaluate("fetch('/api/sessions').then((r) => r.json()).then((list) => list[0]?.running ?? null)")
    assert.equal(during, true, 'the session list reports the session running while the watched turn runs')
    await browser.waitFor('document.querySelector("[data-chat-running]") === null', 30_000)
    assert.ok(await browser.waitFor('document.getElementById("log").innerText.includes("a watched answer")', 15_000), 'and the watched turn answers')
  } finally {
    browser.close()
    await server.close()
  }
})

test('a failed turn leaves no session looking active, and no running row', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * The owner's report: the running row showed for sessions that were not active at all. The mechanism was a turn
   * that **failed**: the page had marked the session running on `model/request`, the failure event carried no session
   * id, so nothing cleared the mark and a finished session kept its running row (and its sidebar spinner) until
   * something else touched it. The server now names the session on the failure event and lists `running` per session,
   * which the page reconciles against whenever it reads the list.
   */
  const server = await startServer('weaving-failure', undefined, { failing: true })
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 25_000)
    await sendMessage(browser, 'this turn will fail')
    assert.ok(await browser.waitFor('document.querySelector("#log .turn.denied") !== null', 20_000), 'the failure is shown as a sentence')
    assert.ok(await browser.waitFor('document.getElementById("send").hidden === false', 15_000), 'and the composer returns to Send')
    assert.equal(await browser.evaluate('document.querySelectorAll("[data-chat-running]").length'), 0, 'no running row survives a failed turn')
    assert.ok(await browser.waitFor('document.getElementById("send").hidden === false', 5_000), 'the page is idle again')
    const running = await browser.evaluate("fetch('/api/sessions').then((r) => r.json()).then((list) => list[0]?.running ?? null)")
    assert.equal(running, false, 'and the server does not call the session running')
  } finally {
    browser.close()
    await server.close()
  }
})

test('the running clock survives navigating away and back', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * The owner's report: navigating to another session and back restarted "Weaving for …" at 1s. The start time
   * belonged to the **row**, and hiding the row — which is what navigation does — cleared it. It belongs to the
   * **turn**: recorded when the turn's first `model/request` arrives, kept per session, dropped when that session's
   * turn ends. This test leaves a turn running, navigates away, returns, and requires the clock to have moved on.
   */
  const steps = () => [
    ...Array.from({ length: 60 }, (_, index) => ({ reasoning: `thinking ${index + 1}`, toolCall: { name: 'bash', arguments: { command: 'sleep 0.25' } } })),
    { text: 'the long weave finished' },
  ]
  const server = await startServer('weaving-navigation', steps, { sandboxRoot: true })
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 25_000)
    await sendMessage(browser, 'start a long weave')
    const secondsOn = async () =>
      Number(/(\d+)s/.exec(String(await browser.evaluate('document.querySelector("[data-chat-running] .label")?.textContent ?? null')))?.[1] ?? 0)
    assert.ok(await browser.waitFor('document.querySelector("[data-chat-running]") !== null', 20_000), 'the turn is weaving')
    assert.ok(await browser.waitFor('(document.querySelector("[data-chat-running] .label")?.textContent ?? "").includes("for 2s")', 20_000), 'the clock reaches 2s')
    const session = await browser.evaluate("fetch('/api/sessions').then((r) => r.json()).then((list) => list.find((entry) => entry.running === true)?.id ?? null)")
    assert.ok(typeof session === 'string' && session.startsWith('session-'), `the running session is known (${session})`)
    const before = await secondsOn()
    /**
     * Navigate to another session in the same workspace — a real one, created through the same route the panel uses,
     * because the row must leave the moment the panel shows a session that is not running.
     */
    await browser.evaluate(`fetch('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: ${JSON.stringify(server.work)} }) })`)
    const other = await browser.evaluate(`fetch('/api/folders/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder: ${JSON.stringify(server.work)} }) }).then((r) => r.json()).then((body) => body.session?.id ?? body.id ?? null)`)
    assert.ok(typeof other === 'string' && other.startsWith('session-'), `a second session exists (${other})`)
    await browser.evaluate(`globalThis.showSession(${JSON.stringify(other)})`)
    assert.ok(await browser.waitFor('document.querySelector("[data-chat-running]") === null', 15_000), 'the row leaves with the view')
    /**
     * The row must leave because **this session has no turn**, not because the original stoped: the session it left
     * is still running. That distinction is what the page-side pending flag broke — being global, it painted the row
     * on whichever session was shown.
     */
    const stillRunning = await browser.evaluate(`fetch('/api/sessions').then((r) => r.json()).then((list) => list.find((entry) => entry.id === ${JSON.stringify(session)})?.running ?? null)`)
    assert.equal(stillRunning, true, 'the original session is still running while the panel shows another one')
    await new Promise((resolve) => setTimeout(resolve, 1200))
    /** And back to the session that is still running. */
    await browser.evaluate(`globalThis.showSession(${JSON.stringify(session)})`)
    assert.ok(await browser.waitFor('document.querySelector("[data-chat-running]") !== null', 20_000), 'the row returns with the session')
    const after = await secondsOn()
    assert.ok(after >= before + 1, `the clock continued while away (${before}s before, ${after}s after)`)
  } finally {
    browser.close()
    await server.close()
  }
})

test('the weaving clock comes from the server: it survives a reload and agrees with the list', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * Where the clock's origin lives. The page used to start its own timer on first sight of an event, so a reload
   * mid-turn restarted "Weaving for …" at 1s; the server now records when a running session's turn began and states
   * it as `runningSince` on `/api/sessions`, and the page takes that as the origin. This test starts a turn from
   * outside, checks the list's own timestamp against the row's label, reloads the page mid-turn and requires the
   * clock to continue rather than restart.
   */
  const steps = () => [
    ...Array.from({ length: 40 }, (_, index) => ({ reasoning: `thinking ${index + 1}`, toolCall: { name: 'bash', arguments: { command: 'sleep 0.25' } } })),
    { text: 'the long weave finished' },
  ]
  const server = await startServer('weaving-server-clock', steps, { sandboxRoot: true })
  const browser = await openBrowser()
  const seconds = () =>
    Number(/(\d+)s/.exec(String(document.querySelector('[data-chat-running] .label')?.textContent ?? null))?.[1] ?? 0)
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 25_000)
    await browser.evaluate(`fetch('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: ${JSON.stringify(server.work)} }) })`)
    const session = await browser.evaluate(`fetch('/api/folders/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder: ${JSON.stringify(server.work)}, new: true }) }).then((r) => r.json()).then((body) => body.session?.id ?? null)`)
    assert.ok(typeof session === 'string' && session.startsWith('session-'), `a session exists (${session})`)
    await browser.evaluate(`globalThis.showSession(${JSON.stringify(session)})`)
    await browser.waitFor('document.getElementById("session-title") !== null', 10_000)
    await browser.evaluate(`(() => { window.__turn = fetch('/api/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'weave from outside', session: ${JSON.stringify(session)} }) }); return true })()`)
    assert.ok(await browser.waitFor('document.querySelector("[data-chat-running]") !== null', 20_000), 'the row is up')
    assert.ok(await browser.waitFor('(() => { const label = document.querySelector("[data-chat-running] .label"); return label !== null && Number(/(\\d+)s/.exec(label.textContent)?.[1] ?? 0) >= 2 })()', 20_000), 'the row reaches 2s')
    /** The list states when the turn began, and at the same moment the row's label is that elapsed time. */
    const listed = await browser.evaluate("fetch('/api/sessions').then((r) => r.json()).then((list) => list.find((entry) => entry.running === true) ?? null)")
    assert.ok(listed !== null && typeof listed.runningSince === 'string', `the list carries runningSince (${JSON.stringify(listed?.runningSince ?? null)})`)
    const fromServer = Math.floor((Date.now() - Date.parse(listed.runningSince)) / 1000)
    const shown = await browser.evaluate('Number(/(\\d+)s/.exec(document.querySelector("[data-chat-running] .label")?.textContent ?? "")?.[1] ?? 0)')
    assert.ok(Math.abs(shown - fromServer) <= 1, `the row's seconds agree with the server's start (${shown}s row, ${fromServer}s list)`)
    /** Reload mid-turn: the clock is the server's, so it must continue rather than restart at 1s. */
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 25_000)
    assert.ok(await browser.waitFor('document.querySelector("[data-chat-running]") !== null', 25_000), 'the row is up again after a reload')
    const afterReload = await browser.evaluate('Number(/(\\d+)s/.exec(document.querySelector("[data-chat-running] .label")?.textContent ?? "")?.[1] ?? 0)')
    assert.ok(afterReload >= 2, `the clock continued through the reload (${afterReload}s)`)
    /** The completion is the server's fact too: the list says not running and when it completed, and the row is gone. */
    assert.ok(await browser.waitFor('document.querySelector("[data-chat-running]") === null', 30_000), 'the row leaves when the turn completes')
    const finished = await browser.evaluate("fetch('/api/sessions').then((r) => r.json()).then((list) => list[0] ?? null)")
    assert.equal(finished.running, false, 'the list says the session is not running')
    assert.ok(typeof finished.turnCompletedAt === 'string', `the list states when the turn completed (${JSON.stringify(finished.turnCompletedAt ?? null)})`)
    assert.ok(Date.parse(finished.turnCompletedAt) >= Date.parse(listed.runningSince), 'and the completion is after the start')
  } finally {
    browser.close()
    await server.close()
  }
})

test('a provider that streams blank lines between tokens still reads as prose', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * The owner's "incoming content in separate lines". The live row concatenates deltas verbatim, so when a provider
   * (or the router in front of it) emits a blank-line-only delta between two tokens — measured 2026-10-18 as
   * `'检测'`, `'\n\n\n'`, `'器'`, … — the answer shows one word per line. A real paragraph break follows
   * sentence-ending punctuation or whitespace; blank lines between ordinary characters are a stream artifact and the
   * page drops them. The double below is exactly that shape.
   */
  const chunks = ['检', '\n\n\n', '测', '\n\n\n', '器', '\n\n\n', '抓', '\n\n\n', '到', '\n\n\n', '了', '。', '\n\n', '下一段。']
  const double = await new Promise((resolve) => {
    const server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        for (const chunk of chunks) {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk }, finish_reason: null }] })}\n\n`)
        }
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        response.write('data: [DONE]\n\n')
        response.end()
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }))
  })
  const server = await startServer('stream-artifact', undefined, { doubleUrl: double.baseUrl })
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 20_000)
    await sendMessage(browser, 'stream it')
    assert.ok(await browser.waitFor('document.getElementById("send").hidden === false && document.querySelector("#log .turn.assistant") !== null', 25_000), 'the turn finished')
    const text = await browser.evaluate('document.querySelector("#log .turn.assistant")?.innerText ?? ""')
    assert.equal(text, '检测器抓到了。\n\n下一段。', `the artifact separators are gone and the real paragraph stays (${JSON.stringify(text)})`)
  } finally {
    browser.close()
    await server.close()
    double.server.close()
  }
})

test('a new turn starts a fresh weaving clock instead of carrying the last one', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * The running row counts **this turn**, so the server's `runningSince` has to be reset when a turn begins rather
   * than kept from whatever an earlier turn left behind. Two sequential turns on one session prove it: the second
   * turn's start is after the first turn's completion, and its label starts near a second — not at the first turn's
   * elapsed time.
   */
  const steps = () => [
    ...Array.from({ length: 8 }, (_, index) => ({ reasoning: `thinking ${index + 1}`, toolCall: { name: 'bash', arguments: { command: 'sleep 0.2' } } })),
    { text: 'a turn' },
  ]
  const server = await startServer('fresh-clock', steps, { sandboxRoot: true })
  const browser = await openBrowser()
  const labelSeconds = () => Number(/(\d+)s/.exec(String(document.querySelector('[data-chat-running] .label')?.textContent ?? null))?.[1] ?? 0)
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 25_000)
    await browser.evaluate(`fetch('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: ${JSON.stringify(server.work)} }) })`)
    const session = await browser.evaluate(`fetch('/api/folders/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder: ${JSON.stringify(server.work)}, new: true }) }).then((r) => r.json()).then((body) => body.session?.id ?? null)`)
    assert.ok(typeof session === 'string' && session.startsWith('session-'), `a session exists (${session})`)
    await browser.evaluate(`globalThis.showSession(${JSON.stringify(session)})`)
    const startTurn = () => browser.evaluate(`(() => { window.__turn = fetch('/api/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'go', session: ${JSON.stringify(session)} }) }); return true })()`)
    const runningEntry = () => browser.evaluate(`fetch('/api/sessions').then((r) => r.json()).then((list) => list.find((entry) => entry.id === ${JSON.stringify(session)}) ?? null)`)

    await startTurn()
    assert.ok(await browser.waitFor('document.querySelector("[data-chat-running]") !== null', 20_000), 'the first turn weaves')
    const first = await runningEntry()
    assert.ok(first !== null && typeof first.runningSince === 'string', `the first turn has a start (${JSON.stringify(first?.runningSince ?? null)})`)
    await browser.waitFor('document.querySelector("[data-chat-running]") === null', 30_000)
    const afterFirst = await runningEntry()
    assert.equal(afterFirst.running, false, 'the first turn ended')
    assert.ok(typeof afterFirst.turnCompletedAt === 'string', 'and the list knows when it completed')

    await startTurn()
    assert.ok(await browser.waitFor('document.querySelector("[data-chat-running]") !== null', 20_000), 'the second turn weaves')
    const second = await runningEntry()
    assert.ok(typeof second.runningSince === 'string', 'the second turn has a start')
    assert.ok(Date.parse(second.runningSince) >= Date.parse(first.runningSince), 'the second start is a later moment than the first')
    assert.ok(Date.parse(second.runningSince) > Date.parse(afterFirst.turnCompletedAt), `the second start follows the first completion (${second.runningSince} vs ${afterFirst.turnCompletedAt})`)
    const label = await browser.evaluate(`Number(/(\\d+)s/.exec(document.querySelector('[data-chat-running] .label')?.textContent ?? "")?.[1] ?? 0)`)
    assert.ok(label <= 2, `the second turn's label starts fresh rather than continuing the first (${label}s)`)
    await browser.waitFor('document.querySelector("[data-chat-running]") === null', 30_000)
  } finally {
    browser.close()
    await server.close()
  }
})

test('a tool call being written is drawn at its first fragment and grows in place, then settles as one card', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * Measured 2026-10-18 at the owner's address against the plugboard DeepSeek route: a `write_file` call's
   * arguments reached the page's own event stream as 1092 `tool-call-delta` fragments over 3.5s, and the page drew
   * nothing until the finished call — its first fragment carried only the tool's name, and the card was drawn through
   * `add`, which returns early on empty text, so there was never a card for the later fragments to grow.
   *
   * The double streams one call as eight fragments with a gap between each, then answers the second round with
   * text. The page is sampled while it runs: a live card must exist before the call is complete, its arguments must
   * take several lengths while it is live, and the finished call must settle **that** card rather than add a second.
   */
  const fragments = ['{"command":"echo ', 'one ', 'two ', 'three ', 'four ', 'five ', 'six', '"}']
  let requests = 0
  const double = await new Promise((resolve) => {
    const server = createServer((request, response) => {
      request.resume()
      request.on('end', async () => {
        /**
         * The page discovers the model list on load, so a double that counted every request spent its tool call
         * on `/models` and answered the real turn with text — the first version of this check did exactly that.
         * Only a completion counts as a round.
         */
        if (!(request.url ?? '').endsWith('/chat/completions')) {
          response.writeHead(404, { 'content-type': 'application/json' })
          response.end('{}')
          return
        }
        requests += 1
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        if (requests === 1) {
          for (const [index, piece] of fragments.entries()) {
            const call = index === 0
              ? { index: 0, id: 'call_live', type: 'function', function: { name: 'bash', arguments: piece } }
              : { index: 0, function: { arguments: piece } }
            response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: null }] })}\n\n`)
            await new Promise((done) => setTimeout(done, 200))
          }
          response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
        } else {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: null }] })}\n\n`)
          response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        }
        response.end('data: [DONE]\n\n')
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }))
  })
  const server = await startServer('tool-call-live', undefined, { doubleUrl: double.baseUrl, sandboxRoot: true })
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.body.dataset.ready === "true"', 20_000)
    await sendMessage(browser, 'run it')
    const samples = []
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      const sample = JSON.parse(
        await browser.evaluate(`JSON.stringify({
          running: document.getElementById('send').hidden,
          live: [...document.querySelectorAll('#log .turn.tool[data-live-call]')].map((node) => node.querySelector('[data-args]')?.textContent.length ?? 0),
          cards: document.querySelectorAll('#log .turn.tool').length,
          answered: document.querySelector('#log .turn.assistant') !== null,
        })`),
      )
      samples.push(sample)
      if (!sample.running && sample.answered) break
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    const whileLive = samples.filter((sample) => sample.live.length > 0)
    assert.ok(whileLive.length > 0, `a card was on screen while the call was still being written (${samples.length} samples)`)
    const lengths = new Set(whileLive.map((sample) => sample.live[0]))
    assert.ok(lengths.size >= 3, `its arguments grew in place while it was live (lengths ${JSON.stringify([...lengths])})`)
    const final = JSON.parse(
      await browser.evaluate(`JSON.stringify([...document.querySelectorAll('#log .turn.tool')].map((node) => ({
        live: node.hasAttribute('data-live-call'),
        id: node.dataset.toolCallId ?? null,
        title: node.querySelector('summary .title')?.textContent ?? null,
        args: node.querySelector('[data-args]')?.textContent ?? null,
      })))`),
    )
    assert.equal(final.length, 1, `the finished call settled the live card instead of adding a second (${JSON.stringify(final)})`)
    assert.equal(final[0].live, false, 'and the card is no longer live')
    assert.equal(final[0].id, 'call_live')
    assert.equal(final[0].title, 'bash')
    assert.equal(final[0].args, fragments.join(''), 'its arguments are the complete recorded call')
  } finally {
    browser.close()
    await server.close()
    double.server.close()
  }
})
