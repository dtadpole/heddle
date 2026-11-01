// What tmp-sweep --worktrees and deps-sweep --floor share: what running processes hold, so a sweep never removes a
// folder in use (every command line, and the path of every open file and working folder, from lsof), the free
// disk, and the repository's worktrees.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** `git worktree list --porcelain` parsed: { path, head, branch, locked, prunable }; the first is the main one. */
export function listWorktrees(repo) {
  const r = spawnSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (r.status !== 0) return null
  const list = []
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) list.push({ path: line.slice(9) })
    else if (!list.length) continue
    else if (line.startsWith('HEAD ')) list.at(-1).head = line.slice(5)
    else if (line.startsWith('branch ')) list.at(-1).branch = line.slice(7).replace(/^refs\/heads\//, '')
    else if (line === 'locked' || line.startsWith('locked ')) list.at(-1).locked = true
    else if (line === 'prunable' || line.startsWith('prunable ')) list.at(-1).prunable = true
  }
  return list
}

/**
 * `{ commands, paths }`: the command lines of every process (ps) and the paths every process has open, its working
 * folder and executable included (lsof -F n, the n lines that are paths). Null when either list cannot be read: a
 * sweep then removes nothing, since it cannot tell what is in use. lsof can exit 1 and still print the list, so its
 * output is judged, not its status.
 */
export function processHolds() {
  const ps = spawnSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const lsof = spawnSync('lsof', ['-n', '-w', '-F', 'n'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 120_000 })
  if (ps.status !== 0 || lsof.error || lsof.signal || !lsof.stdout) return null
  const paths = lsof.stdout
    .split('\n')
    .filter((line) => line.startsWith('n/'))
    .map((line) => line.slice(1))
  return paths.length ? { commands: ps.stdout, paths } : null
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function real(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * Why a process holds `dir`: 'open file' when an open file or working folder lies inside it, 'command line' when a
 * command line names it (as a whole path: /tmp/a does not match /tmp/ab), else null. Both the given and the real path
 * are tried, since lsof prints real paths (/private/tmp) and a command line may not.
 */
export function heldBy(dir, holds) {
  for (const form of new Set([path.resolve(dir), real(dir)])) {
    if (holds.paths.some((p) => p === form || p.startsWith(form + '/'))) return 'open file'
    if (new RegExp(`${escape(form)}(?![\\w.-])`).test(holds.commands)) return 'command line'
  }
  return null
}

/** Free space for this user on the disk holding `p`, in bytes (the Avail of df). Null when it cannot be read. */
export function freeBytes(p) {
  try {
    const st = fs.statfsSync(p)
    return st.bavail * st.bsize
  } catch {
    return null
  }
}

export const gib = (bytes) => (bytes === null ? '?' : (bytes / 1024 ** 3).toFixed(1))
