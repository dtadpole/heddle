import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'

import { connect } from './cdp.mjs'

/**
 * Finding, starting and stopping the browser.
 *
 * The tool ships with no driver package: Chrome's own DevTools endpoint is the interface, and this
 * file owns the part that is about *the machine* rather than about the protocol — where the binary
 * lives, which profile it gets, and how a start is known to have succeeded.
 */

/**
 * Where the usual browsers live on this platform, in preference order.
 *
 * The environment variable comes first because it is the only one that works on a machine whose
 * browser is somewhere else, and it is also how a check pins its own binary.
 */
export const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

/** The first browser binary this machine has, or `undefined`. */
export function browserPath(override) {
  if (override !== undefined && override.length > 0) return override
  for (const variable of ['HEDDLE_BROWSER', 'CHROME_PATH']) {
    const value = process.env[variable]
    if (value !== undefined && value.length > 0 && existsSync(value)) return value
  }
  return CANDIDATES.find((candidate) => existsSync(candidate))
}

/** Whether a browser is available, so a caller can report unjudged rather than failed. */
export function browserAvailable(override) {
  return browserPath(override) !== undefined
}

/** This checkout, so runtime state can live under it rather than in the home directory. */
function repositoryRoot() {
  return new URL('../../', import.meta.url).pathname
}

/**
 * The directory this tool keeps its machine-local state in.
 *
 * A profile is deliberately **not** a temporary directory: a login done once in a visible window is
 * reused by every later call, which is the behaviour the harness's own browser has and the reason a
 * caller can be asked to sign in by hand. It lives **under the checkout** (`.heddle-tmp/browser/`,
 * which git ignores) because the tool runs inside this repository, and a tool that writes into
 * `~/.heddle` by default is a tool whose footprint its owner did not ask for. `HEDDLE_BROWSER_HOME`
 * moves it, so a check or a second owner can have a browser of its own without touching this one.
 */
export function stateDir() {
  const fromEnvironment = process.env.HEDDLE_BROWSER_HOME
  const base = fromEnvironment !== undefined && fromEnvironment.length > 0 ? fromEnvironment : join(repositoryRoot(), '.heddle-tmp', 'browser')
  /**
   * A **named session is a browser of its own**: its own process, its own profile, its own tabs. There is
   * no way for two sessions sharing one Chrome to keep their pages apart in `list_pages` or their
   * selected page apart in a tool call that names none, so isolation is per session rather than per page.
   * `HEDDLE_BROWSER_SESSION` (or `--session=`) selects one; without it, the machine's default session is
   * what a person running the command line by hand gets.
   */
  const session = process.env.HEDDLE_BROWSER_SESSION
  if (session === undefined || session.length === 0) return base
  const safe = session.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return join(base, 'sessions', safe.length > 0 ? safe : 'unnamed')
}

/** The profile directory, created on demand. */
export function profileDir() {
  const dir = join(stateDir(), 'chrome-profile')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Fetch one JSON document from the browser's HTTP side. */
function httpJson(port, path, timeoutMs = 2_000) {
  return new Promise((resolvePromise, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (response) => {
      let body = ''
      response.on('data', (chunk) => {
        body += chunk.toString()
      })
      response.on('end', () => {
        try {
          resolvePromise(JSON.parse(body))
        } catch (error) {
          reject(new Error(`the browser answered '${path}' with something that is not JSON: ${String(error)}`))
        }
      })
    })
    request.on('timeout', () => request.destroy(new Error(`the browser did not answer '${path}' within ${timeoutMs}ms`)))
    request.on('error', reject)
  })
}

/**
 * Marker Chrome prints when the **outer** environment refused its own sandbox.
 *
 * Measured on this machine: Chrome's zygote could not initialize its sandbox (the harness confines
 * every process it starts), so the renderer crashed the moment a page was attached, while the
 * browser itself had started and printed an endpoint. Re-running the same browser with
 * `--no-sandbox` — Chrome's sandbox, not the host's — makes it usable, and this is the only
 * environment signal that distinguishes the two cases.
 */
const SANDBOX_FAILURE = /sandbox initialization failed|failed to initialize sandbox|SUID sandbox helper/i

/** Remove the lock files a killed browser leaves behind, which block the next start on that profile. */
function clearSingleton(profile) {
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      rmSync(join(profile, name), { force: true })
    } catch {
      // A lock that is genuinely held by a live browser will be reported by the start that follows.
    }
  }
}

/** Start one browser process and read its endpoint, or throw with the stderr that explains it. */
async function startOnce(executable, options) {
  const profile = options.profile
  mkdirSync(profile, { recursive: true })
  const width = options.width ?? 1280
  const height = options.height ?? 900
  /**
   * A browser given a profile it has seen before may restore the last session, which would put pages
   * the caller never opened in front of the first `list_pages`. The crash bubble is suppressed because
   * a window that says "restore pages?" is a window a person has to click, and this must run unattended.
   */
  const args = [
    ...(options.headless === true ? ['--headless=new'] : ['--new-window']),
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-session-crashed-bubble',
    ...(options.noSandbox === true ? ['--no-sandbox'] : []),
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    ...(options.colorScheme === 'light' ? ['--force-light-mode'] : options.colorScheme === 'dark' ? ['--force-dark-mode'] : []),
    ...(options.args ?? []),
    'about:blank',
  ]
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  try {
    const wsUrl = await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`the browser printed no debugging endpoint within ${options.timeoutMs ?? 20_000}ms\n${stderr}`)),
        options.timeoutMs ?? 20_000,
      )
      const check = () => {
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)
        if (match !== null) {
          clearTimeout(timer)
          resolvePromise(match[1])
        }
      }
      child.stderr.on('data', check)
      check()
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`the browser exited (code ${String(code)}, signal ${String(signal)}) before printing an endpoint\n${stderr}`))
      })
    })
    const port = Number(new URL(wsUrl).port)
    // The endpoint is printed before the browser is ready to answer the HTTP side; `version` is the
    // readiness signal, and it also names the protocol the browser speaks.
    const deadline = Date.now() + 10_000
    let version
    for (;;) {
      try {
        version = await httpJson(port, '/json/version')
        break
      } catch (error) {
        if (Date.now() > deadline) {
          throw new Error(`the browser endpoint at 127.0.0.1:${port} never answered: ${error instanceof Error ? error.message : String(error)}`)
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
      }
    }
    // The sandbox failure is printed while the renderer warms up, which can be a moment after the
    // endpoint line; the window is short because a browser that needs it says so immediately.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, options.sandboxProbeMs ?? 150))
    const running = {
      child,
      wsUrl,
      port,
      profile,
      binary: executable,
      headless: options.headless === true,
      noSandbox: options.noSandbox === true,
      version,
      stderr: () => stderr,
    }
    if (SANDBOX_FAILURE.test(stderr)) {
      await stopChrome(running)
      throw new Error(`the browser refused its own sandbox and will be retried without it:\n${stderr}`)
    }
    return running
  } catch (error) {
    child.kill('SIGKILL')
    throw error
  }
}

/**
 * Start a browser and return its DevTools endpoint.
 *
 * The debugging port is asked for as `0`, and the endpoint is read from the line Chrome prints — the
 * alternative, picking a free port first and passing it, closes the port between the probe and the
 * start, and that race is the kind a check meets once a week.
 *
 * A machine whose outer confinement forbids Chrome's sandbox gets a **second start** with
 * `--no-sandbox`, and the returned record says which one it was. Silently weakening a browser would be
 * wrong; silently failing on every confined machine would be useless.
 */
export async function launchChrome(options = {}) {
  const executable = options.binary ?? browserPath()
  if (executable === undefined) {
    throw new Error(
      'no browser was found; install Chrome or Chromium, or name one with HEDDLE_BROWSER=/path/to/browser',
    )
  }
  const profile = options.profile ?? profileDir()
  const attempts = options.noSandbox === true || process.env.HEDDLE_BROWSER_NO_SANDBOX === '1' ? [true] : [false, true]
  let lastError
  for (const noSandbox of attempts) {
    clearSingleton(profile)
    try {
      return await startOnce(executable, { ...options, profile, noSandbox })
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      const sandboxRefusal = SANDBOX_FAILURE.test(message)
      const singletonRefusal = /ProcessSingleton/.test(message)
      if (!sandboxRefusal && !singletonRefusal) throw error
      // Retry without the sandbox; a stale singleton lock from the refusal is removed by the next start.
    }
  }
  throw lastError
}

/** Remove a profile directory, retrying because Chrome keeps writing into it while it exits. */
export async function removeProfile(dir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    }
  }
}

/**
 * Stop a browser, politely when it answers and by signal when it does not.
 *
 * `Browser.close` is what flushes the profile and lets a page's `beforeunload` run, so it is tried
 * first; the signal is the fallback for a browser that is wedged, which is exactly when waiting on
 * politeness would hang.
 */
export async function stopChrome(running) {
  if (running === undefined) return
  try {
    const connection = await connect(running.wsUrl)
    await connection.send('Browser.close', {}, { timeoutMs: 2_000 })
    connection.close()
  } catch {
    // Fall through to the signal.
  }
  const child = running.child
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise))
    child.kill('SIGTERM')
    const timer = new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000))
    await Promise.race([exited, timer])
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  if (running.profile !== undefined && running.temporaryProfile === true) await removeProfile(running.profile)
}

export { httpJson }
