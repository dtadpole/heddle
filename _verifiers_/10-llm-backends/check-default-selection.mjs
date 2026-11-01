// The model and effort a new session starts with, as DSH's default model selection works (DSH parity A104): the
// model row's defaultModel and defaultEffort. A new session's first request carries them; a session that already
// exists keeps what it had; a default the endpoint no longer offers falls back to the endpoint's own model rather
// than failing the session. A recording double stands in for the provider. Runs against whichever harness
// HEDDLE_BIN names, or the TypeScript build.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { isolatedHome, isTitleRequest, refuseTitleRequest, removeDir, repoRoot, runCli } from '../../_tools_/verify-runner/lib.mjs'

/** An OpenAI-compatible double that answers every turn request with "ok" and keeps each one's model and effort. */
async function recordingDouble() {
  const seen = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      /** A new session's title request is not a turn; this double judges turns (#68). */
      if (isTitleRequest(body)) return refuseTitleRequest(response)
      const parsed = JSON.parse(body || '{}')
      seen.push({ model: parsed.model, effort: parsed.reasoning_effort })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }) }
}

/** The repository's tree as a profile, with the model row's defaults set (or none). */
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

test('a new session starts with the configured default model and effort; an existing one keeps its own', async () => {
  const home = isolatedHome('default-selection')
  const double = await recordingDouble()
  try {
    const levels = { default: 'low', levels: [{ id: 'low', name: 'Low', value: 'low' }, { id: 'high', name: 'High', value: 'high' }] }
    const config = join(home, 'heddle.json')
    writeFileSync(config, JSON.stringify({
      default: 'gateway',
      exclude: ['scripted'],
      endpoints: [{ name: 'gateway', kind: 'openai-chat', baseUrl: double.baseUrl, model: 'flash', stream: true, models: [{ id: 'flash', name: 'Flash', reasoning: levels }, { id: 'pro', name: 'Pro', reasoning: levels }] }],
    }))
    const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config }
    const profile = join(home, 'profile')
    const turnIn = async (folder) => {
      const cwd = join(home, folder)
      mkdirSync(cwd, { recursive: true })
      const before = double.seen.length
      const run = await runCli(['--profile', profile, '--turn', `hello from ${folder}`], { env, cwd })
      assert.equal(run.code, 0, `the turn in ${folder} ran\n${run.stdout}${run.stderr}`)
      return double.seen.slice(before)
    }

    // 1. Before any default: a session in folder B uses the endpoint's own model.
    writeProfile(profile, {})
    const existing = await turnIn('folder-b')
    assert.equal(existing[0]?.model, 'flash', 'no default configured: the endpoint’s own model')

    // 2. Defaults written: a new session in folder A starts with them.
    writeProfile(profile, { defaultModel: 'pro', defaultEffort: 'high' })
    const fresh = await turnIn('folder-a')
    assert.deepEqual(fresh[0], { model: 'pro', effort: 'high' }, 'a new session’s first request carries the default model and effort')

    // 3. The session that already existed keeps what it had.
    const again = await turnIn('folder-b')
    assert.equal(again[0]?.model, 'flash', 'an existing session’s next request is unchanged by the new default')

    // 4. A default the endpoint no longer offers falls back to the endpoint’s own model, and the session still runs.
    writeProfile(profile, { defaultModel: 'retired', defaultEffort: 'high' })
    const stale = await turnIn('folder-c')
    assert.equal(stale[0]?.model, 'flash', 'a stale default model falls back rather than failing the session')
  } finally {
    await double.close()
    removeDir(home)
  }
})
