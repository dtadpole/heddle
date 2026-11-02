import { execFileSync } from 'node:child_process'
import { futimesSync, readFileSync } from 'node:fs'

/**
 * The session writer lock's protocol: what `<id>.lock` says, and when the lock it is belongs to nobody (#202).
 *
 * Both builds speak it, byte for byte; `rust/crates/heddle-session/src/writer_lock.rs` is the same protocol, and
 * `test/session-lock.fixtures.json` holds lock files both test suites read. The file is one line:
 *
 *     <pid> boot=<boot id> start=<start>\n
 *
 * - `pid` is the holder's process id, in decimal. A file that is a pid and nothing else is the **pid-only** form every
 *   build before #202 wrote, and still the form written where the holder's start cannot be read.
 * - `boot` is the boot the lock was written in: `/proc/sys/kernel/random/boot_id` on Linux, `kern.bootsessionuuid` on
 *   macOS. Both are a random id the kernel draws once per boot, so a lock from an earlier boot never matches, and no
 *   clock correction moves them. (`kern.boottime` was the other candidate; the kernel adjusts it when the clock is
 *   set, so a live holder's lock could have looked a boot old.)
 * - `start` is the holder's start as the kernel keeps it: on Linux field 22 of `/proc/<pid>/stat`, clock ticks after
 *   boot; on macOS the start second, UTC, as `ps -o lstart` prints it (`LC_ALL=C TZ=UTC0`), written as seconds since
 *   1970. Either build reads the same source on the same system, so the two values compare exactly, and a pid the
 *   system has given to another process names a process with another start.
 *
 * A boot that cannot be read is left out (a start that cannot be read makes the line pid-only), and a reader ignores
 * a part it does not know.
 *
 * DSH has none of this to do: it takes a kernel `flock(2)` on `session.lock` (dsh-session-persistence-jsonl
 * lib/index.js:692-716, `tryLockExclusive` from node-addon-system's flock.c:58), which the kernel drops when the
 * holder dies. Node cannot take a flock without a native addon, so a lock that outlives its holder is told apart by
 * hand, by {@link judgeLock}.
 */

/** What a lock file says: the holder's pid and, since #202, which process that pid named. */
export interface LockContent {
  readonly pid: number
  /** The boot the lock was written in; absent in a pid-only lock. */
  readonly boot?: string
  /** The holder's start, in this system's terms (see the module comment); absent in a pid-only lock. */
  readonly start?: string
}

/** The whitespace a lock line is split on: ASCII only, which is what Rust's `split_ascii_whitespace` splits on. */
const SEPARATORS = /[\t\n\f\r ]+/

/** A token `boot` or `start` may hold: printable ASCII with no `=`, so the line splits back the way it was written. */
const TOKEN = /^[!-<>-~]+$/

/** The largest pid either build reads; the Rust build holds one in a `u32`. */
const MAX_PID = 0xffff_ffff

/** Read a lock file's text; undefined when it names no process (empty, half-written, or not a lock). */
export function parseLock(text: string): LockContent | undefined {
  const tokens = text.split(SEPARATORS).filter((token) => token.length > 0)
  const first = tokens[0]
  if (first === undefined || !/^\d+$/.test(first)) return undefined
  const pid = Number(first)
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_PID) return undefined
  let boot: string | undefined
  let start: string | undefined
  for (const token of tokens.slice(1)) {
    const at = token.indexOf('=')
    if (at <= 0) continue
    const key = token.slice(0, at)
    const value = token.slice(at + 1)
    if (!TOKEN.test(value)) continue
    if (key === 'boot' && boot === undefined) boot = value
    else if (key === 'start' && start === undefined) start = value
  }
  return { pid, ...(boot !== undefined ? { boot } : {}), ...(start !== undefined ? { start } : {}) }
}

/** The bytes of a lock file: `<pid>[ boot=<boot>][ start=<start>]\n`, the pid-only form when neither part is known. */
export function formatLock(content: LockContent): string {
  const boot = content.boot !== undefined && TOKEN.test(content.boot) ? ` boot=${content.boot}` : ''
  const start = content.start !== undefined && TOKEN.test(content.start) ? ` start=${content.start}` : ''
  return `${content.pid}${boot}${start}\n`
}

/** Whether a lock carries any identity, rather than being the pid-only form. */
export function hasIdentity(content: LockContent): boolean {
  return content.boot !== undefined || content.start !== undefined
}

/**
 * The modification time a lock with identity is given: 2037-12-31T00:00:00Z, seconds since 1970.
 *
 * A build from before #202 reads a pid out of a lock only when the file is digits and nothing else; any other lock it
 * takes for one still being written while it is younger than five seconds, and removes as debris after that (store.ts
 * and store.rs before #202). So it would have removed a live holder's lock five seconds after it was written. A time
 * in the future reads as young to both (`Date.now() - mtimeMs < 5000`; Rust's `elapsed()` fails and was mapped to
 * young on purpose), so such a build refuses the session rather than taking it. A reader of this protocol never asks
 * a lock with identity for its age. The date is below 2038-01-19, the last second a 32-bit file time holds.
 */
export const IDENTIFIED_LOCK_MTIME_S = 2_145_830_400

/** What the system says about a live process. A field this system cannot read is absent. */
export interface ProcessFacts {
  /** Its start in this system's terms: the value a lock records (see the module comment). */
  readonly start?: string
  /** When it started, in seconds since 1970, for the pid-only rule. */
  readonly startedAt?: number
  /** The user it runs as (effective uid). */
  readonly uid?: number
  /** Its command name, for a person: `ucomm` on macOS, `/proc/<pid>/comm` on Linux. */
  readonly name?: string
}

/** How {@link judgeLock} asks the system; tests hand it a made-up one. */
export interface LockProbe {
  /** The facts of the process with this pid, or null when no process has it. */
  facts(pid: number): ProcessFacts | null
  /** This boot's id, when this system says one. */
  boot(): string | undefined
}

/** A lock file as a reader found it: its text, its modification time and the user who owns it. */
export interface LockFile {
  readonly text: string
  readonly mtimeMs: number
  readonly uid?: number
}

/** Whether the lock still belongs to a live process, which is then named; or it belongs to nobody, and why. */
export type LockVerdict =
  | { readonly kind: 'held'; readonly pid?: number; readonly name?: string }
  | { readonly kind: 'stale'; readonly reason: string }

/** How long a lock file with no pid in it is taken to be one being written, rather than one left half-written. */
export const UNWRITTEN_LOCK_GRACE_MS = 5_000

/**
 * How much later than a pid-only lock's modification time its pid's process must have started for the lock to be
 * another process's: a few seconds, so a clock corrected by a second or two never makes a live holder look younger
 * than its own lock. A pid comes round again minutes after its holder died at the soonest, and after a reboot later
 * than that.
 */
export const PID_ONLY_START_MARGIN_S = 5

/**
 * Judge a lock that names another process than the reader: is its holder alive, or is the lock stale?
 *
 * A lock is **stale** when its pid names no process; when it was written in another boot; when its pid names a
 * process that started at another time than the lock records; or, for a pid-only lock, which records no start, when
 * its pid names a process that started after the lock was written. It is stale too when its pid's process runs as
 * another user than the one who owns the file: the file belongs to the user whose process created it. That is the
 * case of a pid that now names a process this user may not signal (`EPERM`, pid 1): such a process exists, so it is
 * judged by these rules rather than taken to be the holder for as long as it lives. A lock that names no pid is being
 * written while it is younger than {@link UNWRITTEN_LOCK_GRACE_MS}, and debris after that.
 *
 * Anything else is **held**: a fact that cannot be read never makes a lock stale, so a live writer is never
 * expropriated on a guess, and there is no expiry.
 */
export function judgeLock(file: LockFile, probe: LockProbe = systemProbe, now: number = Date.now()): LockVerdict {
  const content = parseLock(file.text)
  if (content === undefined) {
    return now - file.mtimeMs < UNWRITTEN_LOCK_GRACE_MS ? { kind: 'held' } : { kind: 'stale', reason: 'it names no process' }
  }
  const { pid } = content
  const boot = content.boot !== undefined ? probe.boot() : undefined
  if (content.boot !== undefined && boot !== undefined && content.boot !== boot) {
    return { kind: 'stale', reason: `it was written in another boot (${content.boot}, now ${boot})` }
  }
  const facts = probe.facts(pid)
  if (facts === null) return { kind: 'stale', reason: `process ${pid} is gone` }
  if (content.start !== undefined) {
    if (facts.start !== undefined && facts.start !== content.start) {
      return { kind: 'stale', reason: `process ${pid} started at ${facts.start}, not at ${content.start} as the lock records` }
    }
  } else if (facts.startedAt !== undefined && facts.startedAt > file.mtimeMs / 1000 + PID_ONLY_START_MARGIN_S) {
    return { kind: 'stale', reason: `process ${pid} started after the lock was written` }
  }
  if (facts.uid !== undefined && file.uid !== undefined && facts.uid !== file.uid) {
    return { kind: 'stale', reason: `process ${pid} runs as user ${facts.uid}, and the lock is user ${file.uid}'s` }
  }
  return { kind: 'held', pid, ...(facts.name !== undefined ? { name: facts.name } : {}) }
}

/**
 * The refusal of a write to a session another process holds, in the same words in both builds.
 *
 * It opens with DSH's `SessionAlreadyOwnedError` sentence, then names the process (its pid, and its command name when
 * the system says it) and the lock file, and says how to clear the lock when that process is not heddle. The lock is
 * named by its file name and where it is, never by its absolute path: the sentence reaches HTTP answers, and an
 * absolute path would put the store root, home directory included, into them (#130).
 */
export function ownedSentence(id: string, pid?: number, name?: string, lock?: string): string {
  const process = pid !== undefined ? ` (process ${pid}${name !== undefined ? `, ${name}` : ''})` : ''
  const owned = `session "${id}" is already owned by an active write handle${process}`
  if (lock === undefined) return owned
  const who = pid !== undefined ? `if process ${pid} is not heddle` : 'if no heddle is writing this session'
  return `${owned}. Its lock file is ${lock}, beside the session's log; ${who}, delete that file and try again.`
}

// ---------------------------------------------------------------------------------------------------------------------
// The system's answers

/** Whether a process with this pid exists: one this user may not signal (`EPERM`) exists. */
function signalAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * One line of `ps -o uid=,lstart=,ucomm=` under `LC_ALL=C TZ=UTC0`: `  501 Sun Nov  1 19:53:07 2026  sleep`.
 * Exported for the tests; undefined fields are the ones the line did not hold.
 */
export function parsePsLine(line: string): ProcessFacts {
  const tokens = line.trim().split(/\s+/)
  const [uidText, , monthText, dayText, timeText, yearText, ...nameTokens] = tokens
  const uid = uidText !== undefined && /^\d+$/.test(uidText) ? Number(uidText) : undefined
  const month = monthText !== undefined ? MONTHS.indexOf(monthText) : -1
  const clock = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(timeText ?? '')
  let startedAt: number | undefined
  if (month >= 0 && clock !== null && /^\d{1,2}$/.test(dayText ?? '') && /^\d{4}$/.test(yearText ?? '')) {
    const ms = Date.UTC(Number(yearText), month, Number(dayText), Number(clock[1]), Number(clock[2]), Number(clock[3]))
    if (Number.isFinite(ms)) startedAt = ms / 1000
  }
  const name = nameTokens.join(' ')
  return {
    ...(startedAt !== undefined ? { start: String(startedAt), startedAt } : {}),
    ...(uid !== undefined ? { uid } : {}),
    ...(name.length > 0 ? { name } : {}),
  }
}

/** A process's facts on macOS, from `ps`; null when `ps` finds no such process. */
function darwinFacts(pid: number): ProcessFacts | null {
  let out: string
  try {
    out = execFileSync('/bin/ps', ['-o', 'uid=,lstart=,ucomm=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { LC_ALL: 'C', TZ: 'UTC0' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    })
  } catch (error) {
    /** `ps` exits 1 with nothing printed when no process has the pid; any other failure says nothing. */
    const failed = error as { status?: number | null; stdout?: string }
    return failed.status === 1 && String(failed.stdout ?? '').trim() === '' ? null : {}
  }
  return out.trim() === '' ? null : parsePsLine(out)
}

/** The boot time Linux reports in `/proc/stat`, in seconds since 1970. */
function linuxBootTime(): number | undefined {
  try {
    const match = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))
    return match?.[1] !== undefined ? Number(match[1]) : undefined
  } catch {
    return undefined
  }
}

/**
 * Clock ticks per second in `/proc/<pid>/stat`: `USER_HZ`, which is 100 on every architecture Linux runs on today.
 * Neither build can ask `sysconf(_SC_CLK_TCK)` (Node has no binding, and the Rust crates forbid `unsafe`); the value
 * is used only to date a pid-only lock's process, never to compare two starts.
 */
const LINUX_TICKS_PER_SECOND = 100

/**
 * One `/proc/<pid>/stat` line's start (field 22) and command name. Exported for the tests. The name is in brackets
 * and may hold spaces and brackets itself, so the fields are counted from the last `)`.
 */
export function parseProcStat(text: string): { readonly start?: string; readonly name?: string } {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) return {}
  const name = text.slice(open + 1, close)
  const fields = text.slice(close + 1).trim().split(/\s+/)
  const start = fields[19]
  return { ...(start !== undefined && /^\d+$/.test(start) ? { start } : {}), ...(name.length > 0 ? { name } : {}) }
}

/** A process's facts on Linux, from `/proc`; null when there is no `/proc/<pid>`. */
function linuxFacts(pid: number): ProcessFacts | null {
  let stat: string
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ESRCH' ? null : {}
  }
  const { start, name } = parseProcStat(stat)
  let uid: number | undefined
  try {
    const match = /^Uid:\s+\d+\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
    if (match?.[1] !== undefined) uid = Number(match[1])
  } catch {
    // a process that ended between the two reads: its start already says who it was
  }
  const btime = start !== undefined ? linuxBootTime() : undefined
  const startedAt = start !== undefined && btime !== undefined ? btime + Number(start) / LINUX_TICKS_PER_SECOND : undefined
  return {
    ...(start !== undefined ? { start } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(uid !== undefined ? { uid } : {}),
    ...(name !== undefined ? { name } : {}),
  }
}

/** The facts of a live process on this system; null when no process has the pid. */
export function processFacts(pid: number): ProcessFacts | null {
  if (!signalAlive(pid)) return null
  if (process.platform === 'linux') return linuxFacts(pid)
  if (process.platform === 'darwin') return darwinFacts(pid)
  return {}
}

/** This boot's id: Linux's `boot_id`, macOS's `kern.bootsessionuuid`; undefined where the system has neither. */
function readBoot(): string | undefined {
  try {
    const text =
      process.platform === 'linux'
        ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')
        : process.platform === 'darwin'
          ? execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
              encoding: 'utf8',
              env: { LC_ALL: 'C' },
              stdio: ['ignore', 'pipe', 'ignore'],
              timeout: 5_000,
            })
          : ''
    const boot = text.trim()
    return /^[0-9A-Za-z-]+$/.test(boot) ? boot : undefined
  } catch {
    return undefined
  }
}

let bootRead = false
let bootValue: string | undefined

/** This boot's id, read once per process: it cannot change while the process runs. */
export function currentBoot(): string | undefined {
  if (!bootRead) {
    bootValue = readBoot()
    bootRead = true
  }
  return bootValue
}

/** The system as {@link judgeLock} asks it by default. */
export const systemProbe: LockProbe = { facts: processFacts, boot: currentBoot }

let ownLockValue: LockContent | undefined

/**
 * The lock this process writes: its pid, this boot, and its own start, read once per process.
 *
 * Without its start (the system would not say it) the lock is the pid-only form: a build from before #202 reads that
 * one, and it keeps the time it was written, which is what the pid-only rule dates a reused pid by. The start is
 * asked again at the next lock rather than given up on.
 */
export function ownLock(): LockContent {
  if (ownLockValue !== undefined && ownLockValue.pid === process.pid) return ownLockValue
  const start = processFacts(process.pid)?.start
  if (start === undefined) return { pid: process.pid }
  const boot = currentBoot()
  ownLockValue = { pid: process.pid, ...(boot !== undefined ? { boot } : {}), start }
  return ownLockValue
}

/**
 * Whether a lock file's text names this process: its pid, and, where both the line and this process say them, its start
 * and its boot (`names_this_process` in the Rust build). Letting go removes a lock only then, so a lock another process
 * wrote is never removed, whatever happened to this one's (#248).
 */
export function namesThisProcess(text: string): boolean {
  const lock = parseLock(text)
  if (lock === undefined) return false
  const own = ownLock()
  const agrees = (written: string | undefined, mine: string | undefined) => written === undefined || mine === undefined || written === mine
  return lock.pid === own.pid && agrees(lock.start, own.start) && agrees(lock.boot, own.boot)
}

/**
 * Give a lock just written with identity its modification time, {@link IDENTIFIED_LOCK_MTIME_S}; a pid-only lock keeps
 * the time it was written, which is what the pid-only rule reads.
 */
export function stampLock(fd: number, content: LockContent): void {
  if (!hasIdentity(content)) return
  try {
    futimesSync(fd, IDENTIFIED_LOCK_MTIME_S, IDENTIFIED_LOCK_MTIME_S)
  } catch {
    // A file system that refuses the time still holds the lock; only a build from before #202 reads it differently.
  }
}
