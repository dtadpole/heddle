import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import {
  ERROR,
  OK,
  REFUSED,
  isLogPath,
  parseStatus,
  planSync,
  sync,
  unionLines,
} from '../../reflection-sync.mjs'

const SCRIPT = join(import.meta.dirname, '..', '..', 'reflection-sync.mjs')

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd } })
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

function configure(dir) {
  git(dir, ['config', 'user.name', 'D.Tadpole'])
  git(dir, ['config', 'user.email', 'gsk390@gmail.com'])
}

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

// origin main + three clones: seed (the base), shared (the checkout under test), other
// (the session that pushes while shared is behind).
function world(t) {
  const root = mkdtempSync(join(tmpdir(), 'reflection-sync-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const origin = join(root, 'origin.git')
  git(root, ['init', '--bare', '-q', '--initial-branch=main', 'origin.git'])
  const seed = join(root, 'seed')
  git(root, ['clone', '-q', origin, 'seed'])
  configure(seed)
  write(seed, 'README.md', 'base\n')
  write(seed, 'a.md', 'one\n')
  write(seed, 'b.md', 'b\n')
  write(seed, '_logs_/review.jsonl', 'first\nsecond\n')
  git(seed, ['add', '-A'])
  git(seed, ['commit', '-q', '-m', 'base'])
  git(seed, ['push', '-q', '-u', 'origin', 'main'])

  const shared = join(root, 'shared')
  git(root, ['clone', '-q', origin, 'shared'])
  configure(shared)
  const other = join(root, 'other')
  git(root, ['clone', '-q', origin, 'other'])
  configure(other)
  return { root, origin, shared, other, backup: join(root, 'backups') }
}

function pushFrom(w, files, message = 'change') {
  for (const [path, content] of Object.entries(files)) write(w.other, path, content)
  git(w.other, ['add', '-A'])
  git(w.other, ['commit', '-q', '-m', message])
  git(w.other, ['push', '-q', 'origin', 'main'])
}

const options = (w, extra = {}) => ({ repo: w.shared, branch: 'main', remote: 'origin', backupRoot: w.backup, ...extra })
const head = (w) => git(w.shared, ['rev-parse', 'HEAD'])
const remoteHead = (w) => git(w.origin, ['rev-parse', 'main'])
const read = (w, path) => readFileSync(join(w.shared, path), 'utf8')
const run = (w, extra = {}) => sync(options(w, extra))

test('the status parser reads both tree states and an untracked path', () => {
  const entries = parseStatus(' M a.md\x00A  e.md\x00?? d.md\x00R  new.md\x00old.md\x00')
  assert.deepEqual(entries.map((e) => [e.path, e.index, e.worktree, e.untracked]), [
    ['a.md', ' ', 'M', false],
    ['e.md', 'A', ' ', false],
    ['d.md', '?', '?', true],
    ['new.md', 'R', ' ', false],
  ])
})

test('an append-only log unions the remote lines with the local extras', () => {
  assert.equal(unionLines(Buffer.from('a\nb\nc\n'), Buffer.from('a\nb\nx\n')).toString(), 'a\nb\nc\nx\n')
  assert.equal(unionLines(Buffer.from('a\n'), Buffer.from('a\n')).toString(), 'a\n', 'nothing to add')
  assert.equal(unionLines(null, Buffer.from('x\n')).toString(), 'x\n')
  assert.equal(unionLines(Buffer.from('a\n'), null).toString(), 'a\n')
  assert.ok(isLogPath('_logs_/review.jsonl'))
  assert.ok(isLogPath('_projects_/x/_context_/team-operations/execution-review-log.jsonl'))
  assert.equal(isLogPath('src/page.html'), false)
})

test('the plan classifies every kind of local work', () => {
  const content = (map) => (path) => (path in map ? Buffer.from(map[path]) : null)
  const plan = planSync({
    entries: [
      { path: 'staged.md', index: 'A', worktree: ' ', untracked: false },
      { path: 'same.md', index: ' ', worktree: 'M', untracked: false },
      { path: 'edited.md', index: ' ', worktree: 'M', untracked: false },
      { path: 'untouched.md', index: ' ', worktree: 'M', untracked: false },
      { path: '_logs_/log.jsonl', index: ' ', worktree: 'M', untracked: false },
      { path: 'untracked-same.md', index: '?', worktree: '?', untracked: true },
      { path: 'untracked-different.md', index: '?', worktree: '?', untracked: true },
    ],
    changed: new Set(['same.md', 'edited.md', '_logs_/log.jsonl', 'untracked-same.md', 'untracked-different.md']),
    headContent: content({}),
    remoteContent: content({ 'same.md': 'remote', 'edited.md': 'remote', '_logs_/log.jsonl': 'remote', 'untracked-same.md': 'same' }),
    workContent: content({ 'same.md': 'remote', 'untracked-same.md': 'same', 'untracked-different.md': 'mine', 'edited.md': 'mine' }),
    unionLogs: true,
  })
  assert.deepEqual(plan.blockers.map((b) => b.path).sort(), ['edited.md', 'staged.md', 'untracked-different.md'])
  assert.deepEqual(plan.actions.map((a) => a.kind).sort(), ['move-aside', 'refresh', 'union'])
  assert.deepEqual(plan.kept, ['untouched.md'])
})

test('an up-to-date checkout is left alone', (t) => {
  const w = world(t)
  const r = run(w)
  assert.equal(r.code, OK, r.lines.join('\n'))
  assert.match(r.lines.join('\n'), /already up to date/)
  assert.equal(head(w), remoteHead(w))
})

test('a clean checkout fast-forwards and the new tip is read back', (t) => {
  const w = world(t)
  pushFrom(w, { 'c.md': 'new\n' })
  const before = head(w)
  const target = remoteHead(w)
  const r = run(w)
  assert.equal(r.code, OK, r.lines.join('\n'))
  assert.equal(head(w), target)
  assert.notEqual(head(w), before)
  assert.equal(read(w, 'c.md'), 'new\n')
  assert.match(r.lines.join('\n'), new RegExp(`read back HEAD and origin/main at ${target.slice(0, 7)}`))
})

test('a checkout with its own commit is refused and unchanged', (t) => {
  const w = world(t)
  write(w.shared, 'mine.md', 'mine\n')
  git(w.shared, ['add', 'mine.md'])
  git(w.shared, ['commit', '-q', '-m', 'mine'])
  pushFrom(w, { 'c.md': 'new\n' })
  const before = head(w)
  const r = run(w)
  assert.equal(r.code, REFUSED, r.lines.join('\n'))
  assert.match(r.lines.join('\n'), /commit\(s\) the remote lacks/)
  assert.equal(head(w), before)
})

test('a staged change is refused before the merge', (t) => {
  const w = world(t)
  write(w.shared, 'staged.md', 'staged\n')
  git(w.shared, ['add', 'staged.md'])
  pushFrom(w, { 'c.md': 'new\n' })
  const before = head(w)
  const r = run(w)
  assert.equal(r.code, REFUSED, r.lines.join('\n'))
  assert.match(r.lines.join('\n'), /staged change/)
  assert.equal(head(w), before)
  assert.equal(read(w, 'staged.md'), 'staged\n')
})

test('a local edit the remote also changes, differing, is refused untouched', (t) => {
  const w = world(t)
  write(w.shared, 'a.md', 'local edit\n')
  pushFrom(w, { 'a.md': 'remote edit\n' })
  const before = head(w)
  const r = run(w)
  assert.equal(r.code, REFUSED, r.lines.join('\n'))
  assert.match(r.lines.join('\n'), /local edit differs/)
  assert.equal(head(w), before)
  assert.equal(read(w, 'a.md'), 'local edit\n')
})

test('a local edit the remote does not touch survives the fast-forward', (t) => {
  const w = world(t)
  write(w.shared, 'b.md', 'local b\n')
  pushFrom(w, { 'c.md': 'new\n' })
  const r = run(w)
  assert.equal(r.code, OK, r.lines.join('\n'))
  assert.equal(head(w), remoteHead(w))
  assert.equal(read(w, 'b.md'), 'local b\n')
  assert.match(r.lines.join('\n'), /kept 1 unrelated local edit/)
})

test('a local edit already equal to the remote version is refreshed, not a refusal', (t) => {
  const w = world(t)
  write(w.shared, 'a.md', 'same result\n')
  pushFrom(w, { 'a.md': 'same result\n' })
  const r = run(w)
  assert.equal(r.code, OK, r.lines.join('\n'))
  assert.equal(head(w), remoteHead(w))
  assert.equal(read(w, 'a.md'), 'same result\n')
})

test('an untracked copy identical to the remote addition is moved aside, not lost', (t) => {
  const w = world(t)
  write(w.shared, 'd.md', 'same\n')
  pushFrom(w, { 'd.md': 'same\n' })
  const r = run(w)
  assert.equal(r.code, OK, r.lines.join('\n'))
  assert.equal(read(w, 'd.md'), 'same\n')
  assert.equal(head(w), remoteHead(w))
  const stamps = readdirSync(w.backup)
  assert.equal(stamps.length, 1)
  assert.ok(existsSync(join(w.backup, stamps[0], 'd.md')), 'the moved copy was kept under the backup root')
})

test('an untracked copy that differs from the remote addition is refused untouched', (t) => {
  const w = world(t)
  write(w.shared, 'd.md', 'mine\n')
  pushFrom(w, { 'd.md': 'theirs\n' })
  const before = head(w)
  const r = run(w)
  assert.equal(r.code, REFUSED, r.lines.join('\n'))
  assert.match(r.lines.join('\n'), /untracked file would be overwritten/)
  assert.equal(head(w), before)
  assert.equal(read(w, 'd.md'), 'mine\n')
})

test('an append to the review log unions both lines instead of blocking the sync', (t) => {
  const w = world(t)
  write(w.shared, '_logs_/review.jsonl', 'first\nsecond\nlocal append\n')
  pushFrom(w, { '_logs_/review.jsonl': 'first\nsecond\nremote append\n' })
  const r = run(w)
  assert.equal(r.code, OK, r.lines.join('\n'))
  const lines = read(w, '_logs_/review.jsonl').trim().split('\n')
  assert.deepEqual(lines.sort(), ['first', 'local append', 'remote append', 'second'].sort())
  assert.equal(head(w), remoteHead(w))
})

test('the union can be turned off, and then the same log blocks the sync', (t) => {
  const w = world(t)
  write(w.shared, '_logs_/review.jsonl', 'first\nsecond\nlocal append\n')
  pushFrom(w, { '_logs_/review.jsonl': 'first\nsecond\nremote append\n' })
  const before = head(w)
  const r = run(w, { unionLogs: false })
  assert.equal(r.code, REFUSED, r.lines.join('\n'))
  assert.match(r.lines.join('\n'), /local edit differs/)
  assert.equal(head(w), before)
  assert.equal(read(w, '_logs_/review.jsonl'), 'first\nsecond\nlocal append\n')
})

test('a dry run reports the plan and moves nothing', (t) => {
  const w = world(t)
  pushFrom(w, { 'c.md': 'new\n' })
  const before = head(w)
  const r = run(w, { dryRun: true })
  assert.equal(r.code, OK, r.lines.join('\n'))
  assert.match(r.lines.join('\n'), /dry run: would fast-forward/)
  assert.equal(head(w), before)
  assert.equal(existsSync(join(w.shared, 'c.md')), false)
})

test('a path that is not a checkout is an error', () => {
  const r = sync({ repo: join(tmpdir(), 'not-a-repo-' + process.pid) })
  assert.equal(r.code, ERROR)
  assert.match(r.lines.join('\n'), /not a git checkout/)
})

test('the command exits 0 when it fast-forwarded and 2 when it refused', (t) => {
  const w = world(t)
  pushFrom(w, { 'c.md': 'new\n' })
  const cli = (extra = []) =>
    spawnSync(process.execPath, [SCRIPT, '--repo', w.shared, '--backup', w.backup, ...extra], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: w.root },
    })
  const ok = cli()
  assert.equal(ok.status, OK, ok.stdout + ok.stderr)
  assert.match(ok.stdout, /fast-forwarded/)

  write(w.shared, 'a.md', 'local edit\n')
  pushFrom(w, { 'a.md': 'remote edit\n' })
  const refused = cli()
  assert.equal(refused.status, REFUSED, refused.stdout + refused.stderr)
  assert.match(refused.stdout, /refusing/)
})
