import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

/**
 * The installed Web UI service, read the same way on both platforms.
 *
 * `install.sh` writes a launchd agent on macOS and a systemd user unit on Linux. `95-web-daemon` judges that the
 * service is up and stays up; `96-deployment` judges which checkout it serves. Both need the same facts — which
 * program the service runs, from which checkout, on which port, where it logs, which process owns the port — so
 * they are read here once instead of being parsed twice, differently, in two checks.
 *
 * The pure functions (parsers and verdicts) are what the unit tests in `_tests_/service-rules` judge; the host
 * readers at the bottom only feed them what `plutil`, `launchctl`, `systemctl`, `lsof`, `ss`, `ps`, `/proc` and
 * `git` report.
 */

export const LABEL = 'com.dtadpole.heddle-web'
export const UNIT = 'heddle-web.service'

/**
 * The port the service is documented to own. On macOS it is 3082, behind the 8082 gate the owner's browser uses.
 * On Linux nothing fronts the server: it owns 8082 itself, which is the port the owner's SSH forward reaches.
 */
export const DOCUMENTED_PORT = Object.freeze({ darwin: 3082, linux: 8082 })

/** The supervisor a platform installs under, or `null` where `install.sh` has none. */
export function supervisorFor(platform = process.platform) {
  if (platform === 'darwin') return 'launchd'
  if (platform === 'linux') return 'systemd'
  return null
}

/** Where `install.sh` writes the launchd agent. */
export function plistPath(env = process.env) {
  return join(env.HOME ?? '', 'Library', 'LaunchAgents', `${LABEL}.plist`)
}

/** Where `install.sh` writes the systemd user unit: `$XDG_CONFIG_HOME/systemd/user`, defaulting to `~/.config`. */
export function unitPath(env = process.env) {
  const config = env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== '' ? env.XDG_CONFIG_HOME : join(env.HOME ?? '', '.config')
  return join(config, 'systemd', 'user', UNIT)
}

/**
 * A systemd unit file as `{ section: { key: [values] } }`.
 *
 * Follows the parts of systemd's syntax a unit written by `install.sh` or by hand can use: `#` and `;` comments,
 * a trailing backslash continuing the line, repeated keys accumulating, and an empty assignment resetting the
 * list — `ExecStart=` followed by `ExecStart=x` means `x` alone, which a naive last-or-first reader gets wrong.
 */
export function parseUnit(text) {
  const sections = {}
  let current = null
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index].trim()
    while (line.endsWith('\\') && index + 1 < lines.length) {
      index += 1
      line = `${line.slice(0, -1).trimEnd()} ${lines[index].trim()}`
    }
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header !== null) {
      sections[header[1]] ??= {}
      current = sections[header[1]]
      continue
    }
    const at = line.indexOf('=')
    if (at < 0 || current === null) continue
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    if (value === '') current[key] = []
    else (current[key] ??= []).push(value)
  }
  return sections
}

/** The effective (last) value of one key, or `null` when the unit does not set it. */
export function unitValue(sections, section, key) {
  const values = sections[section]?.[key]
  return values === undefined || values.length === 0 ? null : values[values.length - 1]
}

/**
 * An `ExecStart` line as argv, the way systemd splits it: on whitespace, with double and single quotes grouping
 * and a backslash escaping the next character. The prefixes systemd allows before the program (`-`, `@`, `+`, `!`,
 * `:`) change how it runs, not what runs, so they are dropped from the first word.
 */
export function splitCommandLine(line) {
  const argv = []
  let word = ''
  let started = false
  let quote = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '\\' && index + 1 < line.length) {
      index += 1
      word += line[index]
      started = true
    } else if (quote !== null) {
      if (char === quote) quote = null
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) argv.push(word)
      word = ''
      started = false
    } else {
      word += char
      started = true
    }
  }
  if (quote !== null) throw new Error(`unterminated ${quote} in command line: ${line}`)
  if (started) argv.push(word)
  if (argv.length > 0) argv[0] = argv[0].replace(/^[-@+!:]+/, '')
  return argv
}

/** The value after a flag, or `null`. */
function flagValue(argv, flag) {
  const at = argv.indexOf(flag)
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : null
}

/**
 * What a service's command line says about the deployment.
 *
 * - `entry` is what identifies the build the live process must be running: the checkout's `dist/cli.js` for the
 *   TypeScript build, otherwise the program itself (the binary `HEDDLE_BIN` named).
 * - `root` is the checkout: the folder `dist/cli.js` lives in, otherwise the service's working directory, otherwise
 *   the folder of the profile named by `--config`.
 * - `supervised` is true when a supervisor runs in front of the server (`install.sh` puts
 *   [`supervisor.mjs`](supervisor.mjs) there on macOS, because launchd was measured not to restart a job). The
 *   command after `--` is the server, and **that** is what the deployment claims: taking `node` as the entry would
 *   pass for any node process on the machine, which is the lookalike this verifier exists to refuse.
 */
export function describeCommand(argv, workingDirectory = null) {
  const separator = argv.indexOf('--')
  const server = separator >= 0 ? argv.slice(separator + 1) : argv
  const cli = server.find((argument) => typeof argument === 'string' && argument.endsWith('/dist/cli.js')) ?? null
  const portText = flagValue(server, '--port')
  const port = portText !== null && /^\d+$/.test(portText) ? Number(portText) : null
  const config = flagValue(server, '--config')
  const root = cli !== null ? cli.slice(0, -'/dist/cli.js'.length) : (workingDirectory ?? (config !== null ? dirname(config) : null))
  return {
    argv,
    server,
    supervised: separator >= 0,
    program: argv[0] ?? null,
    cli,
    entry: cli ?? server[0] ?? null,
    root,
    port,
    host: flagValue(server, '--host'),
    config,
  }
}

/**
 * The page file a deployment's server sends. The TypeScript build serves the copy `npm run build` placed in
 * `dist/server/`; the Rust binary serves the repository's `src/server/page.html`, the one page both builds share.
 */
export function builtPagePath(service) {
  return service.cli !== null ? join(service.root, 'dist', 'server', 'page.html') : join(service.root, 'src', 'server', 'page.html')
}

/**
 * The document the server must answer with for a given built page: the file with **one** documented substitution,
 * the `<meta name="heddle-page">` marker replaced by the first twelve hex of the file's own sha256 (`markedPage` in
 * `src/server/web.ts`). The marker is how a stale build is told apart from a missing feature.
 */
export function expectedPage(built) {
  const marker = createHash('sha256').update(built).digest('hex').slice(0, 12)
  return { marker, page: built.replace(/<meta name="heddle-page"[^>]*>/, `<meta name="heddle-page" content="${marker}">`) }
}

/** The file a systemd `StandardOutput=` value appends or writes to, or `null` for a journal, a socket or nothing. */
export function logPathOf(value) {
  if (value === null || value === undefined) return null
  const match = /^(?:append|file|truncate):(.+)$/.exec(value.trim())
  return match === null ? null : match[1]
}

/** The launch token of the most recent start, from a server log, or `null` when none was printed. */
export function lastLaunchToken(logText) {
  const matches = [...logText.matchAll(/[?&]token=([A-Za-z0-9_-]+)/g)]
  return matches.length === 0 ? null : matches[matches.length - 1][1]
}

/** `systemctl show` output (`Key=value` lines) as an object. */
export function parseShow(text) {
  const values = {}
  for (const line of text.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) values[line.slice(0, at)] = line.slice(at + 1).trim()
  }
  return values
}

/** The pid `launchctl print` reports for a running job, or `null`. */
export function pidFromLaunchctl(text) {
  const match = /^\s*pid = (\d+)/m.exec(text)
  return match === null ? null : Number(match[1])
}

/**
 * The pid listening on a TCP port, from `ss -ltnpH` output: the line whose local address ends in `:<port>`, and
 * the first `pid=` in its users column. Matching the port on the local address, not anywhere in the line, keeps
 * `:18082` and a peer column from answering for `:8082`.
 */
export function listenerFromSs(text, port) {
  for (const line of text.split('\n')) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 4) continue
    const local = columns.find((column, index) => index >= 2 && /:\d+$/.test(column))
    if (local === undefined || !local.endsWith(`:${port}`)) continue
    const pid = /pid=(\d+)/.exec(line)
    if (pid !== null) return Number(pid[1])
  }
  return null
}

/** The pid on the first data row of `lsof -nP -iTCP:<port> -sTCP:LISTEN`, or `null`. */
export function listenerFromLsof(text) {
  const pid = (text.split('\n')[1] ?? '').trim().split(/\s+/)[1]
  return pid !== undefined && /^\d+$/.test(pid) ? Number(pid) : null
}

/**
 * Whether a checkout contains only committed main, and why not.
 *
 * Two shapes qualify. **On `main` at its tip** is the deployment clone the convention first described. **Detached
 * exactly at `origin/main`** is a deployment worktree: git checks a branch out in one worktree at a time and the
 * base clone holds `main`, so a deployment beside it is detached — and is then held to the fetched tip, which is a
 * stricter reading of "main" than a local branch that may lag it. Anything else, or any uncommitted change, is a
 * workspace.
 */
export function checkoutVerdict(state) {
  const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 12) : 'none')
  if (state.branch === null || state.head === null || state.dirty === null) return { ok: false, reason: 'the path is not a git checkout' }
  if (state.branch === 'main') {
    if (state.head !== state.mainTip) return { ok: false, reason: `its HEAD ${short(state.head)} is not main's tip ${short(state.mainTip)}` }
  } else if (state.branch === 'HEAD') {
    if (state.originTip === null) return { ok: false, reason: 'it is detached and has no origin/main to be held to' }
    if (state.head !== state.originTip) return { ok: false, reason: `it is detached at ${short(state.head)}, not at origin/main ${short(state.originTip)}` }
  } else {
    return { ok: false, reason: `it is on ${state.branch}, not main` }
  }
  if (state.dirty !== '') return { ok: false, reason: `it has uncommitted changes: ${state.dirty.split('\n').slice(0, 5).join('; ')}` }
  return { ok: true, reason: state.branch === 'main' ? 'on main at its tip, clean' : 'detached at origin/main, clean' }
}

// ---------------------------------------------------------------------------------------------------------------
// Host readers. Each returns `null` when the host cannot answer, so a check can report unjudged rather than fail.

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/** The service `install.sh` installed on this machine, described, or `null` when there is none. */
export function installedService(env = process.env, platform = process.platform) {
  const supervisor = supervisorFor(platform)
  if (supervisor === 'launchd') {
    const path = plistPath(env)
    if (!existsSync(path)) return null
    const json = run('plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', path])
    if (json === null) return null
    let argv
    try {
      argv = JSON.parse(json)
    } catch {
      return null
    }
    const workingDirectory = run('plutil', ['-extract', 'WorkingDirectory', 'raw', '-o', '-', path])?.trim() || null
    const log = run('plutil', ['-extract', 'StandardOutPath', 'raw', '-o', '-', path])?.trim() || null
    return { supervisor, path, log, workingDirectory, ...describeCommand(argv, workingDirectory) }
  }
  if (supervisor === 'systemd') {
    const path = unitPath(env)
    if (!existsSync(path)) return null
    const sections = parseUnit(readFileSync(path, 'utf8'))
    const exec = unitValue(sections, 'Service', 'ExecStart')
    if (exec === null) return null
    const workingDirectory = unitValue(sections, 'Service', 'WorkingDirectory')
    const log = logPathOf(unitValue(sections, 'Service', 'StandardOutput'))
    return { supervisor, path, log, workingDirectory, ...describeCommand(splitCommandLine(exec), workingDirectory) }
  }
  return null
}

/** Whether the supervisor has the service running, and its pid. */
export function serviceState(service) {
  if (service.supervisor === 'launchd') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : ''
    const printed = run('launchctl', ['print', `gui/${uid}/${LABEL}`])
    return { loaded: printed !== null, pid: printed === null ? null : pidFromLaunchctl(printed) }
  }
  const shown = run('systemctl', ['--user', 'show', '-p', 'ActiveState', '-p', 'MainPID', '-p', 'NRestarts', UNIT])
  if (shown === null) return { loaded: false, pid: null }
  const values = parseShow(shown)
  const pid = Number(values.MainPID)
  return { loaded: values.ActiveState === 'active', pid: Number.isInteger(pid) && pid > 0 ? pid : null, restarts: Number(values.NRestarts ?? 0) }
}

/** The pid listening on a loopback TCP port, or `null` when nothing does or the host cannot say. */
export function listenerPid(port, platform = process.platform) {
  if (platform === 'linux') {
    const out = run('ss', ['-ltnpH', 'sport', '=', `:${port}`])
    return out === null ? null : listenerFromSs(out, port)
  }
  const out = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'])
  return out === null ? null : listenerFromLsof(out)
}

/** A process's command line as one string, or `null`. */
export function processCommand(pid, platform = process.platform) {
  if (platform === 'linux') {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((part) => part !== '').join(' ')
    } catch {
      return null
    }
  }
  return run('ps', ['-o', 'command=', '-p', String(pid)])?.trim() ?? null
}

/** The git facts `checkoutVerdict` judges, read from a checkout. */
export function checkoutState(root) {
  const git = (...args) => run('git', ['-C', root, ...args])?.trim() ?? null
  return {
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    head: git('rev-parse', 'HEAD'),
    mainTip: git('rev-parse', '-q', '--verify', 'refs/heads/main'),
    originTip: git('rev-parse', '-q', '--verify', 'refs/remotes/origin/main'),
    dirty: git('status', '--porcelain'),
  }
}
