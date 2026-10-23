import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import {
  ERROR,
  OK,
  actionLedger,
  candidateIndexes,
  classifyPath,
  collectReview,
  lastSentReport,
  parseScopes,
  parseStatusZ,
  parseTeamYaml,
  recordedRuns,
  render,
  teamDefaults,
} from '../../review-collect.mjs'

const TOOL = join(import.meta.dirname, '..', '..', 'review-collect.mjs')

function git(cwd, args) {
  const r = spawnSync('git', ['--no-optional-locks', '-C', cwd, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd } })
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

const TEAM = `# fixture roster
title: '[hd] fixture team'
record_owner: hd-coordinator
coordination:
  reporting:
    owner_gateway: hd-coordinator
members:
  - key: fake-seat
    title: '[hd] Fake Seat'
    lane: backend
    current_focus: 'the fake crate, end to end'
    write_scopes:
      - 'heddle rust/crates/fake-crate/'
    excluded_write_scopes:
      - 'every other seat''s worktree'
    resource_identity_ref: 'Mac ~/heddle--fake-seat'
  - key: other-seat
    title: '[hd] Other Seat'
    assignment: planned
    roles:
      - porter
    write_scopes:
      - 'heddle rust/crates/other/'
`

// One bare origin, a reviewer clone with origin/main, and a seat clone on hd/fake-seat
// with commits ahead, an uncommitted edit, a recorded run and a fake inbox/log world.
function world(t) {
  const root = mkdtempSync(join(tmpdir(), 'review-collect-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const origin = join(root, 'origin.git')
  git(root, ['init', '--bare', '-q', '--initial-branch=main', 'origin.git'])
  const seed = join(root, 'seed')
  git(root, ['clone', '-q', origin, 'seed'])
  configure(seed)
  write(seed, 'rust/crates/fake-crate/src/lib.rs', 'one\n')
  write(seed, 'rust/Cargo.lock', 'lock\n')
  write(seed, 'README.md', 'base\n')
  git(seed, ['add', '-A'])
  git(seed, ['commit', '-q', '-m', 'base'])
  git(seed, ['push', '-q', '-u', 'origin', 'main'])

  const clone = (name) => {
    const dir = join(root, name)
    git(root, ['clone', '-q', origin, name])
    configure(dir)
    return dir
  }
  const reviewer = clone('reviewer')
  const seat = clone('seat')
  git(seat, ['checkout', '-q', '-b', 'hd/fake-seat'])
  write(seat, 'rust/crates/fake-crate/src/lib.rs', 'two\n')
  git(seat, ['add', 'rust/crates/fake-crate/src/lib.rs'])
  git(seat, ['commit', '-q', '-m', 'feat(fake-crate): in scope work'])
  write(seat, 'rust/Cargo.lock', 'lock2\n')
  git(seat, ['add', 'rust/Cargo.lock'])
  git(seat, ['commit', '-q', '-m', 'chore: lockfile outside the crate'])
  write(seat, 'rust/crates/fake-crate/INDEX.md', '# fake crate\n\n**Landed:** 3 tests at 2026-10-22, `cargo test -p fake-crate` green.\n')
  git(seat, ['add', 'rust/crates/fake-crate/INDEX.md'])
  git(seat, ['commit', '-q', '-m', 'docs(fake-crate): record the run'])
  // uncommitted: one in scope, one outside
  write(seat, 'rust/crates/fake-crate/src/lib.rs', 'three\n')
  write(seat, 'notes.txt', 'scratch\n')

  const team = join(root, 'TEAM.yaml')
  writeFileSync(team, TEAM)

  const inbox = join(root, 'inbox')
  const message = (id, from, to, created, subject, body, kind = 'fyi') => JSON.stringify({ id, from, to, kind, urgent: false, subject, body, refs: [], reply_to: null, created })
  mkdirSync(join(inbox, 'hd', 'hd-coordinator'), { recursive: true })
  writeFileSync(
    join(inbox, 'hd', 'hd-coordinator', 'inbox.jsonl'),
    [
      message('m-early', 'fake-seat', 'hd-coordinator', '2026-10-22T19:30:00-07:00', 'early report', 'not the last one'),
      message('m-last', 'fake-seat', 'hd-coordinator', '2026-10-22T20:30:00-07:00', 'fake report', 'line one\nline two\nline three'),
      message('m-other', 'other-seat', 'hd-coordinator', '2026-10-22T20:40:00-07:00', 'someone else', 'ignore me'),
      message('m-peer', 'fake-seat', 'other-seat', '2026-10-22T20:45:00-07:00', 'peer answer', 'to a peer', 'answer'),
      message('m-received', 'hd-coordinator', 'fake-seat', '2026-10-22T20:50:00-07:00', 'to the seat', 'not a sent report'),
    ].join('\n') + '\n',
  )
  mkdirSync(join(inbox, 'hd', 'fake-seat'), { recursive: true })
  writeFileSync(
    join(inbox, 'hd', 'fake-seat', 'inbox.jsonl'),
    message('m-received', 'hd-coordinator', 'fake-seat', '2026-10-22T20:50:00-07:00', 'to the seat', 'not a sent report') + '\n',
  )

  const actionLog = join(root, 'action-log.jsonl')
  const action = (timestamp, actor, reason, commit = '-', paths = []) => JSON.stringify({ timestamp, actor, action: 'update', paths, reason, commit })
  writeFileSync(
    actionLog,
    [
      action('2026-10-22T19:00:00-07:00', 'deepseek-flash (dsh)', '[hd] fake-seat: early work'),
      action('2026-10-22T20:00:00-07:00', 'deepseek-flash (dsh)', '[hd] other-seat: another seat'),
      action('2026-10-22T21:00:00-07:00', 'deepseek-flash (dsh)', '[hd] fake-seat: after review work', 'abc1234', ['rust/crates/fake-crate/src/lib.rs']),
      action('2026-10-22T21:05:00-07:00', 'fake-seat', 'direct actor line', 'def5678', []),
    ].join('\n') + '\n',
  )

  const reviewLog = join(root, 'review-log.jsonl')
  writeFileSync(reviewLog, JSON.stringify({ date: '2026-10-22T20:00:00-07:00', reviewer: 'hd-coordinator', member: 'fake-seat', verdict: 'good', evidence: [], fixes: [], sent: 'none' }) + '\n')

  return { root, origin, reviewer, seat, team, inbox, actionLog, reviewLog }
}

const argsFor = (w, extra = []) => [
  '--team', w.team,
  '--repo', w.reviewer,
  '--worktree', w.seat,
  '--inbox-home', w.inbox,
  '--action-log', w.actionLog,
  '--review-log', w.reviewLog,
  ...extra,
]

function cli(w, extra = []) {
  const r = spawnSync(process.execPath, [TOOL, '--seat', 'fake-seat', ...argsFor(w, extra)], { cwd: w.root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: w.root } })
  return { ...r, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
}

test('the roster reader handles maps, lists of maps, quoted scalars and an escaped quote', () => {
  const roster = parseTeamYaml(TEAM)
  assert.equal(roster.title, '[hd] fixture team')
  assert.equal(roster.members.length, 2)
  const seat = roster.members[0]
  assert.equal(seat.key, 'fake-seat')
  assert.equal(seat.lane, 'backend')
  assert.deepEqual(seat.write_scopes, ['heddle rust/crates/fake-crate/'])
  assert.equal(seat.excluded_write_scopes[0], "every other seat's worktree")
  assert.equal(roster.members[1].assignment, 'planned')
  assert.deepEqual(roster.members[1].roles, ['porter'])
})

test('scopes become path prefixes, with the prose kept when there is no path', () => {
  const scopes = parseScopes({
    write_scopes: ['heddle rust/crates/fake-crate/', 'the backend _verifiers_ folders', 'merges of the backend lane onto main', 'the deployment ~/heddle-live'],
    excluded_write_scopes: ["every other seat's worktree"],
  })
  assert.deepEqual(scopes.includes.map((scope) => scope.prefix), ['rust/crates/fake-crate/', '_verifiers_/'])
  assert.deepEqual(scopes.unparsed, ['merges of the backend lane onto main', 'the deployment ~/heddle-live'])
  assert.deepEqual(scopes.excludes, [])
})

test('a path is in, outside, excluded or unscoped, and a glob scope works', () => {
  const scopes = parseScopes({ write_scopes: ['heddle rust/crates/fake-crate/', 'heddle rust/crates/heddle-*/'], excluded_write_scopes: ['heddle rust/Cargo.lock'] })
  assert.equal(classifyPath('rust/crates/fake-crate/src/lib.rs', scopes).verdict, 'in')
  assert.equal(classifyPath('rust/crates/heddle-team/src/lib.rs', scopes).verdict, 'in')
  assert.equal(classifyPath('rust/Cargo.lock', scopes).verdict, 'excluded')
  assert.equal(classifyPath('_tools_/x.mjs', scopes).verdict, 'outside')
  assert.equal(classifyPath('anything', parseScopes({ write_scopes: ['merges onto main'] })).verdict, 'unscoped')
})

test('porcelain status keeps the path and the state, including a rename', () => {
  const entries = parseStatusZ(' M a.rs\0?? b.txt\0R  new.rs\0old.rs\0')
  assert.deepEqual(entries.map((entry) => [entry.index, entry.worktree, entry.path, entry.untracked]), [
    [' ', 'M', 'a.rs', false],
    ['?', '?', 'b.txt', true],
    ['R', ' ', 'new.rs', false],
  ])
})

test('the last sent report is the newest message from the seat, not a received one', (t) => {
  const w = world(t)
  const { report, latest, sent } = lastSentReport({ inboxHome: w.inbox, seat: 'fake-seat', reporter: 'hd-coordinator' })
  assert.equal(report.id, 'm-last', 'the newest message to the coordinator, not the newer peer answer')
  assert.equal(report.subject, 'fake report')
  assert.equal(latest.id, 'm-peer', 'the newer peer message is kept beside it')
  assert.equal(sent, 3, 'three distinct sent messages; the duplicate received copy is not counted')
  assert.equal(lastSentReport({ inboxHome: w.inbox, seat: 'fake-seat', reporter: 'nobody' }).report, null)
  assert.equal(lastSentReport({ inboxHome: w.inbox, seat: 'fake-seat' }).report, null, 'no reporter, no report claimed')
})

test('the ledger keeps only the seat lines after the last review, and can name the last one before it', (t) => {
  const w = world(t)
  const ledger = actionLedger({ actionLog: w.actionLog, reviewLog: w.reviewLog, seat: 'fake-seat' })
  assert.equal(ledger.review.date, '2026-10-22T20:00:00-07:00')
  assert.equal(ledger.lines.length, 2, 'the after-review line and the direct-actor line')
  assert.ok(ledger.lines.every((line) => !String(line.reason).includes('early work')))
  assert.equal(ledger.lastBefore.reason, '[hd] fake-seat: early work')
})

test('the recorded run is the last run line in a scoped INDEX, with its command', (t) => {
  const w = world(t)
  const scopes = parseScopes({ write_scopes: ['heddle rust/crates/fake-crate/'] })
  const runs = recordedRuns({ worktree: w.seat, scopes })
  assert.equal(runs.recorded.length, 1)
  assert.equal(runs.recorded[0].file, 'rust/crates/fake-crate/INDEX.md')
  assert.equal(runs.recorded[0].command, 'cargo test -p fake-crate')
  assert.equal(runs.recorded[0].date, '2026-10-22')
  const none = recordedRuns({ worktree: w.seat, scopes: parseScopes({ write_scopes: ['heddle rust/crates/other/'] }) })
  assert.deepEqual(none.recorded, [])
  assert.deepEqual(none.declared, [])
})

test('a usage line in a code fence is not a run; a declared command is shown as declared', (t) => {
  const w = world(t)
  write(
    w.seat,
    '_verifiers_/50-fake/INDEX.md',
    '# fake verifier\n\n```bash\nsh verify.sh --list     # the check names, and why any was unjudged\n```\n\n| Unit tests | `cargo test -p fake-verifier` |\n',
  )
  const scopes = parseScopes({ write_scopes: ['the backend _verifiers_ folders'] })
  assert.equal(recordedRuns({ worktree: w.seat, scopes }).declared.length, 0, 'a broad scope alone credits no verifier')
  const touched = ['_verifiers_/50-fake/check.mjs']
  const runs = recordedRuns({ worktree: w.seat, scopes, touched })
  assert.equal(runs.recordedTotal, 0, 'a usage comment that says unjudged is not a recorded run')
  assert.equal(runs.declared.length, 1)
  assert.equal(runs.declared[0].command, 'sh verify.sh --list', 'the first declared command, its comment dropped')
  write(w.seat, '_verifiers_/50-fake/INDEX.md', '# fake verifier\n\nLast run 2026-10-22: `sh verify.sh` 9 passed, 1 unjudged.\n')
  const recorded = recordedRuns({ worktree: w.seat, scopes, touched })
  assert.equal(recorded.recordedTotal, 1)
  assert.equal(recorded.recorded[0].command, 'sh verify.sh')
})

test('run candidates are the INDEXes a scope names and the units a seat touched', (t) => {
  const w = world(t)
  write(w.seat, 'rust/INDEX.md', '# status\n\n| 05 | 10 passed, 2026-10-22, `HEDDLE_BIN=x sh verify.sh` |\n')
  write(w.seat, '_tools_/some-tool/INDEX.md', '# tool\n')
  write(w.seat, '_tools_/mine/INDEX.md', '# mine\n')
  write(w.seat, '_tools_/browser/INDEX.md', "```js\nimport { x } from '../../_tools_/verify-runner/browser.mjs'\n```\n")
  const scopes = parseScopes({ write_scopes: ['rust/INDEX.md (status table, single writer)', 'monitoring scripts under heddle _tools_/'] })
  const names = (touched) => candidateIndexes({ worktree: w.seat, scopes, touched }).map((entry) => entry.relativePath)
  assert.deepEqual(names([]), ['rust/INDEX.md'], 'a named file counts; a broad _tools_/ does not on its own')
  assert.deepEqual(names(['_tools_/mine/run.mjs']), ['_tools_/mine/INDEX.md', 'rust/INDEX.md'], 'a touched tool counts, touched first')
  const browser = recordedRuns({ worktree: w.seat, scopes, touched: ['_tools_/browser/x.mjs'] })
  assert.ok(!browser.declared.some((run) => run.command.includes('import')), 'an import line is not a command')
  assert.equal(browser.recorded[0].file, 'rust/INDEX.md', 'the status table row is a recorded run')
})

test('a fenced multi-line command and the counted result below it are one recorded run, dated by its heading', (t) => {
  const w = world(t)
  write(
    w.seat,
    'rust/INDEX.md',
    [
      '# status',
      '',
      '**Run 2026-10-22, in `~/heddle--int-backend`, on the merged candidate at `5b953ad`:**',
      '',
      '```bash',
      '_tools_/local-build/run build --release --manifest-path rust/Cargo.toml    # exit 0',
      'HEDDLE_BIN="$PWD/rust/target/release/heddle" \\',
      '  node _tools_/verify-runner/run.mjs _verifiers_/<part>/check*.mjs --json',
      '```',
      '',
      '**18 check files, 116 checks: 10 passed, 0 failed, 106 unjudged. Part 0 passes.**',
      '',
    ].join('\n'),
  )
  const scopes = parseScopes({ write_scopes: ['rust/INDEX.md (status table, single writer)'] })
  const runs = recordedRuns({ worktree: w.seat, scopes })
  assert.equal(runs.recordedTotal, 1)
  const run = runs.recorded[0]
  assert.equal(run.file, 'rust/INDEX.md')
  assert.equal(run.line, 11)
  assert.equal(run.date, '2026-10-22', 'dated by the heading above the block')
  assert.match(run.text, /10 passed, 0 failed, 106 unjudged/)
  assert.equal(
    run.command,
    '_tools_/local-build/run build --release --manifest-path rust/Cargo.toml ; HEDDLE_BIN="$PWD/rust/target/release/heddle" node _tools_/verify-runner/run.mjs _verifiers_/<part>/check*.mjs --json',
    'both commands, the continuation joined, the comment dropped',
  )
})

test('the page carries every section a review needs', (t) => {
  const w = world(t)
  const r = cli(w)
  assert.equal(r.status, OK, r.output)
  assert.match(r.output, /review-collect: fake-seat/)
  assert.match(r.output, /tip         3 ahead, 0 behind/)
  assert.match(r.output, /commits     3 ahead with subjects/)
  assert.match(r.output, /feat\(fake-crate\): in scope work/)
  assert.match(r.output, /crate fake-crate \(2\) \[in scope \(heddle rust\/crates\/fake-crate\/\)\]/)
  assert.match(r.output, /rust \(1\) \[OUTSIDE SCOPE\]\n    rust\/Cargo\.lock/)
  assert.match(r.output, /scope check ATTENTION: 1 committed and 1 uncommitted path\(s\) outside the write scope \(rust\/Cargo\.lock, notes\.txt\)/)
  assert.match(r.output, /uncommitted 2 path\(s\)/)
  assert.match(r.output, /rust\/crates\/fake-crate\/src\/lib\.rs  in scope/)
  assert.match(r.output, /notes\.txt  OUTSIDE SCOPE/)
  assert.match(r.output, /last report 2026-10-22T20:30:00-07:00 to hd-coordinator \[fyi\] fake report/)
  assert.match(r.output, /line two/)
  assert.doesNotMatch(r.output, /not a sent report/, 'a received message is not the seat report')
  assert.match(r.output, /newer msg   2026-10-22T20:45:00-07:00 to other-seat \[answer\] peer answer/)
  assert.match(r.output, /runs        1 recorded in a scoped INDEX/)
  assert.match(r.output, /command: cargo test -p fake-crate/)
  assert.match(r.output, /action log  2 line\(s\) since 2026-10-22T20:00:00-07:00/)
  assert.match(r.output, /after review work/)
  assert.doesNotMatch(r.output, /early work/, 'the line before the review is not in the ledger')
  assert.match(r.output, /scope       include: rust\/crates\/fake-crate\//)
})

test('the page shows the pushed branch beside local HEAD: not pushed, then partly pushed', (t) => {
  const w = world(t)
  const unpushed = cli(w)
  assert.equal(unpushed.status, OK, unpushed.output)
  assert.match(unpushed.output, /pushed      NOT PUSHED: no origin\/hd\/fake-seat; every commit below is local only/)

  // Push only the first of the three commits: the page must say 1 pushed, 2 local.
  git(w.seat, ['push', '-q', 'origin', 'HEAD~2:refs/heads/hd/fake-seat'])
  const partly = cli(w)
  assert.equal(partly.status, OK, partly.output)
  assert.match(partly.output, /tip         3 ahead, 0 behind/)
  assert.match(partly.output, /pushed      origin\/hd\/fake-seat [0-9a-f]{7}: 1 ahead, 0 behind origin\/main; local HEAD has 2 unpushed commit\(s\)/)

  git(w.seat, ['push', '-q', 'origin', 'HEAD:refs/heads/hd/fake-seat'])
  const all = cli(w)
  assert.match(all.output, /pushed      origin\/hd\/fake-seat [0-9a-f]{7}: 3 ahead, 0 behind origin\/main; local HEAD is the pushed tip/)
})

test('a seat whose work is all in scope reads clean', (t) => {
  const w = world(t)
  git(w.seat, ['reset', '-q', '--hard', 'HEAD~2'])
  rmSync(join(w.seat, 'notes.txt'), { force: true })
  const r = cli(w)
  assert.equal(r.status, OK, r.output)
  assert.match(r.output, /scope check clean: 0 committed and 0 uncommitted path\(s\) outside the write scope/)
  assert.match(r.output, /tip         1 ahead, 0 behind/)
})

test('a planned seat with no worktree still gets its report and ledger, and says MISSING', (t) => {
  const w = world(t)
  const r = spawnSync(process.execPath, [TOOL, '--seat', 'other-seat', '--team', w.team, '--repo', w.reviewer, '--worktree', join(w.root, 'no-such-worktree'), '--inbox-home', w.inbox, '--action-log', w.actionLog, '--review-log', w.reviewLog], { encoding: 'utf8' })
  assert.equal(r.status, OK, r.stderr)
  assert.match(r.stdout, /review-collect: other-seat/)
  assert.match(r.stdout, /MISSING/)
})

test('an unknown seat fails with the list of seats', (t) => {
  const w = world(t)
  const r = spawnSync(process.execPath, [TOOL, '--seat', 'nobody', ...argsFor(w)], { encoding: 'utf8' })
  assert.equal(r.status, ERROR)
  assert.match(r.stderr, /no member "nobody"/)
  assert.match(r.stderr, /seats: fake-seat, other-seat/)
})

test('collectReview returns the same page the render prints, without writing', (t) => {
  const w = world(t)
  const before = git(w.seat, ['status', '--porcelain'])
  const result = collectReview({ seat: 'fake-seat', team: w.team, repo: w.reviewer, worktree: w.seat, inboxHome: w.inbox, actionLog: w.actionLog, reviewLog: w.reviewLog })
  assert.equal(result.ahead, 3)
  assert.equal(result.runs.recordedTotal, 1)
  assert.equal(result.files.length, 3)
  assert.equal(result.uncommitted.length, 2)
  assert.equal(result.ledger.lines.length, 2)
  assert.match(render(result), /review-collect: fake-seat/)
  assert.equal(git(w.seat, ['status', '--porcelain']), before, 'the page writes nothing into the seat worktree')
})

test('the logs and the reporter come from the team record, with no team path built in', (t) => {
  const w = world(t)
  const tree = join(w.root, 'tree')
  const project = '_projects_/fixture'
  write(tree, `${project}/TEAM.yaml`, `${TEAM}reflection:\n  root_hint: ${tree}\nproject_path: ${project}\nreferences:\n  execution_review: ${project}/review-log.jsonl\n`)
  write(tree, `${project}/review-log.jsonl`, readFileSync(w.reviewLog, 'utf8'))
  write(tree, '_logs_/repo-actions/action-log.jsonl', readFileSync(w.actionLog, 'utf8'))
  const teamFile = join(tree, project, 'TEAM.yaml')

  const roster = parseTeamYaml(readFileSync(teamFile, 'utf8'))
  const defaults = teamDefaults({ roster, teamFile })
  assert.equal(defaults.root, tree)
  assert.equal(defaults.reviewLog, join(tree, project, 'review-log.jsonl'))
  assert.equal(defaults.actionLog, join(tree, '_logs_/repo-actions/action-log.jsonl'))
  assert.equal(defaults.reporter, 'hd-coordinator')
  // A root_hint that does not exist falls back to the team file's folder minus its project path.
  const moved = teamDefaults({ roster: { ...roster, reflection: { root_hint: join(w.root, 'gone') } }, teamFile })
  assert.equal(moved.root, tree)

  const r = spawnSync(process.execPath, [TOOL, '--seat', 'fake-seat', '--team', teamFile, '--repo', w.reviewer, '--worktree', w.seat, '--inbox-home', w.inbox], { encoding: 'utf8' })
  assert.equal(r.status, OK, r.stderr)
  assert.match(r.stdout, /action log  2 line\(s\) since 2026-10-22T20:00:00-07:00/, 'both logs found from the record')
  assert.match(r.stdout, /last report 2026-10-22T20:30:00-07:00 to hd-coordinator/, 'the reporter from the record')
  assert.doesNotMatch(r.stdout, /^note /m)
})

test('without --team or HEDDLE_TEAM_FILE the tool refuses and says how to name the record', (t) => {
  const w = world(t)
  const env = { PATH: process.env.PATH, HOME: w.root }
  const r = spawnSync(process.execPath, [TOOL, '--seat', 'fake-seat', '--repo', w.reviewer], { encoding: 'utf8', env })
  assert.equal(r.status, ERROR)
  assert.match(r.stderr, /pass --team <TEAM\.yaml> or set HEDDLE_TEAM_FILE/)
  const viaEnv = spawnSync(process.execPath, [TOOL, '--seat', 'fake-seat', '--repo', w.reviewer, '--worktree', w.seat, '--inbox-home', w.inbox], { encoding: 'utf8', env: { ...env, HEDDLE_TEAM_FILE: w.team } })
  assert.equal(viaEnv.status, OK, viaEnv.stderr)
  assert.match(viaEnv.stdout, /review-collect: fake-seat/)
})

test('a bad --worktree relative path or missing team file is a clear error', (t) => {
  const w = world(t)
  const missingTeam = spawnSync(process.execPath, [TOOL, '--seat', 'fake-seat', '--team', join(w.root, 'nope.yaml'), '--repo', w.reviewer], { encoding: 'utf8' })
  assert.equal(missingTeam.status, ERROR)
  assert.match(missingTeam.stderr, /no team file/)
})
