import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { stateDir } from './chrome.mjs'
import { daemonLogPath, request, SESSION_SOCKET, SESSION_STATE } from './host.mjs'

/**
 * The command-line side of the session host: is one running, start one, call a tool, stop it.
 *
 * All of it exists so that separate commands share one browser. Every decision here is about a failure
 * mode a client meets in practice: a state file whose host is dead, a host that starts but never
 * answers, a host owned by a different state directory, and a log a person can read when the browser
 * never came up.
 */

/** The command that starts a host, relative to this file. */
function cliPath() {
  return fileURLToPath(new URL('./cli.mjs', import.meta.url))
}

/** This checkout, which is the working directory a host is started from. */
function repositoryRoot() {
  return fileURLToPath(new URL('../../', import.meta.url))
}

/** The state file's contents, or `undefined` when there is no host on record. */
export function readState(dir = stateDir()) {
  const path = join(dir, SESSION_STATE)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Ask a running host whether it is alive, with a short leash. */
export async function ping(state, timeoutMs = 2_000) {
  if (state === undefined) return undefined
  try {
    const answer = await request(state.socket, { id: 0, tool: '__ping' }, timeoutMs)
    return answer.ok === true ? answer.result : undefined
  } catch {
    return undefined
  }
}

/** The live host for this state directory, or `undefined`. */
export async function liveHost(dir = stateDir()) {
  const state = readState(dir)
  if (state === undefined) return undefined
  const health = await ping(state)
  return health === undefined ? undefined : { state, health }
}

/** How long a start may take before it is called a failure: a cold Chrome start, plus its sandbox retry. */
const START_TIMEOUT_MS = 60_000

/**
 * Start a host in the background and wait until it answers.
 *
 * The daemon is detached and writes its output to `daemon.log`; when the start fails, the log's tail is
 * what the caller is shown, because "it did not start" without the browser's own words is not something
 * a person can act on.
 */
export async function startHostProcess(options = {}) {
  const dir = options.stateDir ?? stateDir()
  // A named session's directory is created by this start, because the log it writes is opened first.
  mkdirSync(dir, { recursive: true })
  const log = daemonLogPath(dir)
  const logFd = openSync(log, 'a')
  const args = [cliPath(), '__daemon', `--state=${dir}`]
  if (options.headless === true) args.push('--headless')
  if (typeof options.profile === 'string' && options.profile.length > 0) args.push(`--profile=${options.profile}`)
  if (typeof options.binary === 'string' && options.binary.length > 0) args.push(`--binary=${options.binary}`)
  if (Number.isFinite(options.width)) args.push(`--width=${options.width}`)
  if (Number.isFinite(options.height)) args.push(`--height=${options.height}`)
  const child = spawn(process.execPath, args, {
    cwd: repositoryRoot(),
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, HEDDLE_BROWSER_HOME: dir },
  })
  closeSync(logFd)
  child.unref()

  let exited
  child.once('exit', (code) => {
    exited = code
  })

  const deadline = Date.now() + (options.timeoutMs ?? START_TIMEOUT_MS)
  const socketPath = join(dir, SESSION_SOCKET)
  for (;;) {
    const state = readState(dir)
    if (state !== undefined && existsSync(socketPath)) {
      const health = await ping(state)
      if (health !== undefined) return { state, health }
    }
    if (exited !== undefined) {
      throw new Error(`the browser session host exited before it was ready (code ${String(exited)}).\n${tailLog(log)}`)
    }
    if (Date.now() > deadline) {
      // A host that hung is not one the next command should find; removing the record is honest.
      rmSync(join(dir, SESSION_STATE), { force: true })
      throw new Error(`the browser session host did not become ready within ${options.timeoutMs ?? START_TIMEOUT_MS}ms.\n${tailLog(log)}`)
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
}

/** The last lines of the daemon's log, for an error message. */
export function tailLog(path, lines = 12) {
  try {
    const text = readFileSync(path, 'utf8').trimEnd()
    if (text.length === 0) return '(the daemon wrote nothing)'
    return text.split('\n').slice(-lines).join('\n')
  } catch {
    return '(there is no daemon log)'
  }
}

/** The running host, starting one when there is none. */
export async function ensureHost(options = {}) {
  const dir = options.stateDir ?? stateDir()
  const headless = options.headless ?? process.env.HEDDLE_BROWSER_HEADLESS === '1'
  options = { ...options, headless }
  const live = await liveHost(dir)
  if (live !== undefined) return live
  // A state file whose socket is dead names a host that is gone; it must not block the start.
  rmSync(join(dir, SESSION_SOCKET), { force: true })
  rmSync(join(dir, SESSION_STATE), { force: true })
  return startHostProcess({ ...options, stateDir: dir })
}

/** Call one browser tool on the shared session, starting the session when needed. */
export async function callTool(tool, args = {}, options = {}) {
  const { state } = await ensureHost(options)
  const answer = await request(state.socket, { id: Date.now(), tool, args }, options.timeoutMs ?? 180_000)
  if (answer.ok !== true) throw new Error(answer.error?.message ?? 'the browser tool failed')
  return answer.result
}

/** Ask the running host for its health, or report that none is running. */
export async function status(options = {}) {
  const dir = options.stateDir ?? stateDir()
  const live = await liveHost(dir)
  if (live === undefined) return { running: false, state: readState(dir) }
  return { running: true, ...live }
}

/** Stop the running host, and clean up a state record left by one that already died. */
export async function stopHost(options = {}) {
  const dir = options.stateDir ?? stateDir()
  const state = readState(dir)
  if (state !== undefined) {
    try {
      await request(state.socket, { id: Date.now(), tool: '__shutdown' }, 5_000)
    } catch {
      // The host is already gone; removing its record is the rest of stopping it.
    }
  }
  rmSync(join(dir, SESSION_SOCKET), { force: true })
  rmSync(join(dir, SESSION_STATE), { force: true })
  return { stopped: true }
}
