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

/**
 * The largest file the upload route accepts.
 *
 * This is a **local memory guard, not a prompt-size one**: the bytes are written under
 * `$HEDDLE_HOME/uploads` and what reaches the conversation is the path, so a large file costs the server
 * one buffered body and a disk write, not model context. The ceiling was 10 MiB until the owner loaded a
 * Retina screenshot (`LWScreenShot 2026-05-25 at 6.53.05 PM.png`) and the page answered "the file is
 * larger than this server accepts" — an ordinary screenshot passes 10 MiB. 50 MiB covers screenshots,
 * images and small documents while still bounding what one request may buffer.
 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

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

/**
 * The sentence `GET /api/uploads/{leaf}` answers, with `404`, when the requesting session's log does not reference
 * the upload (or no session was named).
 */
export const UPLOAD_NOT_REFERENCED = 'this upload is not referenced by this session'

/**
 * Whether a session's log references an upload by its leaf: some logged message carries an `image` or `file` part
 * whose stored path ends in that leaf.
 *
 * DSH serves an attachment only through `session/attachment(sessionId, attachmentId)`, which reads that session's
 * events and refuses with "Image is not referenced by this session." (`ATTACHMENT_NOT_REFERENCED`) unless a built-in
 * event's declared content carries the image. heddle's events keep an attachment as a content part with the absolute
 * path the upload route stored, so the reference is that part's leaf. Every logged `message` counts, whatever its
 * role (a prompt, a steer, a tool result), because each is content the transcript can draw.
 */
export function uploadReferencedBy(
  events: readonly { readonly type?: string; readonly message?: unknown; readonly [key: string]: unknown }[],
  leaf: string,
): boolean {
  if (leaf.length === 0) return false
  for (const event of events) {
    const message = event.message as { readonly content?: unknown } | undefined
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const part of content as readonly { readonly type?: unknown; readonly path?: unknown }[]) {
      if (part === null || typeof part !== 'object') continue
      if (part.type !== 'image' && part.type !== 'file') continue
      if (typeof part.path === 'string' && basename(part.path) === leaf) return true
    }
  }
  return false
}
