import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Agent presets on the page (inventory A96, slice 2), as DSH's dsh-client-ui-agent-preset offers them.
 *
 * The new-session screen carries a preset chooser listing the roster, with the default selected. A preset chosen
 * there goes with the message that creates the session, which then runs under it and keeps it; the session's
 * header shows its preset as a read-only label. The chooser and the label follow the interface language (#80): the
 * implicit `standard` preset is named in the page's language, a declared preset by its own name, and the label's
 * hint is translated.
 */

const listeners = new Set()
after(() => Promise.all([...listeners].map((listener) => listener.close())))

const CAPABILITY = 'agent presets in the Web UI'

/** A chat double that answers one text delta and lists one model, so a turn completes. */
async function plainDouble() {
  const { createServer } = await import('node:http')
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      if ((request.url ?? '').endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'model-one', object: 'model' }] }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const double = { baseUrl: `http://127.0.0.1:${port}/d`, close: () => new Promise((resolvePromise) => server.close(() => resolvePromise())) }
  listeners.add(double)
  return double
}

/** The shipped tree with absolute row names, plus a `presets` row declaring `standard` (the default) and `reader`. */
function presetsProfile(home) {
  const profile = join(home, 'presets-profile')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const tree = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8').replaceAll('name: ./src/', `name: ${repoRoot}/src/`)
  writeFileSync(
    join(profile, 'heddle.patch.yml'),
    `${tree}
- insert:
    - id: presets
      name: ${repoRoot}/src/plugins/presets.ts
      config:
        default: standard
        presets:
          - id: standard
          - id: reader
            name: Reader
            tools: [read_file, list_dir]
`,
  )
  return profile
}

function startServer(args, env) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', ...args]), {
        cwd: env.HOME,
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
          resolvePromise({ url: match[1], kill: () => child.kill('SIGKILL'), output: () => output })
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
          reject(new Error(`the server printed no URL within 20s\n${output}`))
        }
      }, 20_000).unref()
    })()
  })
}

const SEAT_READ = `(() => ({
  hidden: document.getElementById('preset-seat').hidden,
  label: document.querySelector('#preset-seat label').textContent,
  hint: document.getElementById('preset-select').getAttribute('title'),
  options: [...document.getElementById('preset-select').options].map((option) => option.value + '|' + option.textContent),
  selected: document.getElementById('preset-select').value,
}))()`

const LABEL_READ = `(() => {
  const label = document.getElementById('session-preset')
  return { hidden: label.hidden, text: label.textContent, hint: label.getAttribute('title') }
})()`

test('a preset chosen on the new-session screen is the one the session runs under, shown in its header, in the page language', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('presets-page')
  const double = await plainDouble()
  const config = writeJson(join(home, 'heddle.json'), {
    default: 'double-one',
    exclude: ['scripted'],
    endpoints: [{ name: 'double-one', kind: 'openai-chat', baseUrl: double.baseUrl, model: 'model-one', models: [{ id: 'model-one', name: 'Model One' }] }],
  })
  const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config }
  const server = await startServer(['--profile', presetsProfile(home), '--session-root', join(home, 'sessions'), '--sandbox-root', home], env)
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.send('Network.enable', {})
    await browser.send('Network.setExtraHTTPHeaders', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } })
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.getElementById('empty-state') !== null && !document.getElementById('empty-state').hidden`, 20_000), 'the new-session screen is up')
    assert.ok(
      await browser.waitFor(`document.getElementById('preset-select').options.length > 0`, 10_000),
      `the roster arrives (${JSON.stringify(await browser.evaluate(`fetch('/api/presets').then((response) => response.text())`))})`,
    )

    assert.deepEqual(
      await browser.evaluate(SEAT_READ),
      {
        hidden: false,
        label: 'Agent preset',
        hint: 'Choose the agent preset for your new task',
        options: ['standard|Standard mode', 'reader|Reader'],
        selected: 'standard',
      },
      'the chooser lists the roster with its default selected',
    )
    assert.equal(
      await browser.evaluate(`(() => {
        const seat = document.getElementById('preset-seat')
        seat.hidden = true
        const display = getComputedStyle(seat).display
        seat.hidden = false
        return display
      })()`),
      'none',
      'a hidden chooser is not drawn: nothing to offer means no chooser',
    )

    await browser.evaluate(`(() => {
      const select = document.getElementById('preset-select')
      select.value = 'reader'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      const field = document.querySelector('textarea')
      field.value = 'hello from the reader preset'
      field.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('send').click()
      return true
    })()`)
    assert.ok(
      await browser.waitFor(`(async () => { const list = await (await fetch('/api/sessions')).json(); return list.length === 1 && list[0].preset === 'reader' })()`, 20_000),
      `the session the message created runs under the chosen preset\n${JSON.stringify(await browser.evaluate(`fetch('/api/sessions').then((response) => response.json())`))}`,
    )
    assert.ok(await browser.waitFor(`!document.getElementById('session-preset').hidden`, 15_000), 'the header shows the session preset')
    assert.deepEqual(
      await browser.evaluate(LABEL_READ),
      { hidden: false, text: 'Reader', hint: 'The agent preset chosen when this task started' },
      'by its own name, with DSH\'s hint',
    )
    assert.equal(
      await browser.evaluate(`document.getElementById('preset-select').value`),
      'standard',
      'the chosen preset was used once: the chooser is back on the default for the next session',
    )

    // The interface language switches the chooser and the label's hint; a declared preset keeps its own name.
    await browser.evaluate(`(() => { document.getElementById('settings-open').click(); return true })()`)
    assert.ok(await browser.waitFor(`document.getElementById('settings-dialog').open === true`, 10_000), 'Settings opens')
    await browser.evaluate(`(() => {
      const select = document.getElementById('settings-language')
      select.value = 'zh'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    assert.ok(await browser.waitFor(`document.documentElement.getAttribute('lang') === 'zh-CN'`, 5_000), 'the page is Chinese')
    assert.deepEqual(
      await browser.evaluate(LABEL_READ),
      { hidden: false, text: 'Reader', hint: '本任务的 Agent 预设，在任务开始时确定' },
      'the label keeps the preset\'s own name and translates the hint',
    )
    const seat = await browser.evaluate(SEAT_READ)
    assert.deepEqual(
      { label: seat.label, hint: seat.hint, options: seat.options },
      { label: 'Agent 预设', hint: '选择新任务使用的 Agent 预设', options: ['standard|标准模式', 'reader|Reader'] },
      'the chooser is in Chinese, the implicit name translated and the declared one kept',
    )
  } finally {
    browser.close()
    server.kill()
    await double.close()
    listeners.delete(double)
    removeDir(home)
  }
})
