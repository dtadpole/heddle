#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/**
 * The supervisor half of the Web UI service: it runs the server and puts it back when it exits.
 *
 * **Why it exists.** The convention's supervisor is launchd's `KeepAlive` (macOS) or systemd's `Restart=always`
 * (Linux): the platform restarts the job when the process exits. That is still the outer layer and this file does
 * not replace it — it adds the inner one. On the Mac this repository is developed on (macOS 27.0, 26A428,
 * 2026-10-22) launchd loads an agent but does not spawn it again: a plain `sleep` started with `RunAtLoad` +
 * `KeepAlive` and killed with SIGKILL is still `state = not running` ten seconds later, and a `StartInterval`
 * job never fires at all. The measurement is in `INDEX.md`; the consequence is that on this host "the server
 * comes back after a kill" is not something the platform delivers, so the service must.
 *
 * **What it is not.** Not a replacement for the agent: the agent still owns the log, the working directory and
 * the environment, and it is still what starts this at login. Not a daemon manager either: it runs exactly one
 * child, because the server is one process.
 *
 * Usage, as `install.sh` renders it into the agent:
 *
 *   node supervisor.mjs --health-url http://127.0.0.1:3082/healthz --reclaim-port 3082 -- <program> [arguments…]
 *
 * **Two failures an exit does not show** (measured on a scratch agent, 2026-10-22): a server that hangs keeps its
 * port bound and answers nothing, and the job still reads `running`, so no exit ever comes; and a supervisor that is
 * killed takes the server with it, because launchd kills the job's process group and then never restarts the job.
 * `--health-url` answers the first: a server that misses `--health-misses` probes in a row (one every
 * `--health-every` seconds, after a start-up grace) is killed, and the ordinary restart path takes over. The agent's
 * `AbandonProcessGroup` answers the second — the server outlives a dead supervisor — and `--reclaim-port` makes that
 * safe: before each start, a listener on that port running **exactly this command** is a leftover from a previous
 * generation and is stopped first. A listener running anything else is reported and left alone.
 *
 * **One supervisor per service, by lock** (`--lock FILE`): reclaiming is only safe when no second supervisor of the
 * same service is alive, or each would stop the other's server in turn. The file records the holder's pid; a live
 * holder whose command line is a supervisor refuses the start, and anything else — a dead pid, a reused one — is a
 * stale lock taken over. Node has no `flock`, so this is the convention's third discriminator: a pidfile with its
 * command line checked.
 *
 * **Evidence before the kill** (`--capture-dir DIR`, #257): a hang-kill alone leaves nothing to say what the server was
 * stuck in — the live TS server was killed as hung four times in one day, and the log above each kill was silent.
 * With a capture directory, a server judged hung is examined before the SIGKILL, for at most `CAPTURE_BUDGET_MS`:
 * every server is sampled with macOS `sample` for native stacks (`sample-….txt`; the case where the thread is blocked
 * inside a native call), then a node server is sent SIGUSR1, which opens its inspector on loopback from a thread of
 * its own and interrupts the spinning JavaScript, and `Debugger.pause` yields the JavaScript stack (`stack-….txt`).
 * The directory is 0700 and each file 0600. Only then is the server killed, as before. The inspector is open for
 * those seconds only, on loopback, on a port the system picks, and dies with the server. A program that is not node
 * is never sent SIGUSR1: its default action is to terminate.
 *
 * A server run that lasts at least `STABLE_MS` resets the failure count and is restarted immediately. Runs that
 * die sooner are restarted at a doubling delay, and after `--max-failures` of them it **slows down instead of
 * stopping**: one retry every `--retry-seconds` (60 s by default), with one loud line saying so. Exiting is the
 * right shape where the platform restarts the job — and wrong here, where launchd was measured not to: a transient
 * cause (another process holding the port for a minute, a profile being written) would otherwise leave the page
 * down until a person noticed. `--give-up` restores the bounded behaviour for a host whose platform does restart
 * the job.
 */

/** A run at least this long counts as having started: a crash loop shorter than this is a failure to start. */
const STABLE_MS = 5_000
/** The longest a restart is delayed, however many have failed. */
const MAX_DELAY_MS = 5_000
/** Consecutive failed starts before the supervisor stops retrying fast. */
const DEFAULT_MAX_FAILURES = 10
/**
 * How long it waits between slow retries once that limit is reached.
 *
 * The first version **exited 1** after the fast retries, and on a host whose platform restarts the job that is the
 * right shape: launchd or systemd picks it up and the log says why. On this Mac, launchd was measured not to
 * restart a loaded agent at all, so exiting means the page stays down until a person or a monitor notices — even
 * when the cause was transient (another process holding the port for a minute). A slow retry keeps the service
 * alive through that, at one log line a minute; `--give-up` asks for the old bounded behaviour for a host whose
 * platform does restart the job.
 */
const DEFAULT_SLOW_RETRY_MS = 60_000
/** Seconds between health probes, probes missed in a row before a restart, and the start-up grace before counting. */
const DEFAULT_HEALTH_EVERY_MS = 5_000
const DEFAULT_HEALTH_MISSES = 3
const DEFAULT_HEALTH_GRACE_MS = 20_000
/** How long a probe may take before it counts as missed. */
const PROBE_TIMEOUT_MS = 2_000

/**
 * The delay before restart number `failures` (1-based): 250 ms, doubling, capped.
 *
 * Backoff exists because a server that cannot bind its port fails in milliseconds, and restarting it as fast as
 * possible turns one failure into thousands of log lines and a busted CPU.
 */
export function restartDelay(failures) {
  const n = Math.max(1, failures)
  return Math.min(250 * 2 ** (n - 1), MAX_DELAY_MS)
}

/**
 * What to do after a run of `ranForMs` ended, given how many starts have already failed in a row.
 *
 * Returns the new count, the delay, and whether to give up. A run that lasted counts as a start, which is the
 * distinction between "the server keeps crashing" and "the server was killed once after hours of work".
 */
export function nextAttempt({
  ranForMs,
  failures,
  maxFailures = DEFAULT_MAX_FAILURES,
  slowRetryMs = DEFAULT_SLOW_RETRY_MS,
  giveUp = false,
}) {
  if (ranForMs >= STABLE_MS) return { failures: 0, delayMs: 0, slow: false, giveUp: false }
  const grown = failures + 1
  if (grown >= maxFailures) {
    if (giveUp) return { failures: grown, delayMs: 0, slow: false, giveUp: true }
    return { failures: grown, delayMs: slowRetryMs, slow: true, giveUp: false }
  }
  return { failures: grown, delayMs: restartDelay(grown), slow: false, giveUp: false }
}

/**
 * What one health probe means for a running server: `{ misses, restart }`.
 *
 * A server that has never answered gets `graceMs` to start before a miss counts, so a slow start is not a hang; after
 * that, or once it has answered, `allowed` misses in a row mean it is hung and must be restarted. One answer resets
 * the count, so a single slow request does not restart a working server.
 */
export function afterProbe({ ok, misses, allowed = DEFAULT_HEALTH_MISSES, ranForMs, graceMs = DEFAULT_HEALTH_GRACE_MS, answeredOnce }) {
  if (ok) return { misses: 0, restart: false }
  if (!answeredOnce && ranForMs < graceMs) return { misses, restart: false }
  const grown = misses + 1
  return { misses: grown, restart: grown >= allowed }
}

/**
 * Whether the process listening on our port is a leftover of this same service: its command line is exactly the
 * command this supervisor runs. Anything else is somebody else's process and is never ours to stop.
 */
export function isOurLeftover(listenerCommand, command) {
  const normal = (text) => text.trim().split(/\s+/).join(' ')
  return typeof listenerCommand === 'string' && listenerCommand.trim() !== '' && normal(listenerCommand) === normal(command.join(' '))
}

/**
 * Whether this supervisor may take the lock: `take` unless the recorded holder is another live supervisor.
 *
 * A pid alone is not proof: pids are reused, so a live pid whose command line is not a supervisor is a stale lock.
 */
export function lockVerdict({ holderPid, holderAlive, holderCommand, selfPid }) {
  if (!Number.isInteger(holderPid) || holderPid <= 0 || holderPid === selfPid) return 'take'
  if (!holderAlive) return 'take'
  return typeof holderCommand === 'string' && holderCommand.includes('supervisor.mjs') ? 'refuse' : 'take'
}

/**
 * The command line as `{ command, maxFailures, slowRetryMs, giveUp, healthUrl, healthEveryMs, healthMisses,
 * healthGraceMs, reclaimPort, lock }`.
 *
 * Everything after `--` is the server and is passed through untouched: flags, paths with spaces, and a program
 * that is not node (the Rust binary the port will serve) all stay exactly as the installer rendered them.
 */
export function parseSupervisorArgs(argv) {
  const separator = argv.indexOf('--')
  if (separator < 0) throw new Error('missing "--" before the server command')
  let maxFailures = DEFAULT_MAX_FAILURES
  let slowRetryMs = DEFAULT_SLOW_RETRY_MS
  let giveUp = false
  let healthUrl = null
  let healthEveryMs = DEFAULT_HEALTH_EVERY_MS
  let healthMisses = DEFAULT_HEALTH_MISSES
  let healthGraceMs = DEFAULT_HEALTH_GRACE_MS
  let reclaimPort = null
  let lock = null
  let captureDir = null
  const number = (flag, at) => {
    const value = argv[at + 1]
    if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) {
      throw new Error(`${flag} needs a positive integer`)
    }
    return Number(value)
  }
  for (let index = 0; index < separator; index += 1) {
    const arg = argv[index]
    if (arg === '--max-failures') {
      maxFailures = number(arg, index)
      index += 1
    } else if (arg === '--retry-seconds') {
      slowRetryMs = number(arg, index) * 1000
      index += 1
    } else if (arg === '--give-up') {
      giveUp = true
    } else if (arg === '--health-url') {
      const value = argv[index + 1]
      if (value === undefined || !/^https?:\/\//.test(value)) throw new Error('--health-url needs an http(s) URL')
      healthUrl = value
      index += 1
    } else if (arg === '--health-every') {
      healthEveryMs = number(arg, index) * 1000
      index += 1
    } else if (arg === '--health-misses') {
      healthMisses = number(arg, index)
      index += 1
    } else if (arg === '--health-grace') {
      healthGraceMs = number(arg, index) * 1000
      index += 1
    } else if (arg === '--reclaim-port') {
      reclaimPort = number(arg, index)
      index += 1
    } else if (arg === '--lock') {
      const value = argv[index + 1]
      if (value === undefined || !value.startsWith('/')) throw new Error('--lock needs an absolute path')
      lock = value
      index += 1
    } else if (arg === '--capture-dir') {
      const value = argv[index + 1]
      if (value === undefined || !value.startsWith('/')) throw new Error('--capture-dir needs an absolute path')
      captureDir = value
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      throw new Error(
        'usage: supervisor.mjs [--max-failures N] [--retry-seconds S] [--give-up] [--health-url URL [--health-every S] [--health-misses N] [--health-grace S]] [--reclaim-port N] [--lock FILE] [--capture-dir DIR] -- <program> [arguments…]',
      )
    } else {
      throw new Error(`unknown supervisor option ${arg}`)
    }
  }
  const command = argv.slice(separator + 1)
  if (command.length === 0) throw new Error('no server command after --')
  return { command, maxFailures, slowRetryMs, giveUp, healthUrl, healthEveryMs, healthMisses, healthGraceMs, reclaimPort, lock, captureDir }
}

/** The longest a hung server is examined before it is killed (#257). */
export const CAPTURE_BUDGET_MS = 5_000
/** How long `sample` records the hung process for. */
const SAMPLE_SECONDS = 3

/** Whether the server program is node, so that it opens its inspector on SIGUSR1 rather than dying of it. */
export function isNodeProgram(program) {
  return /^node(\.exe)?$/.test(basename(program))
}

/**
 * What to capture from a hung server: `{ stack, sample }`. A node server can be paused through its inspector for the
 * JavaScript stack; any process can be sampled. A program that is not node gets no SIGUSR1: terminating is its default.
 */
export function captureSteps(command) {
  return { stack: isNodeProgram(command[0]), sample: true }
}

/**
 * The server's environment: the supervisor's own, plus, when hangs are captured and the server is node, an inspector
 * port of `127.0.0.1:0`. That opens nothing: it only means that the inspector SIGUSR1 starts listens on loopback, on a
 * port the system picks, so it never collides with a debugger on 9229. Options already in `NODE_OPTIONS` come first.
 *
 * Not `--report-on-signal`: node handles that signal on its event loop, so a server whose JavaScript spins never
 * writes the report (measured, node 24.21, 2026-11-01). SIGUSR1 starts the inspector from its own thread and
 * interrupts running JavaScript, which is the case a hang is.
 */
export function serverEnvironment(env, command, captureDir) {
  if (captureDir === null || !captureSteps(command).stack) return env
  const inspector = '--inspect-port=127.0.0.1:0'
  const existing = env.NODE_OPTIONS?.trim()
  return { ...env, NODE_OPTIONS: existing ? `${existing} ${inspector}` : inspector }
}

/** The loopback port `pid` listens on besides `servicePort` — its inspector, once SIGUSR1 has opened it. */
function inspectorPortOf(pid, servicePort) {
  const shown = spawnSync(LSOF, ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' })
  for (const match of (shown.stdout ?? '').matchAll(/^n127\.0\.0\.1:(\d+)$/gm)) {
    const port = Number(match[1])
    if (port !== servicePort) return port
  }
  return null
}

/** How long `Debugger.pause` may go unanswered: a server blocked inside a native call never answers it. */
const PAUSE_WAIT_MS = 1_500

/**
 * The stack file's lines for a `Debugger.paused` event: the pause reason, then one frame per line with its location and
 * the **types** of its scopes (local, closure, module, …), which tell an await loop from a synchronous one without
 * reading a single value. Nothing is evaluated in the server.
 */
export function formatPaused(params) {
  return [
    `paused: ${params.reason}`,
    ...params.callFrames.map((frame) => {
      const scopes = (frame.scopeChain ?? []).map((scope) => scope.type).join(',')
      return `${frame.functionName || '(anonymous)'} ${frame.url}:${frame.location.lineNumber + 1}:${frame.location.columnNumber + 1} [${scopes}]`
    }),
  ]
}

/**
 * The JavaScript stack of a hung node server as the stack file's lines: `formatPaused`'s, or one line saying why the
 * inspector did not pause, so the file always says what happened.
 *
 * SIGUSR1 opens the inspector on loopback; `Debugger.pause` stops the running JavaScript at its next interrupt check
 * and the paused event carries the call frames. A server blocked inside a native call never services the inspector,
 * which is what the native `sample` before this is for. The inspector stays open only until the kill that follows.
 */
async function javascriptStackOf(run, servicePort, budgetMs) {
  const deadline = Date.now() + budgetMs
  const failed = (reason) => [`inspector did not pause: ${reason}`]
  run.signalling('SIGUSR1')
  let port = null
  while (port === null && Date.now() < deadline) {
    port = inspectorPortOf(run.pid, servicePort)
    if (port === null) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (port === null) return failed(`no inspector port within ${budgetMs} ms of SIGUSR1`)
  try {
    const listed = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1)) })
    const [target] = await listed.json()
    if (target?.webSocketDebuggerUrl === undefined) return failed('the inspector listed no target')
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    return await new Promise((resolve) => {
      let timer = null
      const finish = (lines) => {
        clearTimeout(timer)
        try {
          socket.close()
        } catch {
          // already closed
        }
        resolve(lines)
      }
      timer = setTimeout(() => finish(failed('the inspector socket did not open in time')), Math.max(deadline - Date.now(), 1))
      socket.onerror = () => finish(failed('the inspector socket failed'))
      socket.onopen = () => {
        clearTimeout(timer)
        const wait = Math.max(Math.min(PAUSE_WAIT_MS, deadline - Date.now()), 1)
        timer = setTimeout(() => finish(failed(`no Debugger.paused within ${wait} ms (blocked inside a native call?)`)), wait)
        socket.send(JSON.stringify({ id: 1, method: 'Debugger.enable' }))
        socket.send(JSON.stringify({ id: 2, method: 'Debugger.pause' }))
      }
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data))
        if (message.method === 'Debugger.paused') finish(formatPaused(message.params))
      }
    })
  } catch (error) {
    return failed(error.message)
  }
}

/** Make `dir` a 0700 directory; true when it exists afterwards. */
function prepareCaptureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    return true
  } catch (error) {
    process.stderr.write(`heddle-supervisor: cannot prepare ${dir} for the hang capture: ${error.message}\n`)
    return false
  }
}

/**
 * Examine a hung server before it is killed (#257), within `CAPTURE_BUDGET_MS`: first `sample` for native stacks, then,
 * for node, the JavaScript stack through the inspector. In that order because a paused server sits in the debugger's
 * loop, and a sample taken then would show that instead of the hang. Never throws and never waits past the budget,
 * because the kill that follows is what brings the service back.
 */
async function captureHung(run, command, captureDir, servicePort) {
  if (run.pid === null || !prepareCaptureDir(captureDir)) return
  const started = Date.now()
  const steps = captureSteps(command)
  const before = new Set(readdirSync(captureDir))
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  if (steps.sample) {
    const sampleFile = join(captureDir, `sample-${stamp}-${run.pid}.txt`)
    await new Promise((resolve) => {
      let sampler
      try {
        sampler = spawn('/usr/bin/sample', [String(run.pid), String(SAMPLE_SECONDS), '-file', sampleFile], { stdio: 'ignore' })
      } catch {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        try {
          sampler.kill('SIGKILL')
        } catch {
          // already gone
        }
        resolve()
      }, (SAMPLE_SECONDS + 1) * 1000)
      sampler.once('error', () => {
        clearTimeout(timer)
        resolve()
      })
      sampler.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  const left = CAPTURE_BUDGET_MS - (Date.now() - started)
  if (steps.stack && left > 200) {
    const lines = await javascriptStackOf(run, servicePort, left)
    writeFileSync(join(captureDir, `stack-${stamp}-${run.pid}.txt`), `${lines.join('\n')}\n`, { mode: 0o600 })
  }
  const written = readdirSync(captureDir).filter((name) => !before.has(name))
  for (const name of written) {
    try {
      chmodSync(join(captureDir, name), 0o600)
    } catch {
      // gone or not ours; the listing below still names it
    }
  }
  process.stderr.write(
    written.length > 0
      ? `heddle-supervisor: captured the hung server before the kill: ${written.join(', ')} in ${captureDir}\n`
      : `heddle-supervisor: captured nothing from the hung server within ${CAPTURE_BUDGET_MS} ms (${captureDir})\n`,
  )
}

/** The command line of `pid`, or `null` when it is not running. */
function commandOf(pid) {
  try {
    process.kill(pid, 0)
  } catch {
    return null
  }
  const shown = spawnSync(PS, ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  return (shown.stdout ?? '').trim()
}

/** Take the lock at `path`, or return the live holder's pid. Written atomically: a temporary file, then a rename. */
function takeLock(path) {
  let holderPid = null
  try {
    holderPid = Number(readFileSync(path, 'utf8').trim())
  } catch {
    // no lock yet
  }
  const holderCommand = Number.isInteger(holderPid) && holderPid > 0 ? commandOf(holderPid) : null
  const verdict = lockVerdict({ holderPid, holderAlive: holderCommand !== null, holderCommand, selfPid: process.pid })
  if (verdict === 'refuse') return holderPid
  const temporary = `${path}.${process.pid}`
  writeFileSync(temporary, `${process.pid}\n`)
  renameSync(temporary, path)
  return null
}

/** Release the lock, only while it is still ours. */
function releaseLock(path) {
  try {
    if (Number(readFileSync(path, 'utf8').trim()) === process.pid) rmSync(path, { force: true })
  } catch {
    // already gone
  }
}

/**
 * The first of `candidates` that exists, else the bare name for `PATH` to resolve.
 *
 * By absolute path because the agent's `PATH` is `/usr/local/bin:/usr/bin:/bin` plus node's folder, and macOS keeps
 * `lsof` in `/usr/sbin`: measured 2026-10-22 on a scratch agent, the bare name was not found, the reclaim saw no
 * listener, and the new server failed to bind ten times in a row beside the orphan it should have replaced.
 */
function tool(candidates) {
  return candidates.find((path) => existsSync(path)) ?? candidates[candidates.length - 1]
}
const LSOF = tool(['/usr/sbin/lsof', '/usr/bin/lsof', 'lsof'])
const PS = tool(['/bin/ps', '/usr/bin/ps', 'ps'])

/**
 * The pid listening on 127.0.0.1:`port` and its command line, `null` when nothing listens, or `{ error }` when the
 * question cannot be asked — which is reported, never read as "nothing listens".
 */
function listenerOn(port) {
  const found = spawnSync(LSOF, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
  if (found.error) return { error: `${LSOF}: ${found.error.message}` }
  const pid = Number((found.stdout ?? '').trim().split('\n')[0])
  if (!Number.isInteger(pid) || pid <= 0) return null
  const shown = spawnSync(PS, ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  return { pid, command: (shown.stdout ?? '').trim() }
}

/**
 * Stop a leftover of this service holding `port` before a start: SIGTERM, then SIGKILL after three seconds.
 *
 * The leftover exists because the agent abandons its process group: a supervisor that was killed leaves its server
 * serving, which is the point, and the next supervisor would otherwise fail to bind for as long as it lives.
 */
async function reclaim(port, command) {
  const listener = listenerOn(port)
  if (listener === null) return
  if (listener.error) {
    process.stderr.write(`heddle-supervisor: cannot look for a leftover on port ${port} (${listener.error}); starting anyway\n`)
    return
  }
  if (!isOurLeftover(listener.command, command)) {
    process.stderr.write(`heddle-supervisor: port ${port} is held by pid ${listener.pid} (${listener.command}), which is not this service; leaving it alone\n`)
    return
  }
  process.stdout.write(`heddle-supervisor: reclaiming port ${port} from a previous generation (pid ${listener.pid})\n`)
  const signal = (name) => {
    try {
      process.kill(listener.pid, name)
    } catch {
      // already gone
    }
  }
  signal('SIGTERM')
  for (let waited = 0; waited < 3_000; waited += 100) {
    if (listenerOn(port)?.pid !== listener.pid) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  signal('SIGKILL')
  await new Promise((resolve) => setTimeout(resolve, 200))
}

/** One probe: true when the URL answers 2xx within the timeout. */
async function probe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    await response.arrayBuffer().catch(() => {})
    return response.ok
  } catch {
    return false
  }
}

/**
 * Start one server and describe it while it runs.
 *
 * Resolves with a handle the loop can signal and await; it never rejects, because a program that cannot even be
 * created is a failed start like any other and the loop above is the one place that decides what to do about it.
 */
function startServer(command, env = process.env) {
  let child = null
  try {
    child = spawn(command[0], command.slice(1), { stdio: 'inherit', env })
  } catch (error) {
    process.stderr.write(`heddle-supervisor: could not start ${command[0]}: ${error.message}\n`)
  }
  const startedAt = Date.now()
  const signalling = (signal) => {
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal)
      } catch {
        // already gone
      }
    }
  }
  const done =
    child === null
      ? Promise.resolve({ code: null, signal: null, ranForMs: 0 })
      : new Promise((resolve) => {
          let settled = false
          const finish = (code, signal) => {
            if (settled) return
            settled = true
            resolve({ code, signal, ranForMs: Date.now() - startedAt })
          }
          child.once('error', (error) => {
            process.stderr.write(`heddle-supervisor: ${command[0]}: ${error.message}\n`)
            finish(null, null)
          })
          child.once('exit', (code, signal) => finish(code, signal))
        })
  return { startedAt, pid: child?.pid ?? null, signalling, done }
}

async function main() {
  let parsed
  try {
    parsed = parseSupervisorArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`heddle-supervisor: ${error.message}\n`)
    process.exit(2)
  }
  const { command, maxFailures, slowRetryMs, giveUp, healthUrl, healthEveryMs, healthMisses, healthGraceMs, reclaimPort, lock, captureDir } = parsed
  const env = serverEnvironment(process.env, command, captureDir)
  const servicePort = healthUrl === null ? null : Number(new URL(healthUrl).port) || null
  if (captureDir !== null) prepareCaptureDir(captureDir)
  if (lock !== null) {
    const holder = takeLock(lock)
    if (holder !== null) {
      process.stderr.write(`heddle-supervisor: another supervisor (pid ${holder}) already runs this service (lock ${lock}); not starting a second\n`)
      process.exit(3)
    }
    process.on('exit', () => releaseLock(lock))
  }

  let stopping = false
  let failures = 0
  let slowedBefore = false
  let current = null
  let wake = null

  const stop = () => {
    stopping = true
    current?.signalling('SIGTERM')
    // A hung server — a stopped process, or one stuck in a loop — never acts on SIGTERM, and launchd would then wait
    // out its own exit timeout before killing this supervisor. Five seconds is the server's chance to stop cleanly.
    const run = current
    if (run !== null) setTimeout(() => run.signalling('SIGKILL'), 5_000).unref()
    if (wake !== null) wake()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  process.stdout.write(`heddle-supervisor: running ${command.join(' ')}\n`)
  while (!stopping) {
    if (reclaimPort !== null) await reclaim(reclaimPort, command)
    if (stopping) break
    current = startServer(command, env)
    let watch = null
    if (healthUrl !== null) {
      // Probe the running server; a hung one is killed, and its exit takes the ordinary restart path below.
      const run = current
      let misses = 0
      let answeredOnce = false
      let probing = false
      watch = setInterval(async () => {
        if (probing) return
        probing = true
        const ok = await probe(healthUrl)
        probing = false
        if (ok) answeredOnce = true
        const verdict = afterProbe({ ok, misses, allowed: healthMisses, ranForMs: Date.now() - run.startedAt, graceMs: healthGraceMs, answeredOnce })
        misses = verdict.misses
        if (verdict.restart && !stopping) {
          process.stderr.write(`heddle-supervisor: ${healthUrl} missed ${misses} probes in a row; the server is hung, restarting it\n`)
          // Stop probing first: the capture below takes seconds, and a second verdict must not start a second one.
          clearInterval(watch)
          if (captureDir !== null) await captureHung(run, command, captureDir, servicePort)
          run.signalling('SIGKILL')
        }
      }, healthEveryMs)
    }
    const ended = await current.done
    if (watch !== null) clearInterval(watch)
    current = null
    if (stopping) break
    process.stdout.write(
      `heddle-supervisor: ${command[0]} exited (${ended.signal ?? `code ${ended.code}`}) after ${ended.ranForMs} ms\n`,
    )
    const attempt = nextAttempt({ ranForMs: ended.ranForMs, failures, maxFailures, slowRetryMs, giveUp })
    const slowed = attempt.slow && !slowedBefore
    failures = attempt.failures
    slowedBefore = attempt.slow
    if (attempt.giveUp) {
      process.stderr.write(
        `heddle-supervisor: giving up after ${failures} failed starts in a row; the log above says why\n`,
      )
      process.exit(1)
    }
    if (attempt.delayMs > 0) {
      if (slowed) {
        process.stderr.write(
          `heddle-supervisor: ${failures} starts in a row failed; still retrying, every ${Math.round(attempt.delayMs / 1000)} s, because nothing else restarts this service on this host\n`,
        )
      }
      process.stdout.write(`heddle-supervisor: restarting in ${attempt.delayMs} ms\n`)
      await new Promise((resolve) => {
        wake = resolve
        setTimeout(resolve, attempt.delayMs)
      })
      wake = null
    }
  }
  process.stdout.write('heddle-supervisor: stopped\n')
  process.exit(0)
}

/**
 * Run only when this file is the program.
 *
 * The rules above are imported by `_tests_/supervisor-rules`, and importing a supervisor must not start one — the
 * first version of this file did, and the test run became the server's command line.
 */
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`heddle-supervisor: ${error.stack ?? error.message}\n`)
    process.exit(1)
  })
}
