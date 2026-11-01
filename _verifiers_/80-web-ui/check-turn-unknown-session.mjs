import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A turn for a session the server does not hold is one client error on every build.
 *
 * DSH answers a session it does not hold with `session/not-found` (`dsh-api-session-controller`). heddle's other session
 * routes answer `404 {"error": "no session <id>"}`, so `/api/turn` answers `404 {"error": "no session <id>", "code":
 * "session/not-found"}`, and a string that is not a session id gets the same status and code without being echoed.
 * Before, the TypeScript server answered `500 internal error: no session '<id>' under <session root>` and the Rust
 * server `400 {"error": "no session '<id>' under <session root>"}` (DSH parity R-developer-seven-2): two shapes, one of
 * them calling a client mistake an internal error, and both printing a path from the server's disk.
 *
 * No browser: this judges the route, on whichever build `HEDDLE_BIN` names (the TypeScript build otherwise).
 */

function startServer(label) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const home = isolatedHome(`turn-unknown-${label}`)
      const work = fixtureDir(`turn-unknown-${label}-work`)
      const { config } = scriptedConfig({ home, steps: [{ text: 'first answer' }, { text: 'second answer' }] })
      const sessionRoot = `${home}/sessions`
      const child = spawn(
        ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', sessionRoot]),
        { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({
            url: match[1],
            home,
            work,
            sessionRoot,
            close: async () => {
              child.kill('SIGKILL')
              removeDir(home)
              removeDir(work)
            },
          })
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
    })()
  })
}

/** A request carrying the launch token, as the page's first load does. */
async function request(server, path, options = {}) {
  const base = new URL(server.url)
  const target = new URL(path, base)
  target.searchParams.set('token', base.searchParams.get('token') ?? '')
  const response = await fetch(target, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
  const text = await response.text()
  return { status: response.status, type: response.headers.get('content-type') ?? '', text }
}

const turn = (server, body) => request(server, '/api/turn', { method: 'POST', body: JSON.stringify(body) })

test('a turn for a session the server does not hold is 404 session/not-found, and a held session continues', async (t) => {
  const server = await startServer('main')
  try {
    await t.test('a well-formed id of no session: 404, DSH code, the id named, no path', async () => {
      const unknown = 'session-22222222-2222-2222-2222-222222222222'
      const answer = await turn(server, { prompt: 'hello', session: unknown })
      assert.equal(answer.status, 404, `status, with body ${answer.text}`)
      assert.match(answer.type, /^application\/json/, 'a JSON body')
      assert.deepEqual(JSON.parse(answer.text), { error: `no session ${unknown}`, code: 'session/not-found' })
      assert.ok(!answer.text.includes(server.sessionRoot) && !answer.text.includes(server.home), 'no path from the server')
    })

    await t.test('a string that is not a session id: the same status and code, not echoed', async () => {
      for (const raw of ['session-does-not-exist', '../../etc/passwd']) {
        const answer = await turn(server, { prompt: 'hello', session: raw })
        assert.equal(answer.status, 404, `${raw}: status, with body ${answer.text}`)
        assert.deepEqual(JSON.parse(answer.text), { error: 'no session with that id', code: 'session/not-found' }, raw)
      }
    })

    await t.test('nothing was created by a refused turn, and a held session still continues', async () => {
      const before = await request(server, '/api/sessions')
      assert.equal(before.status, 200)
      assert.equal(JSON.parse(before.text).length, 0, 'the refusals left no session behind')
      const first = await turn(server, { prompt: 'start one', folder: server.work })
      assert.equal(first.status, 200, `the first turn runs: ${first.text.slice(0, 200)}`)
      const listed = JSON.parse((await request(server, '/api/sessions')).text)
      assert.equal(listed.length, 1, 'the first turn made one session')
      const again = await turn(server, { prompt: 'continue', session: listed[0].id })
      assert.equal(again.status, 200, `a held session continues: ${again.text.slice(0, 200)}`)
    })
  } finally {
    await server.close()
  }
})
