import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * Agent presets in Settings (A96, slice 3), DSH's section of the same name: every preset with what it offers, the
 * default for new tasks badged "New task default", and "Set as new task default" on the others. Setting one writes the
 * presets row, which applies to the running server: the badge moves, the new-session chooser selects it, and the next
 * new session runs under it, while a session started before keeps its own. The section follows the interface language.
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


const SECTION = `({
  hidden: document.getElementById('settings-presets-section').hidden,
  heading: document.querySelector('#settings-presets-section h3').textContent,
  rows: [...document.querySelectorAll('#settings-presets .settings-preset')].map((row) => ({
    id: row.dataset.preset,
    name: row.querySelector('.name').textContent,
    offers: row.querySelector('.meta').textContent,
    badge: row.querySelector('.badge')?.textContent ?? null,
    button: row.querySelector('button')?.textContent ?? null,
  })),
})`

test('Settings lists the agent presets and sets the default for new tasks without a restart, in the page language', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), CAPABILITY)) return
  const home = isolatedHome('presets-settings')
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
    assert.ok(await browser.waitFor(`document.getElementById('preset-select').options.length > 0`, 20_000), 'the roster arrives')
    await browser.evaluate(`(() => { document.getElementById('settings-open').click(); return true })()`)
    assert.ok(await browser.waitFor(`document.getElementById('settings-dialog').open === true`, 10_000), 'Settings opens')
    assert.deepEqual(await browser.evaluate(SECTION), {
      hidden: false,
      heading: 'Agent presets',
      rows: [
        { id: 'standard', name: 'Standard mode', offers: 'Every tool', badge: 'New task default', button: null },
        { id: 'reader', name: 'Reader', offers: 'Tools: read_file, list_dir', badge: null, button: 'Set as new task default' },
      ],
    }, 'each preset with what it offers, the default badged and the other settable')

    await browser.evaluate(`(() => { document.querySelector('#settings-presets [data-preset="reader"] button').click(); return true })()`)
    assert.ok(
      await browser.waitFor(`document.querySelector('#settings-presets [data-preset="reader"] .badge') !== null`, 10_000),
      `the badge moves to Reader (${JSON.stringify(await browser.evaluate(`document.getElementById('settings-presets-note').textContent`))})`,
    )
    assert.equal(await browser.evaluate(`document.getElementById('settings-presets-note').hidden`), true, 'applied at once, so nothing to say')
    assert.equal(await browser.evaluate(`document.getElementById('preset-select').value`), 'reader', 'the new-session chooser starts on the new default')
    const listed = await browser.evaluate(`fetch('/api/presets').then((response) => response.json())`)
    assert.equal(listed.default, 'reader', 'the server holds the written default')

    // The section follows the interface language.
    await browser.evaluate(`(() => {
      const select = document.getElementById('settings-language')
      select.value = 'zh'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    assert.ok(await browser.waitFor(`document.documentElement.getAttribute('lang') === 'zh-CN'`, 5_000), 'the page is Chinese')
    assert.deepEqual(await browser.evaluate(SECTION), {
      hidden: false,
      heading: 'Agent 预设',
      rows: [
        { id: 'standard', name: '标准模式', offers: '全部工具', badge: null, button: '设为新任务默认' },
        { id: 'reader', name: 'Reader', offers: '工具：read_file, list_dir', badge: '新任务默认', button: null },
      ],
    }, 'in DSH\'s Chinese, a declared preset keeping its own name')
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
  }
})
