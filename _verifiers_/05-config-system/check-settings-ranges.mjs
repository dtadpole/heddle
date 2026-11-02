// Each numeric setting has a declared range, judged at Save in one sentence on both builds (issue #216). Settings saved
// -1 into most numeric settings (TS 19 of 32 fields, Rust 7), and the builds disagreed on 12: a negative round cap,
// depth, member count, message size or timeout took effect at the next restart. Now each plugin's Config schema
// declares its range as DSH's do (a positive integer for counts, rounds, bytes and timeouts, a non-negative one for
// the subagent depth, -1 or 1..2147483 seconds for the question timeout, dsh-tool-ask-user), Save refuses a value
// outside it with 422 settings-rejected in Schemastery's words, the profile patch is left as it was, and a value in
// range is written. Runs against whichever harness HEDDLE_BIN names, or the TypeScript build, on a scratch profile.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig } from '../../_tools_/verify-runner/lib.mjs'

/** The shipped tree with absolute row names, as the profile's own patch, so a write lands in this scratch file. */
function scratchProfile(home) {
  const profile = join(home, 'settings-ranges-profile')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const tree = readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8').replaceAll('name: ./src/', `name: ${repoRoot}/src/`)
  writeFileSync(join(profile, 'heddle.patch.yml'), tree)
  return profile
}

function startServer(args, env) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(...heddleCommand(['web', '--port', '0', ...args]), {
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
          resolvePromise({
            base: match[1],
            token: match[2],
            output: () => output,
            stop: () => new Promise((done) => {
              if (child.exitCode !== null || child.signalCode !== null) return done()
              child.once('exit', () => done())
              child.kill('SIGKILL')
            }),
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
          reject(new Error(`the server printed no URL within 20s\n${output}`))
        }
      }, 20_000).unref()
    })()
  })
}

async function write(server, ns, update) {
  const response = await fetch(`${server.base}/api/settings/${ns}?token=${server.token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ update }),
  })
  const text = await response.text()
  let body = text
  try {
    body = JSON.parse(text)
  } catch {}
  return { status: response.status, body, text }
}

/** A value outside each range, and the sentence both builds refuse it with. */
const REFUSED = [
  ['goal', { defaultMaxGoalRounds: -1 }, 'goal: $.defaultMaxGoalRounds expected number >= 1 but got -1'],
  ['goal', { defaultMaxGoalRounds: 0 }, 'goal: $.defaultMaxGoalRounds expected number >= 1 but got 0'],
  ['subagent-tool', { maxDepth: -1 }, 'subagent-tool: $.maxDepth expected number >= 0 but got -1'],
  ['subagent-tool', { maxActive: 0 }, 'subagent-tool: $.maxActive expected number >= 1 but got 0'],
  ['team', { maxMembers: -1 }, 'team: $.maxMembers expected number >= 1 but got -1'],
  ['team', { maxTasks: -1 }, 'team: $.maxTasks expected number >= 1 but got -1'],
  ['team', { maxPendingMessagesPerMember: -1 }, 'team: $.maxPendingMessagesPerMember expected number >= 1 but got -1'],
  ['team', { maxMessageBytes: -1 }, 'team: $.maxMessageBytes expected number >= 1 but got -1'],
  ['approvals', { answerTimeoutMs: -1 }, 'approvals: $.answerTimeoutMs expected number >= 1 but got -1'],
  ['schedule', { maxRounds: -1 }, 'schedule: $.maxRounds expected number >= 1 but got -1'],
  ['jobs', { maxRounds: -1 }, 'jobs: $.maxRounds expected number >= 1 but got -1'],
  ['questions', { timeout: 0 }, 'questions: $.timeout expected -1 | number but got 0'],
  ['questions', { timeout: -2 }, 'questions: $.timeout expected -1 | number but got -2'],
  ['tools', { bashTimeoutMs: -1 }, 'tools: $.bashTimeoutMs expected number >= 1 but got -1'],
  ['tools', { bashTimeoutMs: 1.5 }, 'tools: $.bashTimeoutMs expected number multiple of 1 but got 1.5'],
]

/** Values in range, at the edges the ranges allow, which are written. */
const KEPT = [
  ['questions', { timeout: -1 }],
  ['subagent-tool', { maxDepth: 0 }],
  ['goal', { defaultMaxGoalRounds: 5 }],
  ['team', { maxMembers: 1 }],
]

test('a numeric setting outside its declared range is refused at Save in the same words on both builds, and one inside it is written', async () => {
  const home = isolatedHome('settings-ranges')
  let server
  try {
    const profile = scratchProfile(home)
    const patch = join(profile, 'heddle.patch.yml')
    const { config } = scriptedConfig({ home, steps: [{ text: 'unused' }] })
    const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config }
    const args = ['--profile', profile, '--endpoint', 'scripted', '--session-root', join(home, 'sessions')]
    server = await startServer(args, env)
    const before = readFileSync(patch, 'utf8')
    const seen = []
    for (const [ns, update, sentence] of REFUSED) {
      const refused = await write(server, ns, update)
      seen.push(`${ns} ${JSON.stringify(update)} -> ${refused.status} ${refused.body?.error ?? refused.text}`)
      if (process.env.HEDDLE_PROBE) continue
      assert.equal(refused.status, 422, `${ns} ${JSON.stringify(update)} is refused at Save\n${refused.text}`)
      assert.equal(refused.body.code, 'settings-rejected')
      assert.equal(refused.body.error, sentence, `${ns} ${JSON.stringify(update)} is refused in the words both builds say`)
      assert.equal(readFileSync(patch, 'utf8'), before, `nothing is written for ${ns} ${JSON.stringify(update)}`)
    }
    for (const [ns, update] of KEPT) {
      const kept = await write(server, ns, update)
      seen.push(`${ns} ${JSON.stringify(update)} -> ${kept.status} ${kept.body?.error ?? ''}`)
      if (process.env.HEDDLE_PROBE) continue
      assert.equal(kept.status, 200, `${ns} ${JSON.stringify(update)} is in range and written\n${kept.text}`)
      const [field, value] = Object.entries(update)[0]
      assert.equal(kept.body.value?.[field], value, `${ns} answers with the written value`)
    }
    if (process.env.HEDDLE_PROBE) console.log(seen.join('\n'))
  } finally {
    await server?.stop()
    removeDir(home)
  }
})
