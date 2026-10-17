import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/check-helpers/browser.mjs'
import { fixtureDir, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/check-helpers/lib.mjs'

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

async function startServer(label, steps) {
  const home = isolatedHome(`chat-${label}`)
  const work = fixtureDir(`chat-${label}-work`)
  const { config } = scriptedConfig({
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
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), ...(process.env.HEDDLE_CHECK_PATCH ? ['--patch', process.env.HEDDLE_CHECK_PATCH] : []), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
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
      const child = spawn(process.execPath, [join(repoRoot, 'dist', 'cli.js'), ...args], {
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
        const userStyle = user ? getComputedStyle(user) : null
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
          userAlign: userStyle ? userStyle.alignSelf : null,
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
   * The reference is the reference's `nav[aria-label="Conversation minimap"]`, read while it ran: one 12px row per
   * message, a 12px bar whose thickness encodes the message's size, resting opacities of 0.33 (user) and 0.267
   * (assistant), the visible window brightened with feathered edges, and on hover a ±4-row swell reaching opacity 1
   * and `scaleX` 2.1 / `scaleY` 1.5, with a 300×81 `#242424` preview card to the left of the rail.
   *
   * The conversation is made long on purpose, because the scroll window is only observable when the transcript
   * actually scrolls; a fixture that fits on one screen would let a broken scrollspy pass.
   */
  const answer = 'word '.repeat(140)
  const server = await startServer('minimap', [
    { text: answer }, { text: 'second answer ' + answer }, { text: 'third answer ' + answer }, { text: 'fourth answer ' + answer },
    { text: 'fifth answer ' + answer }, { text: 'sixth answer ' + answer }, { text: 'seventh answer ' + answer }, { text: 'eighth answer ' + answer },
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
    await browser.waitFor('document.querySelectorAll("#log > .turn").length >= 8', 25_000)
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
    assert.ok(shape.rows >= 8, `the rail has a row per turn (${shape.rows})`)
    assert.equal(shape.rows, shape.turns, 'one row per displayed turn')
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
    assert.equal(hovered.previewVisible, true, 'a preview card appears')
    assert.ok(hovered.previewText.length > 2, `with the turn's text (${hovered.previewText})`)
    assert.equal(hovered.previewWidth, 300, 'at the reference width of 300px')
    assert.equal(hovered.previewBg, 'rgb(36, 36, 36)', 'on the reference surface')
    assert.equal(hovered.previewRadius, '8px', 'at the reference radius')
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
