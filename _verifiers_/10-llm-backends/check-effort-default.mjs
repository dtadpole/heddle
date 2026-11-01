// A turn that names no reasoning effort runs at its model's declared default (#157), as DSH's dsh-llm
// resolveCallWithInfo resolves `requested ?? reasoning.defaultEffort`: the provider receives that level's value and the
// session's model/request record names it, marked reasoningEffortDefault as DSH marks adapterDefaults. A model that declares levels but
// no default sends nothing (the provider's own default). Runs against whichever harness HEDDLE_BIN names, or the
// TypeScript build; a local OpenAI-compatible double stands in for the provider.
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
  return { status: response.status, body: parsed }
}

const LEVELS = [
  { id: 'low', name: 'Low', value: 'low' },
  { id: 'high', name: 'High', value: 'high' },
  { id: 'xhigh', name: 'XHigh', value: 'xhigh' },
]

/** The session's model/request records, read from its log as the page's Download does. */
async function modelRequests(server, session) {
  const response = await fetch(`${server.base}/api/sessions/${encodeURIComponent(session)}/log?token=${server.token}`)
  const text = await response.text()
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.type === 'model/request')
}

test('a turn that names no effort runs at the model\'s declared default, recorded as that level and marked as a default', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), 'web')) return
  const home = isolatedHome('effort-default')
  const double = await chatDouble({ content: 'ok' })
  let server
  try {
    const file = join(home, 'heddle.json')
    writeFileSync(
      file,
      JSON.stringify({
        default: 'gateway',
        exclude: ['scripted'],
        endpoints: [{
          name: 'gateway', kind: 'openai-chat', baseUrl: double.baseUrl, model: 'opus', stream: true,
          models: [
            { id: 'opus', name: 'Opus', reasoning: { default: 'xhigh', levels: LEVELS } },
            { id: 'sonnet', name: 'Sonnet', reasoning: { levels: LEVELS } },
          ],
        }],
      }),
    )
    server = await startServer({ HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: file })

    // No effort named, on a model whose default is xhigh.
    const first = await call(server, 'POST', '/api/turn', { prompt: 'think about it' })
    assert.equal(first.status, 200, `the turn ran\n${JSON.stringify(first.body).slice(0, 300)}`)
    const listed = await call(server, 'GET', '/api/sessions')
    const firstSession = (Array.isArray(listed.body) ? listed.body : [])[0]?.id
    assert.ok(firstSession, 'the turn started a session')
    const sent = JSON.parse(double.requests[0].body)
    assert.equal(sent.model, 'opus')
    assert.equal(sent.reasoning_effort, 'xhigh', 'the provider receives the declared default, as DSH sends it')

    // A named effort is the request's own.
    const named = await call(server, 'POST', '/api/turn', { prompt: 'a little', reasoningEffort: 'low' })
    assert.equal(named.status, 200, JSON.stringify(named.body).slice(0, 300))
    assert.equal(JSON.parse(double.requests.at(-1).body).reasoning_effort, 'low', 'a named level is sent as named')

    // A model with levels but no default sends nothing.
    const plain = await call(server, 'POST', '/api/turn', { prompt: 'plainly', model: 'sonnet' })
    assert.equal(plain.status, 200, JSON.stringify(plain.body).slice(0, 300))
    const plainBody = JSON.parse(double.requests.at(-1).body)
    assert.equal(plainBody.model, 'sonnet')
    assert.equal(plainBody.reasoning_effort, undefined, 'no default: the provider\'s own, so nothing is invented')

    // The first turn's record names the effort the call ran at, as DSH's request header does.
    const records = await modelRequests(server, firstSession)
    assert.ok(records.length >= 1, 'the session recorded its request')
    assert.equal(records[0].reasoningEffort, 'xhigh', 'the record names the effort the call ran at')
    assert.equal(records[0].reasoningEffortDefault, true, 'marked as the model default, not a person\'s choice')
    const all = await call(server, 'GET', '/api/sessions')
    const namedSession = (Array.isArray(all.body) ? all.body : []).map((meta) => meta.id).filter((id) => id !== firstSession)
    for (const id of namedSession) {
      for (const record of await modelRequests(server, id)) {
        assert.equal(record.reasoningEffortDefault, undefined, `a named level or no level is not marked as a default (${JSON.stringify(record).slice(0, 160)})`)
      }
    }
  } finally {
    server?.kill()
    await double.close()
    removeDir(home)
  }
})
