import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import {
  OK,
  READ_BACK_FAILED,
  REFUSED,
  SYNC_REFUSED,
  baseCheck,
  collectFiles,
  isLogPath,
  unionLines,
  verifyLanded,
} from '../../record-commit.mjs'

const TOOL = join(import.meta.dirname, '..', '..', 'record-commit.mjs')

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

const read = (root, path) => readFileSync(join(root, path), 'utf8')

// A bare origin, a seed that makes the base commit, and three clones of it: live (the
// checkout the coordinator edits), writer (another session that pushes meanwhile), and
// nothing else.
function world(t) {
  const root = mkdtempSync(join(tmpdir(), 'record-commit-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const origin = join(root, 'origin.git')
  git(root, ['init', '--bare', '-q', '--initial-branch=main', 'origin.git'])
  const seed = join(root, 'seed')
  git(root, ['clone', '-q', origin, 'seed'])
  configure(seed)
  write(seed, '_projects_/x/note.md', 'one\n')
  write(seed, '_projects_/x/other.md', 'other\n')
  write(seed, '_logs_/run.jsonl', 'a\nb\n')
  git(seed, ['add', '-A'])
  git(seed, ['commit', '-q', '-m', 'base'])
  git(seed, ['push', '-q', '-u', 'origin', 'main'])

  const clone = (name) => {
    const dir = join(root, name)
    git(root, ['clone', '-q', origin, name])
    configure(dir)
    return dir
  }
  const live = clone('live')
  const writer = clone('writer')

  const validator = join(root, 'validator.sh')
  writeFileSync(validator, '#!/bin/sh\nexit 0\n')
  chmodSync(validator, 0o755)
  const failingValidator = join(root, 'validator-fail.sh')
  writeFileSync(failingValidator, '#!/bin/sh\necho "error   fixture: no frontmatter"\nexit 1\n')
  chmodSync(failingValidator, 0o755)
  const recordingValidator = join(root, 'validator-record.sh')
  writeFileSync(
    recordingValidator,
    '#!/bin/sh\nroot=$2\n{ for f in _projects_/x/note.md _projects_/x/other.md _logs_/run.jsonl; do if [ -f "$root/$f" ]; then echo "saw $f"; else echo "missing $f"; fi; done; } > "$VALIDATOR_LOG"\nexit 0\n',
  )
  chmodSync(recordingValidator, 0o755)

  const warningValidator = join(root, 'validator-warning.sh')
  writeFileSync(warningValidator, '#!/bin/sh\necho "warning fixture: a link does not resolve"\necho "checked 9 file(s): 0 error(s), 1 warning(s)"\nexit 0\n')
  chmodSync(warningValidator, 0o755)

  return { root, origin, seed, live, writer, validator, failingValidator, recordingValidator, warningValidator, validatorLog: join(root, 'validator.log') }
}

function pushFrom(w, files, message = 'writer') {
  git(w.writer, ['fetch', '-q', 'origin'])
  git(w.writer, ['reset', '-q', '--hard', 'origin/main'])
  for (const [path, content] of Object.entries(files)) write(w.writer, path, content)
  git(w.writer, ['add', '-A'])
  git(w.writer, ['commit', '-q', '-m', message])
  git(w.writer, ['push', '-q'])
}

function cli(w, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [TOOL, '--repo', w.live, ...args], {
    cwd: w.root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: w.root, ...extraEnv },
  })
  return { ...r, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
}

const record = (w, path, message = 'record: edit') => ['--message', message, '--file', path, '--validator', w.validator]

const originShow = (w, path) => {
  const r = spawnSync('git', ['show', `main:${path}`], { cwd: w.origin, encoding: 'utf8' })
  return r.status === 0 ? r.stdout : null
}

const worktreeCount = (w) => git(w.live, ['worktree', 'list']).split('\n').filter(Boolean).length

test('a log is the two named shapes, and the union keeps origin then adds what it lacks', () => {
  assert.ok(isLogPath('_logs_/review.jsonl'))
  assert.ok(isLogPath('_projects_/x/_context_/team-operations/execution-review-log.jsonl'))
  assert.equal(isLogPath('_context_/team-operations/decision-log.yaml'), false)
  assert.equal(unionLines(Buffer.from('a\nb\nc\n'), Buffer.from('a\nb\nlocal\n')).toString(), 'a\nb\nc\nlocal\n')
  assert.equal(unionLines(Buffer.from('a\n'), Buffer.from('a\n')).toString(), 'a\n')
  assert.equal(unionLines(null, Buffer.from('x\n')).toString(), 'x\n')
  assert.equal(unionLines(Buffer.from('a\n'), null).toString(), 'a\n')
  // Removing an origin line in the staging copy cannot remove it from the commit.
  assert.equal(unionLines(Buffer.from('a\nb\n'), Buffer.from('a\n')).toString(), 'a\nb\n')
})

test('a base that is not origin is named with both sizes and refused', () => {
  assert.deepEqual(baseCheck({ path: 'p', base: Buffer.from('x'), origin: Buffer.from('x') }), { ok: true, path: 'p' })
  const stale = baseCheck({ path: 'p', base: Buffer.from('x'), origin: Buffer.from('xy') })
  assert.equal(stale.ok, false)
  assert.match(stale.reason, /base does not match origin\/main \(base 1 byte\(s\), origin 2 byte\(s\)\)/)
  assert.equal(baseCheck({ path: 'new', base: null, origin: null }).ok, true)
  assert.equal(baseCheck({ path: 'new', base: null, origin: Buffer.from('x') }).ok, false)
})

test('the read-back verifier fails on a different file, a missing line and a wrong commit', () => {
  const file = { path: 'a.md', kind: 'file', content: Buffer.from('one\n'), expected: Buffer.from('one\n') }
  const log = { path: '_logs_/r.jsonl', kind: 'log', content: Buffer.from('a\nb\nlocal\n'), expected: Buffer.from('a\nb\nlocal\n') }
  const readAll = (map) => (path) => (map[path] === undefined ? null : Buffer.from(map[path]))
  assert.deepEqual(verifyLanded({ commit: 'c1', originMain: 'c1', files: [file, log], readOrigin: readAll({ 'a.md': 'one\n', '_logs_/r.jsonl': 'a\nb\nlocal\n' }) }), [])

  const wrongFile = verifyLanded({ commit: 'c1', originMain: 'c1', files: [file], readOrigin: readAll({ 'a.md': 'two\n' }) })
  assert.match(wrongFile.join('\n'), /a\.md: origin\/main does not carry the staged bytes/)

  const missingLine = verifyLanded({ commit: 'c1', originMain: 'c1', files: [log], readOrigin: readAll({ '_logs_/r.jsonl': 'a\nb\n' }) })
  assert.match(missingLine.join('\n'), /does not carry the unioned log/)

  const missingStaged = verifyLanded({
    commit: 'c1',
    originMain: 'c1',
    files: [log],
    readOrigin: readAll({ '_logs_/r.jsonl': 'a\nb\n' }),
  })
  assert.ok(missingStaged.length > 0)

  const wrongCommit = verifyLanded({ commit: 'c1', originMain: 'c2', files: [], readOrigin: () => null })
  assert.match(wrongCommit.join('\n'), /origin\/main is c2, not the committed c1/)
})

test('the happy path commits, reads back, and fast-forwards the live tree', (t) => {
  const w = world(t)
  write(w.live, '_projects_/x/note.md', 'one\nedited\n')
  const r = cli(w, record(w, '_projects_/x/note.md'))
  assert.equal(r.status, OK, r.output)
  assert.match(r.output, /read back: origin\/main [0-9a-f]{7} carries all 1 file\(s\)/)
  assert.match(r.output, /sync: .*fast-forwarded/)
  assert.equal(originShow(w, '_projects_/x/note.md'), 'one\nedited\n')
  assert.equal(git(w.live, ['rev-parse', 'HEAD']), git(w.origin, ['rev-parse', 'main']))
  assert.equal(git(w.live, ['status', '--porcelain']), '', 'the live tree is clean after the sync')
  assert.equal(worktreeCount(w), 1, 'the temporary worktree was removed')
  assert.equal(git(w.origin, ['log', '-1', '--format=%an <%ae>']), 'D.Tadpole <gsk390@gmail.com>')
})

test('a stale base is refused, origin keeps its version, and nothing is committed', (t) => {
  const w = world(t)
  write(w.live, '_projects_/x/note.md', 'mine\n')
  pushFrom(w, { '_projects_/x/note.md': 'theirs\n' })
  const before = git(w.origin, ['rev-parse', 'main'])
  const r = cli(w, record(w, '_projects_/x/note.md'))
  assert.equal(r.status, REFUSED, r.output)
  assert.match(r.output, /REFUSED _projects_\/x\/note\.md: base does not match origin\/main/)
  assert.equal(git(w.origin, ['rev-parse', 'main']), before)
  assert.equal(originShow(w, '_projects_/x/note.md'), 'theirs\n')
  assert.equal(read(w.live, '_projects_/x/note.md'), 'mine\n', 'the live edit is untouched')
  assert.equal(worktreeCount(w), 1)
})

test('two writers appending to a log both keep their lines, and it is never replaced', (t) => {
  const w = world(t)
  write(w.live, '_logs_/run.jsonl', 'a\nb\nlocal\n')
  pushFrom(w, { '_logs_/run.jsonl': 'a\nb\nremote\n' })
  const r = cli(w, record(w, '_logs_/run.jsonl', 'record: log'))
  assert.equal(r.status, OK, r.output)
  assert.match(r.output, /union _logs_\/run\.jsonl/)
  const lines = originShow(w, '_logs_/run.jsonl').trim().split('\n')
  assert.deepEqual(lines.sort(), ['a', 'b', 'local', 'remote'].sort())
  assert.equal(git(w.live, ['status', '--porcelain']), '', 'the live tree is clean and holds every line')
  assert.equal(read(w.live, '_logs_/run.jsonl').trim().split('\n').sort().join(','), 'a,b,local,remote')
})

test('a log edit that deletes an origin line cannot delete it from the commit', (t) => {
  const w = world(t)
  write(w.live, '_logs_/run.jsonl', 'a\nlocal\n') // line b is dropped locally
  pushFrom(w, { '_logs_/run.jsonl': 'a\nb\nremote\n' })
  const r = cli(w, record(w, '_logs_/run.jsonl', 'record: log'))
  assert.equal(r.status, OK, r.output)
  const lines = originShow(w, '_logs_/run.jsonl').trim().split('\n')
  for (const line of ['a', 'b', 'local', 'remote']) assert.ok(lines.includes(line), `${line} survived`)
})

test('the frontmatter validator sees the whole tree, and its failure refuses the commit', (t) => {
  const w = world(t)
  write(w.live, '_projects_/x/note.md', 'one\nvalidated\n')
  const ok = cli(w, [...record(w, '_projects_/x/note.md'), '--validator', w.recordingValidator], { VALIDATOR_LOG: w.validatorLog })
  assert.equal(ok.status, OK, ok.output)
  const seen = readFileSync(w.validatorLog, 'utf8')
  assert.match(seen, /saw _projects_\/x\/note\.md/)
  assert.match(seen, /saw _projects_\/x\/other\.md/, 'the validator ran on the whole tree, not just the staged file')
  assert.match(seen, /saw _logs_\/run\.jsonl/)

  write(w.live, '_projects_/x/note.md', 'worse\n')
  const landed = git(w.origin, ['rev-parse', 'main'])
  const refused = cli(w, ['--message', 'record: bad', '--file', '_projects_/x/note.md', '--validator', w.failingValidator])
  assert.equal(refused.status, REFUSED, refused.output)
  assert.match(refused.output, /frontmatter: the validator failed; nothing committed/)
  assert.equal(git(w.origin, ['rev-parse', 'main']), landed, 'the refused edit did not land')
  assert.equal(originShow(w, '_projects_/x/note.md'), 'one\nvalidated\n', 'origin still holds the accepted edit')
})

test('validator warnings are counted, not dumped, unless --verbose asks for them', (t) => {
  const w = world(t)
  write(w.live, '_projects_/x/note.md', 'one\nwith warnings\n')
  const quiet = cli(w, ['--message', 'record: warned', '--file', '_projects_/x/note.md', '--validator', w.warningValidator, '--no-sync'])
  assert.equal(quiet.status, OK, quiet.output)
  assert.match(quiet.output, /frontmatter: checked 9 file\(s\): 0 error\(s\), 1 warning\(s\)/)
  assert.match(quiet.output, /frontmatter: 1 warning\(s\), none blocking \(--verbose lists them\)/)
  assert.doesNotMatch(quiet.output, /a link does not resolve/)

  git(w.live, ['fetch', '-q', 'origin'])
  git(w.live, ['reset', '-q', '--hard', 'origin/main'])
  write(w.live, '_projects_/x/note.md', 'one\nverbose\n')
  const loud = cli(w, ['--message', 'record: verbose', '--file', '_projects_/x/note.md', '--validator', w.warningValidator, '--no-sync', '--verbose'])
  assert.equal(loud.status, OK, loud.output)
  assert.match(loud.output, /warning fixture: a link does not resolve/)
})

test('a staging tree is committed from --base, and a stale base refuses it', (t) => {
  const w = world(t)
  const staged = join(w.root, 'staged')
  const base = join(w.root, 'base')
  write(staged, '_projects_/x/note.md', 'one\nstaged\n')
  write(base, '_projects_/x/note.md', 'one\n')
  const args = ['--message', 'record: staged', '--staged', staged, '--base', base, '--validator', w.validator, '--no-sync']
  const ok = cli(w, args)
  assert.equal(ok.status, OK, ok.output)
  assert.equal(originShow(w, '_projects_/x/note.md'), 'one\nstaged\n')

  pushFrom(w, { '_projects_/x/note.md': 'origin moved\n' })
  const stale = cli(w, ['--message', 'record: stale', '--staged', staged, '--base', base, '--validator', w.validator, '--no-sync'])
  assert.equal(stale.status, REFUSED, stale.output)
  assert.match(stale.output, /base does not match origin\/main/)
  assert.equal(originShow(w, '_projects_/x/note.md'), 'origin moved\n')
})

test('content already equal to origin is nothing to commit', (t) => {
  const w = world(t)
  const r = cli(w, record(w, '_projects_/x/note.md'))
  assert.equal(r.status, REFUSED, r.output)
  assert.match(r.output, /nothing to commit/)
})

test('a dry run validates and plans but commits nothing', (t) => {
  const w = world(t)
  write(w.live, '_projects_/x/note.md', 'one\ndry\n')
  const before = git(w.origin, ['rev-parse', 'main'])
  const r = cli(w, [...record(w, '_projects_/x/note.md'), '--dry-run'])
  assert.equal(r.status, OK, r.output)
  assert.match(r.output, /dry run: would commit 1 file\(s\)/)
  assert.equal(git(w.origin, ['rev-parse', 'main']), before)
  assert.equal(git(w.live, ['rev-parse', 'HEAD']), before, 'the live tree is not synced on a dry run')
  assert.equal(worktreeCount(w), 1)
})

test('a push race is rebuilt from a fresh origin and both commits land', (t) => {
  const w = world(t)
  write(w.live, '_projects_/x/note.md', 'one\nraced\n')
  const marker = join(w.root, 'race.marker')
  const hookDir = join(w.live, '.git', 'hooks')
  mkdirSync(hookDir, { recursive: true })
  writeFileSync(
    join(hookDir, 'pre-push'),
    `#!/bin/sh
if [ ! -f "$RACE_MARKER" ]; then
  touch "$RACE_MARKER"
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
  git -C "$WRITER" fetch -q origin
  git -C "$WRITER" reset -q --hard origin/main
  printf 'racing\\n' > "$WRITER/_projects_/x/other.md"
  git -C "$WRITER" commit -qam race
  git -C "$WRITER" push -q
fi
exit 0
`,
  )
  chmodSync(join(hookDir, 'pre-push'), 0o755)
  const r = cli(w, record(w, '_projects_/x/note.md', 'record: raced'), { RACE_MARKER: marker, WRITER: w.writer })
  assert.equal(r.status, OK, r.output)
  assert.match(r.output, /push rejected .*rebuilding from a fresh origin/)
  assert.equal(originShow(w, '_projects_/x/note.md'), 'one\nraced\n')
  assert.equal(originShow(w, '_projects_/x/other.md'), 'racing\n', 'the racing commit was not dropped')
  assert.equal(git(w.origin, ['rev-list', '--count', 'main']), '3', 'base + race + record')
})

test('a commit that lands but cannot sync the live tree exits 3', (t) => {
  const w = world(t)
  write(w.live, '_projects_/x/other.md', 'my unrelated edit\n')
  pushFrom(w, { '_projects_/x/other.md': 'their change\n' })
  write(w.live, '_projects_/x/note.md', 'one\nrecorded\n')
  const r = cli(w, record(w, '_projects_/x/note.md', 'record: note'))
  assert.equal(r.status, SYNC_REFUSED, r.output)
  assert.match(r.output, /sync: the record is committed and pushed; the live tree was not fast-forwarded/)
  assert.equal(originShow(w, '_projects_/x/note.md'), 'one\nrecorded\n', 'the record did land')
  assert.equal(read(w.live, '_projects_/x/other.md'), 'my unrelated edit\n', 'the other edit is untouched')
})

test('arguments are checked before any repository work', (t) => {
  const w = world(t)
  assert.equal(cli(w, ['--file', '_projects_/x/note.md']).status, REFUSED, 'no message')
  assert.equal(cli(w, ['--message', 'x']).status, REFUSED, 'no files')
  assert.equal(cli(w, ['--message', 'x', '--staged', w.root, '--file', '_projects_/x/note.md']).status, REFUSED, 'both modes')
  const missing = cli(w, ['--message', 'x', '--file', '_projects_/x/nope.md'])
  assert.equal(missing.status, REFUSED)
  assert.match(missing.output, /does not exist/)
})

test('collectFiles refuses a path that escapes the checkout', (t) => {
  const w = world(t)
  assert.throws(() => collectFiles({ repo: w.live, flagFiles: ['../outside.md'] }), /inside the checkout/)
  assert.throws(() => collectFiles({ repo: w.live, flagFiles: ['/etc/hosts'] }), /inside the checkout/)
  const files = collectFiles({ repo: w.live, flagFiles: ['_projects_/x/note.md'] })
  assert.equal(files.length, 1)
  assert.equal(files[0].base.toString(), 'one\n')
})
