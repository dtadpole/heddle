import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, readTranscript, removeDir, repoRoot, scriptedConfig, sessionsUnder } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A restart during a bash call ends the command and records the call as interrupted.
 *
 * Live-testing issue #6: a server sent SIGTERM while a turn's bash command ran either exited at once and left the
 * command running orphaned (Rust), or waited for the command to finish on its own and then wrote no result at all
 * (TypeScript). DSH cancels its agents at teardown, ends each command's process group with a grace, and closes open
 * calls as interrupted. Here the command starts a background `sleep`, writes its pid into the workspace and waits; the
 * check sends the server SIGTERM, as a service restart does, and asks: did the server go promptly, is the `sleep`
 * gone, and does the session log on disk say the call was interrupted.
 *
 * No browser: the scripted endpoint, the built server, process facts and the session store are enough.
 */

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

async function gone(pid, withinMs) {
  const deadline = Date.now() + withinMs
  while (alive(pid) && Date.now() < deadline) await settle(25)
  return !alive(pid)
}

test('a restart during a bash call ends the command and records the call as interrupted, as DSH tears down', async (t) => {
  const home = isolatedHome('shutdown-group')
  const work = fixtureDir('shutdown-group-work')
  const pidFile = join(work, 'child.pid')
  const sessions = join(home, 'sessions')
  const command = `sleep 43 & echo $! > ${JSON.stringify(pidFile)}; wait`
  const { config } = scriptedConfig({ home, steps: [{ toolCall: { name: 'bash', arguments: { command } } }, { text: 'after the command' }] })
  const server = spawn(...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', sessions, '--sandbox-root', work]), {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, HEDDLE_CONFIG: config, NO_COLOR: '1' },
  })
  const exited = new Promise((resolve) => server.on('exit', () => resolve(Date.now())))
  let printed = ''
  let pid
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the server did not start:\n${printed}`)), 20_000)
      const read = (chunk) => {
        printed += chunk
        const match = /heddle web: (http:\/\/\S+)/.exec(printed)
        if (match) {
          clearTimeout(timer)
          resolve(match[1])
        }
      }
      server.stdout.on('data', read)
      server.stderr.on('data', read)
    })
    const base = new URL(url)
    const address = (path) => {
      const target = new URL(path, base)
      target.searchParams.set('token', base.searchParams.get('token') ?? '')
      return target
    }
    const post = (path, payload) =>
      fetch(address(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    assert.ok((await post('/api/workspaces', { path: work })).status < 300, 'the workspace is registered')
    const session = (await (await post('/api/sessions', { branch: work, title: 'shutdown' })).json()).session
    assert.equal(typeof session, 'string', 'a session is created')
    // The turn's stream is left open; the restart ends it.
    void post('/api/turn', { session, prompt: 'run the command' }).then((response) => response.text()).catch(() => {})

    const startBy = Date.now() + 20_000
    while (!(existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '') && Date.now() < startBy) await settle(25)
    assert.ok(existsSync(pidFile), 'the command started and wrote its child pid')
    pid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.ok(Number.isInteger(pid) && alive(pid), 'the background command is running')

    const signalledAt = Date.now()
    server.kill('SIGTERM')
    const end = await Promise.race([exited, settle(15_000).then(() => null)])

    await t.test('the server goes promptly, not when the command would have finished', () => {
      assert.ok(end !== null, 'the server exited within 15 s of SIGTERM')
      assert.ok(end - signalledAt < 8_000, `the server exited ${end - signalledAt} ms after SIGTERM`)
    })
    await t.test('nothing the command started outlives the server', async () => {
      assert.ok(await gone(pid, 3_000), `the background sleep (pid ${pid}) is gone after the restart`)
    })
    await t.test('the session log on disk records the call as interrupted', () => {
      const dir = sessionsUnder(sessions)[0]
      assert.ok(dir, 'the session is on disk')
      const tools = readTranscript(join(sessions, dir))
        .filter((event) => event.type === 'message' && event.message?.role === 'tool')
        .map((event) => (event.message.content ?? []).map((part) => part.text ?? '').join(''))
      assert.ok(tools.some((text) => /^error \(INTERRUPTED\)/.test(text)), `the bash result says INTERRUPTED: ${JSON.stringify(tools)}`)
    })
  } finally {
    if (pid !== undefined && alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
    server.kill('SIGKILL')
    removeDir(home)
    removeDir(work)
  }
})

/**
 * A turn asked for while the server is shutting down is refused, not started.
 *
 * The shutdown gives stopped turns DSH's grace to settle (TERM, then KILL after 3 s for a command run as a job), and
 * the listener stays open for that time. developer-nine's follow-up to issue #6: a turn that arrives in that window
 * used to start a fresh command that nothing would stop, because the turns were aborted before it existed. Here the
 * command and its sleep ignore SIGTERM, so the grace runs its full 3 s; a second session's turn is asked for in it.
 */
test('a turn asked for during the shutdown grace is refused with 503, not started', async (t) => {
  const home = isolatedHome('shutdown-refuse')
  const work = fixtureDir('shutdown-refuse-work')
  const pidFile = join(work, 'child.pid')
  const sessions = join(home, 'sessions')
  const command = `trap '' TERM; sleep 47 & echo $! > ${JSON.stringify(pidFile)}; wait`
  const { config } = scriptedConfig({
    home,
    steps: [{ toolCall: { name: 'bash', arguments: { command } } }, { text: 'after the command' }, { text: 'a turn that must not run' }],
  })
  const server = spawn(...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'scripted', '--session-root', sessions, '--sandbox-root', work]), {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, HEDDLE_CONFIG: config, NO_COLOR: '1' },
  })
  const exited = new Promise((resolve) => server.on('exit', () => resolve(Date.now())))
  let printed = ''
  let pid
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the server did not start:\n${printed}`)), 20_000)
      const read = (chunk) => {
        printed += chunk
        const match = /heddle web: (http:\/\/\S+)/.exec(printed)
        if (match) {
          clearTimeout(timer)
          resolve(match[1])
        }
      }
      server.stdout.on('data', read)
      server.stderr.on('data', read)
    })
    const base = new URL(url)
    const address = (path) => {
      const target = new URL(path, base)
      target.searchParams.set('token', base.searchParams.get('token') ?? '')
      return target
    }
    const post = (path, payload) =>
      fetch(address(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    assert.ok((await post('/api/workspaces', { path: work })).status < 300, 'the workspace is registered')
    const first = (await (await post('/api/sessions', { branch: work, title: 'shutdown' })).json()).session
    const late = (await (await post('/api/sessions', { branch: work, title: 'late' })).json()).session
    assert.ok(typeof first === 'string' && typeof late === 'string', 'two sessions are created')
    void post('/api/turn', { session: first, prompt: 'run the command' }).then((response) => response.text()).catch(() => {})

    const startBy = Date.now() + 20_000
    while (!(existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '') && Date.now() < startBy) await settle(25)
    assert.ok(existsSync(pidFile), 'the command started and wrote its child pid')
    pid = Number(readFileSync(pidFile, 'utf8').trim())

    const signalledAt = Date.now()
    server.kill('SIGTERM')
    await settle(300)
    const answer = await post('/api/turn', { session: late, prompt: 'start during the grace' })
      .then(async (response) => ({
        status: response.status,
        body: await Promise.race([response.text().catch((error) => String(error)), settle(8_000).then(() => '(still streaming)')]),
      }))
      .catch((error) => ({ status: 0, body: String(error) }))
    const end = await Promise.race([exited, settle(15_000).then(() => null)])

    await t.test('the server still answered during its grace', () => {
      assert.notEqual(answer.status, 0, `the late request reached the server: ${answer.body}`)
    })
    await t.test('the late turn is refused with 503 and says the server is shutting down', () => {
      assert.equal(answer.status, 503, `a turn asked for during the grace is refused: ${answer.status} ${answer.body.slice(0, 200)}`)
      assert.match(answer.body, /shutting down/, 'the refusal says why')
    })
    await t.test('the server still goes within the grace', () => {
      assert.ok(end !== null && end - signalledAt < 8_000, `the server exited ${end === null ? 'not at all' : `${end - signalledAt} ms`} after SIGTERM`)
    })
  } finally {
    if (pid !== undefined && alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
    server.kill('SIGKILL')
    removeDir(home)
    removeDir(work)
  }
})
