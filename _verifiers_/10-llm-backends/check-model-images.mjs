import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isTitleRequest, readTranscript, refuseTitleRequest, removeDir, repoRoot, runCli, skipUnless, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A model's image input can be declared per model, so an image never depends on a slow provider list (#178).
 *
 * Measured before, on main 40182eed5, on both builds: an endpoint that declares no endpoint-wide `inputModalities`
 * learns per model whether it takes images by reading `GET <base>/models`, with a 1.5 s timeout. A list that answered
 * after 2.5 s was a failed read, so an image for an image-capable model went out as "[image omitted because this model
 * accepts text only …]", on every image turn, and nobody was told. A per-model declaration was ignored.
 *
 * DSH declares image input per model in its catalogue (dsh-llm-deepseek: the image-capable deepseek-flash beside the
 * text-only deepseek-v4-pro), not by a request-time read. heddle now reads `inputModalities` on an endpoint's `models`
 * entries: the model's own, else the endpoint's, else the provider's list.
 */

const CAPABILITY = 'a Web UI whose turn route runs model turns'
/** A one-pixel PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

/**
 * A chat double whose model list answers after `delayMs` (2.5 s by default) with `list`, or refuses with a 500 when
 * `failList`; every completion body is kept.
 */
async function slowListDouble({ delayMs = 2500, list = [{ id: 'vis-fake', input_modalities: ['text', 'image'] }, { id: 'text-fake', input_modalities: ['text'] }], failList = false } = {}) {
  const state = { completions: [], listReads: 0 }
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      if (new URL(request.url ?? '/', 'http://x').pathname.endsWith('/models')) {
        state.listReads += 1
        if (failList) {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'list unavailable' }))
          return
        }
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ data: list }))
        }, delayMs).unref()
        return
      }
      if (isTitleRequest(body)) return refuseTitleRequest(response)
      state.completions.push(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'seen' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    state,
    close: () =>
      new Promise((done) => {
        server.close(done)
        server.closeAllConnections()
      }),
  }
}

function startServer(args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(...heddleCommand(args), { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let settled = false
    const onData = (chunk) => {
      output += chunk.toString()
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match && !settled) {
        settled = true
        resolvePromise({ child, url: match[1] })
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
    }, 15_000).unref()
  })
}

function killServer(server) {
  return new Promise((resolve) => {
    if (server.child.exitCode !== null || server.child.signalCode !== null) return resolve()
    server.child.once('exit', () => resolve())
    server.child.kill('SIGKILL')
  })
}

/** Post a turn and read it to its end; the session it ran in, and the streamed body. */
async function turn(server, body) {
  const base = new URL(server.url)
  const target = new URL('/api/turn', base)
  target.searchParams.set('token', base.searchParams.get('token') ?? '')
  const response = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
  const text = await response.text()
  assert.equal(response.status, 200, `the turn was accepted\n${text.slice(0, 400)}`)
  const named = /event: session\ndata: (\{.*\})/.exec(text)
  return { session: named ? JSON.parse(named[1]).session : undefined, text }
}

/** An API call with the printed URL's token. */
function api(server, path, options = {}) {
  const base = new URL(server.url)
  const target = new URL(path, base)
  target.searchParams.set('token', base.searchParams.get('token') ?? '')
  return fetch(target, { ...options, signal: AbortSignal.timeout(60_000) })
}

/** Upload the PNG and run one turn on `model` with it attached; the turn's streamed body. */
async function imageTurn(server, work, model, endpoint = 'mixed', session) {
  const uploaded = await api(server, '/api/uploads?name=dot.png', { method: 'POST', body: PNG })
  assert.equal(uploaded.status, 200, `the upload was stored (${uploaded.status})`)
  const stored = String((await uploaded.json()).path ?? '')
  const response = await api(server, '/api/turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'What is in the picture?', folder: work, endpoint, model, attachments: [stored], ...(session !== undefined ? { session } : {}) }),
  })
  const text = await response.text()
  assert.equal(response.status, 200, `the turn was accepted\n${text.slice(0, 400)}`)
  assert.match(text, /seen/, `the turn was answered\n${text.slice(-300)}`)
  const named = /event: session\ndata: (\{.*\})/.exec(text)
  return { text, session: named ? JSON.parse(named[1]).session : undefined }
}

/** One endpoint serving an image model beside a text model, each declared, plus `plain`, which declares nothing. */
async function withServer(label, double, body) {
  const home = fixtureDir(label)
  const work = join(home, 'work')
  const sessions = join(home, 'sessions')
  let server
  try {
    mkdirSync(work, { recursive: true })
    writeJson(join(home, 'heddle.json'), {
      default: 'mixed',
      endpoints: [{
        name: 'mixed',
        kind: 'openai-chat',
        baseUrl: double.url,
        model: 'vis-fake',
        stream: true,
        models: [{ id: 'vis-fake', inputModalities: ['text', 'image'] }, { id: 'text-fake', inputModalities: ['text'] }],
      }, { name: 'plain', kind: 'openai-chat', baseUrl: double.url, model: 'vis-fake', stream: true }],
    })
    server = await startServer(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', sessions], { HOME: home, HEDDLE_HOME: home, HEDDLE_CONFIG: join(home, 'heddle.json') })
    await body(server, work, sessions)
  } finally {
    if (server) await killServer(server)
    await double.close()
    removeDir(home)
  }
}

const supportsWeb = async () => /web/.test((await runCli(['--help'])).stdout)

test('a model declared image-capable gets the image without waiting on a slow provider list (#178)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const double = await slowListDouble()
  await withServer('model-images-vis', double, async (server, work) => {
    await imageTurn(server, work, 'vis-fake')
    const sent = double.state.completions.at(-1) ?? ''
    assert.match(sent, /"type":"image_url"/, 'the provider received the image part')
    assert.doesNotMatch(sent, /accepts text only/, 'not the text-only placeholder')
    assert.equal(double.state.listReads, 0, 'and the provider list was not read: the declaration was enough')
  })
})

test('a model declared text-only beside it gets the placeholder, without a list read either (#178)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const double = await slowListDouble()
  await withServer('model-images-text', double, async (server, work) => {
    await imageTurn(server, work, 'text-fake')
    const sent = double.state.completions.at(-1) ?? ''
    assert.match(sent, /\[image omitted because this model accepts text only; attachment sha256:[0-9a-f]{8}\]/, "DSH's placeholder, as declared")
    assert.doesNotMatch(sent, /"type":"image_url"/)
    assert.equal(double.state.listReads, 0, 'the provider list was not read')
  })
})

test('a model nothing declares, whose list cannot be read, has its image held back truthfully and the person is told (#178)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const double = await slowListDouble({ failList: true })
  await withServer('model-images-unread', double, async (server, work, sessions) => {
    const first = await imageTurn(server, work, 'vis-fake', 'plain')
    const sent = double.state.completions.at(-1) ?? ''
    assert.match(sent, /\[image not sent: this model's image support could not be read from the provider; attachment sha256:[0-9a-f]{8}\]/, 'the model is told the image was withheld')
    assert.doesNotMatch(sent, /accepts text only|"type":"image_url"/, 'not a false "text only", and no image bytes')
    const completed = readTranscript(join(sessions, first.session)).filter((event) => event.type === 'assistant/completed').at(-1)
    assert.ok((completed?.ended ?? []).some((reason) => /^image not sent: the model's image support could not be read/.test(reason)), `the turn keeps the notice for the person\n${JSON.stringify(completed?.ended)}`)
    assert.equal(double.state.listReads, 1)
    await imageTurn(server, work, 'vis-fake', 'plain', first.session)
    assert.equal(double.state.listReads, 2, 'a failed read is not cached: the next image turn asks again')
  })
})

test('a model whose list answers text only gets DSH\'s placeholder and no notice (#178)', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const double = await slowListDouble({ delayMs: 0, list: [{ id: 'vis-fake', input_modalities: ['text'] }] })
  await withServer('model-images-answered-text', double, async (server, work, sessions) => {
    const turn = await imageTurn(server, work, 'vis-fake', 'plain')
    const sent = double.state.completions.at(-1) ?? ''
    assert.match(sent, /\[image omitted because this model accepts text only; attachment sha256:[0-9a-f]{8}\]/, 'the placeholder, as the list said')
    assert.doesNotMatch(sent, /"type":"image_url"/)
    const completed = readTranscript(join(sessions, turn.session)).filter((event) => event.type === 'assistant/completed').at(-1)
    assert.equal(completed?.ended, undefined, 'a known text-only model is no surprise to report')
  })
})
