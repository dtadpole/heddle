#!/usr/bin/env node
// Remove stale scratch entries that tests and browser runs leave in the user TMPDIR.
//
//   _tools_/local-build/tmp-sweep              remove heddle-*, hd-*-browser-*, scoped_dir*, com.google.Chrome*
//                                              entries older than 2 hours
//   _tools_/local-build/tmp-sweep --dry-run    list what would go
//   _tools_/local-build/tmp-sweep --age-minutes 240 --dir <folder>
//
// An entry's age is the newest mtime of the entry and its direct children, so a folder still being written
// into is young. An entry named on any running process's command line (a live browser's profile) is kept.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const KINDS = [
  ['heddle-*', /^heddle-/],
  ['hd-*-browser-*', /^hd-.*-browser-/],
  ['scoped_dir*', /^scoped_dir/],
  ['com.google.Chrome*', /^com\.google\.Chrome/],
]

const kindOf = (name) => (KINDS.find(([, re]) => re.test(name)) || [])[0]

/** Newest mtime (ms) of an entry and, for a folder, of its direct children; symlinks are not followed. */
export function newestMtime(entry) {
  let newest = fs.lstatSync(entry).mtimeMs
  try {
    if (fs.lstatSync(entry).isDirectory())
      for (const child of fs.readdirSync(entry)) {
        try {
          newest = Math.max(newest, fs.lstatSync(path.join(entry, child)).mtimeMs)
        } catch {}
      }
  } catch {}
  return newest
}

/** Every running process's command line, to keep entries a live process names (a browser's profile). */
function commandLines() {
  const ps = spawnSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return ps.status === 0 ? ps.stdout : ''
}

export function sweep({ dir = os.tmpdir(), ageMinutes = 120, dryRun = false, now = Date.now(), commands = commandLines() } = {}) {
  const real = (() => {
    try {
      return fs.realpathSync(dir)
    } catch {
      return dir
    }
  })()
  const result = { dir, removed: {}, tooNew: 0, inUse: 0, errors: [] }
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch (error) {
    result.errors.push(`${dir}: ${error.message}`)
    return result
  }
  for (const name of names) {
    const kind = kindOf(name)
    if (!kind) continue
    const entry = path.join(dir, name)
    let mtime
    try {
      mtime = newestMtime(entry)
    } catch {
      continue // gone meanwhile
    }
    if (now - mtime < ageMinutes * 60_000) {
      result.tooNew++
      continue
    }
    if (commands.includes(entry) || commands.includes(path.join(real, name))) {
      result.inUse++
      continue
    }
    if (!dryRun) {
      try {
        fs.rmSync(entry, { recursive: true, force: true })
      } catch (error) {
        result.errors.push(`${name}: ${error.message}`)
        continue
      }
    }
    result.removed[kind] = (result.removed[kind] || 0) + 1
  }
  return result
}

export function render(result, dryRun) {
  const total = Object.values(result.removed).reduce((a, b) => a + b, 0)
  const byKind = KINDS.map(([kind]) => `${kind} ${result.removed[kind] || 0}`).join(', ')
  const lines = [
    `tmp-sweep: ${result.dir}: ${dryRun ? 'would remove' : 'removed'} ${total} (${byKind}); ` +
      `kept ${result.tooNew} younger than the age, ${result.inUse} in use`,
  ]
  for (const error of result.errors.slice(0, 10)) lines.push(`  error: ${error}`)
  if (result.errors.length > 10) lines.push(`  ... ${result.errors.length - 10} more errors`)
  return lines.join('\n')
}

export function main(argv) {
  const opt = { dryRun: false, ageMinutes: 120, dir: os.tmpdir() }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') opt.dryRun = true
    else if (argv[i] === '--age-minutes') opt.ageMinutes = Number(argv[++i])
    else if (argv[i] === '--dir') opt.dir = argv[++i]
    else {
      console.error('usage: tmp-sweep [--dry-run] [--age-minutes <n>] [--dir <folder>]')
      return 64
    }
  }
  if (!Number.isFinite(opt.ageMinutes) || opt.ageMinutes < 0 || !opt.dir) {
    console.error('tmp-sweep: --age-minutes needs a number of minutes, --dir a folder')
    return 64
  }
  const result = sweep(opt)
  console.log(render(result, opt.dryRun))
  return result.errors.length ? 1 : 0
}

const invoked = process.argv[1] && fs.realpathSync(process.argv[1])
if (invoked === fs.realpathSync(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)))
