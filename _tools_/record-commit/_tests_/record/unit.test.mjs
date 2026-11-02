import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import {
  OK,
  READ_BACK_FAILED,
  INCOMPLETE,
  REFUSED,
  SYNC_REFUSED,
  baseCheck,
  collectFiles,
  findPython,
  isLogPath,
  isProtectedRejection,
  messageWarnings,
  parkedContent,
  protectedDetail,
  rejectionReasons,
  seatFromTeam,
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
  // Fails on what the record writes (a note saying 'worse'), so the error is the record's own.
  writeFileSync(failingValidator, '#!/bin/sh\nif grep -q worse "$2/_projects_/x/note.md" 2>/dev/null; then echo "error   _projects_/x/note.md: no frontmatter"; exit 1; fi\nexit 0\n')
  chmodSync(failingValidator, 0o755)
  // main already fails this one (other.md), and a note saying BAD adds an error of the record's.
  const inheritedValidator = join(root, 'validator-inherited.sh')
  writeFileSync(
    inheritedValidator,
    '#!/bin/sh\necho "error   _projects_/x/other.md: missing required field level"\nif grep -q BAD "$2/_projects_/x/note.md" 2>/dev/null; then echo "error   _projects_/x/note.md: BAD"; fi\necho "checked 3 file(s)"\nexit 1\n',
  )
  chmodSync(inheritedValidator, 0o755)
  const crashingValidator = join(root, 'validator-crash.sh')
  writeFileSync(crashingValidator, '#!/bin/sh\necho "Traceback (most recent call last): boom" >&2\nexit 2\n')
  chmodSync(crashingValidator, 0o755)
  const recordingValidator = join(root, 'validator-record.sh')
  writeFileSync(
    recordingValidator,
    '#!/bin/sh\nroot=$2\n{ for f in _projects_/x/note.md _projects_/x/other.md _logs_/run.jsonl; do if [ -f "$root/$f" ]; then echo "saw $f"; else echo "missing $f"; fi; done; } > "$VALIDATOR_LOG"\nexit 0\n',
  )
  chmodSync(recordingValidator, 0o755)

  const warningValidator = join(root, 'validator-warning.sh')
  writeFileSync(warningValidator, '#!/bin/sh\necho "warning fixture: a link does not resolve"\necho "checked 9 file(s): 0 error(s), 1 warning(s)"\nexit 0\n')
  chmodSync(warningValidator, 0o755)

  return { root, origin, seed, live, writer, validator, failingValidator, inheritedValidator, crashingValidator, recordingValidator, warningValidator, validatorLog: join(root, 'validator.log') }
}

function pushFrom(w, files, message = 'writer') {
  git(w.writer, ['fetch', '-q', 'origin'])
  git(w.writer, ['reset', '-q', '--hard', 'origin/main'])
  for (const [path, content] of Object.entries(files)) write(w.writer, path, content)
  git(w.writer, ['add', '-A'])
  git(w.writer, ['commit', '-q', '-m', message])
  git(w.writer, ['push', '-q'])
}

// The tool as a seat runs it: by default it parks every record and never pushes main.
function run(w, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [TOOL, '--repo', w.live, ...args], {
    cwd: w.root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: w.root, ...extraEnv },
  })
  return { ...r, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
}

// The tests written before parking became the default judge the direct push to main
// (and its fallback to parking on a protected main), which now takes --main.
const cli = (w, args, extraEnv = {}) => run(w, [...args, '--main'], extraEnv)

const record = (w, path, message = 'docs(test): edit the note') => ['--message', message, '--file', path, '--validator', w.validator]

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
  assert.match(r.output, /read back: origin\/main [0-9a-f]{7} is the commit, and it carries all 1 given file\(s\)/)
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
  const r = cli(w, record(w, '_logs_/run.jsonl', 'log(test): append a line'))
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
  const r = cli(w, record(w, '_logs_/run.jsonl', 'log(test): append a line'))
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
  const refused = cli(w, ['--message', 'docs(test): a bad edit', '--file', '_projects_/x/note.md', '--validator', w.failingValidator])
  assert.equal(refused.status, REFUSED, refused.output)
  assert.match(refused.output, /frontmatter: the validator failed; nothing committed/)
  assert.equal(git(w.origin, ['rev-parse', 'main']), landed, 'the refused edit did not land')
  assert.equal(originShow(w, '_projects_/x/note.md'), 'one\nvalidated\n', 'origin still holds the accepted edit')
})

// 2026-11-01 15:38 PST: the GHE convergence left reflection main with 35 validator errors,
// and every record was refused for errors that were not its own.
test('an error main already has does not refuse a record, and is counted, not hidden', (t) => {
  const w = world(t)
  const pushed = logPushes(w)
  write(w.live, '_projects_/x/note.md', 'one\nfine\n')
  const r = run(w, ['--message', 'docs(test): on a broken main', '--file', '_projects_/x/note.md', '--validator', w.inheritedValidator, '--seat', 'dev-one'])
  assert.equal(r.status, OK, r.output)
  assert.ok(parkedLine(r, 'dev-one'), r.output)
  assert.match(r.output, /frontmatter: 1 error\(s\) already on origin\/main, none added by this record, so none blocking \(--verbose lists them\)/)
  assert.deepEqual(pushed(), ['refs/heads/records/dev-one'])
  write(w.live, '_projects_/x/note.md', 'one\nfine\nverbose\n')
  const loud = run(w, ['--message', 'docs(test): verbose', '--file', '_projects_/x/note.md', '--validator', w.inheritedValidator, '--seat', 'dev-one', '--verbose'])
  assert.equal(loud.status, OK, loud.output)
  assert.match(loud.output, /frontmatter: already on origin\/main: error {3}_projects_\/x\/other\.md: missing required field level/)
  assert.equal(worktreeCount(w), 1)
})

test('an error the record adds still refuses it, named apart from the ones main already has', (t) => {
  const w = world(t)
  const pushed = logPushes(w)
  write(w.live, '_projects_/x/note.md', 'one\nBAD\n')
  const r = run(w, ['--message', 'docs(test): a record that breaks', '--file', '_projects_/x/note.md', '--validator', w.inheritedValidator, '--seat', 'dev-one'])
  assert.equal(r.status, REFUSED, r.output)
  assert.match(r.output, /frontmatter: error {3}_projects_\/x\/note\.md: BAD/)
  assert.doesNotMatch(r.output, /frontmatter: error {3}_projects_\/x\/other\.md/, 'main\'s own error is counted, not listed as the record\'s')
  assert.match(r.output, /frontmatter: 1 more error\(s\) already on origin\/main, not this record's/)
  assert.match(r.output, /frontmatter: the validator failed; nothing committed/)
  assert.deepEqual(pushed(), [])
  assert.equal(read(w.live, '_projects_/x/note.md'), 'one\nBAD\n', 'the live edit is kept')
  assert.equal(worktreeCount(w), 1)
})

test('an error main has in the very file a record edits is still main\'s', (t) => {
  const w = world(t)
  pushFrom(w, { '_projects_/x/note.md': 'one\nBAD on main\n' })
  git(w.live, ['pull', '-q'])
  write(w.live, '_projects_/x/note.md', 'one\nBAD on main\nand more\n')
  const r = run(w, ['--message', 'docs(test): edit a broken file', '--file', '_projects_/x/note.md', '--validator', w.inheritedValidator, '--seat', 'dev-one'])
  assert.equal(r.status, OK, r.output)
  assert.match(r.output, /2 error\(s\) already on origin\/main, none added/)
})

test('a validator that fails without naming an error still refuses the record', (t) => {
  const w = world(t)
  const pushed = logPushes(w)
  write(w.live, '_projects_/x/note.md', 'one\ncrash\n')
  const r = run(w, ['--message', 'docs(test): a broken validator', '--file', '_projects_/x/note.md', '--validator', w.crashingValidator, '--seat', 'dev-one'])
  assert.equal(r.status, REFUSED, r.output)
  assert.match(r.output, /frontmatter: Traceback \(most recent call last\): boom/)
  assert.match(r.output, /frontmatter: the validator failed; nothing committed/)
  assert.deepEqual(pushed(), [])
})

test('validator warnings are counted, not dumped, unless --verbose asks for them', (t) => {
  const w = world(t)
  write(w.live, '_projects_/x/note.md', 'one\nwith warnings\n')
  const quiet = cli(w, ['--message', 'docs(test): an edit with warnings', '--file', '_projects_/x/note.md', '--validator', w.warningValidator, '--no-sync'])
  assert.equal(quiet.status, OK, quiet.output)
  assert.match(quiet.output, /frontmatter: checked 9 file\(s\): 0 error\(s\), 1 warning\(s\)/)
  assert.match(quiet.output, /frontmatter: 1 warning\(s\), none blocking \(--verbose lists them\)/)
  assert.doesNotMatch(quiet.output, /a link does not resolve/)

  git(w.live, ['fetch', '-q', 'origin'])
  git(w.live, ['reset', '-q', '--hard', 'origin/main'])
  write(w.live, '_projects_/x/note.md', 'one\nverbose\n')
  const loud = cli(w, ['--message', 'docs(test): a verbose edit', '--file', '_projects_/x/note.md', '--validator', w.warningValidator, '--no-sync', '--verbose'])
  assert.equal(loud.status, OK, loud.output)
  assert.match(loud.output, /warning fixture: a link does not resolve/)
})

test('a staging tree is committed from --base, and a stale base refuses it', (t) => {
  const w = world(t)
  const staged = join(w.root, 'staged')
  const base = join(w.root, 'base')
  write(staged, '_projects_/x/note.md', 'one\nstaged\n')
  write(base, '_projects_/x/note.md', 'one\n')
  const args = ['--message', 'docs(test): a staged edit', '--staged', staged, '--base', base, '--validator', w.validator, '--no-sync']
  const ok = cli(w, args)
  assert.equal(ok.status, OK, ok.output)
  assert.equal(originShow(w, '_projects_/x/note.md'), 'one\nstaged\n')

  pushFrom(w, { '_projects_/x/note.md': 'origin moved\n' })
  const stale = cli(w, ['--message', 'docs(test): a stale edit', '--staged', staged, '--base', base, '--validator', w.validator, '--no-sync'])
  assert.equal(stale.status, REFUSED, stale.output)
  assert.match(stale.output, /base does not match origin\/main/)
  assert.equal(originShow(w, '_projects_/x/note.md'), 'origin moved\n')
})

test('content already equal to origin is a file the commit would not carry: exit 2, nothing committed', (t) => {
  const w = world(t)
  const before = git(w.origin, ['rev-parse', 'main'])
  const r = cli(w, record(w, '_projects_/x/note.md'))
  assert.equal(r.status, INCOMPLETE, r.output)
  assert.match(r.output, /UNCHANGED _projects_\/x\/note\.md: its content already equals origin\/main/)
  assert.equal(git(w.origin, ['rev-parse', 'main']), before)
})

// The 21:08 case: three files given, one carrying an edit, two whose edits never reached
// the tree the tool reads. It committed the one with exit 0; it must refuse all three.
test('three given files with two unchanged are refused together, exit 2, and nothing is committed', (t) => {
  const w = world(t)
  write(w.live, '_projects_/x/note.md', 'one\nedited\n')
  const before = git(w.origin, ['rev-parse', 'main'])
  const r = cli(w, ['--message', 'docs(test): three files', '--file', '_projects_/x/note.md', '--file', '_projects_/x/other.md', '--file', '_logs_/run.jsonl', '--validator', w.validator])
  assert.equal(r.status, INCOMPLETE, r.output)
  assert.match(r.output, /UNCHANGED _projects_\/x\/other\.md: its content already equals origin\/main/)
  assert.match(r.output, /UNCHANGED _logs_\/run\.jsonl: every given line is already in origin\/main/)
  assert.doesNotMatch(r.output, /UNCHANGED _projects_\/x\/note\.md/)
  assert.match(r.output, /refusing: 2 of 3 given file\(s\) would not change/)
  assert.equal(git(w.origin, ['rev-parse', 'main']), before, 'not even the changed file was committed')
  assert.equal(originShow(w, '_projects_/x/note.md'), 'one\n')
  assert.equal(read(w.live, '_projects_/x/note.md'), 'one\nedited\n', 'the live edit is untouched')
  assert.equal(worktreeCount(w), 1)
})

test('a log whose new lines another writer already landed is unchanged, not a silent no-op', (t) => {
  const w = world(t)
  write(w.live, '_logs_/run.jsonl', 'a\nb\nnew line\n')
  pushFrom(w, { '_logs_/run.jsonl': 'a\nb\nnew line\n' })
  const r = cli(w, record(w, '_logs_/run.jsonl', 'log(test): append a line'))
  assert.equal(r.status, INCOMPLETE, r.output)
  assert.match(r.output, /UNCHANGED _logs_\/run\.jsonl/)
})

function raceHook(w, file, content) {
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
  mkdir -p "$(dirname "$WRITER/${file}")"
  printf '%s' '${content}' > "$WRITER/${file}"
  git -C "$WRITER" add -A
  git -C "$WRITER" commit -qm race
  git -C "$WRITER" push -q
fi
exit 0
`,
  )
  chmodSync(join(hookDir, 'pre-push'), 0o755)
}

// The coordinator's scenario: one staged file that another writer adds to origin between
// this run's fetch and its push, alongside two other staged files. The record must carry
// all three or refuse with exit 2, whatever bytes the other writer used.
function threeFilesWithRace(w, racedContent) {
  write(w.live, '_projects_/x/handover.md', 'handover\n')
  write(w.live, '_projects_/x/note.md', 'one\nref to handover\n')
  write(w.live, '_logs_/run.jsonl', 'a\nb\nstep line\n')
  raceHook(w, '_projects_/x/handover.md', racedContent)
  return cli(
    w,
    ['--message', 'docs(test): handover, its ref and a step line', '--file', '_projects_/x/handover.md', '--file', '_projects_/x/note.md', '--file', '_logs_/run.jsonl', '--validator', w.validator],
    { RACE_MARKER: join(w.root, 'race'), WRITER: w.writer },
  )
}

function assertNothingOfOursLanded(w) {
  assert.equal(originShow(w, '_projects_/x/note.md'), 'one\n', 'the second staged file was not committed on its own')
  assert.equal(originShow(w, '_logs_/run.jsonl'), 'a\nb\n', 'the third staged file was not committed on its own')
  assert.equal(git(w.origin, ['rev-list', '--count', 'main']), '2', 'base + the racing commit, nothing of ours')
  assert.equal(worktreeCount(w), 1)
}

test('another writer adds one of three staged files with the same bytes between fetch and push: exit 2, none committed', (t) => {
  const w = world(t)
  const r = threeFilesWithRace(w, 'handover\n')
  assert.equal(r.status, INCOMPLETE, r.output)
  assert.match(r.output, /push rejected .*rebuilding from a fresh origin/)
  assert.match(r.output, /UNCHANGED _projects_\/x\/handover\.md/)
  assert.match(r.output, /refusing: 1 of 3 given file\(s\) would not change/)
  assertNothingOfOursLanded(w)
  assert.equal(originShow(w, '_projects_/x/handover.md'), 'handover\n')
})

test('another writer adds one of three staged files with different bytes between fetch and push: exit 2, none committed', (t) => {
  const w = world(t)
  const r = threeFilesWithRace(w, 'theirs\n')
  assert.equal(r.status, INCOMPLETE, r.output)
  assert.match(r.output, /push rejected .*rebuilding from a fresh origin/)
  assert.match(r.output, /REFUSED _projects_\/x\/handover\.md: base does not match origin\/main/)
  assert.match(r.output, /refusing: another writer changed 1 given file\(s\) while this run was pushing; nothing was committed/)
  assertNothingOfOursLanded(w)
  assert.equal(originShow(w, '_projects_/x/handover.md'), 'theirs\n', 'the other writer keeps its version')
})

test('the read-back counts the files it was given, not the files the commit happened to carry', () => {
  const files = [
    { path: 'a.md', kind: 'file', content: Buffer.from('a\n'), expected: Buffer.from('a\n') },
    { path: 'b.md', kind: 'file', content: Buffer.from('b\n'), expected: Buffer.from('b\n') },
  ]
  const readOrigin = (path) => Buffer.from(path === 'a.md' ? 'a\n' : 'b\n')
  const problems = verifyLanded({ commit: 'c1', originMain: 'c1', files, readOrigin, committedPaths: ['a.md'] })
  assert.match(problems.join('\n'), /the commit carries 1 of the 2 given file\(s\); not carried: b\.md/)
  assert.deepEqual(verifyLanded({ commit: 'c1', originMain: 'c1', files, readOrigin, committedPaths: ['a.md', 'b.md'] }), [])
})

test('a message outside <type>(<scope>): <subject> is warned about on stderr, and the commit still lands', (t) => {
  assert.deepEqual(messageWarnings('docs(hd): record the handover', ['_projects_/x/a.md']), [])
  // Every type of the shared commit-messages convention is accepted, and nothing else.
  for (const type of ['feat', 'fix', 'docs', 'test', 'refactor', 'perf', 'ci', 'chore', 'revert']) {
    assert.deepEqual(messageWarnings(`${type}(hd): a subject`, ['_projects_/x/a.md']), [], `${type} is a type`)
  }
  assert.match(messageWarnings('logs(hd): lines', ['_logs_/run.jsonl']).join(), /'logs' is not a commit type .*spelled log/)
  assert.match(messageWarnings('hd(008): a seat as a type', ['_projects_/x/a.md']).join(), /'hd' is not a commit type/)
  assert.deepEqual(messageWarnings('log(hd): two step lines', ['_logs_/repo-actions/action-log.jsonl']), [])
  assert.match(messageWarnings('record: the handover', ['_projects_/x/a.md']).join(), /'record' is not a commit type .*a record edit is docs\(<scope>\)/)
  assert.match(messageWarnings('Updated the handover', ['_projects_/x/a.md']).join(), /not <type>\(<scope>\): <subject>/)
  assert.match(messageWarnings('record(hd): the handover', ['_projects_/x/a.md']).join(), /a record edit is docs\(<scope>\)/)
  assert.match(messageWarnings('docs(hd): lines', ['_logs_/run.jsonl']).join(), /the type is log\(<scope>\), not docs/)
  assert.match(messageWarnings('log(hd): more', ['_projects_/x/a.md', '_logs_/run.jsonl']).join(), /only appends to _logs_/)
  const w = world(t)
  write(w.live, '_projects_/x/note.md', 'one\nwarned\n')
  const r = cli(w, ['--message', 'record: an old-style message', '--file', '_projects_/x/note.md', '--validator', w.validator, '--no-sync'])
  assert.equal(r.status, OK, r.output)
  assert.match(r.stderr, /record-commit: warning: 'record' is not a commit type/)
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

test('a push race on another file is replayed on the new tip and both commits land', (t) => {
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
  const r = cli(w, record(w, '_projects_/x/note.md', 'docs(test): a raced edit'), { RACE_MARKER: marker, WRITER: w.writer })
  assert.equal(r.status, OK, r.output)
  assert.match(r.output, /push rejected \(the remote moved; none of the given files changed there\): replayed as/)
  assert.equal(originShow(w, '_projects_/x/note.md'), 'one\nraced\n')
  assert.equal(originShow(w, '_projects_/x/other.md'), 'racing\n', 'the racing commit was not dropped')
  assert.equal(git(w.origin, ['rev-list', '--count', 'main']), '3', 'base + race + record')
})

// The coordinator's report (2026-10-26 07:28): other teams pushed so often that every
// rebuilt attempt, which reruns the validator over the whole tree, was beaten again, and
// after three rejections nothing was committed. Here the remote moves on four pushes in a
// row; the commit must still land, by replaying, with every racing commit kept and the
// attempt built only once.
test('a remote that moves on four pushes in a row is beaten by replays, and every racing commit is kept', (t) => {
  const w = world(t)
  write(w.live, '_projects_/x/note.md', 'one\nbusy remote\n')
  const hookDir = join(w.live, '.git', 'hooks')
  mkdirSync(hookDir, { recursive: true })
  writeFileSync(
    join(hookDir, 'pre-push'),
    `#!/bin/sh
n=$(cat "$RACE_COUNT" 2>/dev/null || echo 0)
if [ "$n" -lt 4 ]; then
  echo $((n + 1)) > "$RACE_COUNT"
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
  git -C "$WRITER" fetch -q origin
  git -C "$WRITER" reset -q --hard origin/main
  printf 'race %s\\n' "$n" > "$WRITER/_projects_/x/other-$n.md"
  git -C "$WRITER" add -A
  git -C "$WRITER" commit -qm "race $n"
  git -C "$WRITER" push -q
fi
exit 0
`,
  )
  chmodSync(join(hookDir, 'pre-push'), 0o755)
  const r = cli(w, record(w, '_projects_/x/note.md', 'docs(test): an edit against a busy remote'), { RACE_COUNT: join(w.root, 'race.count'), WRITER: w.writer })
  assert.equal(r.status, OK, r.output)
  assert.equal((r.output.match(/replayed as/g) ?? []).length, 4, r.output)
  assert.equal((r.output.match(/^record-commit: /gm) ?? []).length, 1, 'built once, never rebuilt')
  assert.equal(originShow(w, '_projects_/x/note.md'), 'one\nbusy remote\n')
  for (const n of [0, 1, 2, 3]) assert.equal(originShow(w, `_projects_/x/other-${n}.md`), `race ${n}\n`, `racing commit ${n} was kept`)
  assert.equal(git(w.origin, ['rev-list', '--count', 'main']), '6', 'base + four races + record')
  assert.equal(worktreeCount(w), 1)
})

test('a commit that lands but cannot sync the live tree exits 3', (t) => {
  const w = world(t)
  write(w.live, '_projects_/x/other.md', 'my unrelated edit\n')
  pushFrom(w, { '_projects_/x/other.md': 'their change\n' })
  write(w.live, '_projects_/x/note.md', 'one\nrecorded\n')
  const r = cli(w, record(w, '_projects_/x/note.md', 'docs(test): the note'))
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

test('the validator python is the repository .venv when it has one, else a python3, and the choice is named', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'record-commit-python-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fallback = findPython(null, dir)
  assert.ok(fallback, 'some python with PyYAML exists on this Mac')
  assert.match(fallback.why, /^no \.venv; /, 'without a .venv the fallback says so')
  // A .venv whose python is this Mac's PyYAML python: the nearest .venv wins and is named.
  mkdirSync(join(dir, '.venv', 'bin'), { recursive: true })
  symlinkSync(fallback.command.includes('/') ? fallback.command : spawnSync('/bin/sh', ['-c', `command -v ${fallback.command}`], { encoding: 'utf8' }).stdout.trim(), join(dir, '.venv', 'bin', 'python'))
  const venv = findPython(null, dir)
  assert.equal(venv.command, join(dir, '.venv', 'bin', 'python'))
  assert.equal(venv.why, "the repository's .venv")
  assert.equal(findPython('/no/such/python', dir).why, "the repository's .venv", 'a missing explicit path is skipped')
})

test('a run with the repository validator names the python it used and why', (t) => {
  const w = world(t)
  // The record repository's own validator path, as on origin; a stand-in that passes.
  pushFrom(w, { 'shared/_tools_/frontmatter-validator/validate-frontmatter.py': 'import yaml\nprint("checked 1 file(s): 0 error(s), 0 warning(s)")\n' })
  git(w.live, ['pull', '-q', '--ff-only'])
  write(w.live, '_projects_/x/note.md', 'one\nnamed\n')
  const r = cli(w, ['--message', 'docs(test): name the python', '--file', '_projects_/x/note.md', '--no-sync', '--dry-run'])
  assert.equal(r.status, OK, r.output)
  assert.match(r.output, /  python: \S+ \(no \.venv; a python3? with PyYAML\)/, 'no .venv in the scratch record repo, and the report says so')
})

// 2026-11-01 ~12:45 PST: github.com/dtadpole/reflection main became protected, and every
// record push failed with GH006. A protected main now parks the commit on
// refs/heads/records/<seat>. The fake remote's update hook refuses main as GitHub does.
const GH006 = 'echo "error: GH006: Protected branch update failed for refs/heads/main." >&2\necho "error: Changes must be made through a pull request." >&2'

function protect(w, refusal = GH006) {
  const hook = join(w.origin, 'hooks', 'update')
  writeFileSync(hook, `#!/bin/sh\ncase "$1" in\n  refs/heads/main)\n${refusal}\n    exit 1;;\nesac\nexit 0\n`)
  chmodSync(hook, 0o755)
}

// What an owner's bypass or a merged pull request does: main moves without a push to it.
function bypass(w, files, message = 'merged') {
  git(w.writer, ['fetch', '-q', 'origin'])
  git(w.writer, ['reset', '-q', '--hard', 'origin/main'])
  for (const [path, content] of Object.entries(files)) write(w.writer, path, content)
  git(w.writer, ['add', '-A'])
  git(w.writer, ['commit', '-q', '-m', message])
  git(w.writer, ['push', '-q', 'origin', 'HEAD:refs/heads/bypass'])
  git(w.origin, ['update-ref', 'refs/heads/main', 'refs/heads/bypass'])
  git(w.origin, ['update-ref', '-d', 'refs/heads/bypass'])
}

const originRef = (w, ref) => {
  const r = spawnSync('git', ['rev-parse', '--verify', '-q', ref], { cwd: w.origin, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}
const parkedLine = (r, seat) => new RegExp(`^parked on records/${seat} ([0-9a-f]{40})$`).exec(r.stdout.trim().split('\n').at(-1) ?? '')
const recordsRefs = (w) => git(w.origin, ['for-each-ref', '--format=%(refname)', 'refs/heads/records'])
const park = (w, paths, extra = [], env = {}) =>
  cli(w, ['--message', 'docs(test): a parked record', ...paths.flatMap((path) => ['--file', path]), '--validator', w.validator, ...extra], env)

test('a protected-branch refusal is told from a race, and its GitHub line is the detail', () => {
  assert.ok(isProtectedRejection('remote: error: GH006: Protected branch update failed for refs/heads/main.'))
  assert.ok(isProtectedRejection('!\tHEAD:refs/heads/main\t[remote rejected] (protected branch hook declined)'))
  assert.ok(isProtectedRejection('remote: error: GH013: Repository rule violations found for refs/heads/main.'))
  assert.ok(isProtectedRejection('remote: - Changes must be made through a pull request.'))
  assert.equal(isProtectedRejection('! [rejected] HEAD -> main (fetch first)'), false)
  assert.equal(isProtectedRejection('! [rejected] HEAD -> main (non-fast-forward)'), false)
  assert.equal(isProtectedRejection('remote: error: quota exceeded'), false)
  assert.equal(protectedDetail('To x\nremote: error: GH006: Protected branch update failed for refs/heads/main.\nremote: error: more'), 'GH006: Protected branch update failed for refs/heads/main.')
})

test('the seat is the TEAM.yaml key of this session, found in any project roster', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'record-commit-seat-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  write(repo, '_projects_/a/TEAM.yaml', 'members:\n  - key: other\n    session_id: session-1\n')
  write(repo, '_projects_/b/TEAM.yaml', "mechanical_backstop:\n  session_id: session-2\nmembers:\n  - key: hd-coordinator\n    session_id: 'session-3'\n  - key: developer-two\n    title: x\n    session_id: session-2\n")
  assert.equal(seatFromTeam(repo, 'session-2'), 'developer-two')
  assert.equal(seatFromTeam(repo, 'session-3'), 'hd-coordinator', 'a quoted session id')
  assert.equal(seatFromTeam(repo, 'session-1'), 'other')
  assert.equal(seatFromTeam(repo, 'session-9'), null)
  assert.equal(seatFromTeam(repo, undefined), null)
})

test('a log parked on an existing records branch gets only its own lines', () => {
  const file = { kind: 'log', origin: Buffer.from('a\nb\nmain\n'), content: Buffer.from('a\nb\nseat\n') }
  assert.equal(parkedContent(file, Buffer.from('a\nb\nearlier\n')).toString(), 'a\nb\nearlier\nseat\n')
  const plain = { kind: 'file', origin: Buffer.from('x\n'), content: Buffer.from('y\n') }
  assert.equal(parkedContent(plain, Buffer.from('z\n')).toString(), 'y\n')
})

test('a protected main parks the commit on records/<seat>, created from origin/main, and exits 0 with the line', (t) => {
  const w = world(t)
  protect(w)
  const main = originRef(w, 'main')
  write(w.live, '_projects_/x/note.md', 'one\nparked\n')
  const r = park(w, ['_projects_/x/note.md'], ['--seat', 'dev-one'])
  assert.equal(r.status, OK, r.output)
  const line = parkedLine(r, 'dev-one')
  assert.ok(line, `the last line is 'parked on records/dev-one <sha>':\n${r.output}`)
  assert.match(r.output, /push rejected: main is protected \(GH006: Protected branch update failed for refs\/heads\/main\.\)/)
  assert.match(r.output, /created from origin\/main [0-9a-f]{7}/)
  assert.equal(originRef(w, 'main'), main, 'main did not move')
  assert.equal(originRef(w, 'refs/heads/records/dev-one'), line[1])
  assert.equal(originRef(w, `${line[1]}^`), main, 'the parked commit sits on origin/main')
  assert.equal(git(w.origin, ['show', `${line[1]}:_projects_/x/note.md`]), 'one\nparked')
  assert.equal(git(w.live, ['rev-parse', 'HEAD']), main, 'the live tree was not synced')
  assert.equal(read(w.live, '_projects_/x/note.md'), 'one\nparked\n', 'the live edit is kept')
  assert.equal(worktreeCount(w), 1)
})

test('a second park appends on the branch, carrying only the seat\'s own log lines', (t) => {
  const w = world(t)
  protect(w)
  write(w.live, '_projects_/x/note.md', 'one\nfirst\n')
  const first = parkedLine(park(w, ['_projects_/x/note.md'], ['--seat', 'dev-one']), 'dev-one')[1]
  bypass(w, { '_logs_/run.jsonl': 'a\nb\nmain line\n' })
  write(w.live, '_projects_/x/other.md', 'other\nsecond\n')
  write(w.live, '_logs_/run.jsonl', 'a\nb\nseat line\n')
  const r = park(w, ['_projects_/x/other.md', '_logs_/run.jsonl'], ['--seat', 'dev-one'])
  assert.equal(r.status, OK, r.output)
  const second = parkedLine(r, 'dev-one')[1]
  assert.match(r.output, new RegExp(`appended to records/dev-one ${first.slice(0, 7)}`))
  assert.equal(originRef(w, `${second}^`), first, 'appended, not replaced')
  assert.equal(git(w.origin, ['show', `${second}:_projects_/x/note.md`]), 'one\nfirst', 'the first park is kept')
  assert.equal(git(w.origin, ['show', `${second}:_projects_/x/other.md`]), 'other\nsecond')
  assert.equal(git(w.origin, ['show', `${second}:_logs_/run.jsonl`]), 'a\nb\nseat line', 'own lines only, not main\'s')
  assert.equal(originShow(w, '_logs_/run.jsonl'), 'a\nb\nmain line\n', 'main keeps its log')
  assert.equal(worktreeCount(w), 1)
})

test('a rerun of a parked edit pushes nothing new and still names the branch', (t) => {
  const w = world(t)
  protect(w)
  write(w.live, '_projects_/x/note.md', 'one\nagain\n')
  const first = parkedLine(park(w, ['_projects_/x/note.md'], ['--seat', 'dev-one']), 'dev-one')[1]
  const r = park(w, ['_projects_/x/note.md'], ['--seat', 'dev-one'])
  assert.equal(r.status, OK, r.output)
  assert.match(r.output, /already carried by records\/dev-one/)
  assert.equal(parkedLine(r, 'dev-one')[1], first)
  assert.equal(originRef(w, 'refs/heads/records/dev-one'), first)
})

test('a records branch that main already contains is fast-forwarded', (t) => {
  const w = world(t)
  protect(w)
  write(w.live, '_projects_/x/note.md', 'one\nmerged later\n')
  const first = parkedLine(park(w, ['_projects_/x/note.md'], ['--seat', 'dev-one']), 'dev-one')[1]
  git(w.origin, ['update-ref', 'refs/heads/main', first])
  write(w.live, '_projects_/x/other.md', 'other\nafter the merge\n')
  const r = park(w, ['_projects_/x/other.md'], ['--seat', 'dev-one'])
  assert.equal(r.status, OK, r.output)
  assert.match(r.output, new RegExp(`fast-forwarded from ${first.slice(0, 7)}`))
  assert.equal(originRef(w, `${parkedLine(r, 'dev-one')[1]}^`), first)
})

test('without --seat the seat is this session\'s TEAM.yaml key', (t) => {
  const w = world(t)
  protect(w)
  write(w.live, '_projects_/t/TEAM.yaml', 'members:\n  - key: dev-two\n    session_id: session-abc\n')
  write(w.live, '_projects_/x/note.md', 'one\nfrom the roster\n')
  const r = park(w, ['_projects_/x/note.md'], [], { DSH_SESSION_ID: 'session-abc' })
  assert.equal(r.status, OK, r.output)
  assert.ok(parkedLine(r, 'dev-two'), r.output)
  assert.match(r.output, /seat dev-two, the TEAM\.yaml key of session-abc/)
})

test('a protected main with no seat known is refused, and nothing is pushed anywhere', (t) => {
  const w = world(t)
  protect(w)
  const main = originRef(w, 'main')
  write(w.live, '_projects_/x/note.md', 'one\nno seat\n')
  const r = park(w, ['_projects_/x/note.md'], [], { DSH_SESSION_ID: 'session-unknown' })
  assert.equal(r.status, REFUSED, r.output)
  assert.match(r.output, /refusing: no seat to park on; pass --seat NAME/)
  assert.doesNotMatch(r.output, /^parked on/m)
  assert.equal(originRef(w, 'main'), main)
  assert.equal(recordsRefs(w), '')
  assert.equal(worktreeCount(w), 1)
})

test('a rejection that is not protection is still refused, never parked', (t) => {
  const w = world(t)
  protect(w, 'echo "error: quota exceeded" >&2')
  write(w.live, '_projects_/x/note.md', 'one\nquota\n')
  const r = park(w, ['_projects_/x/note.md'], ['--seat', 'dev-one'])
  assert.equal(r.status, REFUSED, r.output)
  assert.match(r.output, /push rejected: /)
  assert.match(r.output, /^    remote: error: quota exceeded$/m, 'the remote\'s reason is shown, not only git\'s last line')
  assert.match(r.output, /^    ! \S+ \[remote rejected\]/m)
  assert.doesNotMatch(r.output, /^parked on|is protected/m)
  assert.equal(recordsRefs(w), '')
})

test('a records branch another run moves mid-park is rebuilt on, and both commits are kept', (t) => {
  const w = world(t)
  protect(w)
  const hookDir = join(w.live, '.git', 'hooks')
  mkdirSync(hookDir, { recursive: true })
  writeFileSync(
    join(hookDir, 'pre-push'),
    `#!/bin/sh
while read local_ref local_sha remote_ref remote_sha; do
  case "$remote_ref" in
    refs/heads/records/*)
      if [ ! -f "$RACE_MARKER" ]; then
        touch "$RACE_MARKER"
        unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
        git -C "$WRITER" fetch -q origin
        git -C "$WRITER" reset -q --hard origin/main
        printf 'other run\\n' > "$WRITER/_projects_/x/other.md"
        git -C "$WRITER" commit -qam 'another run of the seat'
        git -C "$WRITER" push -q origin HEAD:refs/heads/records/dev-one
      fi;;
  esac
done
exit 0
`,
  )
  chmodSync(join(hookDir, 'pre-push'), 0o755)
  write(w.live, '_projects_/x/note.md', 'one\nmid-park\n')
  const r = park(w, ['_projects_/x/note.md'], ['--seat', 'dev-one'], { RACE_MARKER: join(w.root, 'race'), WRITER: w.writer })
  assert.equal(r.status, OK, r.output)
  assert.match(r.output, /records\/dev-one moved while parking/)
  const sha = parkedLine(r, 'dev-one')[1]
  assert.equal(git(w.origin, ['show', `${sha}:_projects_/x/other.md`]), 'other run', 'the other run is kept')
  assert.equal(git(w.origin, ['show', `${sha}:_projects_/x/note.md`]), 'one\nmid-park')
  assert.equal(originRef(w, 'refs/heads/records/dev-one'), sha)
})

// 2026-11-01 15:24 PST: the owner froze reflection main for the KB cutover, and after it
// main takes pull requests only. A seat must never push main, even while its protection is
// off, so parking became the default. This origin accepts main and logs every ref pushed.
function logPushes(w) {
  const log = join(w.root, 'pushed-refs')
  const hook = join(w.origin, 'hooks', 'update')
  writeFileSync(hook, `#!/bin/sh\necho "$1" >> '${log}'\nexit 0\n`)
  chmodSync(hook, 0o755)
  return () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [])
}

test('by default a record is parked on records/<seat> and main is never pushed, even when it would accept', (t) => {
  const w = world(t)
  const pushed = logPushes(w)
  const main = originRef(w, 'main')
  write(w.live, '_projects_/x/note.md', 'one\nby default\n')
  const r = run(w, ['--message', 'docs(test): a default record', '--file', '_projects_/x/note.md', '--validator', w.validator, '--seat', 'dev-one'])
  assert.equal(r.status, OK, r.output)
  const line = parkedLine(r, 'dev-one')
  assert.ok(line, `the last line is 'parked on records/dev-one <sha>':\n${r.output}`)
  assert.match(r.output, /main is not pushed: parking is the default \(--main would try a direct push first\)/)
  assert.deepEqual(pushed(), ['refs/heads/records/dev-one'], 'the only ref pushed is the records branch; main was never attempted')
  assert.equal(originRef(w, 'main'), main, 'main did not move')
  assert.equal(originRef(w, `${line[1]}^`), main, 'the parked commit sits on origin/main')
  assert.equal(git(w.origin, ['show', `${line[1]}:_projects_/x/note.md`]), 'one\nby default')
  assert.equal(git(w.live, ['rev-parse', 'HEAD']), main, 'the live tree was not synced')
  assert.equal(worktreeCount(w), 1)
})

test('by default the seat is this session\'s TEAM.yaml key, and a second record appends', (t) => {
  const w = world(t)
  const pushed = logPushes(w)
  write(w.live, '_projects_/t/TEAM.yaml', 'members:\n  - key: dev-two\n    session_id: session-abc\n')
  write(w.live, '_projects_/x/note.md', 'one\nfirst\n')
  const args = (path) => ['--message', 'docs(test): a roster record', '--file', path, '--validator', w.validator]
  const first = parkedLine(run(w, args('_projects_/x/note.md'), { DSH_SESSION_ID: 'session-abc' }), 'dev-two')
  assert.ok(first)
  write(w.live, '_projects_/x/other.md', 'other\nsecond\n')
  const r = run(w, args('_projects_/x/other.md'), { DSH_SESSION_ID: 'session-abc' })
  assert.equal(r.status, OK, r.output)
  assert.match(r.output, new RegExp(`appended to records/dev-two ${first[1].slice(0, 7)}`))
  assert.match(r.output, /seat dev-two, the TEAM\.yaml key of session-abc/)
  assert.ok(pushed().every((ref) => ref === 'refs/heads/records/dev-two'), `main was never attempted: ${pushed()}`)
})

test('by default no seat refuses the run before anything is committed or pushed', (t) => {
  const w = world(t)
  const pushed = logPushes(w)
  write(w.live, '_projects_/x/note.md', 'one\nno seat\n')
  const r = run(w, ['--message', 'docs(test): no seat', '--file', '_projects_/x/note.md', '--validator', w.validator], { DSH_SESSION_ID: 'session-unknown' })
  assert.equal(r.status, REFUSED, r.output)
  assert.match(r.output, /refusing: no seat to park on; pass --seat NAME.*main is never pushed without --main/)
  assert.doesNotMatch(r.output, /commit [0-9a-f]{7}/, 'nothing was committed')
  assert.deepEqual(pushed(), [])
  const bad = run(w, ['--message', 'docs(test): bad seat', '--file', '_projects_/x/note.md', '--validator', w.validator, '--seat', '../main'])
  assert.equal(bad.status, REFUSED, bad.output)
  assert.match(bad.output, /is not a branch-safe name\. Nothing was committed/)
  assert.doesNotMatch(bad.output, /commit [0-9a-f]{7}/, 'refused before the commit, not after it')
  assert.deepEqual(pushed(), [])
  assert.equal(worktreeCount(w), 1)
})

test('a default dry run names the records branch it would park on, and pushes nothing', (t) => {
  const w = world(t)
  const pushed = logPushes(w)
  write(w.live, '_projects_/x/note.md', 'one\ndry\n')
  const r = run(w, ['--message', 'docs(test): dry', '--file', '_projects_/x/note.md', '--validator', w.validator, '--seat', 'dev-one', '--dry-run'])
  assert.equal(r.status, OK, r.output)
  assert.match(r.output, /dry run: would commit 1 file\(s\) and park it on records\/dev-one, not pushing origin\/main/)
  assert.deepEqual(pushed(), [])
})

test('--main pushes main directly when it accepts', (t) => {
  const w = world(t)
  const pushed = logPushes(w)
  write(w.live, '_projects_/x/note.md', 'one\ndirect\n')
  const r = run(w, ['--message', 'docs(test): direct', '--file', '_projects_/x/note.md', '--validator', w.validator, '--main'])
  assert.equal(r.status, OK, r.output)
  assert.deepEqual(pushed(), ['refs/heads/main'])
  assert.equal(originShow(w, '_projects_/x/note.md'), 'one\ndirect\n')
  assert.doesNotMatch(r.output, /^parked on/m)
})

test('a refusal names the remote\'s reasons and the porcelain status, not only git\'s last line', () => {
  const text = "!\tHEAD:refs/heads/main\t[remote rejected] (hook declined)\nDone\nremote: error: quota exceeded        \nremote: \nremote: Create a pull request for 'x' on GitHub by visiting:\nTo github.com:dtadpole/reflection.git\nerror: failed to push some refs to 'github.com:dtadpole/reflection.git'\n"
  assert.deepEqual(rejectionReasons(text), ['! HEAD:refs/heads/main [remote rejected] (hook declined)', 'remote: error: quota exceeded'])
  assert.deepEqual(rejectionReasons('error: failed to push some refs'), [])
  assert.equal(rejectionReasons(Array.from({ length: 20 }, (_, i) => `remote: line ${i}`).join('\n')).length, 8)
})
