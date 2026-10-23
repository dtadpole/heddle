#!/usr/bin/env node
// Commit record edits without losing another writer's entries.
//
//   node _tools_/record-commit/record-commit.mjs --repo ~/reflection \
//     --message "record: ..." --file _projects_/x/note.md
//   node _tools_/record-commit/record-commit.mjs --repo ~/reflection \
//     --message "record: ..." --staged /tmp/record-edits [--base /tmp/record-base]
//
// The reflection tree is written by several sessions at once, so a commit made in a
// lagging checkout can silently replace content that landed meanwhile. This tool never
// commits in the live checkout: it fetches, creates a temporary worktree at the fetched
// origin/main, copies only the staged files there, checks each one's base against
// origin, unions append-only logs, runs the frontmatter validator over the whole tree,
// commits with explicit paths, pushes to main, reads the pushed bytes back from
// origin/main, and only then fast-forwards the live tree with reflection-sync.
//
// Input (exactly one of):
//   --file REL     a path in the live checkout; its base is HEAD:REL
//   --staged DIR   a staging tree; each file's path is its path under DIR; its base is
//                  --base DIR/REL when given, else HEAD:REL of the live checkout
//   --base DIR     the pre-edit tree for --staged, used for the stale-base check
//   --append PATH  treat PATH as append-only even if it does not match the log pattern
//
// A normal file is refused when its base is not byte-equal to origin/main's version:
// that edit was made on content origin no longer has. An append-only log is never
// refused on that ground and never replaced: origin's lines are kept and the new lines
// are added, and every line of both is verified present in what was pushed.
//
// A record commit carries every file it is given, or none. A given file that would not
// change origin/main (its content already equal, or every one of its log lines already
// there) refuses the whole run before anything is committed: silently committing the
// rest is how two of three files once went missing with an exit 0.
//
//   0  committed, read back, live tree synced (or --no-sync)
//   1  refused before the commit: stale base, validator, bad arguments
//   2  the record would not carry every given file (refused, nothing committed), or the
//      pushed commit does not carry it as expected
//   3  committed and read back, but the live tree could not be synced
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const OK = 0
export const REFUSED = 1
export const READ_BACK_FAILED = 2
export const INCOMPLETE = 2
export const SYNC_REFUSED = 3

export const IDENTITY = { name: 'D.Tadpole', email: 'gsk390@gmail.com' }
export const LOG_PATTERN = /(^|\/)_logs_\/.*\.jsonl$|(^|\/)execution-review-log\.jsonl$/i
export const VALIDATOR_PATH = 'shared/_tools_/frontmatter-validator/validate-frontmatter.py'

// shared/_conventions_/core-conventions/commit-messages.md: the types, and a commit that
// only appends to _logs_/ is log(...). No gate reads messages, so the tool warns.
export const COMMIT_TYPES = ['feat', 'fix', 'docs', 'test', 'refactor', 'perf', 'ci', 'chore', 'revert', 'log']

export function messageWarnings(message, paths = []) {
  const subject = String(message ?? '').split('\n')[0]
  const match = /^([a-z]+)(\([^)]+\))?!?: \S/.exec(subject)
  if (!match) {
    const loose = /^([A-Za-z]+)(\([^)]*\))?:/.exec(subject)
    const hint = loose && ['record', 'logs'].includes(loose[1].toLowerCase()) ? ` ('${loose[1]}' is spelled ${loose[1].toLowerCase() === 'logs' ? 'log' : 'docs or log'})` : ''
    return [`the message is not <type>(<scope>): <subject>${hint}`]
  }
  const warnings = []
  const type = match[1]
  if (!COMMIT_TYPES.includes(type)) {
    const hint = type === 'record' ? ': a record edit is docs(<scope>), a log-only commit is log(<scope>)' : type === 'logs' ? ': spelled log' : ''
    warnings.push(`'${type}' is not a commit type (${COMMIT_TYPES.join(', ')})${hint}`)
  }
  const logOnly = paths.length > 0 && paths.every((path) => /(^|\/)_logs_\//.test(path))
  if (logOnly && type !== 'log') warnings.push(`every path is under _logs_/, so the type is log(<scope>), not ${type}`)
  if (type === 'log' && !logOnly && paths.length > 0) warnings.push('log(<scope>) is for a commit that only appends to _logs_/; this one touches more')
  return warnings
}

export function isLogPath(path, extra = []) {
  return LOG_PATTERN.test(path) || extra.includes(path)
}

// The committed log is origin's lines in their order, then the staged lines origin
// lacks. Nothing origin already has can be dropped by the edit.
export function unionLines(origin, staged) {
  const base = origin ?? Buffer.alloc(0)
  if (staged === null) return base
  const text = base.toString('utf8')
  const lines = text.length === 0 ? [] : text.split('\n')
  const have = new Set(lines.filter((line) => line !== ''))
  const extra = staged
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '' && !have.has(line))
  if (extra.length === 0) return base
  const head = text === '' || text.endsWith('\n') ? text : `${text}\n`
  return Buffer.from(head + extra.map((line) => `${line}\n`).join(''), 'utf8')
}

const same = (a, b) => (a === null || b === null ? a === b : a.equals(b))

// What a file's base was, and what origin has now: a normal file must not replace a
// version its editor never saw.
export function baseCheck({ path, base, origin }) {
  if (same(base, origin)) return { ok: true, path }
  const baseShown = base === null ? 'absent' : `${base.length} byte(s)`
  const originShown = origin === null ? 'absent' : `${origin.length} byte(s)`
  return {
    ok: false,
    path,
    reason: `base does not match origin/main (base ${baseShown}, origin ${originShown}); the edit was made on a stale version`,
  }
}

// After the push: origin/main must be the commit, and every file must carry what was
// staged — byte-for-byte for a file, line-for-line (origin's and the staged ones) for
// an append-only log.
export function verifyLanded({ commit, originMain, files, readOrigin, committedPaths = null }) {
  const problems = []
  if (committedPaths !== null) {
    const missing = files.map((file) => file.path).filter((path) => !committedPaths.includes(path))
    if (missing.length > 0) {
      problems.push(`the commit carries ${files.length - missing.length} of the ${files.length} given file(s); not carried: ${missing.join(', ')}`)
    }
  }
  if (originMain !== commit) {
    problems.push(`origin/main is ${String(originMain).slice(0, 12)}, not the committed ${String(commit).slice(0, 12)}`)
  }
  for (const file of files) {
    const landed = readOrigin(file.path)
    if (landed === null) {
      problems.push(`${file.path}: origin/main does not have the file`)
      continue
    }
    if (!file.expected.equals(landed)) {
      problems.push(`${file.path}: origin/main does not carry the ${file.kind === 'log' ? 'unioned log' : 'staged bytes'}`)
      continue
    }
    if (file.kind === 'log') {
      const landedLines = new Set(landed.toString('utf8').split('\n').filter(Boolean))
      for (const line of file.content.toString('utf8').split('\n').filter(Boolean)) {
        if (!landedLines.has(line)) problems.push(`${file.path}: a staged line is missing from origin/main`)
      }
    }
  }
  return problems
}

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (result.error) throw new Error(`git ${args[0]} could not run: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.slice(0, 2).join(' ')} failed: ${String(result.stderr || '').trim()}`)
  }
  return result
}

function show(repo, rev, path) {
  const result = spawnSync('git', ['show', `${rev}:${path}`], { cwd: repo, encoding: null, maxBuffer: 256 * 1024 * 1024 })
  return result.status === 0 ? result.stdout : null
}

function readFileMaybe(path) {
  return existsSync(path) ? readFileSync(path) : null
}

function baseFromHead(repo, path) {
  const result = spawnSync('git', ['show', `HEAD:${path}`], { cwd: repo, encoding: null, maxBuffer: 256 * 1024 * 1024 })
  return result.status === 0 ? result.stdout : null
}

function listTree(root) {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push({ path: relative(root, full).split(sep).join('/'), full })
    }
  }
  walk(root)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

const safePath = (path) => !path.startsWith('/') && !path.split('/').includes('..') && path !== ''

export function collectFiles({ repo, staged, base, flagFiles = [] }) {
  const liveRoot = resolve(repo)
  const files = []
  if (staged) {
    const root = resolve(staged)
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`--staged ${staged} is not a directory`)
    for (const entry of listTree(root)) {
      if (!safePath(entry.path)) throw new Error(`--staged has an unsafe path ${entry.path}`)
      const baseContent = base ? readFileMaybe(join(resolve(base), entry.path)) : baseFromHead(liveRoot, entry.path)
      files.push({ path: entry.path, content: readFileSync(entry.full), mode: statSync(entry.full).mode & 0o777, base: baseContent })
    }
  }
  for (const flag of flagFiles) {
    const path = flag.split(sep).join('/')
    if (!safePath(path)) throw new Error(`--file ${flag} must be a path inside the checkout`)
    const full = join(liveRoot, path)
    if (!existsSync(full)) throw new Error(`--file ${flag} does not exist in ${liveRoot}`)
    files.push({ path, content: readFileSync(full), mode: statSync(full).mode & 0o777, base: baseFromHead(liveRoot, path) })
  }
  const seen = new Set()
  return files.filter((file) => {
    if (seen.has(file.path)) return false
    seen.add(file.path)
    return true
  })
}

function findPython(explicit) {
  for (const candidate of [explicit, process.env.PYTHON, '/opt/homebrew/bin/python3', 'python3', 'python'].filter(Boolean)) {
    const probe = spawnSync(candidate, ['-c', 'import yaml'], { stdio: 'ignore' })
    if (probe.status === 0) return candidate
  }
  return null
}

function cleanupWorktree(repo, root) {
  const removed = git(repo, ['worktree', 'remove', '--force', join(root, 'tree')], { allowFailure: true })
  if (removed.status !== 0) git(repo, ['worktree', 'prune'], { allowFailure: true })
  rmSync(root, { recursive: true, force: true })
}

function attempt({ config, report }) {
  const { repo, remote, branch, message, validator, python, noValidate, dryRun } = config
  git(repo, ['fetch', '-q', remote])
  const mainRef = `${remote}/${branch}`
  const originMain = git(repo, ['rev-parse', mainRef]).stdout.trim()
  report.push(`record-commit: ${config.files.length} file(s) from ${repo}, base ${mainRef} ${originMain.slice(0, 7)}`)

  const prepared = config.files.map((file) => {
    const origin = show(repo, originMain, file.path)
    const log = isLogPath(file.path, config.append)
    const expected = log ? unionLines(origin, file.content) : file.content
    // Equal to origin is checked before the base: if another writer already landed the
    // same bytes, the file is not stale, it is simply not this commit's to carry.
    const unchanged = origin !== null && expected.equals(origin)
    if (!log && !unchanged) {
      const check = baseCheck({ path: file.path, base: file.base, origin })
      if (!check.ok) return { ...file, kind: 'file', refused: check.reason }
    }
    return { ...file, kind: log ? 'log' : 'file', origin, expected, unchanged }
  })
  const refused = prepared.filter((file) => file.refused)
  if (refused.length > 0) {
    for (const file of refused) report.push(`  REFUSED ${file.path}: ${file.refused}`)
    return { code: REFUSED, files: prepared, report }
  }
  const unchanged = prepared.filter((file) => file.unchanged)
  if (unchanged.length > 0) {
    for (const file of unchanged) {
      const why =
        file.kind === 'log'
          ? 'every given line is already in origin/main'
          : 'its content already equals origin/main'
      report.push(`  UNCHANGED ${file.path}: ${why}, so the commit would not carry it (was the edit saved in ${repo}, or did another writer land it?)`)
    }
    report.push(
      `  refusing: ${unchanged.length} of ${prepared.length} given file(s) would not change; a record commit carries every file it is given or none. ` +
        'Nothing was committed; rerun without them if that is what you mean.',
    )
    return { code: INCOMPLETE, files: prepared, report }
  }
  for (const file of prepared) {
    const detail =
      file.kind === 'log'
        ? `union ${file.path} (${file.expected.toString('utf8').split('\n').filter(Boolean).length} line(s))`
        : `update ${file.path}`
    report.push(`  ${detail}`)
  }

  const root = mkdtempSync(join(tmpdir(), 'record-commit-'))
  const tmp = join(root, 'tree')
  try {
    git(repo, ['worktree', 'add', '--quiet', '--detach', tmp, originMain])
    for (const file of prepared) {
      const target = join(tmp, file.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.expected)
      if (file.mode !== 0) chmodSync(target, file.mode)
    }

    if (!noValidate) {
      // --validator is a runnable command; the default is the tree's own validator,
      // run with a python that can import PyYAML.
      let command
      let commandArgs
      if (validator) {
        if (!existsSync(validator)) {
          report.push(`  frontmatter: validator not found at ${validator}`)
          return { code: REFUSED, files: prepared, report }
        }
        command = validator
        commandArgs = ['--root', tmp]
      } else {
        const validatorPath = join(tmp, VALIDATOR_PATH)
        if (!existsSync(validatorPath)) {
          report.push(`  frontmatter: validator not found at ${validatorPath}`)
          return { code: REFUSED, files: prepared, report }
        }
        command = findPython(python)
        if (!command) {
          report.push('  frontmatter: no python with PyYAML found; pass --python or --no-validate')
          return { code: REFUSED, files: prepared, report }
        }
        commandArgs = [validatorPath, '--root', tmp]
      }
      const run = spawnSync(command, commandArgs, { cwd: tmp, encoding: 'utf8' })
      const lines = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().split('\n').filter(Boolean)
      const errors = lines.filter((line) => /^error\b/.test(line))
      const warnings = lines.filter((line) => /^warning\b/.test(line))
      const summary = lines.filter((line) => /^checked \d+ file\(s\)/.test(line))
      for (const line of errors) report.push(`  frontmatter: ${line}`)
      if (errors.length > 0 || run.status !== 0) {
        for (const line of lines.filter((l) => !/^warning\b/.test(l) && !/^checked \d/.test(l))) report.push(`  frontmatter: ${line}`)
        report.push('  frontmatter: the validator failed; nothing committed')
        return { code: REFUSED, files: prepared, report }
      }
      for (const line of summary) report.push(`  frontmatter: ${line}`)
      if (warnings.length > 0) {
        if (config.verbose) for (const line of warnings) report.push(`  frontmatter: ${line}`)
        else report.push(`  frontmatter: ${warnings.length} warning(s), none blocking (--verbose lists them)`)
      }
    }

    if (dryRun) {
      report.push(`  dry run: would commit ${prepared.length} file(s) and push ${mainRef}`)
      return { code: OK, files: prepared, report, dryRun: true }
    }

    const paths = prepared.map((file) => file.path)
    git(tmp, ['add', '--', ...paths])
    const stagedDiff = git(tmp, ['diff', '--cached', '--name-only'], { allowFailure: true })
    const stagedPaths = stagedDiff.stdout.split('\n').filter(Boolean)
    const notStaged = paths.filter((path) => !stagedPaths.includes(path))
    if (notStaged.length > 0) {
      // A safety net behind the unchanged check: git itself saw no change for these.
      report.push(`  refusing: git staged ${stagedPaths.length} of the ${paths.length} given file(s); not staged: ${notStaged.join(', ')}. Nothing was committed.`)
      return { code: INCOMPLETE, files: prepared, report }
    }
    git(tmp, ['-c', `user.name=${config.identity.name}`, '-c', `user.email=${config.identity.email}`, 'commit', '-q', '-m', message])
    const commit = git(tmp, ['rev-parse', 'HEAD']).stdout.trim()
    report.push(`  commit ${commit.slice(0, 7)}: ${message.split('\n')[0]}`)

    const push = git(tmp, ['push', '--porcelain', remote, `HEAD:refs/heads/${branch}`], { allowFailure: true })
    if (push.status !== 0) {
      // A rejection is a race only when the remote actually moved: fetch and compare
      // with the tip this attempt was built on. Anything else (a hook, auth, a lock) is
      // fatal, not something to retry around.
      git(tmp, ['fetch', '-q', remote], { allowFailure: true })
      const moved = git(tmp, ['rev-parse', mainRef], { allowFailure: true })
      const remoteTip = moved.status === 0 ? moved.stdout.trim() : originMain
      const retryable = remoteTip !== originMain
      const detail = `${push.stdout ?? ''}${push.stderr ?? ''}`.trim().split('\n').filter(Boolean).at(-1) ?? ''
      report.push(`  push rejected${retryable ? ' (the remote moved; rebuilding from a fresh origin)' : ''}: ${detail}`)
      return { code: retryable ? 'retry' : REFUSED, files: prepared, report }
    }
    git(tmp, ['fetch', '-q', remote])
    const landedMain = git(tmp, ['rev-parse', mainRef]).stdout.trim()
    const committedPaths = git(tmp, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commit]).stdout.split('\0').filter(Boolean)
    const problems = verifyLanded({
      commit,
      originMain: landedMain,
      files: prepared,
      readOrigin: (path) => show(tmp, mainRef, path),
      committedPaths,
    })
    if (problems.length > 0) {
      for (const problem of problems) report.push(`  READ-BACK ${problem}`)
      return { code: READ_BACK_FAILED, commit, files: prepared, report }
    }
    report.push(`  read back: ${mainRef} ${landedMain.slice(0, 7)} is the commit, and it carries all ${prepared.length} given file(s)`)
    return { code: OK, commit, files: prepared, report }
  } finally {
    cleanupWorktree(repo, root)
  }
}

function runSync({ repo, remote, branch, report }) {
  const tool = join(dirname(fileURLToPath(import.meta.url)), '..', 'reflection-sync', 'reflection-sync.mjs')
  if (!existsSync(tool)) {
    report.push(`  sync: reflection-sync not found at ${tool}`)
    return false
  }
  const result = spawnSync(process.execPath, [tool, '--repo', repo, '--remote', remote, '--branch', branch], { encoding: 'utf8' })
  for (const line of `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').filter(Boolean)) {
    report.push(`  sync: ${line}`)
  }
  return result.status === 0
}

export function recordCommit(config) {
  const report = []
  let last
  for (let tries = 0; tries <= (config.retries ?? 2); tries += 1) {
    last = attempt({ config, report })
    if (last.code !== 'retry') break
    if (tries === (config.retries ?? 2)) {
      last = { ...last, code: REFUSED }
      report.push('  push kept being rejected after the retry limit; nothing retried further')
    }
  }
  if (last.code !== OK) return { code: last.code, lines: report }
  if (last.dryRun) return { code: OK, lines: report }
  if (config.sync) {
    const synced = runSync({ repo: config.repo, remote: config.remote, branch: config.branch, report })
    if (!synced) {
      report.push('  sync: the record is committed and pushed; the live tree was not fast-forwarded, retry next pass')
      return { code: SYNC_REFUSED, lines: report }
    }
  } else {
    report.push('  sync: skipped by --no-sync')
  }
  return { code: OK, lines: report }
}

function parseArgs(argv) {
  const args = {
    repo: join(process.env.HOME ?? '', 'reflection'),
    remote: 'origin',
    branch: 'main',
    files: [],
    flagFiles: [],
    staged: null,
    base: null,
    append: [],
    message: null,
    validator: null,
    python: null,
    noValidate: false,
    noSync: false,
    dryRun: false,
    verbose: false,
    retries: 2,
    identity: IDENTITY,
    help: false,
  }
  const value = (i, name) => {
    const next = argv[i]
    if (next === undefined) throw new Error(`${name} needs a value`)
    return next
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--repo') args.repo = value((i += 1), '--repo')
    else if (arg === '--remote') args.remote = value((i += 1), '--remote')
    else if (arg === '--branch') args.branch = value((i += 1), '--branch')
    else if (arg === '--file') args.flagFiles.push(value((i += 1), '--file'))
    else if (arg === '--staged') args.staged = value((i += 1), '--staged')
    else if (arg === '--base') args.base = value((i += 1), '--base')
    else if (arg === '--append') args.append.push(value((i += 1), '--append'))
    else if (arg === '--message') args.message = value((i += 1), '--message')
    else if (arg === '--message-file') args.message = readFileSync(value((i += 1), '--message-file'), 'utf8')
    else if (arg === '--validator') args.validator = value((i += 1), '--validator')
    else if (arg === '--python') args.python = value((i += 1), '--python')
    else if (arg === '--no-validate') args.noValidate = true
    else if (arg === '--no-sync') args.noSync = true
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--verbose') args.verbose = true
    else if (arg === '--retries') args.retries = Number(value((i += 1), '--retries'))
    else if (arg === '--author') {
      const text = value((i += 1), '--author')
      const match = /^(.*)<([^>]+)>$/.exec(text)
      if (!match) throw new Error('--author needs "Name <email>"')
      args.identity = { name: match[1].trim(), email: match[2].trim() }
    } else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`)
  }
  if (args.message !== null) args.message = args.message.trim()
  return args
}

const USAGE = `usage: record-commit.mjs --message TEXT (--file PATH ... | --staged DIR [--base DIR]) [options]
  --repo DIR       the live checkout (default ~/reflection)
  --file PATH      a live-checkout path to commit; its base is HEAD:PATH
  --staged DIR     a staging tree; paths are relative to DIR
  --base DIR       the pre-edit tree for --staged (default: the live checkout's HEAD)
  --append PATH    treat PATH as append-only even if it is not a .jsonl log
  --validator PATH frontmatter validator (default: <tree>/shared/_tools/frontmatter-validator/validate-frontmatter.py)
  --python PATH    python with PyYAML (default: the first that imports yaml)
  --no-validate / --no-sync / --dry-run / --verbose / --retries N
  exit 0 committed and read back, 1 refused, 2 read-back failed, 3 live tree not synced`

// Node runs the main module from its real path, so compare real paths: through a symlink
// such as macOS /tmp the plain comparison was false and the command silently did nothing,
// which for the hygiene gate meant exit 0 with no judgement at all.
function invokedAsScript() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}

if (invokedAsScript()) {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
      console.log(USAGE)
      process.exitCode = OK
    } else if (!args.message) {
      console.error('record-commit: --message is required')
      process.exitCode = REFUSED
    } else if (args.staged && args.flagFiles.length > 0) {
      console.error('record-commit: use --staged or --file, not both')
      process.exitCode = REFUSED
    } else if (!args.staged && args.flagFiles.length === 0) {
      console.error('record-commit: give --file PATH or --staged DIR')
      process.exitCode = REFUSED
    } else {
      const files = collectFiles(args)
      if (files.length === 0) {
        console.error('record-commit: no files to commit')
        process.exitCode = REFUSED
      } else {
        for (const warning of messageWarnings(args.message, files.map((file) => file.path))) {
          console.error(`record-commit: warning: ${warning}`)
        }
        const result = recordCommit({ ...args, files, sync: !args.noSync })
        for (const line of result.lines) console.log(line)
        process.exitCode = result.code
      }
    }
  } catch (error) {
    console.error(`record-commit: ${error.message}`)
    process.exitCode = REFUSED
  }
}
