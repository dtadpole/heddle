import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { turnVerdict } from '../src/server/web.ts'

/**
 * A detached turn answers at acceptance and says how it ended on `/api/events` (#128).
 *
 * A browser allows six connections per host, shared by every tab, and a turn whose `POST /api/turn` answer stays open
 * until the turn ends holds one of them for minutes. Measured before (issue #128, developer-six, both builds): five
 * turns running from one tab, and every other request of that page waited until one ended. With `detach: true` the
 * route answers `202 {session, turn}` while the turn runs, and pushes the verdict as a numbered `turn` frame after the
 * turn's own events, without the answer's text. The Rust route is judged by heddle-server's
 * `a_detached_turn_answers_at_acceptance_and_its_verdict_follows_its_events`.
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'heddle-turn-detached-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

const TITLE_REQUEST = 'Create a concise title for an AI coding-assistant session'

/** A chat double that streams `held`, then waits for `release()` before it ends; a FAIL prompt is answered 500. */
async function heldDouble() {
  let release: () => void = () => {}
  let released = new Promise<void>((done) => (release = done))
  const server = createServer((request, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', async () => {
      if (request.url?.endsWith('/models')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }
      if (body.includes(TITLE_REQUEST)) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'this double answers turns, not titles' } }))
        return
      }
      if (body.includes('FAIL')) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'the double failed on purpose' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const frame = (delta: unknown, finish: string | null = null) =>
        response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`)
      frame({ role: 'assistant', content: 'held' })
      await released
      frame({ content: ' answer' })
      frame({}, 'stop')
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    release: () => release(),
    rearm: () => {
      released = new Promise<void>((done) => (release = done))
    },
    close: () =>
      new Promise<void>((done) => {
        release()
        server.closeAllConnections()
        server.close(() => done())
      }),
  }
}

function startServer(env: NodeJS.ProcessEnv, work: string): Promise<{ url: string; child: ChildProcess }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [join(repoRoot, 'src', 'cli.ts'), 'web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--session-root', join(scratch, 'sessions'), '--sandbox-root', scratch],
      { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`the server printed no URL within 30s\n${output}`))
    }, 30_000)
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match?.[1] !== undefined) {
        clearTimeout(timer)
        resolvePromise({ url: match[1], child })
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`the server exited ${code} before printing a URL\n${output}`))
    })
  })
}

interface Frame {
  readonly name: string
  readonly id: string
  readonly data: Record<string, unknown>
}

/** `/api/events`, read frame by frame. */
async function follow(url: string, cookie: string) {
  const controller = new AbortController()
  const response = await fetch(new URL('/api/events', url), { headers: { cookie }, signal: controller.signal })
  assert.equal(response.status, 200)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const frames: Frame[] = []
  const next = async (): Promise<Frame> => {
    for (;;) {
      const at = buffer.indexOf('\n\n')
      if (at !== -1) {
        const block = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        const name = /^event: (.+)$/m.exec(block)?.[1]
        const data = /^data: (.+)$/m.exec(block)?.[1]
        if (name === undefined || data === undefined) continue
        const frame = { name, id: /^id: (.+)$/m.exec(block)?.[1] ?? '', data: JSON.parse(data) as Record<string, unknown> }
        frames.push(frame)
        return frame
      }
      const { value, done } = await reader.read()
      if (done) throw new Error('the stream ended')
      buffer += decoder.decode(value, { stream: true })
    }
  }
  return {
    next,
    /** Frames up to and including the first that `wanted` accepts, within the deadline. */
    async until(wanted: (frame: Frame) => boolean, timeoutMs = 10_000): Promise<Frame[]> {
      const seen: Frame[] = []
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const remaining = deadline - Date.now()
        assert.ok(remaining > 0, `no wanted frame within ${timeoutMs} ms; saw ${seen.map((frame) => frame.name).join(', ')}`)
        const frame = await Promise.race([next(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for a frame')), remaining))])
        seen.push(frame)
        if (wanted(frame)) return seen
      }
    },
    close: () => controller.abort(),
  }
}

test('a detached turn answers 202 while it runs, and its verdict follows its events on the stream', { timeout: 60_000 }, async () => {
  const double = await heldDouble()
  const home = join(scratch, 'home-one')
  const work = join(scratch, 'work-one')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  const config = join(home, 'heddle.json')
  writeFileSync(config, JSON.stringify({ default: 'double', endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: double.url, model: 'm', capabilities: ['chat', 'stream'] }] }))
  const { url, child } = await startServer({ ...process.env, HOME: home, HEDDLE_HOME: home, HEDDLE_CONFIG: config, NO_COLOR: '1' }, work)
  try {
    const handshake = await fetch(url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]!
    const stream = await follow(url, cookie)
    try {
      await stream.until((frame) => frame.name === 'ready')
      const accepted = await Promise.race([
        fetch(new URL('/api/turn', url), {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'go', detach: true }),
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the turn did not answer while it ran')), 5_000)),
      ])
      assert.equal(accepted.status, 202)
      assert.match(String(accepted.headers.get('content-type')), /application\/json/)
      const body = (await accepted.json()) as { session?: string; turn?: string }
      assert.ok(typeof body.session === 'string' && typeof body.turn === 'string' && body.turn.length > 0, JSON.stringify(body))
      /** Answered once the prompt is in the log: a page that adopts the session from this answer and reads it sees the message. */
      const view = (await (await fetch(new URL(`/api/sessions/${body.session}`, url), { headers: { cookie } })).json()) as { turns?: { kind?: string; text?: string }[] }
      assert.ok((view.turns ?? []).some((turn) => turn.kind === 'user' && String(turn.text).includes('go')), `the prompt is in the session at the 202: ${JSON.stringify(view.turns)}`)
      await stream.until((frame) => frame.name === 'session' && JSON.stringify(frame.data).includes('held'))
      const listed = (await (await fetch(new URL('/api/sessions', url), { headers: { cookie } })).json()) as { id: string; running?: boolean }[]
      assert.equal(listed.find((entry) => entry.id === body.session)?.running, true, 'accepted and still running')

      double.release()
      const rest = await stream.until((frame) => frame.name === 'turn')
      const verdict = rest.at(-1)!
      assert.ok(verdict.id.length > 0, 'the verdict is numbered, so a reconnect replays it')
      assert.equal(verdict.data.turn, body.turn)
      assert.equal(verdict.data.outcome, 'done')
      assert.equal(verdict.data.session, body.session)
      assert.equal('text' in verdict.data, false, 'without the answer, which the stream already carried')
      const kinds = rest.filter((frame) => frame.name === 'session').map((frame) => (frame.data.event as { type?: string }).type)
      assert.ok(kinds.includes('turn/completed'), `the turn's own end came before its verdict: ${kinds.join(', ')}`)
      const after = (await (await fetch(new URL('/api/sessions', url), { headers: { cookie } })).json()) as { id: string; running?: boolean }[]
      assert.notEqual(after.find((entry) => entry.id === body.session)?.running, true, 'and it is no longer running')

      double.rearm()
      const failed = await fetch(new URL('/api/turn', url), {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'FAIL now', session: body.session, detach: true }),
      })
      assert.equal(failed.status, 202)
      const failedTurn = ((await failed.json()) as { turn: string }).turn
      const ending = await stream.until((frame) => frame.name === 'turn' && frame.data.turn === failedTurn)
      const failure = ending.at(-1)!
      assert.equal(failure.data.outcome, 'error')
      assert.match(String(failure.data.message), /failed on purpose|500/)
      const recorded = await stream.until((frame) => frame.name === 'session' && (frame.data.event as { type?: string }).type === 'turn/failed')
      assert.ok(recorded.length > 0, 'and the failure is recorded for every page')
    } finally {
      stream.close()
    }
  } finally {
    child.kill('SIGKILL')
    await double.close()
  }
})

test('a turn without detach still streams its answer to the end', { timeout: 60_000 }, async () => {
  const double = await heldDouble()
  const home = join(scratch, 'home-two')
  const work = join(scratch, 'work-two')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  const config = join(home, 'heddle.json')
  writeFileSync(config, JSON.stringify({ default: 'double', endpoints: [{ name: 'double', kind: 'openai-chat', baseUrl: double.url, model: 'm', capabilities: ['chat', 'stream'] }] }))
  const { url, child } = await startServer({ ...process.env, HOME: home, HEDDLE_HOME: home, HEDDLE_CONFIG: config, NO_COLOR: '1' }, work)
  try {
    const handshake = await fetch(url, { redirect: 'manual' })
    const cookie = String(handshake.headers.get('set-cookie') ?? '').split(';')[0]!
    double.release()
    const response = await fetch(new URL('/api/turn', url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'go' }),
    })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.match(text, /event: session\n/)
    assert.match(text, /event: done\n/)
    assert.match(text, /"text":"held answer"/, 'the done frame on the response keeps the answer text')
  } finally {
    child.kill('SIGKILL')
    await double.close()
  }
})

test("the verdict is the terminal frame's fields with its name as outcome, the turn id, and no answer text", () => {
  assert.deepEqual(turnVerdict('t1', 'done', { session: 's', text: 'the answer', finishReason: 'stop', rounds: 1, denials: [] }), {
    session: 's',
    finishReason: 'stop',
    rounds: 1,
    denials: [],
    turn: 't1',
    outcome: 'done',
  })
  assert.deepEqual(turnVerdict('t2', 'error', { session: 's', message: 'boom' }), { session: 's', message: 'boom', turn: 't2', outcome: 'error' })
})
