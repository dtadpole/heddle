// A row the profile patch has broken does not stop the server (issue #213). A settings block holding contextWindow -5
// or "abc", or a retained ratio above the trigger ratio, failed the context row at start; the five rows that wait on
// context stayed pending and the Rust build exited with only "5 entr(y/ies) are still pending: …", naming neither the
// row, the value nor the file (TS started on -5 and failed every turn instead). Now, as DSH keeps the running
// configuration and refuses only Save (and as #165 settled for an unreadable patch), both builds start on the value
// beneath Settings' block, print one line naming the row, the problem and the file, and run a turn; Settings still
// answers with the block's value, and Reset removes it. A refused value outside the block cannot fall back, and is
// still named, row, problem and file. Runs against whichever harness HEDDLE_BIN names, or the TypeScript build.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { heddleCommand, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig } from '../../_tools_/verify-runner/lib.mjs'

const BEGIN = '# >>> heddle settings'
const END = '# <<< heddle settings'
const FELL_BACK = 'this run uses the value beneath it until Settings saves or resets it'
const NAMED = 'fix it in the file or run `heddle config --validate`'

/** The shipped tree with absolute row names as the profile's patch, with a settings block for the context row. */
function profileWith(home, block, tree = (text) => text) {
  const profile = join(home, 'boot-fallback-profile')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const shipped = tree(readFileSync(join(repoRoot, 'heddle.patch.yml'), 'utf8').replaceAll('name: ./src/', `name: ${repoRoot}/src/`))
  const settings = block === undefined ? '' : `${BEGIN}\n- patch:\n    - id: "context"\n      config: ${block}\n${END}\n`
  writeFileSync(join(profile, 'heddle.patch.yml'), `${shipped}${shipped.endsWith('\n') ? '' : '\n'}${settings}`)
  return profile
}

/** The one stderr line naming the context row, split at the file it names. */
function note(stderr) {
  const line = stderr.split('\n').find((candidate) => candidate.startsWith('heddle: context: '))
  if (line === undefined) return null
  const match = /^(heddle: context: .*) \(in (.+heddle\.patch\.yml)\); (.*)$/.exec(line)
  return match === null ? { line } : { said: match[1], file: match[2], then: match[3] }
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

test('a context value Settings\' block broke falls back to the value beneath it with one named line, and a turn runs', async () => {
  for (const [block, said] of [
    ['{"contextWindow": -5}', 'heddle: context: contextWindow (-5) must be a positive integer'],
    ['{"contextWindow": "abc"}', 'heddle: context: $.contextWindow expected number but got abc'],
    ['{"retainRatio": 0.99, "thresholdRatio": 0.5}', 'heddle: context: retainRatio (0.99) must be less than the resolved thresholdRatio (0.5)'],
  ]) {
    const home = isolatedHome('boot-fallback')
    try {
      const profile = profileWith(home, block)
      const { config } = scriptedConfig({ home, steps: [{ text: 'a turn on the value beneath' }] })
      const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config }
      const run = await runCli(['--profile', profile, '--endpoint', 'scripted', '--turn', 'hello'], { env, cwd: home })
      assert.equal(run.code, 0, `${block}: the run starts and its turn answers\n${run.stdout}\n${run.stderr}`)
      assert.match(run.stdout, /a turn on the value beneath/)
      const named = note(run.stderr)
      assert.deepEqual(
        named === null ? null : { said: named.said, then: named.then },
        { said, then: FELL_BACK },
        `${block}: one line names the row and the problem, and says what the run does\n${run.stderr}`,
      )
      assert.ok(named.file.endsWith('boot-fallback-profile/heddle.patch.yml'), `and the file: ${named.file}`)
      assert.equal(run.stderr.split('\n').filter((line) => line.startsWith('heddle: context: ')).length, 1, 'said once')
    } finally {
      removeDir(home)
    }
  }
})

test('Settings still answers on a fallen-back row and Reset removes the broken value; outside the block the row is named', async () => {
  const home = isolatedHome('boot-fallback-settings')
  let server
  try {
    const profile = profileWith(home, '{"contextWindow": -5}')
    const patch = join(profile, 'heddle.patch.yml')
    const { config } = scriptedConfig({ home, steps: [{ text: 'answered' }] })
    const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config }
    const args = ['--profile', profile, '--endpoint', 'scripted', '--session-root', join(home, 'sessions')]
    server = await startServer(args, env)
    const url = (path) => `${server.base}${path}?token=${server.token}`
    const shown = await (await fetch(url('/api/settings/context'))).json()
    assert.equal(shown.value?.contextWindow, -5, `Settings shows the block's value, the one to repair\n${JSON.stringify(shown)}`)
    const reset = await fetch(url('/api/settings/context'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [{ op: 'unset', path: ['contextWindow'] }] }),
    })
    assert.equal(reset.status, 200, `Reset is accepted\n${await reset.text()}`)
    assert.ok(!readFileSync(patch, 'utf8').includes('-5'), 'and the broken value is gone from the patch')
    await server.stop()
    server = undefined
    const again = await runCli(['--profile', profile, '--endpoint', 'scripted', '--turn', 'again'], { env, cwd: home })
    assert.equal(again.code, 0, `the repaired profile runs\n${again.stderr}`)
    assert.equal(note(again.stderr), null, `and says nothing more about context\n${again.stderr}`)

    // A refused value in the tree itself, outside Settings' block: nothing is beneath it, and it is still named.
    const outside = profileWith(home, undefined, (text) => text.replace('contextWindow: 1048576', 'contextWindow: -5'))
    const named = await runCli(['--profile', outside, '--endpoint', 'scripted', '--turn', 'hello'], { env, cwd: home })
    const said = note(named.stderr)
    assert.deepEqual(
      said === null ? null : { said: said.said, then: said.then },
      { said: 'heddle: context: contextWindow (-5) must be a positive integer', then: NAMED },
      `the row, the problem and the file are named\n${named.stderr}`,
    )
  } finally {
    await server?.stop()
    removeDir(home)
  }
})
