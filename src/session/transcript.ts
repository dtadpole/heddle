import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/**
 * The transcript's on-disk format: **one zstd frame per event**, appended.
 *
 * Modelled on `@deepseek-ai/dsh-session`'s `session.v4.jsonl.zstd`, and the reason for the shape is
 * the same: a log that is only ever appended to wants to be compressed *per write* rather than
 * rewritten, and a zstd frame is the smallest unit that can be appended to a compressed file.
 *
 * Three measured facts decide the code below.
 *
 * 1. **Node reads one frame and stops.** `zstdDecompressSync` on a three-frame buffer returns the
 *    first frame's content and silently ignores the rest; the `zstd` CLI decodes all three. So the
 *    reader cannot hand the file to the decompressor — it has to walk the frames itself, which is
 *    what {@link splitFrames} is for. This is the whole reason this module exists rather than a
 *    single `zstdDecompressSync` call.
 * 2. **Appending a frame leaves the earlier bytes identical.** Measured by hashing the prefix before
 *    and after an append. That is the property the format is for, and it is what a check asserts.
 * 3. **A torn tail costs the last frame and nothing else.** The directory walk stops at the first
 *    incomplete frame, so a reader returns every complete event and never throws on a half-written
 *    one — the honest reading of a crash.
 *
 * The cost is stated rather than hidden: one frame per event compresses worse than one frame per
 * file (measured on a real session, 2.13x against 3.49x) because frames share no match window. The
 * alternative — buffering events to batch them — would mean an event on disk *after* the step it
 * describes, which this store refuses to do.
 */

/** The four bytes every zstd frame begins with, little-endian. */
export const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** One frame's byte range inside a transcript. */
export interface Frame {
  readonly start: number
  readonly end: number
}

/** Whether a buffer begins with a whole zstd frame. */
export function isCompressed(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.subarray(0, 4).equals(FRAME_MAGIC)
}

/**
 * Whether a buffer is **meant** to be a transcript of frames, including a truncated one.
 *
 * The distinction matters and was measured: a file cut off after one byte begins with `0x28`, and a
 * reader that only recognised the whole four-byte magic read that byte as plain text and reported a
 * line `'('` — an event nobody wrote. A plain transcript starts with `{` or whitespace, so any
 * prefix of the magic is unambiguous.
 */
export function looksCompressed(buffer: Buffer): boolean {
  if (buffer.length === 0) return false
  const length = Math.min(FRAME_MAGIC.length, buffer.length)
  return buffer.subarray(0, length).equals(FRAME_MAGIC.subarray(0, length))
}

/**
 * Where one frame ends, or `undefined` when it is incomplete or malformed.
 *
 * This walks the frame header and then its blocks, because a zstd frame does not record its own
 * total length: the end is only knowable by following the block chain to the block marked last.
 * Every field it reads is part of the public format (RFC 8878 §3), and anything unexpected ends the
 * walk rather than throwing — a torn tail is a normal thing to find in an appended file.
 */
export function frameEnd(buffer: Buffer, start: number): number | undefined {
  const end = frameExtent(buffer, start)
  return typeof end === 'number' ? end : undefined
}

/**
 * Where one frame ends, or why it does not: `'short'` when the bytes stop inside a frame that is well formed so far
 * (a torn tail, or a head not read far enough yet), `'malformed'` when they are not a frame at all — no magic where
 * one must start, or a reserved block type. {@link frameEnd} folds both into `undefined`; the header check
 * ({@link judgeLogHeader}) needs them apart, because a torn first frame is a crash heddle repairs and a malformed
 * one is a file that is not a log.
 */
export function frameExtent(buffer: Buffer, start: number): number | 'short' | 'malformed' {
  const magic = Math.min(4, buffer.length - start)
  if (magic <= 0) return 'short'
  if (!buffer.subarray(start, start + magic).equals(FRAME_MAGIC.subarray(0, magic))) return 'malformed'
  if (magic < 4) return 'short'
  let cursor = start + 4
  if (cursor + 1 > buffer.length) return 'short'
  const descriptor = buffer[cursor] ?? 0
  cursor += 1

  const contentSizeFlag = descriptor >> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const checksum = (descriptor & 0x04) !== 0
  const dictionaryFlag = descriptor & 0x03

  if (!singleSegment) cursor += 1 // Window_Descriptor
  cursor += [0, 1, 2, 4][dictionaryFlag] ?? 0 // Dictionary_ID
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][contentSizeFlag] ?? 0
  cursor += contentSizeBytes
  if (cursor > buffer.length) return 'short'

  for (;;) {
    if (cursor + 3 > buffer.length) return 'short'
    const header = (buffer[cursor] ?? 0) | ((buffer[cursor + 1] ?? 0) << 8) | ((buffer[cursor + 2] ?? 0) << 16)
    cursor += 3
    const lastBlock = (header & 0x01) !== 0
    const blockType = (header >> 1) & 0x03
    const blockSize = header >> 3
    if (blockType === 3) return 'malformed' // reserved
    const payload = blockType === 1 ? 1 : blockSize // an RLE block carries one byte
    cursor += payload
    if (cursor > buffer.length) return 'short'
    if (lastBlock) break
  }

  if (checksum) cursor += 4
  return cursor > buffer.length ? 'short' : cursor
}

/**
 * Every complete frame in a buffer, in order.
 *
 * The walk stops at the first byte that is not a frame or the first incomplete one, so the result is
 * always "the frames that are fully there" — which is exactly what a reader wants after a crash.
 */
export function splitFrames(buffer: Buffer): readonly Frame[] {
  const frames: Frame[] = []
  let start = 0
  while (start < buffer.length) {
    const end = frameEnd(buffer, start)
    if (end === undefined || end <= start) break
    frames.push({ start, end })
    start = end
  }
  return frames
}

/** One event, compressed as one frame with a content checksum. */
export function encodeFrame(line: string): Buffer {
  return zstdCompressSync(Buffer.from(line, 'utf8'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
}

/** What a transcript file held, and how it was read. */
export interface DecodedTranscript {
  /** The lines that survived, in order. A torn final frame is simply absent. */
  readonly lines: readonly string[]
  /** How the bytes were stored, so a caller can say what it read. */
  readonly format: 'zstd-frames' | 'plain-text'
  /** Complete frames when compressed; 0 for a plain file. */
  readonly frames: number
  /** True when a trailing byte range was not a complete frame and was left out. */
  readonly torn: boolean
  /**
   * How many bytes were read whole.
   *
   * This is what a repair keeps: the file is cut back to here before anything is appended, because a
   * torn frame in the middle of a file makes every frame **after** it unreadable — the walk stops at
   * the first incomplete frame, so appending past one would write events nothing could ever read.
   * Measured before the repair existed: a torn tail plus one appended frame read back as one event
   * instead of two, with the new event silently gone.
   */
  readonly readableBytes: number
}

/**
 * Read a transcript's bytes, whichever format they are in.
 *
 * Both formats are read forever: transcripts written before this module existed are plain JSONL, and
 * a session that already has one keeps being appended to in the format it has — the store never
 * rewrites a file to change how it is stored.
 */
export function decodeTranscript(buffer: Buffer): DecodedTranscript {
  if (!looksCompressed(buffer)) {
    const text = buffer.toString('utf8')
    return {
      lines: text.split('\n').filter((line) => line.length > 0),
      format: 'plain-text',
      frames: 0,
      torn: false,
      readableBytes: buffer.length,
    }
  }

  const frames = splitFrames(buffer)
  const lines: string[] = []
  let consumed = 0
  for (const frame of frames) {
    const slice = buffer.subarray(frame.start, frame.end)
    let text: string
    try {
      text = zstdDecompressSync(slice).toString('utf8')
    } catch {
      // A frame that cannot be decoded is treated as the end of the readable record rather than as
      // a failure of the whole file: everything before it already decoded.
      consumed = frame.start
      return { lines, format: 'zstd-frames', frames: frames.length, torn: true, readableBytes: consumed }
    }
    lines.push(...text.split('\n').filter((line) => line.length > 0))
    consumed = frame.end
  }
  return { lines, format: 'zstd-frames', frames: frames.length, torn: consumed !== buffer.length, readableBytes: consumed }
}

/**
 * What a log's first record says about whether the log can be read at all.
 *
 * - `readable`: a first record that is a session event, or nothing to judge yet — an empty file, or a first frame torn
 *   by a crash, which the store has always read as an empty session and cut back on the next write.
 * - `unreadable`: the first record does not decode, is not JSON, or is not a session event; `reason` says which.
 * - `incomplete`: the bytes given end before the first record does; read further and ask again.
 */
export type LogHeader =
  | { readonly kind: 'readable' }
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'incomplete' }

/**
 * Judge a log by its **first record**, the way DSH's JSONL backend judges a session by its header before it lists it.
 *
 * DSH (dsh-session-persistence-jsonl, README "Reading the logs": "Unreadable or unsupported headers, including corrupt
 * Zstandard header frames, are omitted from discovery and `list()`") reads only the header frame
 * (`readFirstZstdLine`, lib/index.js:3378-3409): a frame that fails validation is corruption (:3403), a first line that
 * is not JSON or not a header is no header (`readGenerationHeader`, :3150-3156 and :3170), and `listArtifacts` leaves
 * both out (:3114-3127). A heddle log has no separate header line; its first record is the first event, so that is the
 * record judged here, with the event shape the Rust build's reader already requires of every line (a whole-number
 * `seq`, a string `at` and a string `type`). The rules for the tolerated shapes are unchanged: an empty file and a torn
 * first frame read as an empty session, as {@link decodeTranscript} reads them.
 *
 * @param head - the file's first bytes; `atEnd` says whether they are the whole file.
 */
export function judgeLogHeader(head: Buffer, atEnd: boolean): LogHeader {
  if (looksCompressed(head)) {
    const end = frameExtent(head, 0)
    if (end === 'short') return atEnd ? { kind: 'readable' } : { kind: 'incomplete' }
    if (end === 'malformed') return { kind: 'unreadable', reason: 'its first zstd frame is malformed' }
    let text: string
    try {
      text = zstdDecompressSync(head.subarray(0, end)).toString('utf8')
    } catch {
      return { kind: 'unreadable', reason: 'its first zstd frame does not decode' }
    }
    return judgeFirstLine(text.split('\n').find((line) => line.length > 0) ?? '')
  }
  let start = 0
  while (start < head.length && head[start] === 0x0a) start += 1
  if (start === head.length) return atEnd ? { kind: 'readable' } : { kind: 'incomplete' }
  const newline = head.indexOf(0x0a, start)
  if (newline === -1 && !atEnd) return { kind: 'incomplete' }
  return judgeFirstLine(head.subarray(start, newline === -1 ? head.length : newline).toString('utf8'))
}

/** The first record's verdict: valid JSON, and a session event (`seq` a whole number, `at` and `type` strings). */
function judgeFirstLine(line: string): LogHeader {
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    return { kind: 'unreadable', reason: 'its first record is not valid JSON' }
  }
  return isEventRecord(record) ? { kind: 'readable' } : { kind: 'unreadable', reason: 'its first record is not a session event' }
}

/** Whether a parsed line has the shape every event the store writes has: a whole-number `seq`, a string `at`, a string `type`. */
export function isEventRecord(record: unknown): boolean {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return false
  const { seq, at, type } = record as { seq?: unknown; at?: unknown; type?: unknown }
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 && typeof at === 'string' && typeof type === 'string'
}
