#!/usr/bin/env node
// Remove superseded heddle build artifacts from a cargo target's deps folders.
//
//   _tools_/local-build/deps-sweep [--target <dir>] [--age-minutes 60] [--dry-run]
//   _tools_/local-build/deps-sweep --all                  every worktree of this repository (git worktree list)
//   deps-sweep.mjs --after-build -- <cargo args>          the slot runner, after a successful cargo command
//   _tools_/local-build/deps-sweep --floor [--floor-gib 18] [--age-minutes 30] [--repo <dir>] [--roster <TEAM.yaml>]
//
// Each build leaves new hashed heddle test binaries and rlibs in target/<profile>/deps and never removes the
// old ones. An artifact named [lib]heddle<crate>-<16 hex>[.ext] is removed when a newer one with the same name
// and extension exists and it is older than the age, so a crate whose lib and bin tests share a name is not
// rebuilt over and over. Third-party crates are left alone, and so is a deps folder a running process names.
//
// --floor acts only when the disk has less free than the floor (18 GiB). It then removes the whole
// rust/target/debug folder of every worktree of the repository that nothing wrote for the age (30 minutes;
// the folder, its entries and theirs) and no process holds (an open file or working folder inside it, or a
// command line naming it), oldest first, and lists each with its owner. It tells no one: the coordinator
// tells the owners.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { freeBytes, gib, heldBy, listWorktrees, processHolds } from './sweep-lib.mjs'

const ARTIFACT = /^(lib)?(heddle[a-z0-9_]*)-([0-9a-f]{16})(\..+)?$/

/** The group an artifact belongs to ("libheddle_server.rlib", "heddle_server"), or null when it is not ours. */
export function artifactKey(name) {
  const m = name.match(ARTIFACT)
  return m ? `${m[1] || ''}${m[2]}${m[4] || ''}` : null
}

/** The target folders a cargo command used: CARGO_TARGET_DIR, else next to --manifest-path, else ./target. */
export function targetsFor(args, env = process.env, cwd = process.cwd()) {
  if (env.CARGO_TARGET_DIR) return [path.resolve(cwd, env.CARGO_TARGET_DIR)]
  for (let i = 0; i < args.length; i++) {
    const manifest = args[i] === '--manifest-path' ? args[i + 1] : args[i].startsWith('--manifest-path=') ? args[i].slice(16) : null
    if (manifest) return [path.join(path.dirname(path.resolve(cwd, manifest)), 'target')]
  }
  return fs.existsSync(path.join(cwd, 'Cargo.toml')) ? [path.join(cwd, 'target')] : []
}

/** target/<profile>/deps and target/<triple>/<profile>/deps. */
export function depsDirs(target) {
  const found = []
  const scan = (dir, depth) => {
    let names = []
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of names) {
      if (!entry.isDirectory()) continue
      const child = path.join(dir, entry.name)
      if (entry.name === 'deps') found.push(child)
      else if (depth < 2) scan(child, depth + 1)
    }
  }
  scan(target, 0)
  return found
}

function size(p) {
  try {
    const st = fs.lstatSync(p)
    if (!st.isDirectory()) return st.size
    return fs.readdirSync(p).reduce((sum, name) => sum + size(path.join(p, name)), 0)
  } catch {
    return 0
  }
}

export function sweepDeps(deps, { ageMinutes = 60, dryRun = false, now = Date.now(), commands = '' } = {}) {
  const result = { deps, removed: 0, bytes: 0, kept: 0, inUse: false, errors: [] }
  if (commands.includes(deps)) {
    result.inUse = true
    return result
  }
  const groups = new Map()
  for (const name of fs.readdirSync(deps)) {
    const key = artifactKey(name)
    if (!key) continue
    try {
      const mtime = fs.lstatSync(path.join(deps, name)).mtimeMs
      groups.set(key, [...(groups.get(key) || []), { name, mtime }])
    } catch {}
  }
  for (const files of groups.values()) {
    files.sort((a, b) => b.mtime - a.mtime)
    result.kept++
    for (const old of files.slice(1)) {
      if (now - old.mtime < ageMinutes * 60_000) {
        result.kept++
        continue
      }
      const p = path.join(deps, old.name)
      const bytes = size(p)
      if (!dryRun) {
        try {
          fs.rmSync(p, { recursive: true, force: true })
        } catch (error) {
          result.errors.push(`${old.name}: ${error.message}`)
          continue
        }
      }
      result.removed++
      result.bytes += bytes
    }
  }
  return result
}

function commandLines() {
  const ps = spawnSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return ps.status === 0 ? ps.stdout : ''
}

export const FLOOR_GIB = 18

/** The newest mtime of `dir`, its entries and theirs (two levels deep), stopping as soon as one reaches `since`. */
export function newestWrite(dir, since = Infinity) {
  let newest = fs.lstatSync(dir).mtimeMs
  const entries = (d) => {
    try {
      return fs.readdirSync(d)
    } catch {
      return []
    }
  }
  for (const a of entries(dir)) {
    if (newest >= since) return newest
    const pa = path.join(dir, a)
    let st
    try {
      st = fs.lstatSync(pa)
    } catch {
      continue // gone meanwhile
    }
    newest = Math.max(newest, st.mtimeMs)
    if (!st.isDirectory()) continue
    for (const b of entries(pa)) {
      if (newest >= since) return newest
      try {
        newest = Math.max(newest, fs.lstatSync(path.join(pa, b)).mtimeMs)
      } catch {}
    }
  }
  return newest
}

/**
 * Seats by worktree folder, from the roster's resource_identity_ref lines
 * ("Mac ~/heddle--integrator-one, ~/heddle--int-backend" gives both folders to integrator-one).
 */
export function rosterOwners(text) {
  const owners = new Map()
  let key = null
  for (const line of text.split('\n')) {
    const k = /^\s*- key:\s*['"]?([\w.-]+)/.exec(line)
    if (k) key = k[1]
    const ref = /^\s*resource_identity_ref:\s*(.*)$/.exec(line)
    if (ref && key) for (const m of ref[1].matchAll(/~\/([\w.-]+)/g)) owners.set(m[1], key)
  }
  return owners
}

/**
 * The seat that owns a worktree. Its top folder under `parent` (the outer worktree of a nested one) is looked up in
 * the roster, as is the seat folder it extends (heddle--developer-eight-b10 is developer-eight's); then a
 * hd/<seat>[-topic] branch names a roster seat; else the top folder's own name stands.
 */
export function ownerOf(wtPath, { parent, branch = '', roster = new Map() } = {}) {
  const top = parent && wtPath.startsWith(parent + '/') ? wtPath.slice(parent.length + 1).split('/')[0] : path.basename(wtPath)
  const longest = (name, keys) =>
    [...keys].filter((k) => name === k || name.startsWith(k + '-')).sort((a, b) => b.length - a.length)[0]
  const folder = longest(top, roster.keys())
  if (folder) return roster.get(folder)
  const seat = branch.startsWith('hd/') ? longest(branch.slice(3), new Set(roster.values())) : null
  return seat || top
}

const hm = (minutes) => `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`

function duKiB(dir) {
  const du = spawnSync('du', ['-sk', dir], { encoding: 'utf8', timeout: 300_000 })
  const kib = Number((du.stdout || '').split(/\s+/)[0])
  return Number.isFinite(kib) && du.stdout ? kib : null
}

/**
 * Under the floor, remove each worktree's rust/target/debug that nothing wrote for `ageMinutes` and no process holds,
 * oldest first. The process list is read again just before the removals, so a build that started while the sizes
 * were measured keeps its folder. `worktrees` is listWorktrees' list, the main worktree first.
 */
export function floorSweep({
  worktrees,
  floorGiB = FLOOR_GIB,
  ageMinutes = 30,
  dryRun = false,
  now = Date.now(),
  free = freeBytes(worktrees[0].path),
  holds = processHolds(),
  refreshHolds = processHolds,
  roster = new Map(),
}) {
  const result = { floorGiB, ageMinutes, free, freeAfter: free, under: false, removed: [], young: [], held: [], errors: [] }
  if (free === null) {
    result.errors.push('the free disk space could not be read, so nothing was removed')
    return result
  }
  result.under = free < floorGiB * 1024 ** 3
  if (!result.under) return result
  if (!holds) {
    result.errors.push('the process list (ps, lsof) could not be read, so nothing was removed')
    return result
  }
  const parent = path.dirname(worktrees[0].path)
  const idle = []
  for (const wt of worktrees) {
    const dir = path.join(wt.path, 'rust', 'target', 'debug')
    try {
      if (!fs.lstatSync(dir).isDirectory()) continue // a link is not a target to remove
    } catch {
      continue
    }
    const owner = ownerOf(wt.path, { parent, branch: wt.branch, roster })
    const newest = newestWrite(dir, now - ageMinutes * 60_000)
    if (now - newest < ageMinutes * 60_000) result.young.push(owner)
    else if (heldBy(dir, holds)) result.held.push(owner)
    else idle.push({ dir, owner, idleMinutes: Math.floor((now - newest) / 60_000) })
  }
  idle.sort((a, b) => b.idleMinutes - a.idleMinutes)
  for (const d of idle) d.kib = duKiB(d.dir)
  const fresh = idle.length && !dryRun ? refreshHolds() : holds
  if (!fresh) {
    result.errors.push('the process list (ps, lsof) could not be read again, so nothing was removed')
    return result
  }
  for (const d of idle) {
    if (heldBy(d.dir, fresh)) {
      result.held.push(d.owner)
      continue
    }
    if (!dryRun) {
      try {
        fs.rmSync(d.dir, { recursive: true, force: true })
      } catch (error) {
        result.errors.push(`${d.dir}: ${error.message}`)
        continue
      }
    }
    result.removed.push(d)
  }
  result.freeAfter = freeBytes(worktrees[0].path) ?? free
  return result
}

export function renderFloor(r, dryRun) {
  const head = `deps-sweep --floor: disk ${gib(r.free)} GiB free`
  if (r.free === null) return [`deps-sweep --floor: free disk unknown`, ...r.errors.map((e) => `  error: ${e}`)].join('\n')
  if (!r.under) return `${head}, at or above the ${r.floorGiB} GiB floor: nothing removed`
  const kib = r.removed.reduce((n, d) => n + (d.kib || 0), 0)
  const lines = [
    `${head}, under the ${r.floorGiB} GiB floor: ${dryRun ? 'would remove' : 'removed'} ${r.removed.length} rust/target/debug ` +
      `folder(s) unwritten for ${r.ageMinutes}+ minutes, ${gib(kib * 1024)} GiB; disk ${gib(r.freeAfter)} GiB free after. ` +
      'Owners are not told: tell them.',
  ]
  for (const d of r.removed)
    lines.push(`  ${dryRun ? 'would remove' : 'removed'} ${d.dir} (owner ${d.owner}, unwritten ${hm(d.idleMinutes)}, ${d.kib === null ? '?' : gib(d.kib * 1024)} GiB)`)
  if (r.young.length) lines.push(`  kept, written in the last ${r.ageMinutes} minutes: ${r.young.join(', ')}`)
  if (r.held.length) lines.push(`  kept, held by a process: ${r.held.join(', ')}`)
  for (const e of r.errors) lines.push(`  error: ${e}`)
  return lines.join('\n')
}

function worktreeTargets() {
  const r = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  return (r.stdout || '')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => path.join(l.slice(9), 'rust', 'target'))
    .filter((t) => fs.existsSync(t))
}

export function main(argv) {
  const opt = { ageMinutes: null, dryRun: false, quiet: false, targets: [], floor: false, floorGiB: FLOOR_GIB, repo: '.', roster: null }
  let afterBuild = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      afterBuild = argv.slice(i + 1)
      break
    } else if (a === '--dry-run') opt.dryRun = true
    else if (a === '--quiet') opt.quiet = true
    else if (a === '--after-build') afterBuild = afterBuild ?? []
    else if (a === '--all') opt.targets.push(...worktreeTargets())
    else if (a === '--target') opt.targets.push(path.resolve(argv[++i]))
    else if (a === '--age-minutes') opt.ageMinutes = Number(argv[++i])
    else if (a === '--floor') opt.floor = true
    else if (a === '--floor-gib') opt.floorGiB = Number(argv[++i])
    else if (a === '--repo') opt.repo = argv[++i]
    else if (a === '--roster') opt.roster = argv[++i]
    else {
      console.error(
        'usage: deps-sweep [--target <dir> | --all] [--age-minutes <n>] [--dry-run] [--after-build -- <cargo args>]\n' +
          '       deps-sweep --floor [--floor-gib <n>] [--age-minutes <n>] [--repo <dir>] [--roster <TEAM.yaml>] [--dry-run]',
      )
      return 64
    }
  }
  if (opt.floor) return floorMain(opt)
  opt.ageMinutes ??= 60
  if (afterBuild) opt.targets.push(...targetsFor(afterBuild))
  if (!Number.isFinite(opt.ageMinutes) || opt.ageMinutes < 0) return 64
  if (!opt.targets.length && !afterBuild) opt.targets.push(...targetsFor([]))
  const commands = commandLines()
  let errors = 0
  for (const target of opt.targets) {
    const all = depsDirs(target).map((d) => sweepDeps(d, { ageMinutes: opt.ageMinutes, dryRun: opt.dryRun, commands }))
    errors += all.reduce((n, r) => n + r.errors.length, 0)
    const removed = all.reduce((n, r) => n + r.removed, 0)
    const mb = (all.reduce((n, r) => n + r.bytes, 0) / 1e6).toFixed(0)
    const busy = all.filter((r) => r.inUse).map((r) => path.relative(target, r.deps))
    if (!opt.quiet || removed)
      console.log(
        `deps-sweep: ${target}: ${opt.dryRun ? 'would remove' : 'removed'} ${removed} superseded heddle artifact(s), ${mb} MB` +
          (busy.length ? `; skipped ${busy.join(', ')} (in use)` : ''),
      )
  }
  return errors ? 1 : 0
}

/** The roster read for owners: --roster, else the team's TEAM.yaml when this Mac has it; no roster is no error. */
const DEFAULT_ROSTER = path.join(os.homedir(), 'reflection', '_projects_', 'heddle', 'TEAM.yaml')

function floorMain(opt) {
  opt.ageMinutes ??= 30
  if (!Number.isFinite(opt.ageMinutes) || opt.ageMinutes < 0 || !Number.isFinite(opt.floorGiB) || opt.floorGiB < 0 || !opt.repo) {
    console.error('deps-sweep: --age-minutes and --floor-gib need numbers, --repo a repository')
    return 64
  }
  const worktrees = listWorktrees(path.resolve(opt.repo))
  if (!worktrees?.length) {
    console.error(`deps-sweep --floor: ${opt.repo}: git worktree list failed`)
    return 1
  }
  let roster = new Map()
  const rosterFile = opt.roster ?? (fs.existsSync(DEFAULT_ROSTER) ? DEFAULT_ROSTER : null)
  if (rosterFile) {
    try {
      roster = rosterOwners(fs.readFileSync(rosterFile, 'utf8'))
    } catch (error) {
      console.error(`deps-sweep --floor: roster ${rosterFile}: ${error.message}`)
      return 64
    }
  }
  const r = floorSweep({ worktrees, floorGiB: opt.floorGiB, ageMinutes: opt.ageMinutes, dryRun: opt.dryRun, roster })
  console.log(renderFloor(r, opt.dryRun))
  return r.errors.length ? 1 : 0
}

const invoked = process.argv[1] && fs.realpathSync(process.argv[1])
if (invoked === fs.realpathSync(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)))
