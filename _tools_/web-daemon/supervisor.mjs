#!/usr/bin/env node
import { spawn } from 'node:child_process'
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
 *   node supervisor.mjs --max-failures 10 -- <program> [server arguments…]
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
 * The command line as `{ command, maxFailures, slowRetryMs, giveUp }`.
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
    } else if (arg === '--help' || arg === '-h') {
      throw new Error('usage: supervisor.mjs [--max-failures N] [--retry-seconds S] [--give-up] -- <program> [arguments…]')
    } else {
      throw new Error(`unknown supervisor option ${arg}`)
    }
  }
  const command = argv.slice(separator + 1)
  if (command.length === 0) throw new Error('no server command after --')
  return { command, maxFailures, slowRetryMs, giveUp }
}

/**
 * Start one server and describe it while it runs.
 *
 * Resolves with a handle the loop can signal and await; it never rejects, because a program that cannot even be
 * created is a failed start like any other and the loop above is the one place that decides what to do about it.
 */
function startServer(command) {
  let child = null
  try {
    child = spawn(command[0], command.slice(1), { stdio: 'inherit' })
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
  return { startedAt, signalling, done }
}

async function main() {
  let parsed
  try {
    parsed = parseSupervisorArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`heddle-supervisor: ${error.message}\n`)
    process.exit(2)
  }
  const { command, maxFailures, slowRetryMs, giveUp } = parsed

  let stopping = false
  let failures = 0
  let slowedBefore = false
  let current = null
  let wake = null

  const stop = () => {
    stopping = true
    current?.signalling('SIGTERM')
    if (wake !== null) wake()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  process.stdout.write(`heddle-supervisor: running ${command.join(' ')}\n`)
  while (!stopping) {
    current = startServer(command)
    const ended = await current.done
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
