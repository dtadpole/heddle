/**
 * The bounded output ring behind one job: chunks at absolute UTF-8 byte offsets, head eviction that never moves an
 * assigned offset, and non-consuming reads from any offset.
 *
 * A port of DSH's `OutputRing` (`dsh-jobs-local/lib/index.js`, `lib/types/ring.js`, :163-265). `total` counts every
 * byte ever appended and is the offset the next chunk starts at; `earliest` is the offset of the oldest byte still
 * held and only ever advances. A read below `earliest` is not an error: it answers what is left with `lossy: true`.
 */

/** Where a chunk came from. `log` is producer narration for observers; the model never reads it. */
export type JobChannel = 'stdout' | 'stderr' | 'log'

/** How a producer labels one appended chunk. */
export interface AppendOptions {
  readonly channel?: JobChannel
  /** Bytes before this chunk were lost on the producer's side. */
  readonly gapBefore?: boolean
}

/** One chunk as a reader receives it: a fresh copy, never the ring's own record. */
export interface JobChunk {
  /** Absolute UTF-8 byte offset of the chunk's first byte. */
  readonly at: number
  readonly text: string
  readonly channel?: JobChannel
  readonly gapBefore?: boolean
}

/** A read from an offset: the chunks overlapping `[from, total)`, the resume offset, and whether bytes were evicted. */
export interface RingRead {
  readonly chunks: readonly JobChunk[]
  readonly next: number
  readonly lossy: boolean
}

interface StoredChunk {
  at: number
  text: string
  bytes: number
  readonly channel?: JobChannel
  gapBefore?: boolean
}

/**
 * The UTF-8-safe tail of `text` no longer than `maxBytes`: the cut advances past continuation bytes, so the surviving
 * text never starts inside a code point (DSH's `utf8Tail`).
 */
export function utf8Tail(text: string, maxBytes: number): { readonly text: string; readonly bytes: number } {
  const raw = Buffer.from(text, 'utf8')
  let start = raw.length - maxBytes
  while (start < raw.length && ((raw[start] as number) & 0xc0) === 0x80) start += 1
  const tail = raw.subarray(start)
  return { text: tail.toString('utf8'), bytes: tail.length }
}

export class OutputRing {
  private readonly chunks: StoredChunk[] = []
  /** Sum of the retained chunks' byte lengths. */
  private retainedBytes = 0
  /** Total UTF-8 bytes ever appended: the offset the next chunk starts at. */
  total = 0
  /** Offset of the oldest retained byte; equals `total` when nothing is retained. */
  earliest = 0

  /**
   * Append one chunk and trim the head to `cap`.
   *
   * Answers false for an empty chunk, which changes nothing and wakes no observer.
   */
  append(text: string, options: AppendOptions | undefined, cap: number): boolean {
    if (text.length === 0) return false
    const bytes = Buffer.byteLength(text, 'utf8')
    this.chunks.push({
      at: this.total,
      text,
      bytes,
      ...(options?.channel !== undefined ? { channel: options.channel } : {}),
      ...(options?.gapBefore !== undefined ? { gapBefore: options.gapBefore } : {}),
    })
    this.total += bytes
    this.retainedBytes += bytes
    this.trim(cap)
    return true
  }

  /**
   * Drop whole head chunks until the ring fits `cap`; a single oversized chunk keeps only its UTF-8-safe tail, marked
   * `gapBefore`.
   */
  trim(cap: number): void {
    while (this.retainedBytes > cap && this.chunks.length > 1) {
      const dropped = this.chunks.shift()
      if (dropped === undefined) break
      this.retainedBytes -= dropped.bytes
    }
    const single = this.chunks.length === 1 ? this.chunks[0] : undefined
    if (single !== undefined && single.bytes > cap) {
      const tail = utf8Tail(single.text, cap)
      single.at += single.bytes - tail.bytes
      single.text = tail.text
      single.bytes = tail.bytes
      single.gapBefore = true
      this.retainedBytes = tail.bytes
    }
    this.earliest = this.chunks[0]?.at ?? this.total
  }

  /** The retained chunks overlapping `[from, total)`, as fresh copies. Never moves anything. */
  readFrom(from: number): RingRead {
    const chunks: JobChunk[] = []
    for (const chunk of this.chunks) {
      if (chunk.at + chunk.bytes <= from) continue
      chunks.push({
        at: chunk.at,
        text: chunk.text,
        ...(chunk.channel !== undefined ? { channel: chunk.channel } : {}),
        ...(chunk.gapBefore !== undefined ? { gapBefore: chunk.gapBefore } : {}),
      })
    }
    return { chunks, next: this.total, lossy: from < this.earliest }
  }
}
