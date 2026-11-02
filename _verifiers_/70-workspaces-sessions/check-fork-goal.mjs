import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A fork keeps the session's goal (issue #166).
 *
 * dsh-goal: "After session resume or fork, the goal, its phase, its revisions, and its admitted-round count are all
 * still there. Automatic continuation is the exception: an active goal is disarmed after any session-start edge." The
 * fork seed is the source's exact event prefix (`buildForkSeed`). heddle left every `goal/change` out of the seed on
 * both builds, so the branch answered "No goal is currently set". The goal's objective, phase and round count were gone.
 *
 * The source sets a goal and pauses it. The fork must carry the same goal: id, objective, phase paused, revision, round
 * count. A person's `/goal resume` in the branch must then work there.
 */

const CAPABILITY = 'the Web UI'

async function startServer(label) {
  const home = isolatedHome(`fork-goal-${label}`)
  const work = fixtureDir(`fork-goal-${label}-work`)
  mkdirSync(work, { recursive: true })
  const config = join(home, 'heddle.json')
  const script = join(home, 'script.json')
  scriptedConfig({ home, steps: [{ text: 'idle' }] })
  const child = spawn(...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')]), {
    cwd: work,
    env: { ...process.env, NO_COLOR: '1', HEDDLE_HOME: home, HEDDLE_CONFIG: config },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const url = await new Promise((resolvePromise, reject) => {
    const onData = (chunk) => {
      output += chunk.toString()
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match) resolvePromise(match[1])
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => reject(new Error(`the server exited ${code} before printing a URL\n${output}`)))
    setTimeout(() => reject(new Error(`the server printed no URL within 15s\n${output}`)), 15_000).unref()
  })
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')?.split(';')[0]
  if (cookie === undefined) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return {
    url,
    work,
    script,
    cookie,
    output: () => output,
    close: async () => {
      child.kill('SIGKILL')
      removeDir(home)
      removeDir(work)
    },
  }
}

async function api(server, path, init = {}) {
  const response = await fetch(new URL(path, server.url), { ...init, headers: { cookie: server.cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

test('#166: a fork carries its source’s goal, phase and round count, and the branch can resume it', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('paused')
  try {
    const folder = join(server.work, 'source')
    mkdirSync(folder, { recursive: true })
    await api(server, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: folder }) })
    writeFileSync(server.script, JSON.stringify({ steps: ['hello', 'one', 'two', 'three', 'four', 'five'].map((text) => ({ text })) }))
    const response = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie: server.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a first turn', folder, new: true }),
    })
    assert.equal(response.status, 200, `the first turn ran (${response.status})`)
    const source = JSON.parse(/event: session\ndata: (.*)/.exec(await response.text())?.[1] ?? '{}').session
    assert.equal(typeof source, 'string', 'the turn named its session')
    const command = (session, line) => api(server, `/api/sessions/${encodeURIComponent(session)}/commands`, { method: 'POST', body: JSON.stringify({ line }) })
    const goalOf = async (session) => (await api(server, `/api/goal?session=${encodeURIComponent(session)}`)).body.goal
    assert.equal((await command(source, '/goal keep the notes file tidy')).body.kind, 'success', '/goal set the goal')
    const settle = async (session, probe, what) => {
      const end = Date.now() + 10_000
      for (;;) {
        const goal = await goalOf(session)
        if (probe(goal)) return goal
        if (Date.now() > end) assert.fail(`${what}\nsaw: ${JSON.stringify(goal)}`)
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
      }
    }
    // Pause it once the driver is idle again, so the fork's cut (the last completed turn) holds the pause.
    let paused
    for (let attempt = 0; attempt < 20 && paused === undefined; attempt += 1) {
      const answer = await command(source, '/goal pause')
      if (answer.body.kind === 'success') paused = await goalOf(source)
      else await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
    }
    assert.equal(paused?.phase, 'paused', 'the source’s goal is paused')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500))
    const before = await settle(source, (goal) => goal?.phase === 'paused', 'the source stays paused')
    // A last turn after the pause, so the default cut includes it.
    await fetch(new URL('/api/turn', server.url), { method: 'POST', headers: { cookie: server.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'one more', folder, session: source }) }).then((r) => r.text())

    const forked = await api(server, `/api/sessions/${encodeURIComponent(source)}/fork`, { method: 'POST', body: '{}' })
    assert.equal(forked.status, 200, `the fork was made (${JSON.stringify(forked.body)})`)
    const child = forked.body.session
    const inherited = await goalOf(child)
    assert.ok(inherited !== null && inherited !== undefined, `the branch has a goal, not "No goal is currently set"\nsaw: ${JSON.stringify(inherited)}`)
    assert.equal(inherited.id, before.id, 'the same goal')
    assert.equal(inherited.objective, before.objective)
    assert.equal(inherited.phase, 'paused', 'a paused goal stays paused in the branch')
    assert.equal(inherited.revision, before.revision)
    assert.equal(inherited.roundsStarted, before.roundsStarted, 'and its admitted-round count comes along')
    const shown = await command(child, '/goal')
    assert.match(String(shown.body.text ?? ''), /paused/i, `/goal in the branch shows it\nsaw: ${JSON.stringify(shown.body)}`)

    const resumed = await command(child, '/goal resume')
    assert.equal(resumed.body.kind, 'success', `a person resumes it in the branch (${JSON.stringify(resumed.body)})`)
    assert.equal((await goalOf(source)).phase, 'paused', 'the source’s own goal is untouched')
  } finally {
    await server.close()
  }
})
