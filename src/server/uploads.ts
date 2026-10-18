import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { heddleHome } from '../config/schema.ts'

/**
 * Where a file chosen on the person's computer is stored so the agent can read it.
 *
 * Heddle's substrate for "a file in the conversation" is a **path**, not a provider attachment:
 * `read_file` opens a path and the sandbox decides whether that path may be read. This module is the
 * one place that turns uploaded bytes into such a path, and every rule it has comes from that:
 *
 * - the file lands under `$HEDDLE_HOME/uploads/`, the harness's own store — the sandbox admits
 *   `$HEDDLE_HOME` for reading, so the path in the draft is one the agent can actually open;
 * - the name is reduced to one safe leaf before it is joined, so a hand-made request cannot choose a
 *   path outside that directory;
 * - an existing file is never overwritten, because two files may honestly share a name;
 * - the file is created `0600`: it is the person's data, not the machine's.
 */

/** The largest file the upload route accepts, matching the turn body's own ceiling. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** One stored upload, as the route answers with it and the page puts in the draft. */
export interface SavedUpload {
  /** Absolute path, the thing the agent's `read_file` takes. */
  readonly path: string
  /** The safe leaf name the file was stored under. */
  readonly name: string
  readonly bytes: number
}

/** The directory uploads live in. A parameter, so a test does not have to touch the operator's home. */
export function uploadDirectory(home: string = heddleHome()): string {
  return join(home, 'uploads')
}

/** Characters that are path syntax on some platform, or that a terminal treats specially. */
const UNSAFE = /[\u0000-\u001f\u007f/\\:*?"<>|]/g
/** The longest leaf a name is allowed to become, before the extension is considered. */
const MAX_LEAF = 120
/** The longest extension that is preserved when a name must be cut. */
const MAX_EXTENSION = 16

/**
 * Reduce a client-supplied name to one safe file name.
 *
 * The steps are ordered: separators are removed by taking the basename **after** Windows separators are
 * normalised to POSIX ones, so `C:\Users\me\report.txt` and `../../etc/passwd` both become a leaf; then
 * characters a filesystem refuses become `_`; then leading dots are removed so the result can never be
 * `..` or a hidden path; then the length is capped with the extension kept.
 */
export function safeUploadName(name: string): string {
  const leaf = basename(String(name).replace(/\\/g, '/')).trim()
  const cleaned = leaf.replace(UNSAFE, '_').replace(/^[.\s]+/, '').trim()
  if (cleaned.length === 0) return 'file'
  const characters = Array.from(cleaned)
  if (characters.length <= MAX_LEAF) return cleaned
  const dot = cleaned.lastIndexOf('.')
  const extension = dot > 0 && cleaned.length - dot <= MAX_EXTENSION ? cleaned.slice(dot) : ''
  const stem = Array.from(extension.length > 0 ? cleaned.slice(0, dot) : cleaned).slice(0, MAX_LEAF - Array.from(extension).length)
  return `${stem.join('')}${extension}` || 'file'
}

/**
 * Store one upload and answer with the path the draft should name.
 *
 * `now` is a parameter rather than a call to `new Date()` because a test must be able to make two
 * uploads collide on purpose; the route passes nothing.
 */
export function saveUpload(name: string, data: Buffer, options: { home?: string; now?: Date } = {}): SavedUpload {
  const safe = safeUploadName(name)
  const directory = uploadDirectory(options.home)
  mkdirSync(directory, { recursive: true })
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
  let path = join(directory, `${stamp}-${safe}`)
  for (let attempt = 1; existsSync(path); attempt += 1) {
    path = join(directory, `${stamp}-${attempt}-${safe}`)
  }
  writeFileSync(path, data, { mode: 0o600 })
  return { path, name: safe, bytes: data.length }
}
