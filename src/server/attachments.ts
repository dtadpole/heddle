import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'

import { isUnder } from '../paths.ts'
import type { ContentPart, ImageMediaType } from '../llm/types.ts'
import { MAX_UPLOAD_BYTES, uploadDirectory } from './uploads.ts'

/**
 * The server half of an attachment: a path the browser names becomes a typed content block.
 *
 * The browser only says **which stored file**; the server decides the display name, byte size, sha256 and
 * media type. That separation is the security rule — a hand-made request must not be able to point a
 * message at a file outside the upload directory — and the descriptive rule: the block a request projection
 * reads later is the one the server measured, not one a client asserted.
 *
 * The reference is the durable path, which is the substrate this project already has: the agent's file tools
 * read the same path, and the sandbox admits it. The session log therefore stores a reference, never bytes.
 */

/** A refused attachment, with a sentence a person can act on. */
export class AttachmentInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttachmentInputError'
  }
}

/** The most files one message may carry. DSH bounds a batch too; the exact per-image limits come later. */
export const MAX_ATTACHMENTS = 10

/** Raster extensions the request projection can send as image content. */
const IMAGE_TYPES: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** The timestamp the upload store prefixes a stored file with, e.g. `2026-10-18T04-27-03-497Z-`. */
const UPLOAD_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-/

/** The name a person attached, recovered from the store's timestamped leaf. */
export function displayNameForStored(storedPath: string): string {
  const leaf = basename(storedPath)
  return leaf.replace(UPLOAD_STAMP, '') || leaf
}

/** The upload directory, canonicalised, so the comparison is path-segment rather than string-prefix. */
function uploadRoot(): string {
  const directory = uploadDirectory()
  try {
    return realpathSync(directory)
  } catch {
    return directory
  }
}

/**
 * Read one attachment reference into its canonical content block.
 *
 * Every failure is a named refusal: not a string, no longer on disk, outside the upload directory, not a
 * regular file, larger than the upload ceiling. The path is canonicalised **before** the containment test,
 * so a symlink placed inside the upload directory that points elsewhere is refused rather than followed.
 */
export function readAttachment(value: unknown): ContentPart {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AttachmentInputError('an attachment must be a path')
  }
  const root = uploadRoot()
  let canonical: string
  try {
    canonical = realpathSync(value)
  } catch {
    throw new AttachmentInputError(`the attached file no longer exists: ${value}`)
  }
  if (!isUnder(root, canonical)) {
    throw new AttachmentInputError(`an attachment must be inside the upload directory (${root})`)
  }
  const stats = statSync(canonical)
  if (!stats.isFile()) {
    throw new AttachmentInputError(`an attachment must be a file: ${canonical}`)
  }
  if (stats.size > MAX_UPLOAD_BYTES) {
    throw new AttachmentInputError(`the attached file is larger than this server accepts (${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB)`)
  }
  const bytes = readFileSync(canonical)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const name = displayNameForStored(canonical)
  const mimeType = IMAGE_TYPES[extname(canonical).toLowerCase()]
  if (mimeType !== undefined) {
    return { type: 'image', name, mimeType, path: canonical, bytes: stats.size, sha256 }
  }
  return { type: 'file', name, path: canonical, bytes: stats.size, sha256 }
}

/**
 * Read the attachment list a turn or steer request carries.
 *
 * Absent means no attachments. Anything present must be an array of paths within the batch limit; each is
 * read by `readAttachment`, so one bad entry refuses the whole request rather than sending a partial one.
 */
export function readAttachments(value: unknown): ContentPart[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new AttachmentInputError('attachments must be an array of paths')
  if (value.length > MAX_ATTACHMENTS) {
    throw new AttachmentInputError(`one message may carry at most ${MAX_ATTACHMENTS} attachments`)
  }
  return value.map(readAttachment)
}
