// The context row's values are judged where they are written (issue #212). Settings used to save a context window of
// 0, a negative ratio, or a retained ratio at or above the trigger ratio, and every later turn on that server then
// failed with "retainTokens (…) is not below thresholdTokens (…)" until someone repaired the patch by hand; the TS build
// also saved a negative or fractional window, which the Rust build refused. Now each is refused at Save with 422
// settings-rejected, in the same words on both builds — the schema's bounds in Schemastery's words, and the budget rule
// in DSH's compaction-basic words — and the profile patch is left as it was. A valid budget is written and a turn runs
// on it after a restart; `config --validate` refuses a hand-edited patch in the same words. Runs against whichever
// harness HEDDLE_BIN names, or the TypeScript build, on a scratch profile.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig } from '../../_tools_/verify-runner/lib.mjs'

/** The shipped tree with absolute row names, as the profile's own patch, so a write lands in this scratch file. */
function scratchProfile(home) {
  const profile = join(home, 'context-budget-profile')
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

/** developer-six's rows from #212, and the neighbours of each bound, with the one sentence both builds say. */
const REFUSED = [
  [{ contextWindow: -5 }, 'context: $.contextWindow expected number >= 1 but got -5'],
  [{ contextWindow: 1.5 }, 'context: $.contextWindow expected number multiple of 1 but got 1.5'],
  [{ contextWindow: 0 }, 'context: $.contextWindow expected number >= 1 but got 0'],
  [{ thresholdRatio: -1 }, 'context: $.thresholdRatio expected number >= 0 but got -1'],
  [{ thresholdRatio: 2 }, 'context: $.thresholdRatio expected number <= 1 but got 2'],
  [{ retainTokens: 2.5 }, 'context: $.retainTokens expected number multiple of 1 but got 2.5'],
  [{ thresholdRatio: 0 }, 'context: thresholdRatio (0) must be a number in (0, 1]'],
  [{ retainRatio: 0.99, thresholdRatio: 0.5 }, 'context: retainRatio (0.99) must be less than the resolved thresholdRatio (0.5)'],
  [{ thresholdTokens: 400, retainTokens: 500 }, 'context: retainTokens (500) must be less than thresholdTokens (400)'],
  [
    { contextWindow: 1 },
    'context: retainRatio (0.16) of contextWindow 1 is 0 tokens, which must be less than the threshold tokens (0 = thresholdRatio 0.8 of contextWindow 1)',
  ],
  [
    { retainTokens: 900000 },
    'context: retainTokens (900000) must be less than the threshold tokens (838860 = thresholdRatio 0.8 of contextWindow 1048576)',
  ],
]

test('a context value a turn would refuse is refused at Save in the same words on both builds, and a valid budget runs a turn', async () => {
  const home = isolatedHome('settings-context-budget')
  let server
  try {
    const profile = scratchProfile(home)
    const patch = join(profile, 'heddle.patch.yml')
    const { config } = scriptedConfig({ home, steps: [{ text: 'a turn on the saved budget' }] })
    const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config }
    const args = ['--profile', profile, '--endpoint', 'scripted', '--session-root', join(home, 'sessions')]
    server = await startServer(args, env)
    const before = readFileSync(patch, 'utf8')

    for (const [update, sentence] of REFUSED) {
      const refused = await write(server, 'context', update)
      assert.equal(refused.status, 422, `${JSON.stringify(update)} is refused at Save\n${refused.text}`)
      assert.equal(refused.body.code, 'settings-rejected')
      assert.equal(refused.body.error, sentence, `${JSON.stringify(update)} is refused in the words both builds say`)
      assert.equal(readFileSync(patch, 'utf8'), before, `nothing is written for ${JSON.stringify(update)}`)
    }

    const kept = await write(server, 'context', { contextWindow: 200000, thresholdRatio: 0.7, retainRatio: 0.2 })
    assert.equal(kept.status, 200, `a valid budget is written\n${kept.text}`)
    assert.equal(kept.body.value?.retainRatio, 0.2)
    assert.notEqual(readFileSync(patch, 'utf8'), before, 'into the profile patch')

    await server.stop()
    server = undefined
    const turn = await runCli(['--profile', profile, '--endpoint', 'scripted', '--turn', 'hello'], { env, cwd: home })
    assert.equal(turn.code, 0, `a turn runs on the saved budget\n${turn.stdout}${turn.stderr}`)
    assert.match(turn.stdout, /a turn on the saved budget/)

    // A hand edit is refused by `config --validate` in the same words as a Save.
    writeFileSync(patch, before.replace('contextWindow: 1048576', 'contextWindow: 1048576\n        thresholdRatio: 0.5\n        retainRatio: 0.99'))
    const validate = await runCli(['--profile', profile, 'config', '--validate'], { env, cwd: home })
    assert.notEqual(validate.code, 0, `validation fails on the hand-edited budget\n${validate.stdout}${validate.stderr}`)
    assert.match(validate.stdout + validate.stderr, /context: retainRatio \(0\.99\) must be less than the resolved thresholdRatio \(0\.5\)/)
  } finally {
    await server?.stop()
    removeDir(home)
  }
})
