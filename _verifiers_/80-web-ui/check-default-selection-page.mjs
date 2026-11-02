import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/verify-runner/browser.mjs'
import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A fresh session's composer starts from the run's default selection (DSH parity A104, DSH's default model
 * selection): with the model row's defaultModel and defaultEffort set, the seat shows them before anything is chosen,
 * and the first message asks the provider for exactly them. Without them the seat shows the endpoint's own model.
 */

async function recordingDouble() {
  const turns = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      if ((request.url ?? '').endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [] }))
        return
      }
      const parsed = JSON.parse(body || '{}')
      turns.push({ model: parsed.model, effort: parsed.reasoning_effort })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'answered' }, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, turns, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }) }
}

function writeProfile(dir, defaults) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  let tree = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8').replaceAll('name: ./src/', `name: ${repoRoot}/src/`)
  const row = `    - id: model\n      name: ${repoRoot}/src/plugins/model.ts\n`
  assert.ok(tree.includes(row), 'the tree has the model row this check edits')
  const config = Object.entries(defaults).map(([key, value]) => `        ${key}: ${value}\n`).join('')
  if (config.length > 0) tree = tree.replace(row, `${row}      config:\n${config}`)
  writeFileSync(join(dir, 'heddle.patch.yml'), tree)
  return dir
}

async function startServer(home, profile, config) {
  const child = spawn(...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--profile', profile, '--sandbox-root', home]), {
    cwd: home,
    env: { ...process.env, HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { out += chunk })
  const url = await new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const match = /heddle web: (http:\/\/\S+)/.exec(out)
      if (match) {
        clearInterval(timer)
        resolve(match[1])
      }
    }, 50)
    setTimeout(() => {
      clearInterval(timer)
      reject(new Error(`server did not start\n${out}`))
    }, 20_000)
  })
  return { url, close: () => child.kill('SIGKILL') }
}

test('a fresh session’s composer shows and sends the configured default model and effort', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), 'web')) return
  if (!skipUnless(context, browserAvailable(), 'browser')) return
  const home = isolatedHome('default-selection-page')
  const double = await recordingDouble()
  const levels = { default: 'low', levels: [{ id: 'low', name: 'Low', value: 'low' }, { id: 'high', name: 'High', value: 'high' }] }
  const config = join(home, 'heddle.json')
  writeFileSync(config, JSON.stringify({
    default: 'gateway',
    exclude: ['scripted'],
    endpoints: [{ name: 'gateway', kind: 'openai-chat', baseUrl: double.baseUrl, model: 'flash', stream: true, models: [{ id: 'flash', name: 'Flash', reasoning: levels }, { id: 'pro', name: 'Pro', reasoning: levels }] }],
  }))
  const browser = await openBrowser()
  let server
  let plainHome
  try {
    // 1. Defaults set: the seat shows Pro · High before anything is chosen, and the first message asks for them.
    server = await startServer(home, writeProfile(join(home, 'with-defaults'), { defaultModel: 'pro', defaultEffort: 'high' }), config)
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.getElementById('model-label')?.textContent === 'Pro'`, 20_000), 'the seat shows the default model')
    assert.equal(await browser.evaluate(`document.getElementById('model-effort').textContent`), 'High', 'and the default effort')
    await browser.evaluate(`(() => { const field = document.querySelector('#prompt textarea'); field.value = 'first'; field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`)
    assert.ok(await browser.waitFor(`document.getElementById('log').innerText.includes('answered')`, 20_000), 'the turn was answered')
    assert.deepEqual(double.turns[0], { model: 'pro', effort: 'high' }, 'the first message asked for the default model and effort')
    server.close()

    // 2. No defaults: the seat shows the endpoint's own model. A home of its own, because the page reopens the session
    //    step 1 made, and that session rightly keeps the Pro · High it recorded at creation.
    plainHome = isolatedHome('default-selection-page-plain')
    const plainConfig = join(plainHome, 'heddle.json')
    writeFileSync(plainConfig, readFileSync(config, 'utf8'))
    server = await startServer(plainHome, writeProfile(join(plainHome, 'without-defaults'), {}), plainConfig)
    await browser.goto(server.url)
    assert.ok(await browser.waitFor(`document.getElementById('model-label')?.textContent === 'Flash'`, 20_000), 'without defaults, the endpoint’s own model')
  } finally {
    server?.close()
    await browser.close()
    await double.close()
    removeDir(home)
    if (plainHome !== undefined) removeDir(plainHome)
  }
})
