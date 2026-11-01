import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Whole-file writes that leave the old file whole when they fail (#195).
 *
 * `writeFileSync` truncates the file and then writes it, so a write that fails part-way (a full disk) or a process
 * killed between the two leaves a cut file. For a session's record that cut file was the whole failure of #195: the
 * session dropped out of the list, search, Rename and Pin without a word, while its log was intact. The store rewrote
 * that record in place on every prompt (the turn count and the prompt time) and on every rename, pin, archive, preset
 * and model switch.
 *
 * A write here goes to a temporary file in the same folder and is renamed over the target, which POSIX makes atomic:
 * a reader sees the old bytes or the new ones, never a mix, and a write that fails leaves the old file as it was and
 * removes its temporary file. This is the Rust build's `write_atomic` (heddle-session `fsio.rs`), whose temporary name
 * this one shares, and DSH's `writeFileAtomic` (`@deepseek-ai/dsh-atomic-write` lib/index.js:62-78, through which DSH
 * makes every whole-file write). No fsync, as neither of those does: atomicity for a reader comes from the rename alone.
 */

let next = 0

/**
 * The temporary path beside `path`: a dot-file unique to this process and call. It never ends in `.json` and never
 * starts with `session-`, so no listing reads it as a record, and the tree hides it.
 */
function temporaryBeside(path: string): string {
  const unique = next
  next += 1
  return join(dirname(path), `.${basename(path)}.${process.pid}.${unique}.tmp`)
}

/**
 * Replace `path` with `data` atomically. On failure the temporary file is removed, `path` keeps what it held, and the
 * error is thrown to the caller.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  const temporary = temporaryBeside(path)
  try {
    writeFileSync(temporary, data)
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // never written, or already renamed: nothing of ours is left beside the target
    }
    throw error
  }
}
