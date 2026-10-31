import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/**
 * Interactive shell terminals for the page's right sidebar (#85, slice 1: the server half).
 *
 * DSH's `dsh-api-terminal-controller` opens the execution environment's shell in a session's folder. A browser
 * reload reconnects to it and gets the screen back, and closing it ends the process. Terminal output never
 * reaches the agent's transcript. This is the same arrangement over the routes heddle's page already uses: REST
 * for create, input, resize and close, and an event stream for output.
 *
 * Stated differences from DSH, each chosen on purpose:
 * - **Confined like bash.** The shell runs under the session's sandbox mode, with the profile and environment
 *   bash calls get (developer-ten's condition for the server half). DSH runs user terminals with the user's own
 *   permissions, apart from the agent's sandbox. heddle's server is reachable from a browser, so its terminal
 *   gets the same fence as the agent's shell.
 * - **PTY through `script(1)`**: no native module and no `unsafe`. The flags differ by platform (BSD:
 *   `script -q /dev/null <cmd>`; util-linux: `script -qfec <cmd> /dev/null`). Resize runs `stty -f` (BSD) or
 *   `stty -F` (Linux) on the shell's own tty.
 * - **Replay is the raw output tail** (`replayBytes`, DSH's 2 MiB `maxBufferedBytes`), not a screen redrawn by a
 *   headless xterm. A page writes it into a reset emulator.
 * - **Reclaimed when unattended**: a terminal with no stream attached and no input or output for
 *   `unattendedMs` (DSH's two hours) is closed. DSH also watches whether a command is still running. Here,
 *   output counts as activity.
 * - **One default shell**: `$SHELL` when it is an absolute, executable path, else `/bin/sh`. That is DSH's
 *   fallback order without its list of other installed shells.
 */

/** DSH's defaults where it has one (`maxTerminals`, `maxCols`, `maxRows`, `maxBufferedBytes`, `maxInputBytes`, `disposeGraceMs`, `unattendedTimeoutMs`). */
export interface TerminalLimits {
  readonly maxTerminals: number
  readonly maxCols: number
  readonly maxRows: number
  readonly replayBytes: number
  readonly maxInputBytes: number
  readonly disposeGraceMs: number
  readonly unattendedMs: number
}

export const TERMINAL_LIMITS: TerminalLimits = {
  maxTerminals: 8,
  maxCols: 500,
  maxRows: 200,
  replayBytes: 2 * 1024 * 1024,
  maxInputBytes: 65536,
  disposeGraceMs: 1000,
  unattendedMs: 2 * 60 * 60 * 1000,
}

/** What a listing shows for one terminal. Its screen is not included; a stream carries that. */
export interface TerminalInfo {
  readonly id: string
  readonly session: string
  readonly shell: string
  readonly cwd: string
  readonly mode: string
  readonly cols: number
  readonly rows: number
  readonly created: string
  readonly exited: boolean
  readonly exitCode: number | null
}

/** What a stream receives after its snapshot. `seq` is the count of output bytes so far, so it only grows. */
export type TerminalEvent =
  | { readonly type: 'output'; readonly seq: number; readonly data: string }
  | { readonly type: 'exit'; readonly code: number | null }

/** The opening frame of a stream: the retained output tail, and whether older output was dropped. */
export interface TerminalSnapshot {
  readonly seq: number
  readonly data: string
  readonly truncated: boolean
  readonly exited: boolean
  readonly exitCode: number | null
}

/** What one new terminal needs: the session's folder and mode, and a way to wrap the shell under that mode. */
export interface TerminalSpawn {
  readonly session: string
  readonly cwd: string
  readonly mode: string
  readonly cols: number
  readonly rows: number
  /** Wraps an argv under the session's sandbox, as bash's calls are wrapped; throws when it cannot. */
  readonly confine: (argv: readonly string[]) => readonly string[]
  readonly env: NodeJS.ProcessEnv
  /** The shell to start; the default shell when left out. */
  readonly shell?: string
}

export type InputResult = 'ok' | 'missing' | 'exited' | 'too-large' | 'busy'
export type ResizeResult = 'ok' | 'missing' | 'exited' | 'out-of-range' | 'unavailable'

/** The line the wrapper prints on stderr when the PTY ends, with the shell's exit status. */
const EXIT_MARK = 'heddle-terminal-exit:'

/** Input bytes a terminal may have waiting for the PTY before more input is refused as busy. */
const MAX_PENDING_INPUT_BYTES = 1024 * 1024

/** The search path for the helpers this module runs (`ps`, `stty`), so an ambient PATH cannot pick them. */
const HELPER_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }

/** Output smaller than this is appended to the previous replay chunk, so many tiny reads do not cost one string each. */
const SMALL_CHUNK = 4096

/** The shell a new terminal runs: `$SHELL` when it names an executable by absolute path, else `/bin/sh`. */
export function defaultShell(env: NodeJS.ProcessEnv = process.env): string {
  const shell = env.SHELL
  if (typeof shell === 'string' && isAbsolute(shell)) {
    try {
      accessSync(shell, constants.X_OK)
      return shell
    } catch {
      // Fall through to the POSIX shell.
    }
  }
  return '/bin/sh'
}

/** Quote one word for `/bin/sh`. */
function shQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/**
 * The argv a terminal is spawned with, outermost first.
 *
 * Inside out:
 * - The shell starts interactive. A small `sh` sets the PTY's size first, because `script` copies the size of
 *   its own stdin, and here that is a pipe.
 * - That `sh` is wrapped by the session's sandbox (`confine`).
 * - The result runs in a PTY from `script(1)`.
 * - `script` reads from `cat`, because BSD `script` refuses a socket for stdin (`tcgetattr/ioctl: Operation not
 *   supported on socket`) and Node gives a child a socket. When `script` ends, the wrapper reports the exit
 *   status on stderr and ends its own process group, so `cat` does not outlive it.
 */
export function terminalArgv(platform: string, confined: readonly string[]): readonly string[] {
  const pty =
    platform === 'darwin'
      ? ['/usr/bin/script', '-q', '/dev/null', ...confined]
      : ['script', '-qfec', confined.map(shQuote).join(' '), '/dev/null']
  return ['/bin/sh', '-c', `cat | { "$@"; echo "${EXIT_MARK}$?" >&2; kill -TERM 0; }`, 'heddle-terminal', ...pty]
}

/** The shell's own argv before confinement: set the size, then become the interactive shell. */
export function shellArgv(shell: string, cols: number, rows: number): readonly string[] {
  return ['/bin/sh', '-c', 'stty cols "$1" rows "$2" 2>/dev/null; SHELL=$3; export SHELL; exec "$3" -i', 'heddle-terminal-shell', String(cols), String(rows), shell]
}

interface ProcessRow {
  readonly pid: number
  readonly ppid: number
  readonly tty: string
}

/**
 * Every process on the machine, from one `ps -A`.
 *
 * Asynchronous on purpose: a loaded host can take hundreds of milliseconds over `ps -A`, and the tty learner runs it
 * unprompted on every new terminal, so a synchronous call there would stall every request and stream on the server
 * (developer-ten's review of #85). The 5 s timeout still bounds one call; a failed call reads as an empty table.
 */
function processTable(): Promise<readonly ProcessRow[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,tty='], { encoding: 'utf8', timeout: 5000, env: HELPER_ENV }, (error, out) => {
      if (error !== null) {
        resolve([])
        return
      }
      const rows: ProcessRow[] = []
      for (const line of out.split('\n')) {
        const [pid, ppid, tty] = line.trim().split(/\s+/)
        if (pid === undefined || ppid === undefined || pid === '') continue
        rows.push({ pid: Number(pid), ppid: Number(ppid), tty: tty ?? '' })
      }
      resolve(rows)
    })
  })
}

/** Every live descendant of `root` in `table`, nearest first. */
export function descendants(root: number, table: readonly ProcessRow[]): readonly ProcessRow[] {
  const found: ProcessRow[] = []
  let frontier = [root]
  while (frontier.length > 0) {
    const next: number[] = []
    for (const row of table) {
      if (frontier.includes(row.ppid) && row.pid !== root && !found.some((seen) => seen.pid === row.pid)) {
        found.push(row)
        next.push(row.pid)
      }
    }
    frontier = next
  }
  return found
}

/** Whether a `ps` tty column names a real terminal. */
function hasTty(row: ProcessRow): boolean {
  return row.tty !== '' && !row.tty.startsWith('?') && row.tty !== '-'
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name)
  } catch {
    // Already gone.
  }
}

/** One shell in one PTY, owned by one session. */
class Terminal {
  readonly id = `terminal-${randomUUID()}`
  readonly created = new Date().toISOString()
  readonly listeners = new Set<(event: TerminalEvent) => void>()
  cols: number
  rows: number
  exited = false
  exitCode: number | null = null
  lastActivity = Date.now()
  private chunks: string[] = []
  private held = 0
  private seq = 0
  private truncated = false
  private tty: string | undefined
  private stderrLine = ''
  private readonly done: Promise<void>
  private closing: Promise<void> | undefined

  readonly session: string
  readonly shell: string
  readonly cwd: string
  readonly mode: string
  private readonly child: ChildProcess
  private readonly limits: TerminalLimits
  private readonly platform: string

  constructor(
    owner: { readonly session: string; readonly shell: string; readonly cwd: string; readonly mode: string; readonly cols: number; readonly rows: number },
    child: ChildProcess,
    limits: TerminalLimits,
    platform: string,
  ) {
    this.session = owner.session
    this.shell = owner.shell
    this.cwd = owner.cwd
    this.mode = owner.mode
    this.cols = owner.cols
    this.rows = owner.rows
    this.child = child
    this.limits = limits
    this.platform = platform
    const out = new StringDecoder('utf8')
    const err = new StringDecoder('utf8')
    child.stdout?.on('data', (chunk: Buffer) => this.push(out.write(chunk)))
    child.stderr?.on('data', (chunk: Buffer) => this.stderr(err.write(chunk)))
    child.stdin?.on('error', () => {
      // The PTY ended while input was in flight; the exit event reports it.
    })
    // The tty is learned while the PTY is surely this terminal's, so a close can sweep jobs that left the tree. It
    // is retried a few times, because a loaded host can take a while to start the shell.
    // Each try waits for the previous one, so a slow `ps` never stacks a second behind it.
    const learn = (tries: number): void => {
      const timer = setTimeout(() => {
        void this.learnTty().then((tty) => {
          if (!this.exited && tty === undefined && tries < 6) learn(tries + 1)
        })
      }, 500)
      timer.unref()
    }
    learn(1)
    this.done = new Promise((resolve) => {
      child.on('error', (error) => {
        this.push(`${error.message}\r\n`)
        this.finish(null)
        resolve()
      })
      child.on('close', () => {
        this.push(out.end())
        this.stderr(err.end())
        if (this.stderrLine.length > 0) this.push(this.stderrLine)
        this.stderrLine = ''
        this.finish(this.exitCode)
        resolve()
      })
    })
  }

  info(): TerminalInfo {
    return {
      id: this.id,
      session: this.session,
      shell: this.shell,
      cwd: this.cwd,
      mode: this.mode,
      cols: this.cols,
      rows: this.rows,
      created: this.created,
      exited: this.exited,
      exitCode: this.exitCode,
    }
  }

  snapshot(): TerminalSnapshot {
    return { seq: this.seq, data: this.chunks.join(''), truncated: this.truncated, exited: this.exited, exitCode: this.exitCode }
  }

  input(data: string): InputResult {
    if (Buffer.byteLength(data, 'utf8') > this.limits.maxInputBytes) return 'too-large'
    if (this.exited || this.child.stdin === null || this.child.stdin.destroyed) return 'exited'
    if (this.child.stdin.writableLength > MAX_PENDING_INPUT_BYTES) return 'busy'
    this.lastActivity = Date.now()
    this.child.stdin.write(data)
    return 'ok'
  }

  async resize(cols: number, rows: number): Promise<ResizeResult> {
    if (this.exited) return 'exited'
    const tty = await this.learnTty()
    if (tty === undefined) return 'unavailable'
    const flag = this.platform === 'darwin' ? '-f' : '-F'
    const ok = await new Promise<boolean>((resolve) => {
      execFile('stty', [flag, tty, 'cols', String(cols), 'rows', String(rows)], { timeout: 5000, env: HELPER_ENV }, (error) => resolve(error === null))
    })
    if (!ok) return 'unavailable'
    this.cols = cols
    this.rows = rows
    this.lastActivity = Date.now()
    return 'ok'
  }

  /** Close the terminal and everything it started; resolves once the process has ended and its output is drained. */
  close(): Promise<void> {
    this.closing ??= this.terminate()
    return this.closing
  }

  /**
   * End the PTY's processes, softly and then for good.
   *
   * The descendants are collected first, while the tree is whole. The shell leads its own session inside the
   * PTY, so the wrapper's process group alone would miss it and its jobs. Each one gets SIGHUP, as closing a
   * terminal window sends, and SIGTERM. Whatever is still alive after the grace period (DSH's `disposeGraceMs`)
   * gets SIGKILL, along with the wrapper's group and the shell's group.
   */
  private async terminate(): Promise<void> {
    const leader = this.child.pid
    // A terminal that ended on its own is not swept: once its PTY is gone the tty name can be reused by another
    // terminal, and DSH, too, leaves a shell's nohup jobs running after the shell exits by itself.
    if (leader === undefined || this.exited) return this.done
    const tty = await this.learnTty()
    const table = await processTable()
    // The tree, plus every process on this terminal's tty: a job started as `(cmd &)` or `nohup cmd &` leaves the
    // tree for init but keeps the tty while the PTY is still this terminal's.
    const tree = [...descendants(leader, table)]
    if (tty !== undefined) {
      for (const row of table) if (`/dev/${row.tty}` === tty && row.pid !== process.pid && !tree.some((seen) => seen.pid === row.pid)) tree.push(row)
    }
    const groups = [leader, ...tree.filter(hasTty).map((row) => row.pid)]
    for (const row of tree) {
      signal(row.pid, 'SIGHUP')
      signal(row.pid, 'SIGTERM')
    }
    signal(-leader, 'SIGTERM')
    const graceful = await Promise.race([this.done.then(() => true), delay(this.limits.disposeGraceMs).then(() => false)])
    const left = descendants(leader, await processTable())
    if (!graceful || left.length > 0 || tree.some((row) => alive(row.pid))) {
      for (const row of [...tree, ...left]) signal(row.pid, 'SIGKILL')
      for (const group of groups) signal(-group, 'SIGKILL')
    }
    await Promise.race([this.done, delay(this.limits.disposeGraceMs * 2)])
  }

  /** The PTY's device, learned once from the first descendant that has a tty. */
  private async learnTty(): Promise<string | undefined> {
    if (this.tty !== undefined) return this.tty
    const leader = this.child.pid
    if (leader === undefined) return undefined
    const row = descendants(leader, await processTable()).find(hasTty)
    if (row === undefined) return undefined
    this.tty ??= `/dev/${row.tty}`
    return this.tty
  }

  private stderr(text: string): void {
    if (text.length === 0) return
    this.stderrLine += text
    let newline = this.stderrLine.indexOf('\n')
    while (newline >= 0) {
      const line = this.stderrLine.slice(0, newline)
      this.stderrLine = this.stderrLine.slice(newline + 1)
      if (line.startsWith(EXIT_MARK)) {
        const code = Number(line.slice(EXIT_MARK.length))
        this.exitCode = Number.isInteger(code) ? code : null
      } else {
        this.push(`${line}\r\n`)
      }
      newline = this.stderrLine.indexOf('\n')
    }
  }

  private push(text: string): void {
    if (text.length === 0) return
    const bytes = Buffer.byteLength(text, 'utf8')
    this.seq += bytes
    this.lastActivity = Date.now()
    const last = this.chunks.length - 1
    if (last >= 0 && (this.chunks[last] as string).length < SMALL_CHUNK) this.chunks[last] = `${this.chunks[last] as string}${text}`
    else this.chunks.push(text)
    this.held += bytes
    while (this.held > this.limits.replayBytes && this.chunks.length > 1) {
      this.held -= Buffer.byteLength(this.chunks.shift() as string, 'utf8')
      this.truncated = true
    }
    if (this.held > this.limits.replayBytes) {
      const only = Buffer.from(this.chunks[0] as string, 'utf8')
      let start = only.length - this.limits.replayBytes
      // Never start inside a character: skip UTF-8 continuation bytes.
      while (start < only.length && ((only[start] as number) & 0xc0) === 0x80) start += 1
      const kept = only.subarray(start).toString('utf8')
      this.chunks = [kept]
      this.held = Buffer.byteLength(kept, 'utf8')
      this.truncated = true
    }
    for (const listener of this.listeners) listener({ type: 'output', seq: this.seq, data: text })
  }

  private finish(code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.exitCode = code
    this.lastActivity = Date.now()
    for (const listener of this.listeners) listener({ type: 'exit', code })
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref())
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Every session's terminals, with the limits and the clean-up paths: close, archive, idle and shutdown. */
export class TerminalRegistry {
  readonly limits: TerminalLimits
  private readonly platform: string
  private readonly sessions = new Map<string, Map<string, Terminal>>()
  private readonly timer: NodeJS.Timeout
  /** Set by `closeAll`: a server that is stopping starts no terminal, so none outlives the shutdown. */
  private closed = false

  constructor(options: { readonly limits?: Partial<TerminalLimits>; readonly platform?: string; readonly pollMs?: number } = {}) {
    this.limits = { ...TERMINAL_LIMITS, ...options.limits }
    this.platform = options.platform ?? process.platform
    this.timer = setInterval(() => void this.reclaim(), options.pollMs ?? 30_000)
    this.timer.unref()
  }

  list(session: string): readonly TerminalInfo[] {
    return [...(this.sessions.get(session)?.values() ?? [])].map((terminal) => terminal.info())
  }

  /**
   * Start a terminal. Answers `limit` when the session already holds `maxTerminals` (exited ones count, as in DSH),
   * and `closed` once the server is stopping.
   */
  create(spec: TerminalSpawn): TerminalInfo | 'limit' | 'closed' {
    if (this.closed) return 'closed'
    const owned = this.sessions.get(spec.session) ?? new Map<string, Terminal>()
    if (owned.size >= this.limits.maxTerminals) return 'limit'
    const shell = spec.shell ?? defaultShell(spec.env)
    const argv = terminalArgv(this.platform, spec.confine(shellArgv(shell, spec.cols, spec.rows)))
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: spec.cwd,
      // SHELL=/bin/sh for util-linux script, which runs its command through $SHELL -c; the shell's own wrapper
      // exports the real shell again.
      env: { ...spec.env, TERM: 'xterm-256color', SHELL: '/bin/sh' },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const terminal = new Terminal({ session: spec.session, shell, cwd: spec.cwd, mode: spec.mode, cols: spec.cols, rows: spec.rows }, child, this.limits, this.platform)
    owned.set(terminal.id, terminal)
    this.sessions.set(spec.session, owned)
    return terminal.info()
  }

  /** One session's terminal, and never another session's. */
  private get(session: string, id: string): Terminal | undefined {
    return this.sessions.get(session)?.get(id)
  }

  input(session: string, id: string, data: string): InputResult {
    return this.get(session, id)?.input(data) ?? 'missing'
  }

  async resize(session: string, id: string, cols: number, rows: number): Promise<ResizeResult> {
    const terminal = this.get(session, id)
    if (terminal === undefined) return 'missing'
    if (!this.fits(cols, rows)) return 'out-of-range'
    return terminal.resize(cols, rows)
  }

  /** Whether a size is one a PTY may take here. */
  fits(cols: number, rows: number): boolean {
    return Number.isInteger(cols) && Number.isInteger(rows) && cols >= 1 && rows >= 1 && cols <= this.limits.maxCols && rows <= this.limits.maxRows
  }

  /** Attach a listener: answers the snapshot to draw first, and the detach. */
  attach(session: string, id: string, listener: (event: TerminalEvent) => void): { readonly snapshot: TerminalSnapshot; readonly detach: () => void } | undefined {
    const terminal = this.get(session, id)
    if (terminal === undefined) return undefined
    terminal.listeners.add(listener)
    terminal.lastActivity = Date.now()
    return {
      snapshot: terminal.snapshot(),
      detach: () => {
        terminal.listeners.delete(listener)
        terminal.lastActivity = Date.now()
      },
    }
  }

  /** Close one terminal and wait for its processes to end. */
  async close(session: string, id: string): Promise<boolean> {
    const owned = this.sessions.get(session)
    const terminal = owned?.get(id)
    if (owned === undefined || terminal === undefined) return false
    await terminal.close()
    owned.delete(id)
    if (owned.size === 0) this.sessions.delete(session)
    return true
  }

  /** Close every terminal a session holds: archiving a session ends its terminals, as DSH's owner disposal does. */
  async closeSession(session: string): Promise<number> {
    const ids = [...(this.sessions.get(session)?.keys() ?? [])]
    await Promise.all(ids.map((id) => this.close(session, id)))
    return ids.length
  }

  /** Close everything, for server shutdown, so a restart leaves no orphan shells. */
  async closeAll(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    await Promise.all([...this.sessions.keys()].map((session) => this.closeSession(session)))
  }

  /** Close terminals nobody is watching that have been quiet for `unattendedMs`. */
  async reclaim(now: number = Date.now()): Promise<number> {
    const due: Array<[string, string]> = []
    for (const [session, owned] of this.sessions) {
      for (const [id, terminal] of owned) {
        if (terminal.listeners.size === 0 && now - terminal.lastActivity >= this.limits.unattendedMs) due.push([session, id])
      }
    }
    await Promise.all(due.map(([session, id]) => this.close(session, id)))
    return due.length
  }
}
