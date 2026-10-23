#!/usr/bin/env node
// Fast-forward a shared checkout to origin without touching anyone's in-progress work.
//
//   node _tools_/reflection-sync/reflection-sync.mjs              # ~/reflection, branch main
//   node _tools_/reflection-sync/reflection-sync.mjs --dry-run
//   node _tools_/reflection-sync/reflection-sync.mjs --repo DIR --branch main
//
// Several sessions share one checkout, so the checkout must never commit on its own
// branch: commits go through a temporary worktree at a fresh origin/main. This tool only
// moves the checkout forward, and only when doing so cannot overwrite another session:
//
//   - a local commit the remote lacks, a staged change, or an unmerged index is a refusal;
//   - a modified tracked file that the remote also changes, with content different from
//     the remote's, is a refusal (retry next pass, nobody's edit is stashed or dropped);
//   - an untracked file at a path the remote adds is moved aside only when it is
//     byte-identical to the remote's version, and is a refusal otherwise;
//   - an append-only log (.jsonl under _logs_, execution-review-log.jsonl) is the one
//     exception: the remote's lines and the local lines are unioned, so every line is
//     kept and the fast-forward is not blocked by another session's append.
//
//   0  fast-forwarded, or already up to date
//   1  could not run (not a repository, fetch or merge failed, detached HEAD)
//   2  refused: local work differs; nothing was changed
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const OK = 0
export const ERROR = 1
export const REFUSED = 2

const DEFAULT_LOG = /(^|\/)_logs_\/|(^|\/)execution-review-log\.jsonl$/i

export function isLogPath(path, pattern = DEFAULT_LOG) {
  return pattern.test(path)
}

// git status --porcelain=v1 -z: "XY path\0", and a rename or copy carries the source
// path in the next token.
export function parseStatus(output) {
  const entries = []
  const tokens = output.split('\0')
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (!token) continue
    const index = token[0]
    const worktree = token[1]
    const path = token.slice(3)
    entries.push({ path, index, worktree, untracked: index === '?' && worktree === '?' })
    if (index === 'R' || index === 'C') i += 1
  }
  return entries
}

const same = (a, b) => (a === null || b === null ? a === b : a.equals(b))

// Decide what a fast-forward from HEAD to the fetched remote tip would do to the
// working tree. `changed` is the set of paths the tip changes; the three content
// readers return Buffer or null.
export function planSync({ entries, changed, headContent, remoteContent, workContent, unionLogs = true, logPattern = DEFAULT_LOG }) {
  const blockers = []
  const actions = []
  const kept = []
  for (const entry of entries) {
    if (entry.untracked) {
      if (!changed.has(entry.path)) continue
      const local = workContent(entry.path)
      if (same(local, remoteContent(entry.path))) {
        actions.push({ kind: 'move-aside', path: entry.path })
      } else {
        blockers.push({ path: entry.path, reason: 'untracked file would be overwritten and differs from the remote' })
      }
      continue
    }
    if (entry.index !== ' ' && entry.index !== '?') {
      blockers.push({ path: entry.path, reason: 'staged change' })
      continue
    }
    if (entry.worktree === ' ' || entry.worktree === '?') continue
    if (!changed.has(entry.path)) {
      kept.push(entry.path)
      continue
    }
    const local = workContent(entry.path)
    const remote = remoteContent(entry.path)
    if (same(local, remote)) {
      actions.push({ kind: 'refresh', path: entry.path })
      continue
    }
    if (unionLogs && isLogPath(entry.path, logPattern)) {
      actions.push({ kind: 'union', path: entry.path })
      continue
    }
    void headContent
    blockers.push({ path: entry.path, reason: 'local edit differs from the remote version' })
  }
  return { blockers, actions, kept }
}

// Every line the remote has, in its order, then every local line the remote lacks.
export function unionLines(remote, local) {
  const origin = remote ?? Buffer.alloc(0)
  if (local === null) return origin
  const text = origin.toString('utf8')
  const lines = text.length === 0 ? [] : text.split('\n')
  const trailing = text.endsWith('\n') || text.length === 0
  const have = new Set(lines.filter((line) => line !== ''))
  const extra = local
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '' && !have.has(line))
  if (extra.length === 0) return origin
  const head = trailing ? text : `${text}\n`
  return Buffer.from(head + extra.map((line) => `${line}\n`).join(''), 'utf8')
}

export function describePlan(plan, { dryRun }) {
  const lines = []
  const counts = plan.actions.reduce((acc, action) => ({ ...acc, [action.kind]: (acc[action.kind] ?? 0) + 1 }), {})
  const parts = []
  for (const [kind, label] of [['refresh', 'stale file(s) to update'], ['move-aside', 'identical untracked file(s) to move aside'], ['union', 'append-only log(s) to union']]) {
    if (counts[kind]) parts.push(`${counts[kind]} ${label}`)
  }
  if (plan.kept.length) parts.push(`${plan.kept.length} unrelated local edit(s) kept`)
  lines.push(`plan: ${parts.length ? parts.join(', ') : 'nothing to change'}`)
  for (const action of plan.actions) lines.push(`  ${action.kind.padEnd(10)} ${action.path}`)
  for (const path of plan.kept) lines.push(`  keep       ${path}`)
  for (const blocker of plan.blockers) lines.push(`  REFUSED    ${blocker.path} (${blocker.reason})`)
  if (plan.blockers.length) lines.push(`${dryRun ? 'would refuse' : 'refusing'}: ${plan.blockers.length} path(s) carry work that differs from the remote; nothing was changed`)
  return lines.join('\n')
}

function git(cwd, args, { binary = false, allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: binary ? null : 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (result.error) throw new Error(`git ${args[0]} could not run: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.slice(0, 2).join(' ')} failed: ${String(result.stderr ?? '').trim()}`)
  }
  return result
}

function show(repo, rev, path) {
  const result = git(repo, ['show', `${rev}:${path}`], { binary: true, allowFailure: true })
  return result.status === 0 ? result.stdout : null
}

function readWork(repo, path) {
  const full = join(repo, path)
  return existsSync(full) ? readFileSync(full) : null
}

function writeWork(repo, path, content) {
  const full = join(repo, path)
  if (content === null) {
    rmSync(full, { force: true })
    return
  }
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

export function sync({
  repo = join(process.env.HOME ?? '', 'reflection'),
  branch = 'main',
  remote = 'origin',
  dryRun = false,
  unionLogs = true,
  backupRoot = join(tmpdir(), 'reflection-sync-backup'),
} = {}) {
  const report = []
  const full = resolve(repo)
  if (!existsSync(join(full, '.git'))) {
    return { code: ERROR, lines: [`reflection-sync: ${full} is not a git checkout`] }
  }
  const current = git(full, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true })
  if (current.status !== 0) {
    return { code: ERROR, lines: [`reflection-sync: ${full} has a detached HEAD; check it out on ${branch} first`] }
  }
  if (current.stdout.trim() !== branch) {
    return { code: ERROR, lines: [`reflection-sync: ${full} is on ${current.stdout.trim()}, not ${branch}`] }
  }
  const unmerged = git(full, ['diff', '--name-only', '--diff-filter=U'], { allowFailure: true })
  if (unmerged.stdout.trim()) {
    return { code: REFUSED, lines: ['reflection-sync: unmerged index entries; resolve them before syncing'] }
  }

  git(full, ['fetch', '-q', remote])
  const before = git(full, ['rev-parse', 'HEAD']).stdout.trim()
  const target = git(full, ['rev-parse', `${remote}/${branch}`]).stdout.trim()
  const ahead = Number(git(full, ['rev-list', '--count', `${remote}/${branch}..HEAD`]).stdout.trim())
  const behind = Number(git(full, ['rev-list', '--count', `HEAD..${target}`]).stdout.trim())
  report.push(`reflection-sync: ${full} on ${branch}, HEAD ${before.slice(0, 7)}, ${remote}/${branch} ${target.slice(0, 7)}, behind ${behind}, ahead ${ahead}`)
  if (ahead > 0) {
    return {
      code: REFUSED,
      lines: [...report, `refusing: the checkout has ${ahead} commit(s) the remote lacks; commit through a temporary worktree instead`],
    }
  }
  if (behind === 0) {
    return { code: OK, lines: [...report, `already up to date at ${target.slice(0, 7)}`] }
  }

  const status = parseStatus(git(full, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout)
  const changed = new Set(
    git(full, ['diff', '--name-only', '-z', `${before}..${target}`])
      .stdout.split('\0')
      .filter(Boolean),
  )
  const plan = planSync({
    entries: status,
    changed,
    headContent: (path) => show(full, before, path),
    remoteContent: (path) => show(full, target, path),
    workContent: (path) => readWork(full, path),
    unionLogs,
  })
  report.push(describePlan(plan, { dryRun }))
  if (plan.blockers.length > 0) return { code: REFUSED, lines: report }
  if (dryRun) return { code: OK, lines: [...report, `dry run: would fast-forward ${before.slice(0, 7)}..${target.slice(0, 7)}`] }

  const backup = join(backupRoot, stamp())
  const saved = []
  const refreshed = []
  const moved = []
  let succeeded = false
  try {
    for (const action of plan.actions) {
      const fullPath = join(full, action.path)
      if (action.kind === 'move-aside') {
        const dst = join(backup, action.path)
        mkdirSync(dirname(dst), { recursive: true })
        cpSync(fullPath, dst)
        rmSync(fullPath, { force: true })
        moved.push(action.path)
      } else if (action.kind === 'union' || action.kind === 'refresh') {
        const content = readWork(full, action.path)
        if (action.kind === 'union' && content !== null) {
          mkdirSync(dirname(join(backup, action.path)), { recursive: true })
          writeFileSync(join(backup, action.path), content)
        }
        if (action.kind === 'union') saved.push({ path: action.path, content })
        else refreshed.push({ path: action.path, content })
        // Put HEAD's version back so the fast-forward has nothing to overwrite. A
        // refresh is byte-identical to the target already; a union keeps its local
        // extras and is written back after the merge.
        git(full, ['checkout', '--', action.path], { allowFailure: true })
      }
    }
    const merge = git(full, ['merge', '--ff-only', '--quiet', target], { allowFailure: true })
    if (merge.status !== 0) {
      const text = String(merge.stderr ?? '').trim() || String(merge.stdout ?? '').trim()
      return { code: ERROR, lines: [...report, `fast-forward failed: ${text}`, `backups, if any, are under ${backup}`] }
    }
    for (const entry of saved) {
      const union = unionLines(show(full, target, entry.path), entry.content)
      writeWork(full, entry.path, union)
    }
    succeeded = true
  } finally {
    // If anything above failed, every file this run moved aside or checked out must be
    // as it was. On success the fast-forward holds the moved copies and the unions.
    if (!succeeded) {
      for (const entry of [...saved, ...refreshed]) writeWork(full, entry.path, entry.content)
      for (const path of moved) {
        if (!existsSync(join(full, path))) {
          const dst = join(backup, path)
          if (existsSync(dst)) {
            mkdirSync(dirname(join(full, path)), { recursive: true })
            cpSync(dst, join(full, path))
          }
        }
      }
    }
  }

  const after = git(full, ['rev-parse', 'HEAD']).stdout.trim()
  const remoteNow = git(full, ['rev-parse', `${remote}/${branch}`]).stdout.trim()
  if (after !== target || remoteNow !== target) {
    return { code: ERROR, lines: [...report, `read-back failed: HEAD ${after.slice(0, 7)}, ${remote}/${branch} ${remoteNow.slice(0, 7)}, expected ${target.slice(0, 7)}`] }
  }
  report.push(`fast-forwarded ${before.slice(0, 7)}..${after.slice(0, 7)}; read back HEAD and ${remote}/${branch} at ${after.slice(0, 7)}`)
  if (plan.kept.length) report.push(`kept ${plan.kept.length} unrelated local edit(s)`)
  if (plan.actions.some((a) => a.kind === 'union')) report.push(`unioned append-only log(s) under ${backup}`)
  if (plan.actions.some((a) => a.kind === 'move-aside')) report.push(`moved identical untracked file(s) to ${backup}`)
  return { code: OK, lines: report }
}

function parseArgs(argv) {
  // backupRoot is left undefined until --backup is given, so sync() applies its own
  // default; a null here would reach path.join and fail on the first backup.
  const args = { repo: join(process.env.HOME ?? '', 'reflection'), branch: 'main', remote: 'origin', dryRun: false, unionLogs: true, backupRoot: undefined, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--repo') args.repo = argv[++i]
    else if (arg === '--branch') args.branch = argv[++i]
    else if (arg === '--remote') args.remote = argv[++i]
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--no-union-logs') args.unionLogs = false
    else if (arg === '--backup') args.backupRoot = argv[++i]
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`)
  }
  return args
}

const USAGE = `usage: reflection-sync.mjs [--repo DIR] [--branch main] [--remote origin] [--dry-run] [--no-union-logs] [--backup DIR]
  exit 0 fast-forwarded or up to date, 1 could not run, 2 refused because local work differs`

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
      console.log(USAGE)
      process.exitCode = OK
    } else {
      const result = sync(args)
      for (const line of result.lines) console.log(line)
      process.exitCode = result.code
    }
  } catch (error) {
    console.error(`reflection-sync: ${error.message}`)
    process.exitCode = ERROR
  }
}
