import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createServer } from 'node:net'
import { afterProbe, CAPTURE_BUDGET_MS, captureSteps, formatPaused, isNodeProgram, isOurLeftover, lockVerdict, nextAttempt, parseSupervisorArgs, restartDelay, serverCommandLine } from '../../supervisor.mjs'

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
function supervise(command, { maxFailures = 10, retrySeconds = null, giveUp = false } = {}) {
  const flags = ['--max-failures', String(maxFailures)]
  if (retrySeconds !== null) flags.push('--retry-seconds', String(retrySeconds))
  if (giveUp) flags.push('--give-up')
  const child = spawn(process.execPath, [supervisor, ...flags, '--', ...command], {
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
    slowRetryMs: 60_000,
    giveUp: false,
    healthUrl: null,
    healthEveryMs: 5_000,
    healthMisses: 3,
    healthGraceMs: 20_000,
    reclaimPort: null,
    lock: null,
    captureDir: null,
  })
  assert.equal(parseSupervisorArgs(['--lock', '/h/.heddle/web-supervisor.3082.lock', '--', '/b/heddle']).lock, '/h/.heddle/web-supervisor.3082.lock')
  assert.equal(parseSupervisorArgs(['--capture-dir', '/h/.heddle/hang-captures', '--', '/b/heddle']).captureDir, '/h/.heddle/hang-captures')
  const watched = parseSupervisorArgs(['--health-url', 'http://127.0.0.1:3082/healthz', '--health-every', '2', '--health-misses', '4', '--health-grace', '9', '--reclaim-port', '3082', '--', '/b/heddle'])
  assert.equal(watched.healthUrl, 'http://127.0.0.1:3082/healthz')
  assert.deepEqual([watched.healthEveryMs, watched.healthMisses, watched.healthGraceMs, watched.reclaimPort], [2_000, 4, 9_000, 3082])
  const spaced = parseSupervisorArgs(['--max-failures', '3', '--', '/a b/heddle', 'web', '--config', '/a b/cordis.yml'])
  assert.deepEqual(spaced.command, ['/a b/heddle', 'web', '--config', '/a b/cordis.yml'], 'a path with a space stays one argument')
  assert.equal(spaced.maxFailures, 3)
  assert.equal(spaced.slowRetryMs, 60_000, 'the limit means slow retries by default')
  assert.equal(spaced.giveUp, false)
  const bounded = parseSupervisorArgs(['--max-failures', '4', '--retry-seconds', '7', '--give-up', '--', '/b/heddle'])
  assert.equal(bounded.maxFailures, 4)
  assert.equal(bounded.slowRetryMs, 7_000)
  assert.equal(bounded.giveUp, true)
  for (const [argv, message] of [
    [[], /missing "--"/],
    [['--'], /no server command/],
    [['--max-failures', '0', '--', '/b/heddle'], /positive integer/],
    [['--max-failures', 'ten', '--', '/b/heddle'], /positive integer/],
    [['--frobnicate', '--', '/b/heddle'], /unknown supervisor option/],
    [['--health-url', 'localhost:3082', '--', '/b/heddle'], /http\(s\) URL/],
    [['--reclaim-port', 'x', '--', '/b/heddle'], /positive integer/],
    [['--lock', 'relative.lock', '--', '/b/heddle'], /absolute path/],
    [['--capture-dir', 'captures', '--', '/b/heddle'], /absolute path/],
    [['--capture-dir', '--', '/b/heddle'], /absolute path/],
  ]) {
    assert.throws(() => parseSupervisorArgs(argv), message, argv.join(' '))
  }
})

test('a hung node server is sampled and paused for its JavaScript stack; any other program is only sampled (#257)', () => {
  assert.equal(isNodeProgram('/v/node/24.21.0/bin/node'), true)
  assert.equal(isNodeProgram('node'), true)
  assert.equal(isNodeProgram('/b/heddle'), false, 'the Rust binary is not node')
  assert.equal(isNodeProgram('/b/nodemon'), false, 'a name that starts with node is not node')
  assert.deepEqual(captureSteps(['/v/bin/node', '/r/dist/cli.js', 'web']), { stack: true, sample: true })
  assert.deepEqual(captureSteps(['/b/heddle', 'web']), { stack: false, sample: true }, 'SIGUSR1 would terminate a program that is not node')
  assert.ok(CAPTURE_BUDGET_MS <= 5_000, 'the capture never delays the restart by more than five seconds')
})

test('a captured node server gets a loopback inspector port as its own argument, never through NODE_OPTIONS (#257)', () => {
  const node = ['/v/bin/node', '/r/dist/cli.js', 'web', '--port', '3082']
  assert.equal(serverCommandLine(node, null), node, 'no capture directory: the installer\'s command, untouched')
  assert.deepEqual(serverCommandLine(node, '/h/.heddle/hang-captures'), ['/v/bin/node', '--inspect-port=127.0.0.1:0', '/r/dist/cli.js', 'web', '--port', '3082'])
  assert.deepEqual(node, ['/v/bin/node', '/r/dist/cli.js', 'web', '--port', '3082'], 'the parsed command is not changed in place')
  const rust = ['/b/heddle', 'web', '--port', '3097']
  assert.equal(serverCommandLine(rust, '/h/.heddle-rust-preview/hang-captures'), rust, 'the Rust binary gets no node flag')
})

test('a failed start backs off, and a run that lasted resets the count', () => {
  assert.equal(restartDelay(1), 250)
  assert.equal(restartDelay(2), 500)
  assert.equal(restartDelay(3), 1000)
  assert.equal(restartDelay(9), 5000, 'capped, so a crash loop is never silent for long')
  assert.equal(restartDelay(40), 5000)

  assert.deepEqual(nextAttempt({ ranForMs: 120, failures: 0 }), { failures: 1, delayMs: 250, slow: false, giveUp: false })
  assert.deepEqual(nextAttempt({ ranForMs: 120, failures: 2 }), { failures: 3, delayMs: 1000, slow: false, giveUp: false })
  assert.deepEqual(nextAttempt({ ranForMs: 60_000, failures: 4 }), { failures: 0, delayMs: 0, slow: false, giveUp: false }, 'a kill after a long run is not a failure to start')
  // The default at the limit is a slow retry, not an exit: on a host whose platform does not restart the job, exiting
  // means the page stays down even after a transient cause has cleared. Measured reason in supervisor.mjs.
  assert.deepEqual(nextAttempt({ ranForMs: 10, failures: 2, maxFailures: 3 }), { failures: 3, delayMs: 60_000, slow: true, giveUp: false })
  assert.deepEqual(nextAttempt({ ranForMs: 10, failures: 2, maxFailures: 3, slowRetryMs: 5_000 }), { failures: 3, delayMs: 5_000, slow: true, giveUp: false })
  assert.deepEqual(nextAttempt({ ranForMs: 10, failures: 2, maxFailures: 3, giveUp: true }), { failures: 3, delayMs: 0, slow: false, giveUp: true }, '--give-up keeps the bounded behaviour for a host that restarts the job')
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

test('a server that cannot stay up is retried slowly for as long as it takes, not abandoned', async () => {
  const server = fakeServer({ name: 'slow', exitAfterMs: 10 })
  const run = supervise([process.execPath, server.path], { maxFailures: 2, retrySeconds: 1 })
  try {
    await until(() => lines(server.pids).length >= 3, 'a third start after the limit, which the old version refused')
    assert.equal(run.child.exitCode, null, 'still running, so a transient cause can clear without a person')
    assert.match(run.output().stderr, /still retrying, every 1 s/, 'and it says why it is still trying')
  } finally {
    run.child.kill('SIGTERM')
    const exited = await run.exited
    assert.equal(exited.code, 0, 'a supervisor asked to stop still exits cleanly')
  }
})

test('--give-up asks for the bounded behaviour, for a host whose platform restarts the job', async () => {
  const server = fakeServer({ name: 'crash', exitAfterMs: 10 })
  const run = supervise([process.execPath, server.path], { maxFailures: 3, giveUp: true })
  const exited = await run.exited
  assert.equal(exited.code, 1, 'exit 1, so the platform and a person both see a service that is not running')
  assert.equal(lines(server.pids).length, 3, 'three starts, not an endless loop')
  assert.match(run.output().stderr, /giving up after 3 failed starts/, 'and the log says why')
  assert.match(run.output().stdout, /restarting in 250 ms/, 'the first retry waited')
  assert.match(run.output().stdout, /restarting in 500 ms/, 'and the second waited longer')
})

test('a probe that fails counts only after the start-up grace or a first answer, and a few in a row mean hung', () => {
  // Still starting: misses inside the grace, before any answer, are not counted.
  assert.deepEqual(afterProbe({ ok: false, misses: 0, allowed: 3, ranForMs: 1_000, graceMs: 20_000, answeredOnce: false }), { misses: 0, restart: false })
  // Past the grace, or once it has answered, they are.
  assert.deepEqual(afterProbe({ ok: false, misses: 0, allowed: 3, ranForMs: 25_000, graceMs: 20_000, answeredOnce: false }), { misses: 1, restart: false })
  assert.deepEqual(afterProbe({ ok: false, misses: 1, allowed: 3, ranForMs: 2_000, graceMs: 20_000, answeredOnce: true }), { misses: 2, restart: false })
  assert.deepEqual(afterProbe({ ok: false, misses: 2, allowed: 3, ranForMs: 2_000, graceMs: 20_000, answeredOnce: true }), { misses: 3, restart: true })
  // One answer resets the count: a single slow request does not restart a working server.
  assert.deepEqual(afterProbe({ ok: true, misses: 2, allowed: 3, ranForMs: 60_000, graceMs: 20_000, answeredOnce: true }), { misses: 0, restart: false })
})

test('only a listener running exactly this command is a leftover of this service', () => {
  const command = ['/usr/bin/node', '/srv/heddle/dist/cli.js', 'web', '--port', '3082']
  assert.equal(isOurLeftover('/usr/bin/node /srv/heddle/dist/cli.js web --port 3082', command), true)
  assert.equal(isOurLeftover('  /usr/bin/node  /srv/heddle/dist/cli.js web --port 3082\n', command), true, 'spacing is not identity')
  assert.equal(isOurLeftover('/usr/bin/node /other/checkout/dist/cli.js web --port 3082', command), false, 'another checkout is not ours')
  assert.equal(isOurLeftover('/usr/bin/python3 -m http.server 3082', command), false)
  assert.equal(isOurLeftover('', command), false)
  assert.equal(isOurLeftover(undefined, command), false)
})

/** A free loopback port: bind 0, read it, release it. */
async function freePort() {
  return await new Promise((resolvePromise) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolvePromise(port))
    })
  })
}

/** A stand-in HTTP server on the port given as its argument; with `hangAfterMs` it stops itself (SIGSTOP), a real hang. */
function httpServer({ name, hangAfterMs = null, spinAfterMs = null, blockAfterMs = null }) {
  const path = join(scratch, `${name}.mjs`)
  const pids = join(scratch, `${name}.pids`)
  writeFileSync(
    path,
    [
      "import { appendFileSync } from 'node:fs'",
      "import { createServer } from 'node:http'",
      "import { execSync } from 'node:child_process'",
      `appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n')`,
      `appendFileSync(${JSON.stringify(`${pids}.argv`)}, JSON.stringify({ execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? null }) + '\\n')`,
      "createServer((request, response) => response.end('ok')).listen(Number(process.argv[2]), '127.0.0.1')",
      "process.on('SIGTERM', () => process.exit(0))",
      hangAfterMs === null ? '' : `setTimeout(() => process.kill(process.pid, 'SIGSTOP'), ${hangAfterMs})`,
      // The #257 shape: JavaScript that never yields, so the port stays bound and the event loop answers nothing.
      spinAfterMs === null ? '' : `setTimeout(function spinsForever() { for (;;) {} }, ${spinAfterMs})`,
      // The other #257 shape: the thread blocked inside a native call, where the inspector is never serviced.
      blockAfterMs === null ? '' : `setTimeout(function blocksInNative() { execSync('sleep 20') }, ${blockAfterMs})`,
      '',
    ].join('\n'),
  )
  return { path, pids }
}

/**
 * The agent's PATH, exactly as install.sh renders it: no /usr/sbin, where macOS keeps lsof. A reclaim that relied on
 * PATH found no listener under launchd while passing here, until the test ran with this.
 */
const AGENT_PATH = `/usr/local/bin:/usr/bin:/bin:${dirname(process.execPath)}`

function superviseWith(flags, command) {
  const child = spawn(process.execPath, [supervisor, ...flags, '--', ...command], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: AGENT_PATH },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const exited = new Promise((resolvePromise) => child.once('exit', (code, signal) => resolvePromise({ code, signal })))
  return { child, exited, output: () => ({ stdout, stderr }) }
}

test('a server that hangs with its port bound is killed after missed probes and started again', async () => {
  // Measured on a scratch agent before this existed: a SIGSTOPped server kept the port and answered nothing, the job
  // read "running", and nothing acted for as long as it was watched.
  const port = await freePort()
  const server = httpServer({ name: 'hangs', hangAfterMs: 1_500 })
  const run = superviseWith(
    ['--health-url', `http://127.0.0.1:${port}/healthz`, '--health-every', '1', '--health-misses', '2', '--health-grace', '1'],
    [process.execPath, server.path, String(port)],
  )
  try {
    await until(() => lines(server.pids).length >= 2, 'a second server after the first one hung', 15_000)
    assert.match(run.output().stderr, /missed 2 probes in a row; the server is hung, restarting it/)
  } finally {
    run.child.kill('SIGTERM')
    const ended = await run.exited
    assert.equal(ended.code, 0, 'and a supervisor whose server is hung still stops: the SIGKILL fallback reaches a stopped child')
  }
})

test('a hung node server is captured before the kill: its JavaScript stack, and a sample (#257)', async () => {
  const port = await freePort()
  const captures = join(scratch, 'captures')
  const server = httpServer({ name: 'spins', spinAfterMs: 1_500 })
  const run = superviseWith(
    ['--health-url', `http://127.0.0.1:${port}/healthz`, '--health-every', '1', '--health-misses', '2', '--health-grace', '1', '--capture-dir', captures],
    [process.execPath, server.path, String(port)],
  )
  try {
    await until(() => lines(server.pids).length >= 2, 'a second server after the first one hung and was captured', 25_000)
    const { stderr } = run.output()
    assert.match(stderr, /the server is hung, restarting it/)
    assert.match(stderr, /captured the hung server before the kill: /)
    const started = JSON.parse(lines(`${server.pids}.argv`)[0])
    assert.deepEqual(started.execArgv, ['--inspect-port=127.0.0.1:0'], 'the server process carries the inspector port as its own argument')
    assert.equal(started.nodeOptions, process.env.NODE_OPTIONS ?? null, 'and its environment, which its children inherit, is not changed')
    assert.equal(statSync(captures).mode & 0o777, 0o700, 'the capture directory is private')
    const files = readdirSync(captures)
    const stacks = files.filter((name) => name.startsWith('stack-'))
    assert.equal(stacks.length, 1, `one JavaScript stack (${files.join(', ')})`)
    const stack = readFileSync(join(captures, stacks[0]), 'utf8').split('\n')
    assert.equal(stack[0], 'paused: other', 'the file says why the server paused')
    assert.match(stack[1], /^spinsForever file:\/\/\S+spins\.mjs:\d+:\d+ \[local(,[a-z]+)*\]$/, 'the top frame is the function the server is stuck in, with its file and scope types')
    for (const name of files) assert.equal(statSync(join(captures, name)).mode & 0o777, 0o600, `${name} is private`)
    const samples = files.filter((name) => name.startsWith('sample-'))
    // `sample` needs the right to read the process's task port; a host without it still gets the JavaScript stack.
    for (const name of samples) assert.ok(readFileSync(join(captures, name), 'utf8').length > 0, 'a sample holds native stacks')
  } finally {
    run.child.kill('SIGTERM')
    await run.exited
  }
})

test('the stack file carries the pause reason and each frame\'s scope types, never a value (#257)', () => {
  const lines = formatPaused({
    reason: 'other',
    callFrames: [
      { functionName: 'fold', url: 'file:///r/dist/log.js', location: { lineNumber: 41, columnNumber: 7 }, scopeChain: [{ type: 'local', object: { objectId: '1.2' } }, { type: 'closure', object: { objectId: '1.3' } }, { type: 'module' }] },
      { functionName: '', url: '', location: { lineNumber: 0, columnNumber: 0 } },
    ],
  })
  assert.deepEqual(lines, ['paused: other', 'fold file:///r/dist/log.js:42:8 [local,closure,module]', '(anonymous) :1:1 []'])
  assert.ok(!lines.join('\n').includes('1.2'), 'no object of any scope is named')
})

test('a frame without a url is named by its script id, as node 24 reports frames (#257, hang 5)', () => {
  const scripts = new Map([['41', 'file:///r/src/team/service.ts'], ['7', 'node:path']])
  const lines = formatPaused({
    reason: 'other',
    callFrames: [
      { functionName: 'join', url: '', location: { scriptId: '7', lineNumber: 1332, columnNumber: 13 }, scopeChain: [{ type: 'local' }] },
      { functionName: 'leadOf', url: '', location: { scriptId: '41', lineNumber: 131, columnNumber: 33 }, scopeChain: [{ type: 'local' }] },
      { functionName: 'gone', url: '', location: { scriptId: '99', lineNumber: 0, columnNumber: 0 } },
    ],
  }, scripts)
  assert.deepEqual(lines.slice(1), ['join node:path:1333:14 [local]', 'leadOf file:///r/src/team/service.ts:132:34 [local]', 'gone :1:1 []'])
})

test('a hung node server blocked inside a native call still leaves a sample and a one-line stack file (#257)', async () => {
  const port = await freePort()
  const captures = join(scratch, 'captures-native')
  const server = httpServer({ name: 'blocks', blockAfterMs: 1_500 })
  const run = superviseWith(
    ['--health-url', `http://127.0.0.1:${port}/healthz`, '--health-every', '1', '--health-misses', '2', '--health-grace', '1', '--capture-dir', captures],
    [process.execPath, server.path, String(port)],
  )
  try {
    await until(() => lines(server.pids).length >= 2, 'a second server after the blocked one was captured', 25_000)
    const stacks = readdirSync(captures).filter((name) => name.startsWith('stack-'))
    assert.equal(stacks.length, 1)
    const stack = readFileSync(join(captures, stacks[0]), 'utf8').trim().split('\n')
    assert.equal(stack.length, 1, stack.join(' | '))
    assert.match(stack[0], /^inspector did not pause: /, 'the file says the inspector got nowhere, instead of being missing')
  } finally {
    run.child.kill('SIGTERM')
    await run.exited
  }
})

test('a leftover of this same command on the port is reclaimed before a start; a stranger is left alone', async () => {
  const port = await freePort()
  const server = httpServer({ name: 'leftover' })
  const command = [process.execPath, server.path, String(port)]
  // The previous generation, still serving after its supervisor died (the agent abandons its process group).
  const leftover = spawn(command[0], command.slice(1), { stdio: 'ignore', detached: true })
  leftover.unref()
  await until(() => lines(server.pids).length === 1, 'the leftover listening')
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
  const run = superviseWith(['--reclaim-port', String(port)], command)
  try {
    await until(() => lines(server.pids).length >= 2, 'a new generation after the reclaim', 10_000)
    assert.match(run.output().stdout, new RegExp(`reclaiming port ${port} from a previous generation \\(pid ${leftover.pid}\\)`))
    await until(() => { try { process.kill(leftover.pid, 0); return false } catch { return true } }, 'the leftover gone')
  } finally {
    run.child.kill('SIGTERM')
    await run.exited
  }

  // Something else on the port is somebody else's: reported, never stopped.
  const strangerPort = await freePort()
  const stranger = spawn(process.execPath, ['-e', `require('node:http').createServer((q, r) => r.end()).listen(${strangerPort}, '127.0.0.1'); setInterval(() => {}, 1000)`], { stdio: 'ignore' })
  try {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    const guarded = superviseWith(['--reclaim-port', String(strangerPort), '--max-failures', '2', '--give-up'], [process.execPath, server.path, String(strangerPort)])
    await guarded.exited
    assert.match(guarded.output().stderr, new RegExp(`port ${strangerPort} is held by pid ${stranger.pid} .*not this service; leaving it alone`))
    assert.doesNotThrow(() => process.kill(stranger.pid, 0), 'the stranger is still alive')
  } finally {
    stranger.kill('SIGKILL')
  }
})

test('the lock is refused only to a live supervisor; a dead or reused pid is a stale lock', () => {
  const supervisorCommand = '/usr/bin/node /srv/heddle/_tools_/web-daemon/supervisor.mjs --lock /h/l -- /usr/bin/node /srv/heddle/dist/cli.js web'
  assert.equal(lockVerdict({ holderPid: 4242, holderAlive: true, holderCommand: supervisorCommand, selfPid: 1 }), 'refuse')
  assert.equal(lockVerdict({ holderPid: 4242, holderAlive: false, holderCommand: null, selfPid: 1 }), 'take', 'the holder died')
  assert.equal(lockVerdict({ holderPid: 4242, holderAlive: true, holderCommand: '/usr/bin/vim notes.txt', selfPid: 1 }), 'take', 'the pid was reused by something else')
  assert.equal(lockVerdict({ holderPid: 1, holderAlive: true, holderCommand: supervisorCommand, selfPid: 1 }), 'take', 'our own pid')
  assert.equal(lockVerdict({ holderPid: Number.NaN, holderAlive: false, holderCommand: null, selfPid: 1 }), 'take', 'an unreadable lock')
})

test('a second supervisor of the same service is refused while the first holds the lock, and takes it once the first is gone', async () => {
  const server = fakeServer({ name: 'locked' })
  const lock = join(scratch, 'web-supervisor.lock')
  const first = superviseWith(['--lock', lock], [process.execPath, server.path])
  try {
    await until(() => lines(server.pids).length === 1, 'the first supervisor running its server')
    assert.equal(readFileSync(lock, 'utf8').trim(), String(first.child.pid), 'the lock names the holder')
    const second = superviseWith(['--lock', lock], [process.execPath, server.path])
    const refused = await second.exited
    assert.equal(refused.code, 3)
    assert.match(second.output().stderr, new RegExp(`another supervisor \\(pid ${first.child.pid}\\) already runs this service`))
    assert.equal(lines(server.pids).length, 1, 'and it started no second server')
  } finally {
    first.child.kill('SIGKILL')
    await first.exited
    // A killed supervisor leaves its server orphaned (that is the point of abandoning the process group), and the
    // orphan holds this test's output pipe open; stop it so the run can end.
    for (const pid of lines(server.pids)) {
      try {
        process.kill(Number(pid), 'SIGKILL')
      } catch {
        // already gone
      }
    }
  }
  // Killed, the first left its lock behind; the pid is dead, so the lock is stale and the next supervisor takes it.
  const third = superviseWith(['--lock', lock], [process.execPath, server.path])
  try {
    await until(() => readFileSync(lock, 'utf8').trim() === String(third.child.pid), 'the stale lock taken over')
  } finally {
    third.child.kill('SIGTERM')
    await third.exited
  }
  assert.equal(existsSync(lock), false, 'a supervisor that stops cleanly releases its lock')
})
