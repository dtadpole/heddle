#!/usr/bin/env node
// Remove stale scratch entries that tests and browser runs leave in the user TMPDIR.
//
//   _tools_/local-build/tmp-sweep              remove the KINDS below once older than 2 hours: scratch folders,
//                                              browser profiles and Chrome's own leftovers
//   _tools_/local-build/tmp-sweep --dry-run    list what would go
//   _tools_/local-build/tmp-sweep --age-minutes 240 --dir <folder>
//   _tools_/local-build/tmp-sweep --no-caches  skip the cache sizes
//   _tools_/local-build/tmp-sweep --worktrees [--repo ~/heddle]
//                                              also remove the repository's stale scratch worktrees (below)
//
// After the sweep it prints what the folder still holds: its total, its entry count and its five largest
// entries, so the next leak shows in the sweep's own output. It also reports the size of the npm and uv
// caches, which hold gigabytes on this Mac's one disk. It only reports them: clearing a cache is the
// coordinator's call, and every seat would refill it.
//
// An entry's age is the newest mtime of the entry and its direct children, so a folder still being written
// into is young. An entry named on any running process's command line (a live browser's profile) is kept.
//
// --worktrees removes a worktree of the repository under /private/tmp, or a sibling heddle--developer-*-*, when
// all of these hold: older than the age (the folder, its git admin folder and their direct children), not
// locked, holding no other worktree, no process has a file or working folder in it or names it, `git status`
// shows nothing, and HEAD is on a remote branch, so nothing is lost. It removes with `git worktree remove`
// (never --force), then runs `git worktree prune`.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { freeBytes, gib, heldBy, listWorktrees, processHolds } from './sweep-lib.mjs'

// The first kind whose pattern matches names the entry. The two profile kinds are testers' Chrome profiles
// (hd5-live-profile-*, x-chrome-profile-*); the hidden .com.google.Chrome.XXXXXX files are Chrome's temporary
// files, a few hundred KiB each, of which 30,000 (5.3 GiB) had piled up by 31 October.
export const KINDS = [
  ['heddle-*', /^heddle-/],
  ['hd-*-browser-*', /^hd-.*-browser-/],
  ['hd*-live-profile*', /^hd.*-live-profile/],
  ['*-chrome-profile*', /-chrome-profile/],
  ['scoped_dir*', /^scoped_dir/],
  ['com.google.Chrome*', /^com\.google\.Chrome/],
  ['.com.google.Chrome*', /^\.com\.google\.Chrome/],
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

/** A seat's extra worktree beside the repository, heddle--developer-<seat>-<suffix>; never the seat's own. */
export const SIBLING = /^heddle--developer-[^/]+-[^/]+$/

/** Whether the sweep may take this worktree at all: under the tmp root, or a SIBLING beside the main worktree. */
export function isScratchWorktree(wtPath, mainPath, tmpRoot) {
  if (wtPath === mainPath) return false
  if (wtPath.startsWith(tmpRoot + '/')) return true
  return path.dirname(wtPath) === path.dirname(mainPath) && SIBLING.test(path.basename(wtPath))
}

/** A worktree's git admin folder, from the `gitdir:` line of its .git file; null when unreadable. */
function adminDir(wtPath) {
  try {
    const m = /^gitdir: (.+)$/m.exec(fs.readFileSync(path.join(wtPath, '.git'), 'utf8'))
    return m ? path.resolve(wtPath, m[1].trim()) : null
  } catch {
    return null
  }
}

const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const realOr = (p) => {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

export function sweepWorktrees({
  repo = path.join(os.homedir(), 'heddle'),
  tmpRoot = realOr('/tmp'),
  ageMinutes = 120,
  dryRun = false,
  now = Date.now(),
  holds = processHolds(),
} = {}) {
  const result = { repo, removed: [], kept: [], young: 0, pruned: 0, errors: [], freeBefore: freeBytes(repo), freeAfter: null }
  const list = listWorktrees(repo)
  if (!list) {
    result.errors.push(`${repo}: git worktree list failed`)
    return result
  }
  if (!holds) result.errors.push('the process list (ps, lsof) could not be read, so no worktree was removed')
  const main = list[0].path
  for (const wt of list.slice(1)) {
    if (!isScratchWorktree(wt.path, main, tmpRoot) || wt.prunable) continue // a prunable one's folder is gone: prune drops it
    const branch = wt.branch || 'detached'
    const keep = (reason) => result.kept.push({ path: wt.path, branch, reason })
    if (wt.locked) {
      keep('locked')
      continue
    }
    if (list.some((other) => other.path.startsWith(wt.path + '/'))) {
      keep('holds another worktree')
      continue
    }
    let newest
    try {
      const admin = adminDir(wt.path)
      newest = Math.max(newestMtime(wt.path), admin ? newestMtime(admin) : 0)
    } catch {
      continue // gone meanwhile
    }
    if (now - newest < ageMinutes * 60_000) {
      result.young++
      continue
    }
    if (!holds) continue
    const held = heldBy(wt.path, holds)
    if (held) {
      keep(`in use (${held})`)
      continue
    }
    // --no-optional-locks: a status that refreshed the index would make the worktree look young next time.
    const status = git(wt.path, '--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none')
    if (status.status !== 0 || status.stdout.trim()) {
      keep(status.status !== 0 ? 'git status failed' : 'uncommitted changes')
      continue
    }
    const remote = git(repo, 'for-each-ref', '--count=1', '--contains', wt.head || 'HEAD', '--format=%(refname:short)', 'refs/remotes/')
    if (remote.status !== 0 || !remote.stdout.trim()) {
      keep('HEAD not on a remote branch')
      continue
    }
    if (!dryRun) {
      const rm = git(repo, 'worktree', 'remove', wt.path)
      if (rm.status !== 0) {
        result.errors.push(`${wt.path}: ${(rm.stderr || '').trim()}`)
        continue
      }
    }
    result.removed.push({ path: wt.path, branch, remote: remote.stdout.trim(), idleMinutes: Math.floor((now - newest) / 60_000) })
  }
  const prune = git(repo, 'worktree', 'prune', '--verbose', ...(dryRun ? ['--dry-run'] : []))
  result.pruned = `${prune.stdout}\n${prune.stderr}`.split('\n').filter((l) => l.startsWith('Removing ')).length
  result.freeAfter = freeBytes(repo)
  return result
}

const hm = (minutes) => `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`

export function renderWorktrees(r, dryRun) {
  const verb = dryRun ? 'would remove' : 'removed'
  const reasons = new Map()
  for (const k of r.kept) reasons.set(k.reason, (reasons.get(k.reason) || 0) + 1)
  const kept = [`${r.young} younger than the age`, ...[...reasons].map(([reason, n]) => `${n} ${reason}`)].join(', ')
  const lines = [
    `tmp-sweep: worktrees of ${r.repo}: ${verb} ${r.removed.length}; kept ${kept}; ` +
      `${dryRun ? 'would prune' : 'pruned'} ${r.pruned} stale entries; disk ${gib(r.freeBefore)} GiB free before, ${gib(r.freeAfter)} after`,
  ]
  for (const w of r.removed) lines.push(`  ${verb} ${w.path} (${w.branch}, idle ${hm(w.idleMinutes)}, HEAD on ${w.remote})`)
  for (const w of r.kept) lines.push(`  kept ${w.path} (${w.branch}): ${w.reason}`)
  for (const error of r.errors) lines.push(`  error: ${error}`)
  return lines.join('\n')
}

/** The caches to report, from the same settings npm and uv read: npm_config_cache, UV_CACHE_DIR, XDG_CACHE_HOME. */
export function cacheDirs(env = process.env, home = os.homedir()) {
  return [
    ['npm cache', env.npm_config_cache || path.join(home, '.npm')],
    ['uv cache', env.UV_CACHE_DIR || path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'uv')],
  ]
}

/** Each cache's size in KiB with du, null when du failed; absent when the folder does not exist. Removes nothing. */
export function cacheSizes(dirs = cacheDirs()) {
  return dirs.map(([name, dir]) => {
    if (!fs.existsSync(dir)) return { name, dir, absent: true, kib: null }
    const du = spawnSync('du', ['-sk', dir], { encoding: 'utf8', timeout: 120_000 })
    const kib = Number((du.stdout || '').split(/\s+/)[0])
    return { name, dir, absent: false, kib: du.status === 0 && Number.isFinite(kib) ? kib : null }
  })
}

export function formatKiB(kib) {
  if (kib >= 1024 * 1024) return `${(kib / 1024 / 1024).toFixed(1)} GiB`
  if (kib >= 1024) return `${Math.round(kib / 1024)} MiB`
  return `${kib} KiB`
}

/**
 * What `dir` holds: its total in KiB and every top-level entry's size, null when du failed. One `du -k -d 1`
 * sizes the folders and the total (macOS du cannot combine -a with -d); lstat sizes the rest, files and links,
 * by their allocated blocks as du counts them. du exits 1 on an unreadable subfolder but still prints the
 * rest, so only a missing total is a failure. Removes nothing.
 */
export function entrySizes(dir) {
  const top = path.resolve(dir)
  const du = spawnSync('du', ['-k', '-d', '1', top], { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 })
  if (du.error || du.signal) return null
  let total = null
  const folders = new Map()
  for (const line of (du.stdout || '').split('\n')) {
    const m = /^(\d+)\t(.+)$/.exec(line)
    if (!m) continue
    const p = path.resolve(m[2])
    if (p === top) total = Number(m[1])
    else if (path.dirname(p) === top) folders.set(path.basename(p), Number(m[1]))
  }
  if (total === null) return null
  const entries = []
  let names = []
  try {
    names = fs.readdirSync(top)
  } catch {
    return null
  }
  for (const name of names) {
    try {
      const st = fs.lstatSync(path.join(top, name))
      entries.push({ name, kib: st.isDirectory() ? folders.get(name) ?? 0 : Math.ceil(st.blocks / 2) })
    } catch {} // gone meanwhile
  }
  return { total, entries }
}

/** One line: the folder's total, its entry count and its `count` largest entries, largest first. */
export function renderLargest(dir, sizes, count = 5) {
  if (!sizes) return `tmp-sweep: ${dir}: sizes unknown (du failed)`
  const largest = [...sizes.entries].sort((a, b) => b.kib - a.kib || (a.name < b.name ? -1 : 1)).slice(0, count)
  const list = largest.map((e) => `${formatKiB(e.kib)} ${e.name}`).join(', ') || 'none'
  return `tmp-sweep: ${dir} holds ${formatKiB(sizes.total)} in ${sizes.entries.length} entries; largest: ${list}`
}

export function renderCaches(sizes) {
  const parts = sizes.map((c) => `${c.name} ${c.absent ? 'absent' : c.kib === null ? '? (du failed)' : formatKiB(c.kib)} (${c.dir})`)
  return `tmp-sweep: caches, sizes only, never removed: ${parts.join(', ')}`
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
  const opt = { dryRun: false, ageMinutes: 120, dir: os.tmpdir(), caches: true, worktrees: false, repo: path.join(os.homedir(), 'heddle') }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') opt.dryRun = true
    else if (argv[i] === '--no-caches') opt.caches = false
    else if (argv[i] === '--worktrees') opt.worktrees = true
    else if (argv[i] === '--age-minutes') opt.ageMinutes = Number(argv[++i])
    else if (argv[i] === '--dir') opt.dir = argv[++i]
    else if (argv[i] === '--repo') opt.repo = argv[++i]
    else {
      console.error('usage: tmp-sweep [--dry-run] [--age-minutes <n>] [--dir <folder>] [--no-caches] [--worktrees [--repo <dir>]]')
      return 64
    }
  }
  if (!Number.isFinite(opt.ageMinutes) || opt.ageMinutes < 0 || !opt.dir || !opt.repo) {
    console.error('tmp-sweep: --age-minutes needs a number of minutes, --dir a folder, --repo a repository')
    return 64
  }
  const result = sweep(opt)
  console.log(render(result, opt.dryRun))
  console.log(renderLargest(opt.dir, entrySizes(opt.dir)))
  if (opt.caches) console.log(renderCaches(cacheSizes()))
  let errors = result.errors.length
  if (opt.worktrees) {
    const worktrees = sweepWorktrees({ repo: path.resolve(opt.repo), ageMinutes: opt.ageMinutes, dryRun: opt.dryRun })
    console.log(renderWorktrees(worktrees, opt.dryRun))
    errors += worktrees.errors.length
  }
  return errors ? 1 : 0
}

const invoked = process.argv[1] && fs.realpathSync(process.argv[1])
if (invoked === fs.realpathSync(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)))
