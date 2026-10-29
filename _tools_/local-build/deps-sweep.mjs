#!/usr/bin/env node
// Remove superseded heddle build artifacts from a cargo target's deps folders.
//
//   _tools_/local-build/deps-sweep [--target <dir>] [--age-minutes 60] [--dry-run]
//   _tools_/local-build/deps-sweep --all                  every worktree of this repository (git worktree list)
//   deps-sweep.mjs --after-build -- <cargo args>          the slot runner, after a successful cargo command
//
// Each build leaves new hashed heddle test binaries and rlibs in target/<profile>/deps and never removes the
// old ones. An artifact named [lib]heddle<crate>-<16 hex>[.ext] is removed when a newer one with the same name
// and extension exists and it is older than the age, so a crate whose lib and bin tests share a name is not
// rebuilt over and over. Third-party crates are left alone, and so is a deps folder a running process names.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

function worktreeTargets() {
  const r = spawnSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  return (r.stdout || '')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => path.join(l.slice(9), 'rust', 'target'))
    .filter((t) => fs.existsSync(t))
}

export function main(argv) {
  const opt = { ageMinutes: 60, dryRun: false, quiet: false, targets: [] }
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
    else {
      console.error('usage: deps-sweep [--target <dir> | --all] [--age-minutes <n>] [--dry-run] [--after-build -- <cargo args>]')
      return 64
    }
  }
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

const invoked = process.argv[1] && fs.realpathSync(process.argv[1])
if (invoked === fs.realpathSync(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)))
