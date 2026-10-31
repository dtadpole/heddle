import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, scriptedConfig } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A Stop, or the bash wall time, ends the whole command a shell started, not only the shell.
 *
 * Live-testing draft developer-five-5: both builds signalled only `/bin/sh`, so the command's own processes were
 * re-parented to init and kept running after the person pressed Stop (a long build, a server, a destructive loop),
 * and the TypeScript turn did not even end until they exited, then reported `the command exited null`. DSH starts
 * each child detached, as the leader of its own process group, and signals the group (`dsh-subprocess-local`,
 * `signalChildGroup`). Under the session's sandbox mode, as a turn runs it, the command here starts a background
 * `sleep`, writes its pid into the workspace and waits; the check then stops the turn through the API (or lets the
 * wall time pass) and asks three things: did the turn end at once, is the `sleep` gone, and does the call say what
 * happened.
 *
 * No browser: the scripted endpoint, the built server and `ps`-level facts are enough.
 *
 * The wall-time scenario runs with the jobs row's `promoteOnTimeout` off, through a `--patch` overlay over the
 * project's own patch. With it on (the default, as DSH's `dsh-tool-bash` while a job registry is loaded), a command
 * that outlives its wall time is not killed but moves to a background job; `50-agentic-loop/check-jobs.mjs` judges
 * that. A Stop ends the command either way, so the Stop scenario runs with the default profile.
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

/** One server whose scripted model asks for `bash` with `extra` arguments, then answers. */
async function scenario(name, extra, body, options = {}) {
  const home = isolatedHome(`stop-group-${name}`)
  const work = fixtureDir(`stop-group-${name}-work`)
  const pidFile = join(work, 'child.pid')
  const command = `sleep 43 & echo $! > ${JSON.stringify(pidFile)}; wait`
  const { config } = scriptedConfig({
    home,
    steps: [{ toolCall: { name: 'bash', arguments: { command, ...extra } } }, { text: 'after the command' }],
  })
  /** An overlay replaces the project patch, so it includes it first and then edits it. */
  const overlay = options.overlay === undefined ? [] : ['--patch', join(home, 'overlay.yml')]
  if (options.overlay !== undefined) writeFileSync(join(home, 'overlay.yml'), `- include: ${join(repoRoot, 'heddle.patch.yml')}\n${options.overlay}`)
  const child = spawn(
    ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', ...overlay, '--endpoint', 'scripted', '--session-root', join(home, 'sessions'), '--sandbox-root', work]),
    { cwd: repoRoot, env: { ...process.env, HOME: home, HEDDLE_CONFIG: config, NO_COLOR: '1' } },
  )
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
      child.stdout.on('data', read)
      child.stderr.on('data', read)
      child.on('exit', (code) => reject(new Error(`the server exited ${code}:\n${printed}`)))
    })
    const base = new URL(url)
    const address = (path) => {
      const target = new URL(path, base)
      target.searchParams.set('token', base.searchParams.get('token') ?? '')
      return target
    }
    const api = async (method, path, payload) => {
      const response = await fetch(address(path), {
        method,
        headers: { 'content-type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      })
      return { status: response.status, text: await response.text() }
    }
    assert.ok((await api('POST', '/api/workspaces', { path: work })).status < 300, 'the workspace is registered')
    const created = JSON.parse((await api('POST', '/api/sessions', { branch: work, title: name })).text)
    const session = created.session
    assert.equal(typeof session, 'string', 'a session is created')

    /** The turn's stream, read to its end, so the check knows when the turn ended. */
    const turnEnded = fetch(address('/api/turn'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session, prompt: 'run the command' }),
    }).then(async (response) => {
      await response.text()
      return Date.now()
    })

    const startBy = Date.now() + 20_000
    while (!(existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '') && Date.now() < startBy) await settle(25)
    assert.ok(existsSync(pidFile), 'the command started and wrote its child pid')
    pid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.ok(Number.isInteger(pid) && alive(pid), 'the background command is running')

    const ended = (withinMs) => Promise.race([turnEnded, settle(withinMs).then(() => null)])
    const log = async () => (await api('GET', `/api/sessions/${encodeURIComponent(session)}/log`)).text
    await body({ api, session, pid, ended, log })
  } finally {
    if (pid !== undefined && alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
    child.kill('SIGKILL')
    removeDir(home)
    removeDir(work)
  }
}

test('a Stop ends the whole command a shell started, as DSH stops a process group', async (t) => {
  await scenario('stop', {}, async ({ api, session, pid, ended, log }) => {
    const stoppedAt = Date.now()
    const stop = await api('POST', `/api/sessions/${encodeURIComponent(session)}/stop`)
    assert.ok(stop.status < 300, `the stop is accepted: ${stop.status} ${stop.text}`)
    const end = await ended(15_000)

    await t.test('the turn ends at once, not when the command would have finished', () => {
      assert.ok(end !== null, 'the turn ended within 15 s of the Stop')
      assert.ok(end - stoppedAt < 3_000, `the turn ended ${end - stoppedAt} ms after the Stop`)
    })
    await t.test('nothing the command started is left running', async () => {
      assert.ok(await gone(pid, 3_000), `the background sleep (pid ${pid}) is gone after the Stop`)
    })
    await t.test('the call is recorded as stopped, not as an ordinary exit', async () => {
      const text = await log()
      // The tool message the model reads is `error (<code>): <message>` on both builds.
      assert.match(text, /error \(INTERRUPTED\): the command was stopped before it finished/, 'the bash result says it was stopped')
      assert.doesNotMatch(text, /error \(EXIT\): the command exited null/, 'not the old misleading exit')
    })
  })
})

test('the bash wall time ends the whole command too, and says so', async (t) => {
  await scenario('timeout', { timeoutMs: 1_500 }, async ({ pid, ended, log }) => {
    const end = await ended(20_000)
    await t.test('the turn ends soon after the wall time', () => {
      assert.ok(end !== null, 'the turn ended within 20 s')
    })
    await t.test('nothing the command started is left running', async () => {
      assert.ok(await gone(pid, 3_000), `the background sleep (pid ${pid}) is gone after the timeout`)
    })
    await t.test('the call is recorded as timed out', async () => {
      assert.match(await log(), /error \(TIMEOUT\): the command exceeded 1500ms and was killed/, 'the bash result says it timed out')
    })
  }, { overlay: '- patch:\n    - id: jobs\n      config:\n        promoteOnTimeout: false\n' })
})
