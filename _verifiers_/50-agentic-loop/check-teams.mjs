import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { fixtureDir, heddleCommand, isolatedHome, readTranscript, removeDir, repoRoot, scriptedConfig, sessionsUnder, skipUnless, transcriptFile } from '../../_tools_/verify-runner/lib.mjs'
import { workspaceKey } from '../../src/session/layout.ts'

/**
 * Agent Teams end to end: a Lead's real turn spawns a teammate through the tools, creates and completes a task
 * on the shared board, messages the teammate, and answers; the teammate works in its own session.
 *
 * Then the server is killed and restarted on the same store: the team's durable state is still there and the
 * boot edge recovered it. A second test starts from a store a previous process left behind — a provisioning
 * member with a resumable child, a member that never got a child, and a queued message — and judges that boot
 * settles both members and delivers the mail.
 */

/** Both checks start `web` and drive the Lead's turn through it, so the probe asks for the server. */
const CAPABILITY = 'a turn with tools, served by the Web UI'

/**
 * The store the second test boots on, **recorded as bytes** from the TypeScript build at heddle commit `a5b0c66`
 * (2026-10-22) by [`fixtures/record-team-recover-store.mjs`](fixtures/record-team-recover-store.mjs) and committed
 * beside the check.
 *
 * Why recorded rather than written through the store API: the claim is that the harness boots on a store **a
 * previous TypeScript process left behind**, so the input is data, not a module call. It also keeps the backend lane
 * able to judge the binary through `HEDDLE_BIN` without `dist/` or `npm run build` in the lane, which is the point
 * of the seam: a fixture that imports the TypeScript build would drag it back in.
 */
const recordedStore = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'team-recover')

/**
 * Write the recorded store under `root`, filed as a process that ran in `work` would have filed it.
 *
 * The logs are copied byte for byte, because they are the format under judgement; each meta's `cwd` is the one thing
 * replaced, because a meta names the folder its process ran in and this fixture runs in a fresh directory each time.
 */
function materializeRecordedStore(root, work) {
  const dir = join(root, workspaceKey(work))
  mkdirSync(dir, { recursive: true })
  for (const name of readdirSync(recordedStore)) {
    // The folder also carries its INDEX.md; the store is only the metas and the logs.
    if (!name.endsWith('.json') && !name.endsWith('.zstd')) continue
    const source = join(recordedStore, name)
    if (name.endsWith('.json')) {
      const meta = JSON.parse(readFileSync(source, 'utf8'))
      writeFileSync(join(dir, name), `${JSON.stringify({ ...meta, cwd: work }, null, 2)}\n`)
    } else {
      copyFileSync(source, join(dir, name))
    }
  }
  return dir
}

function startServer(home, work, config) {
  const child = spawn(
    ...heddleCommand(['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')]),
    { cwd: work, env: { ...process.env, HEDDLE_HOME: home, HEDDLE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const url = new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = setInterval(() => {
      const match = /heddle web: (http:\/\/\S+)/.exec(output)
      if (match) {
        clearInterval(poll)
        resolve(match[1])
      } else if (child.exitCode !== null || Date.now() - started > 20_000) {
        clearInterval(poll)
        reject(new Error(`the server did not start\n${output}`))
      }
    }, 50)
  })
  return {
    url,
    logs: () => output,
    close: async () => {
      // A harness that exited before printing its URL has already emitted 'exit', and the event is not replayed:
      // waiting for it would hang the check instead of letting it report that the server did not start.
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill()
      await new Promise((resolve) => child.once('exit', resolve))
    },
  }
}

async function cookieFor(url) {
  const response = await fetch(url, { redirect: 'manual' })
  return (response.headers.get('set-cookie') ?? '').split(';')[0]
}

async function api(url, cookie, path, init = {}) {
  const response = await fetch(new URL(path, url), {
    ...init,
    headers: { cookie, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
  })
  const text = await response.text()
  let body = {}
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  return { status: response.status, body }
}

const metaOf = (root, id) => JSON.parse(readFileSync(join(dirname(transcriptFile(join(root, id))), `${id}.json`), 'utf8'))
// Both builds write a session's metadata in place (truncate, then write), so a poll can catch the file empty or
// half-written; measured in lane runs as "Unexpected end of JSON input" thrown out of the wait below. While polling, an
// unreadable file means "not yet", never a verdict.
const metaWhenReadable = (root, id) => {
  try {
    return metaOf(root, id)
  } catch {
    return undefined
  }
}
const isUser = (event, text) => event.type === 'message' && event.message?.role === 'user' && JSON.stringify(event.message?.content ?? '').includes(text)

async function waitFor(read, timeoutMs, what) {
  const started = Date.now()
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

test('a Lead spawns, delegates, tasks, messages and answers — and the team survives a restart', async (context) => {
  if (!skipUnless(context, /^  web\b/m.test((await import('node:child_process')).execFileSync(...heddleCommand(['--help']), { encoding: 'utf8' })), CAPABILITY)) return
  const home = isolatedHome('team-e2e')
  const work = fixtureDir('team-e2e-work')
  const root = join(home, 'sessions')
  const steps = [
    { toolCall: { name: 'spawn_teammate', arguments: { name: 'alpha', description: 'the teammate', prompt: 'write the thing' } } },
    { toolCall: { name: 'team_task_create', arguments: { subject: 'write the thing', write_scopes: ['src/team'] } } },
    { toolCall: { name: 'team_task_update', arguments: { task_id: 'task-1', revision: 1, action: 'claim' } } },
    { toolCall: { name: 'team_task_update', arguments: { task_id: 'task-1', revision: 2, action: 'complete' } } },
    { toolCall: { name: 'send_message', arguments: { target: 'alpha', message: 'the board is clear' } } },
    { toolCall: { name: 'list_agents', arguments: {} } },
    { text: 'team finished the work' },
    { purpose: 'team', text: 'alpha reports: work complete' },
  ]
  const { config } = scriptedConfig({ home, steps })
  let server = startServer(home, work, config)
  try {
    const url = await server.url
    const cookie = await cookieFor(url)
    await api(url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: work }) })
    const opened = await api(url, cookie, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: work }) })
    const session = opened.body.session?.id ?? opened.body.id
    const turn = await fetch(new URL('/api/turn', url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Lead: do the team work', folder: work, session }),
    })
    assert.equal(turn.status, 200, 'the Lead turn ran')
    await turn.text()

    const childId = await waitFor(() => sessionsUnder(root).find((id) => id !== session && metaWhenReadable(root, id)?.teamId === session), 15_000, 'the teammate session')
    const child = await waitFor(() => metaWhenReadable(root, childId), 5_000, 'the teammate metadata, readable')
    assert.equal(child.parentSession, session)
    assert.equal(child.origin, 'subagent')
    assert.equal(child.delegationDepth, 1)

    const leadEvents = readTranscript(join(root, session))
    const teamTypes = leadEvents.filter((event) => event.type.startsWith('team/')).map((event) => event.type)
    assert.ok(teamTypes.filter((type) => type === 'team/member').length >= 2, 'the member is journaled provisioning then active')
    const tasks = leadEvents.filter((event) => event.type === 'team/task').map((event) => event.task)
    assert.deepEqual(tasks.map((task) => [task.id, task.revision, task.status]), [['task-1', 1, 'pending'], ['task-1', 2, 'in_progress'], ['task-1', 3, 'completed']])
    assert.deepEqual(tasks[1].ownerId, session, 'the Lead claimed it')
    assert.equal(leadEvents.filter((event) => event.type === 'team/message/queued').length, 1)
    assert.equal(leadEvents.filter((event) => event.type === 'team/message/delivered').length, 1)
    assert.ok(leadEvents.some((event) => isUser(event, 'Lead: do the team work')), 'the Lead prompt is durable')

    const childEvents = readTranscript(join(root, childId))
    assert.ok(childEvents.some((event) => isUser(event, 'write the thing')), 'the teammate got the spawn prompt')
    assert.ok(childEvents.some((event) => isUser(event, 'the board is clear')), 'and the mailed message')
    assert.ok(
      childEvents.some((event) => JSON.stringify(event).includes('team-message')) && childEvents.some((event) => JSON.stringify(event).includes('alpha reports')),
      'the mailed message carries its team-message source and the teammate answered',
    )
    assert.ok(leadEvents.some((event) => JSON.stringify(event).includes('team finished the work')), 'the Lead answered last')

    const team = await api(url, cookie, `/api/team?session=${encodeURIComponent(session)}`)
    assert.equal(team.status, 200)
    assert.deepEqual(team.body.members.map((member) => [member.name, member.role]), [['lead', 'lead'], ['alpha', 'teammate']])
    assert.deepEqual(team.body.tasks.map((task) => task.status), ['completed'])

    // Restart on the same store: the team is durable, and the server's boot edge recovers it.
    await server.close()
    server = startServer(home, work, config)
    const url2 = await server.url
    await waitFor(() => (/recovered 1 team\(s\)/.test(server.logs()) ? true : undefined), 15_000, 'the boot recovery line')
    const cookie2 = await cookieFor(url2)
    const team2 = await api(url2, cookie2, `/api/team?session=${encodeURIComponent(session)}`)
    assert.equal(team2.status, 200)
    assert.equal(team2.body.members.length, 2, 'the roster survived the restart')
    assert.equal(team2.body.tasks[0].status, 'completed', 'the board survived the restart')
  } finally {
    await server.close()
    removeDir(home)
    removeDir(work)
  }
})

test('boot settles a previous process’s provisioning members and delivers its queued mail', async (context) => {
  if (!skipUnless(context, /^  web\b/m.test((await import('node:child_process')).execFileSync(...heddleCommand(['--help']), { encoding: 'utf8' })), CAPABILITY)) return
  const home = isolatedHome('team-recover')
  const work = fixtureDir('team-recover-work')
  const root = join(home, 'sessions')
  const { config } = scriptedConfig({ home, steps: [{ purpose: 'team', text: 'recovered answer' }] })
  const teamId = 'session-recover-lead'
  const resumableId = 'session-recover-active'
  materializeRecordedStore(root, work)
  try {
    const server = startServer(home, work, config)
    try {
      await server.url
      await waitFor(() => (/recovered 1 team\(s\) \(2 settled, 1 delivered\)/.test(server.logs()) ? true : undefined), 15_000, 'the recovery counts')
      const events = readTranscript(join(root, teamId))
      const phases = events.filter((event) => event.type === 'team/member').map((event) => [event.member.name, event.member.phase])
      assert.deepEqual(phases, [['alpha', 'provisioning'], ['ghost', 'provisioning'], ['alpha', 'active'], ['ghost', 'failed']])
      assert.deepEqual(events.filter((event) => event.type === 'team/message/delivered').map((event) => event.messageId), ['team-message-left-1'])
      const child = readTranscript(join(root, resumableId))
      assert.ok(child.some((event) => event.message?.source?.kind === 'team-message' && event.message.source.messageId === 'team-message-left-1'), 'the queued mail reached the member’s own log')
    } finally {
      await server.close()
    }
  } finally {
    removeDir(home)
    removeDir(work)
  }
})
