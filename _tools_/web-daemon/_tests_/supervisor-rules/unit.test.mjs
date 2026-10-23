import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { nextAttempt, parseSupervisorArgs, restartDelay } from '../../supervisor.mjs'

/**
 * supervisor.mjs: the rules it keeps, and the behaviour it promises.
 *
 * The pure rules — the backoff, the give-up decision, the command line — are judged directly. The loop is judged
 * against **real child processes**: a stand-in server that records each start and then exits or waits, so
 * "the server came back" is measured the way `95-web-daemon` measures it, not asserted from a mock.
 */

const supervisor = resolve(fileURLToPath(new URL('../../supervisor.mjs', import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'heddle-supervisor-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

/** A stand-in server that writes its pid on every start, then either exits quickly or waits to be killed. */
function fakeServer({ name, exitAfterMs = null }) {
  const path = join(scratch, `${name}.mjs`)
  const pids = join(scratch, `${name}.pids`)
  writeFileSync(
    path,
    [
      "import { appendFileSync } from 'node:fs'",
      `appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n')`,
      exitAfterMs === null
        ? "process.on('SIGTERM', () => process.exit(0))\nsetInterval(() => {}, 1000)"
        : `setTimeout(() => process.exit(0), ${exitAfterMs})`,
      '',
    ].join('\n'),
  )
  return { path, pids }
}

/** Run the supervisor in front of a stand-in server; resolves with its exit, code and output. */
function supervise(command, { maxFailures = 10 } = {}) {
  const child = spawn(process.execPath, [supervisor, '--max-failures', String(maxFailures), '--', ...command], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const exited = new Promise((resolvePromise) => child.once('exit', (code, signal) => resolvePromise({ code, signal })))
  return { child, exited, output: () => ({ stdout, stderr }) }
}

/** Wait until `check()` is true, or fail after `timeoutMs`. */
async function until(check, what, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  assert.fail(`timed out waiting for ${what}`)
}

const lines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : [])

test('the command line is everything after --, untouched, and the flags before it are the supervisor\'s', () => {
  assert.deepEqual(parseSupervisorArgs(['--', '/b/heddle', 'web', '--port', '8082']), {
    command: ['/b/heddle', 'web', '--port', '8082'],
    maxFailures: 10,
  })
  const spaced = parseSupervisorArgs(['--max-failures', '3', '--', '/a b/heddle', 'web', '--config', '/a b/cordis.yml'])
  assert.deepEqual(spaced.command, ['/a b/heddle', 'web', '--config', '/a b/cordis.yml'], 'a path with a space stays one argument')
  assert.equal(spaced.maxFailures, 3)
  for (const [argv, message] of [
    [[], /missing "--"/],
    [['--'], /no server command/],
    [['--max-failures', '0', '--', '/b/heddle'], /positive integer/],
    [['--max-failures', 'ten', '--', '/b/heddle'], /positive integer/],
    [['--frobnicate', '--', '/b/heddle'], /unknown supervisor option/],
  ]) {
    assert.throws(() => parseSupervisorArgs(argv), message, argv.join(' '))
  }
})

test('a failed start backs off, and a run that lasted resets the count', () => {
  assert.equal(restartDelay(1), 250)
  assert.equal(restartDelay(2), 500)
  assert.equal(restartDelay(3), 1000)
  assert.equal(restartDelay(9), 5000, 'capped, so a crash loop is never silent for long')
  assert.equal(restartDelay(40), 5000)

  assert.deepEqual(nextAttempt({ ranForMs: 120, failures: 0 }), { failures: 1, delayMs: 250, giveUp: false })
  assert.deepEqual(nextAttempt({ ranForMs: 120, failures: 2 }), { failures: 3, delayMs: 1000, giveUp: false })
  assert.deepEqual(nextAttempt({ ranForMs: 60_000, failures: 4 }), { failures: 0, delayMs: 0, giveUp: false }, 'a kill after a long run is not a failure to start')
  assert.deepEqual(nextAttempt({ ranForMs: 10, failures: 2, maxFailures: 3 }), { failures: 3, delayMs: 0, giveUp: true }, 'the last allowed failure gives up instead of looping')
})

test('a killed server is put back, and stopping the supervisor stops it', async () => {
  const server = fakeServer({ name: 'restart' })
  const run = supervise([process.execPath, server.path])
  try {
    await until(() => lines(server.pids).length === 1, 'the first server start')
    const first = Number(lines(server.pids)[0])
    process.kill(first, 'SIGKILL')
    await until(() => lines(server.pids).length >= 2, 'the server to be restarted')
    assert.notEqual(Number(lines(server.pids)[1]), first, 'a new process, not the killed one')

    run.child.kill('SIGTERM')
    const exited = await run.exited
    assert.equal(exited.code, 0, 'a supervisor asked to stop exits cleanly')
    const starts = lines(server.pids).length
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 600))
    assert.equal(lines(server.pids).length, starts, 'and it does not start another server')
    assert.match(run.output().stdout, /heddle-supervisor: stopped/)
  } finally {
    run.child.kill('SIGKILL')
  }
})

test('a server that cannot stay up is retried at a bounded rate, then the supervisor gives up and says so', async () => {
  const server = fakeServer({ name: 'crash', exitAfterMs: 10 })
  const run = supervise([process.execPath, server.path], { maxFailures: 3 })
  const exited = await run.exited
  assert.equal(exited.code, 1, 'exit 1, so the platform and a person both see a service that is not running')
  assert.equal(lines(server.pids).length, 3, 'three starts, not an endless loop')
  assert.match(run.output().stderr, /giving up after 3 failed starts/, 'and the log says why')
  assert.match(run.output().stdout, /restarting in 250 ms/, 'the first retry waited')
  assert.match(run.output().stdout, /restarting in 500 ms/, 'and the second waited longer')
})
