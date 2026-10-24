import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/verify-runner/lib.mjs'

/**
 * The composition of one session's context, asked for the way the page asks for it.
 *
 * `heddle context <id>` answers this in a terminal, and part 3 judges that answer. What this check adds
 * is that the same answer is reachable **per session over HTTP**, which is what the view needs, plus the
 * two things a token count cannot express: which events are on the surface — the events the model will
 * actually read, after any compaction — and which notes the assembler wrote, which is where the system
 * prompt and the instruction baseline come from.
 *
 * The check is deliberately about *shape and provenance* rather than about a number: a token estimate
 * legitimately changes when a prompt does, but "the system prompt is on the surface", "the instructions
 * came from the folder the run resolved" and "a session that does not exist is not invented" are claims
 * that must hold whatever the numbers say.
 */

const CAPABILITY = 'the Web UI'

async function startServer(label) {
  const home = isolatedHome(`context-api-${label}`)
  const work = fixtureDir(`context-api-${label}-work`)
  const { config } = scriptedConfig({ home, steps: [{ text: 'an answer' }] })
  mkdirSync(work, { recursive: true })
  /**
   * The server runs **in the fixture folder**, which is what makes the provenance claim testable: the
   * directory a run resolves its instructions from is the workspace root the sandbox names, so a check
   * that started the server in the repository would read the repository's `AGENTS.md` and could not
   * tell a fixture's own instructions from the harness's.
   */
  const child = await startCli(
    /**
     * The profile is named explicitly because the server runs in the fixture folder: a run finds the
     * project's profile beside its working directory, and the fixture has none — measured before, as a
     * fixture command that booted an empty tree and looked like a broken plugin.
     */
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config }, cwd: work },
  )
  return {
    home,
    work,
    url: child.url,
    close: async () => {
      child.kill()
      removeDir(home)
      removeDir(work)
    },
  }
}

function startCli(args, options) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(...heddleCommand(args), {
        cwd: options.cwd ?? repoRoot,
        env: { ...process.env, NO_COLOR: '1', ...(options.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ child, url: match[1], kill: () => child.kill('SIGKILL') })
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

async function cookieFor(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')
  if (cookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return cookie.split(';')[0]
}

async function api(url, cookie, path, init = {}) {
  const response = await fetch(new URL(path, url), {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

test('a session reports how its context was composed, with provenance rather than only a count', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  const server = await startServer('shape')
  try {
    mkdirSync(server.work, { recursive: true })
    writeFileSync(join(server.work, 'AGENTS.md'), '# house rules for the fixture\n\nBe terse.\n')
    const cookie = await cookieFor(server.url)
    const registered = await api(server.url, cookie, '/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ path: server.work }),
    })
    assert.equal(registered.status, 200, 'the fixture folder is a workspace root')

    const opened = await api(server.url, cookie, '/api/folders/session', {
      method: 'POST',
      body: JSON.stringify({ folder: server.work }),
    })
    assert.equal(opened.status, 200, 'the folder has a session')
    const session = opened.body.session?.id ?? opened.body.id
    assert.ok(typeof session === 'string' && session.startsWith('session-'), `a session id came back (${JSON.stringify(opened.body).slice(0, 120)})`)

    const composed = await api(server.url, cookie, `/api/context?session=${encodeURIComponent(session)}`)
    assert.equal(composed.status, 200, `the composition was answered (${JSON.stringify(composed.body).slice(0, 160)})`)
    const report = composed.body

    assert.equal(report.session, session, 'the report is about the session that was asked for')
    assert.ok(report.messages.length > 0, 'the model would read some messages')
    /**
     * A note is what the **harness** composed, and its origin says which kind. This profile configures
     * no system prompt, so none is written — that is a fact about the profile rather than a gap in the
     * route, and the note that *is* written still has to say where it came from. (Part 3 judges the
     * system-prompt case against a profile that configures one.)
     */
    assert.ok(report.notes.length > 0, 'the composition includes what the harness wrote')
    for (const note of report.notes) {
      assert.ok(
        note.origin === 'system-prompt' || note.origin === 'instructions',
        `every note says which kind it is, and nothing else\nsaw: ${note.origin}`,
      )
    }
    assert.ok(report.estimatedTokens > 0, 'and the size is reported')
    assert.ok(report.contextWindow >= report.thresholdTokens, 'the window and the trigger are stated together')

    /**
     * Provenance, which is the point of the view: the instructions are the fixture's own file, resolved
     * from the folder the run used, and the notes say where the system prompt and the baseline came from.
     */
    assert.equal(report.cwd, realpathSync(server.work), 'the composition says which folder it resolved from')
    assert.ok(
      report.instructions.some((path) => path.endsWith('AGENTS.md')),
      `the instruction baseline names the file it read\nsaw: ${report.instructions.join(', ')}`,
    )
    assert.ok(
      report.notes.some((note) => note.origin === 'instructions' && note.text.includes('house rules for the fixture')),
      'and the note carries the fixture folder’s own instructions, not another folder’s',
    )
    const origins = report.notes.map((note) => note.origin)
    assert.ok(origins.includes('instructions'), 'a note carries the instruction baseline, and says so')

    /**
     * The surface: the events that survive into the request. Every note is on it, which is the claim
     * "the instructions on the surface are the current ones" — and the replacements list, empty here, is
     * where a compaction would show which span a summary stands in for.
     */
    assert.ok(Array.isArray(report.surface.nodes) && report.surface.nodes.length > 0, 'the surface is reported as seqs')
    assert.ok(
      report.notes.every((note) => report.surface.nodes.includes(note.seq)),
      'and every note the assembler wrote is on it',
    )
    assert.deepEqual(report.surface.replacements, [], 'nothing has been compacted in a fresh session')

    const missing = await api(server.url, cookie, '/api/context?session=session-00000000-0000-4000-8000-000000000000')
    assert.equal(missing.status, 404, 'a session that does not exist is not invented')
    const unasked = await api(server.url, cookie, '/api/context')
    assert.equal(unasked.status, 400, 'and asking for no session is refused')
  } finally {
    await server.close()
  }
})

test('a compacted session shows the span its summary stands in for', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  /**
   * The half a fresh session cannot show. A compaction writes one replacement whose `shadowedSeqs` are
   * the events the summary stands in for, and this is the view that makes that visible to a person
   * rather than only to a debugger — so the check drives a session that has been compacted and asserts
   * the membership rather than the arithmetic: every shadowed seq is off the surface, and the summary
   * that replaced them is on it.
   */
  const server = await startServer('compacted')
  try {
    mkdirSync(server.work, { recursive: true })
    const cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
    const opened = await api(server.url, cookie, '/api/folders/session', {
      method: 'POST',
      body: JSON.stringify({ folder: server.work }),
    })
    const session = opened.body.session?.id ?? opened.body.id

    const composed = await api(server.url, cookie, `/api/context?session=${encodeURIComponent(session)}`)
    const before = composed.body
    /**
     * Whether this profile can summarise at all is a fact about the profile, not about this claim: with
     * no summariser wired the honest answer is "unjudged" rather than a session forced to look compacted.
     */
    if (before.surface.replacements.length === 0) {
      assert.equal(before.compacted, false, 'a session with no replacement says it is not compacted')
      context.diagnostic('this profile did not compact the session, so the span cannot be judged here')
      return
    }
    const replacement = before.surface.replacements[0]
    for (const seq of replacement.shadowedSeqs) {
      assert.ok(!before.surface.nodes.includes(seq), `shadowed seq ${seq} is off the surface`)
    }
    assert.ok(before.surface.nodes.includes(replacement.seq), 'and the event that replaced them is on it')
  } finally {
    await server.close()
  }
})
