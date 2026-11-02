import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A session whose turn the HTTP route did not start is still running when the agent runtime holds a turn for it
 * (issue #187).
 *
 * DSH lists every session with its live state, and its tree counts a parent's running children from that list
 * (`dsh-client-ui-workspace/lib/client.js:1067`, `runningChildCount`; `sessionStatuses`, `:2068-2117`, "1 subagent
 * running"). A background subagent's child runs its turns on the agent runtime, not through `POST /api/turn`, so a
 * listing that counts only the route's own turns said `running: false` for a child that was working, on both builds,
 * and the parent's row could never say that a subagent runs.
 *
 * Driven through the web command with a scripted model: the parent delegates and ends its turn at once; the child
 * runs `sleep 3` through bash, then answers; its settlement notice starts one parent turn.
 */

const CAPABILITY = 'the Web UI'

async function startServer(label) {
  const home = isolatedHome(`running-children-${label}`)
  const work = fixtureDir(`running-children-${label}-work`)
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

test('#187: a background subagent’s child is listed running while it works, and not once it settled', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('subagent')
  try {
    const folder = join(server.work, 'parent')
    mkdirSync(folder, { recursive: true })
    await api(server, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: folder }) })
    writeFileSync(
      server.script,
      JSON.stringify({
        steps: [
          { toolCall: { name: 'delegate', arguments: { prompt: 'child task' } } },
          { text: 'parent started the child' },
          { purpose: 'subagent', toolCall: { name: 'bash', arguments: { command: 'sleep 3; echo child-worked' } } },
          { purpose: 'subagent', text: 'child answer' },
          { purpose: 'subagent-notice', text: 'parent read the notice' },
        ],
      }),
    )
    const response = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie: server.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'parent prompt', folder, new: true }),
    })
    assert.equal(response.status, 200, `the parent turn ran (${response.status})`)
    const parent = /event: session\ndata: (.*)/.exec(await response.text())?.[1]
    const parentId = parent === undefined ? undefined : JSON.parse(parent).session
    assert.equal(typeof parentId, 'string', 'the turn named its session')

    // While the child works: poll the listing as the page does.
    const seen = []
    const deadline = Date.now() + 8_000
    let childId
    while (Date.now() < deadline) {
      const listed = await api(server, '/api/sessions')
      const child = (Array.isArray(listed.body) ? listed.body : []).find((entry) => entry.parentSession === parentId)
      if (child !== undefined) {
        childId = child.id
        seen.push(child.running)
        if (child.running === true) break
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    }
    assert.ok(childId !== undefined, 'the child session is listed under its parent')
    assert.ok(seen.includes(true), `the working child is listed running: true\nsaw running: ${JSON.stringify(seen)}`)

    // Once it settled, the listing says so: no session stays running after its work ended.
    let last
    const until = Date.now() + 15_000
    while (Date.now() < until) {
      const listed = await api(server, '/api/sessions')
      last = (Array.isArray(listed.body) ? listed.body : []).find((entry) => entry.id === childId)
      if (last?.running === false) break
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
    }
    assert.equal(last?.running, false, 'the child is listed running: false once it settled')
  } finally {
    await server.close()
  }
})
