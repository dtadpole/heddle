import { closeSync, fstatSync, fsyncSync, ftruncateSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Appending to a session's log **whole or not at all** (#221).
 *
 * A log is a run of zstd frames, one per event, and the reader walks them and stops at the first one that is not
 * whole. An append that failed part-way — a full disk (ENOSPC) takes what fits and refuses the rest — left its partial
 * frame in the file, and the process went on: the next append, once the disk had room again, landed **after** it. The
 * open-time repair, right for a crash-torn tail (J155), then cut the file at the tear and dropped every later turn,
 * including the ones answered after the space came back (J183, measured on both builds).
 *
 * So an append records the file's length first, and when a write fails it cuts the file back to that length before it
 * reports the failure: the log ends in whole frames again, and the next append lands right after them. DSH does the
 * same (dsh-session-persistence-jsonl lib/index.js:3299-3335: `appendLines` takes the size before it writes and
 * `rollbackAppend` truncates back to it, then the error is rethrown). Neither build fsyncs an append, so the write is
 * the only step that can fail after bytes reached the file. The bytes are a whole frame — or, for a seed or the turn
 * closers, a whole batch of frames — encoded in memory first, so the rollback covers all of them.
 *
 * When even the cut fails, the file ends in bytes no reader can use, and an append after them would be lost on the next
 * open. The failure is then marked **poisoned**: the store refuses every later append of that session with the same
 * error until the session is opened again, and that open re-reads the file and cuts the torn tail as J155 always has.
 *
 * The failure reaches a person in words: `the session could not be saved: no space left on device`, the sentence the
 * turn's error frame and its verdict carry. DSH has the same outcome for its compaction ("Compaction finished, but the
 * session could not be saved.", dsh-command-compact lib/index.js:40-43), and its checkpoint policy fails a step closed
 * when the session cannot be flushed (dsh-session-checkpoint-policy lib/index.js:26-31, :66-75).
 */

/** The file calls one append makes, so a test can fail any of them. */
export interface AppendIo {
  /** Open for appending, creating the file. */
  open(path: string): number
  /** The file's length now. */
  size(fd: number): number
  /** Write part of `bytes`; answers how many were taken. */
  write(fd: number, bytes: Uint8Array, offset: number, length: number): number
  truncate(fd: number, length: number): void
  close(fd: number): void
}

/** The real file system. */
export const NODE_APPEND_IO: AppendIo = {
  open: (path) => openSync(path, 'a'),
  size: (fd) => fstatSync(fd).size,
  write: (fd, bytes, offset, length) => writeSync(fd, bytes, offset, length),
  truncate: (fd, length) => ftruncateSync(fd, length),
  close: (fd) => closeSync(fd),
}

/**
 * The words for a failed save, by error code; the Rust build's `append::unsaved_reason` answers the same words for the
 * same codes. ENOSPC is the one J183 met.
 */
const REASONS: Readonly<Record<string, string>> = {
  ENOSPC: 'no space left on device',
  EDQUOT: 'disk quota exceeded',
  EROFS: 'read-only file system',
  EACCES: 'permission denied',
  EPERM: 'operation not permitted',
  EIO: 'input/output error',
  EFBIG: 'file too large',
  ENOENT: 'no such file or directory',
}

/** What a write that took no bytes is called, in both builds. */
export const NOTHING_WRITTEN = 'nothing was written'

/**
 * Why a save failed, in words: the table above for a known code, else the description in Node's message
 * (`EXDEV: cross-device link not permitted, rename` → `cross-device link not permitted`), else the message itself.
 * Never a path: the sentence reaches the page, and a path would put the store's location, home directory included,
 * into a turn's error frame (#130).
 */
export function unsavedReason(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code
  if (typeof code === 'string' && REASONS[code] !== undefined) return REASONS[code]
  const message = error instanceof Error ? error.message : String(error)
  const described = /^[A-Z][A-Z0-9_]*: ([^,]+)/.exec(message)?.[1]
  const words = (described ?? message).trim()
  return words.length > 0 ? words : 'an unknown error'
}

/**
 * An append that did not reach the session's log: `the session could not be saved: <reason>`.
 *
 * `poisoned` says the partial bytes could not be cut away either, so the store refuses the session's later appends with
 * this same error until the session is opened again.
 *
 * It carries no `code`, on purpose: the agent loop offers an error with a string `code` to the provider-failure recovery
 * (`modelFailure` in `../agent/loop.ts`), which would record a `compaction/recovery` decision for a disk that is full.
 * Without one, a save that fails mid-stream ends the turn at once, with this sentence.
 */
export class SessionUnsavedError extends Error {
  readonly reason: string
  readonly poisoned: boolean

  constructor(reason: string, options: { readonly cause?: unknown; readonly poisoned?: boolean } = {}) {
    super(`the session could not be saved: ${reason}`, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'SessionUnsavedError'
    this.reason = reason
    this.poisoned = options.poisoned === true
  }
}

/**
 * Append `bytes` to the file at `path` whole, or leave the file as it was and throw {@link SessionUnsavedError}.
 *
 * The length is read after the open and before the first write; a write that throws, or takes no bytes, is followed by a
 * truncate back to that length. A truncate that fails too throws a **poisoned** error naming the write's reason.
 */
export function appendWhole(path: string, bytes: Uint8Array, io: AppendIo = NODE_APPEND_IO): void {
  let fd: number
  try {
    fd = io.open(path)
  } catch (error) {
    throw new SessionUnsavedError(unsavedReason(error), { cause: error })
  }
  try {
    let before: number
    try {
      before = io.size(fd)
    } catch (error) {
      throw new SessionUnsavedError(unsavedReason(error), { cause: error })
    }
    try {
      for (let offset = 0; offset < bytes.length; ) {
        const taken = io.write(fd, bytes, offset, bytes.length - offset)
        if (!(taken > 0)) throw new Error(NOTHING_WRITTEN)
        offset += taken
      }
    } catch (error) {
      const reason = unsavedReason(error)
      try {
        io.truncate(fd, before)
      } catch (rollback) {
        throw new SessionUnsavedError(reason, { cause: new AggregateError([error, rollback], 'the partial append could not be cut away'), poisoned: true })
      }
      throw new SessionUnsavedError(reason, { cause: error })
    }
  } finally {
    try {
      io.close(fd)
    } catch {
      // The bytes are written whole or cut away already; a close that fails changes neither.
    }
  }
}

let replacements = 0

/**
 * Replace the file at `path` with `bytes` in one step: a temporary file beside it, written whole and synced, then
 * renamed over it, so a crash leaves the old file or the new one and never a mix. A failure removes the temporary file
 * and leaves `path` as it was.
 *
 * The repair of a log torn in the middle (`recoverTranscript` in `./transcript.ts`) is the one caller; it syncs because
 * it replaces the whole record rather than adding to it.
 */
export function replaceWhole(path: string, bytes: Uint8Array): void {
  replacements += 1
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${replacements}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx')
    for (let offset = 0; offset < bytes.length; ) {
      const taken = writeSync(fd, bytes, offset, bytes.length - offset)
      if (!(taken > 0)) throw new Error(NOTHING_WRITTEN)
      offset += taken
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // the temporary file is removed below either way
      }
    }
    try {
      unlinkSync(temporary)
    } catch {
      // never created, or already renamed
    }
    throw error
  }
}
