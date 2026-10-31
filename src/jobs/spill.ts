import { closeSync, mkdtempSync, openSync, rmdirSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PullRead, PullSource } from './registry.ts'

/**
 * A background command's complete output streams, kept in private spill files once they outgrow the in-memory tail.
 *
 * A port of the spill half of DSH's `OutputCollector` (`dsh-subprocess-local/lib/output.js:7-237`), which DSH's
 * bash provider gives every stream (`dsh-bash-local`: `maxOutputBytes` 64 000, `maxSpillBytes` 64 MiB). A job's
 * ring keeps only a bounded tail, so a model that falls behind reads a lossy delta; DSH's notice then names the
 * files that hold the whole stream (`[some output was dropped from memory; full output: <paths>]`). Without them
 * heddle's notice could only say `(unavailable)`.
 *
 * The rules, as DSH's:
 * - the file opens at the stream's **first overflow** of the in-memory tail, and the chunks still held are written
 *   first, so the file holds the stream from byte 0;
 * - every later chunk is appended, until the stream passes the spill cap: then the file is removed and spilling stops
 *   for good, because it could no longer hold the complete stream;
 * - an open or write failure discards the spill and is reported once; collection never stops for it;
 * - files live in a private (0700) per-process directory under the OS tmpdir, named
 *   `heddle-jobs-<pid>-<n>-<hex>-<stream>.log`. They are kept after the job as full-output recovery artifacts; at
 *   process exit the directory is removed only when it is empty.
 *
 * The job's own reads are unchanged: the producer still appends each chunk as it arrives. The spill reaches the job
 * as a pull source that answers no text, only its path (`JobView.output.spillPaths`).
 */

/** The in-memory tail a stream keeps before it spills: DSH's bash `maxOutputBytes` default. */
export const DEFAULT_STREAM_TAIL_BYTES = 64_000

/** The most a spill file holds: DSH's bash `maxSpillBytes` default (per stream). */
export const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024

export interface SpillSettings {
  /** Bytes a stream keeps in memory before it spills. */
  readonly tailBytes?: number
  /** The most one spill file holds; past it the spill is removed. */
  readonly maxBytes?: number
  /** Where spill files go; the private per-process directory when absent. */
  readonly dir?: string
  /** Told once per stream when a spill fails; a stderr line when absent. */
  readonly onFailure?: (error: unknown, label: string) => void
}

let spillCounter = 0
let defaultSpillDir: string | undefined
let exitHookArmed = false

/** The private per-process spill directory, created on first use (`privateSpillDir`, OUTPUT:20-30). */
export function privateSpillDir(): string {
  if (defaultSpillDir === undefined) {
    defaultSpillDir = mkdtempSync(join(tmpdir(), 'heddle-jobs-'))
    if (!exitHookArmed) {
      exitHookArmed = true
      process.once('exit', () => {
        if (defaultSpillDir === undefined) return
        try {
          rmdirSync(defaultSpillDir)
        } catch {
          // Not empty: the spill files are kept as full-output artifacts.
        }
      })
    }
  }
  return defaultSpillDir
}

function reportToStderr(error: unknown, label: string): void {
  process.stderr.write(`heddle jobs: ${label} spill failed; only the in-memory tail is retained: ${String(error)}\n`)
}

/** One stream's spill (`OutputCollector.push` / `spillAll` / `discardSpill` / `seal`, OUTPUT:115-224). */
export class StreamSpill {
  private readonly tailBytes: number
  private readonly maxBytes: number
  private readonly dir: () => string
  private readonly onFailure: (error: unknown, label: string) => void
  /** The chunks a first overflow writes before itself; dropped once the file is open. */
  private held: Buffer[] = []
  private heldBytes = 0
  private fd: number | undefined
  private file: string | undefined
  private disabled = false
  /** Bytes the stream has carried. */
  total = 0
  /** The stream's name in file names and failure reports. */
  readonly label: string

  constructor(label: string, settings: SpillSettings = {}) {
    this.label = label
    this.tailBytes = settings.tailBytes ?? DEFAULT_STREAM_TAIL_BYTES
    this.maxBytes = settings.maxBytes ?? DEFAULT_MAX_SPILL_BYTES
    const dir = settings.dir
    this.dir = dir !== undefined ? () => dir : privateSpillDir
    this.onFailure = settings.onFailure ?? reportToStderr
  }

  /** The complete-stream file, while it is intact. */
  get path(): string | undefined {
    return this.file
  }

  /** Take one raw chunk of the stream. */
  push(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.total += chunk.length
    if (this.disabled) return
    if (this.fd === undefined && this.heldBytes + chunk.length <= this.tailBytes) {
      this.held.push(chunk)
      this.heldBytes += chunk.length
      return
    }
    if (this.total > this.maxBytes) {
      this.discard()
      return
    }
    try {
      if (this.fd === undefined) {
        spillCounter += 1
        const file = join(this.dir(), `heddle-jobs-${process.pid}-${spillCounter}-${randomBytes(6).toString('hex')}-${this.label}.log`)
        const fd = openSync(file, 'wx', 0o600)
        this.file = file
        this.fd = fd
        for (const prior of this.held) writeSync(fd, prior)
        this.held = []
        this.heldBytes = 0
      }
      writeSync(this.fd, chunk)
    } catch (error) {
      this.discard()
      try {
        this.onFailure(error, this.label)
      } catch (reporterFailure) {
        process.stderr.write(`heddle jobs: spill failure reporter threw: ${String(reporterFailure)}\n`)
      }
    }
  }

  /** Close the file once the stream ended. A failed close stops advertising it: it may miss its tail. Idempotent. */
  seal(): void {
    this.held = []
    this.heldBytes = 0
    if (this.fd === undefined) return
    try {
      closeSync(this.fd)
    } catch {
      this.file = undefined
    }
    this.fd = undefined
  }

  /** Stop spilling and remove the file: it can no longer hold the complete stream, or nobody will ever name it. */
  discard(): void {
    const fd = this.fd
    const file = this.file
    this.fd = undefined
    this.file = undefined
    this.disabled = true
    this.held = []
    this.heldBytes = 0
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Already closed or failed: the unlink below still removes the name.
      }
    }
    if (file !== undefined) {
      try {
        unlinkSync(file)
      } catch {
        // Gone already.
      }
    }
  }
}

/** A command's two streams' spills. */
export interface ProcessSpills {
  readonly stdout: StreamSpill
  readonly stderr: StreamSpill
}

export function processSpills(settings: SpillSettings = {}): ProcessSpills {
  return { stdout: new StreamSpill('stdout', settings), stderr: new StreamSpill('stderr', settings) }
}

/**
 * The spills as the job's pull sources: no text (the producer appends every chunk itself), only each stream's current
 * file, which the registry advertises as `output.spillPaths` and the lossy notice names.
 */
export function spillSources(spills: ProcessSpills): readonly PullSource[] {
  const source = (spill: StreamSpill): PullSource => ({
    read: (fromByte: number): PullRead => ({ text: '', nextOffset: fromByte, lossy: false, ...(spill.path !== undefined ? { spillPath: spill.path } : {}) }),
  })
  return [source(spills.stdout), source(spills.stderr)]
}
