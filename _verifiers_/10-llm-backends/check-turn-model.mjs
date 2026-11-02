// A turn that names a model its endpoint does not offer is refused before anything is written (#239), as the switch
// route refuses it (selectionProblem) and as DSH's session controller refuses a selection it cannot find
// (requireModel -> session/model-unavailable). POST /api/turn checked the endpoint's name and passed the model through:
// a new session was created recording the pair, and a resumed session's record was rewritten, so every later turn
// failed with a name nobody could choose from the menu. Now the refusal is the switch route's sentence, no session is
// created, a resumed session's record is left as it was, and a model the endpoint offers still runs. Runs against
// whichever harness HEDDLE_BIN names, or the TypeScript build; local OpenAI-compatible doubles stand in for providers.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { chatDouble, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

function startServer(env) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(...heddleCommand(['web', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--sandbox-root', env.HOME]), {
        cwd: env.HOME,
        env: { ...process.env, NO_COLOR: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /(http:\/\/127\.0\.0\.1:\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ base: match[1], token: match[2], kill: () => child.kill('SIGKILL') })
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

async function call(server, method, path, body) {
  const response = await fetch(`${server.base}${path}${path.includes('?') ? '&' : '?'}token=${server.token}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  let parsed = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: response.status, body: parsed, text }
}

test('a turn naming a model its endpoint does not offer is refused with the switch route\'s sentence, and nothing is recorded', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), 'web')) return
  const home = isolatedHome('turn-model')
  const alpha = await chatDouble({ content: 'from alpha' })
  const beta = await chatDouble({ content: 'from beta' })
  let server
  try {
    const config = join(home, 'heddle.json')
    writeFileSync(config, JSON.stringify({
      default: 'alpha',
      endpoints: [
        { name: 'alpha', kind: 'openai-chat', baseUrl: alpha.baseUrl, model: 'a1', stream: true, models: [{ id: 'a1' }, { id: 'a2' }] },
        { name: 'beta', kind: 'openai-chat', baseUrl: beta.baseUrl, model: 'b1', stream: true, models: [{ id: 'b1' }] },
      ],
    }))
    server = await startServer({ HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config })
    const sessions = async () => (await call(server, 'GET', '/api/sessions')).body

    // A model the default endpoint does not offer, and one that belongs to another endpoint.
    const unknown = await call(server, 'POST', '/api/turn', { prompt: 'hello', model: 'nope' })
    assert.equal(unknown.status, 400, unknown.text)
    assert.equal(unknown.text, "no model named 'nope' on endpoint 'alpha'; configured: a1, a2\n")
    const elsewhere = await call(server, 'POST', '/api/turn', { prompt: 'hello', endpoint: 'beta', model: 'a1' })
    assert.equal(elsewhere.status, 400, elsewhere.text)
    assert.equal(elsewhere.text, "no model named 'a1' on endpoint 'beta'; configured: b1\n")
    assert.deepEqual(await sessions(), [], 'no session was created for either')
    assert.equal(alpha.requests.length + beta.requests.length, 0, 'and no provider was asked')

    // A model the endpoint offers runs, and is recorded.
    const offered = await call(server, 'POST', '/api/turn', { prompt: 'hello', model: 'a2' })
    assert.equal(offered.status, 200, offered.text)
    const [made] = await sessions()
    assert.deepEqual({ endpoint: made?.endpoint, model: made?.model }, { endpoint: 'alpha', model: 'a2' })

    // Resumed with another endpoint's model and no endpoint named: refused against the record's endpoint, which stays.
    const resumed = await call(server, 'POST', '/api/turn', { prompt: 'again', session: made.id, model: 'b1' })
    assert.equal(resumed.status, 400, resumed.text)
    assert.equal(resumed.text, "no model named 'b1' on endpoint 'alpha'; configured: a1, a2\n")
    const [after] = await sessions()
    assert.deepEqual({ endpoint: after?.endpoint, model: after?.model }, { endpoint: 'alpha', model: 'a2' }, 'the record is left as it was')
  } finally {
    server?.kill()
    await alpha.close()
    await beta.close()
    removeDir(home)
  }
})
