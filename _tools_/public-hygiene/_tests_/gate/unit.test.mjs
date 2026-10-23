import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'

import {
  CANNOT_RUN,
  EXPECTED_IDENTITY,
  FOUND,
  OK,
  checkIdentity,
  describe,
  isPlaceholderNearUuid,
  isPlaceholderUuid,
  liveMatches,
  parseDiff,
  parseIdentifiers,
  parseLog,
  scanText,
} from '../../gate.mjs'

const GATE = join(import.meta.dirname, '..', '..', 'gate.mjs')

const LIST = '# comment\nexample-host-a\nre:example-token-[0-9a-f]{8}-\n\n'

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'public-hygiene-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const list = join(dir, 'identifiers.txt')
  writeFileSync(list, LIST)
  return { dir, list }
}

function git(cwd, args, env = {}) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: cwd, ...env },
  })
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'public-hygiene-repo-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  git(dir, ['init', '-q'])
  const identity = ['-c', 'user.name=D.Tadpole', '-c', 'user.email=gsk390@gmail.com']
  writeFileSync(join(dir, 'README.md'), 'base\n')
  git(dir, [...identity, 'add', 'README.md'])
  git(dir, [...identity, 'commit', '-q', '-m', 'base'])
  return { dir, identity }
}

function gate(cwd, args, extra = {}) {
  const r = spawnSync(process.execPath, [GATE, ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: cwd, ...extra },
  })
  return { ...r, output: `${r.stdout}\n${r.stderr}` }
}

test('an identifier list is literals and regexes, and a rule that cannot work is refused', () => {
  const rules = parseIdentifiers('# notes\nexample-host-a\n\nre:\\bexample-host-[0-9]+\\b\n')
  assert.equal(rules.length, 2)
  assert.equal(rules[0].kind, 'literal')
  assert.equal(rules[1].kind, 'regex')
  assert.match(rules[0].label, /private 2/)
  assert.throws(() => parseIdentifiers('re:(unclosed\n'), /unclosed|Invalid/)
  assert.throws(() => parseIdentifiers('re:\n'), /empty regular expression/)
  assert.throws(() => parseIdentifiers('re:.*\n'), /empty string/, 'a rule matching everything is a mistake')
})

test('a literal is matched case-insensitively and the excerpt never carries the term', () => {
  const rules = parseIdentifiers('EXAMPLE-HOST-A\n')
  const findings = scanText('connect to example-host-a now\nand EXAMPLE-HOST-A again\n', rules)
  assert.equal(findings.length, 2)
  assert.equal(findings[0].line, 1)
  assert.equal(findings[1].line, 2)
  for (const finding of findings) {
    assert.doesNotMatch(finding.excerpt, /example-host-a/i, 'the report must not echo the term')
    assert.match(finding.excerpt, /\[redacted\]/)
  }
})

test('a diff is read as added lines with their new line numbers, and as path names', () => {
  const diff = [
    'diff --git a/a.md b/a.md',
    'index 1..2 100644',
    '--- a/a.md',
    '+++ b/a.md',
    '@@ -1,2 +1,3 @@',
    ' keep',
    '-gone',
    '+added one',
    '+added two',
    'diff --git a/dev/null b/example-host-a-notes.md',
    '--- /dev/null',
    '+++ b/example-host-a-notes.md',
    '@@ -0,0 +1 @@',
    '+body',
  ].join('\n')
  const { added, paths } = parseDiff(diff)
  assert.deepEqual(added, [
    { path: 'a.md', line: 2, text: 'added one' },
    { path: 'a.md', line: 3, text: 'added two' },
    { path: 'example-host-a-notes.md', line: 1, text: 'body' },
  ])
  assert.deepEqual(paths, ['a.md', 'example-host-a-notes.md'])
})

test('a log is read as hash, author, committer and message', () => {
  const record = (hash, who, message) => `${hash}\x00${who}\x00${who}\x00${message}\x1e`
  const commits = parseLog(record('a'.repeat(40), 'D.Tadpole <gsk390@gmail.com>', 'subject\n\nbody') + record('b'.repeat(40), 'Other <o@example.com>', 'x'))
  assert.equal(commits.length, 2)
  assert.equal(commits[0].short, 'aaaaaaa')
  assert.equal(commits[0].message, 'subject\n\nbody')
  assert.equal(commits[1].author, 'Other <o@example.com>')
})

test('a wrong author or committer is a finding, and the report masks it', () => {
  const commits = [{ hash: 'a'.repeat(40), short: 'aaaaaaa', author: 'Other <o@example.com>', committer: EXPECTED_IDENTITY, message: '' }]
  const findings = checkIdentity(commits)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].side, 'author')
  const text = describe(findings).join('\n')
  assert.doesNotMatch(text, /o@example\.com/, 'an unexpected identity is not echoed')
  assert.match(text, /O\*\*\*@example\.com/)
})

test('a clean range exits 0, a leaked literal exits 1 with a redacted report', (t) => {
  const sb = sandbox(t)
  const { dir, identity } = repo(t)
  writeFileSync(join(dir, 'notes.md'), 'deployed on example-host-a today\n')
  git(dir, [...identity, 'add', 'notes.md'])
  git(dir, [...identity, 'commit', '-q', '-m', 'notes'])

  const clean = gate(dir, ['--range', 'HEAD~1..HEAD', '--identifiers', sb.list, '--no-identity'])
  // The base commit is clean but HEAD adds the leak.
  assert.equal(clean.status, FOUND)
  assert.match(clean.output, /content\s+notes\.md:1/)
  assert.match(clean.output, /\[redacted\]/)
  assert.doesNotMatch(clean.output, /example-host-a/)

  const empty = gate(dir, ['--range', 'HEAD..HEAD', '--identifiers', sb.list, '--no-identity'])
  assert.equal(empty.status, OK)
  assert.match(empty.output, /ok: nothing to flag/)
})

test('a leaked term in a path and in a commit message is found too', (t) => {
  const sb = sandbox(t)
  const { dir, identity } = repo(t)
  writeFileSync(join(dir, 'example-host-a-notes.md'), 'plain\n')
  git(dir, [...identity, 'add', 'example-host-a-notes.md'])
  git(dir, [...identity, 'commit', '-q', '-m', 'tell example-host-a about it'])
  const r = gate(dir, ['--range', 'HEAD~1..HEAD', '--identifiers', sb.list, '--no-identity'])
  assert.equal(r.status, FOUND)
  assert.match(r.output, /path\s+\[redacted\]-notes\.md/)
  assert.match(r.output, /message\s+[0-9a-f]{7}:\d+/)
  assert.doesNotMatch(r.output, /example-host-a/)
})

test('the identity line is checked by default and can be waived', (t) => {
  const sb = sandbox(t)
  const { dir } = repo(t)
  writeFileSync(join(dir, 'x.md'), 'x\n')
  git(dir, ['-c', 'user.name=Other', '-c', 'user.email=other@example.com', 'add', 'x.md'])
  git(dir, ['-c', 'user.name=Other', '-c', 'user.email=other@example.com', 'commit', '-q', '-m', 'x'])
  const found = gate(dir, ['--range', 'HEAD~1..HEAD', '--identifiers', sb.list])
  assert.equal(found.status, FOUND)
  assert.match(found.output, /identity\s+[0-9a-f]{7} (author|committer)/)
  const waived = gate(dir, ['--range', 'HEAD~1..HEAD', '--identifiers', sb.list, '--no-identity'])
  assert.equal(waived.status, OK)
})

test('the tree mode scans every text file and the path names, including the built-in private address', (t) => {
  const sb = sandbox(t)
  const { dir, identity } = repo(t)
  // Built from parts so this suite's own source does not carry a private address.
  const privateAddress = [192, 168, 1, 20].join('.')
  writeFileSync(join(dir, 'config.md'), `host = ${privateAddress}\n`)
  git(dir, [...identity, 'add', 'config.md'])
  git(dir, [...identity, 'commit', '-q', '-m', 'config'])
  const found = gate(dir, ['--tree', 'HEAD', '--identifiers', sb.list])
  assert.equal(found.status, FOUND)
  assert.match(found.output, /builtin 1 private IPv4 address/)
  const withoutBuiltin = gate(dir, ['--tree', 'HEAD', '--identifiers', sb.list, '--no-builtin'])
  assert.equal(withoutBuiltin.status, OK)
})

test('the gate refuses to run without a list, with an empty list, or with the list inside the repository', (t) => {
  const sb = sandbox(t)
  const { dir } = repo(t)
  const missing = gate(dir, ['--range', 'HEAD~1..HEAD', '--identifiers', join(sb.dir, 'nope.txt')])
  assert.equal(missing.status, CANNOT_RUN)
  assert.match(missing.output, /no identifier list/)

  const emptyList = join(sb.dir, 'empty.txt')
  writeFileSync(emptyList, '# nothing\n')
  const empty = gate(dir, ['--range', 'HEAD~1..HEAD', '--identifiers', emptyList])
  assert.equal(empty.status, CANNOT_RUN)
  assert.match(empty.output, /has no rules/)

  const inside = join(dir, 'identifiers.txt')
  writeFileSync(inside, 'secret\n')
  const refused = gate(dir, ['--range', 'HEAD~1..HEAD', '--identifiers', inside])
  assert.equal(refused.status, CANNOT_RUN)
  assert.match(refused.output, /outside the repository/)
})

// D-046. The six shapes integrator-two measured in the ui candidate, as UUIDs.
const SIX_SHAPES = [
  '00000000-0000-0000-0000-000000000000', // the nil UUID
  '00000000-0000-0000-0000-000000000001', // the nil UUID ending in 1
  '00000000-0000-4000-8000-000000000000', // v4-shaped zeros
  '00000000-0000-4000-8000-000000000001', // v4-shaped zeros ending in 1
  '11111111-1111-1111-1111-111111111111', // all ones
  '11111111-1111-4111-8111-111111111111', // v4-shaped ones
]
const RANDOM_V4 = '3f9c2a71-5b4e-4d2a-9c1f-7e8b6a5d4c3b'
const TWO_STRAY = '00000000-0000-4000-8000-000000000012'

test('D-046: a UUID is a placeholder when 29 of its 30 non-version, non-variant digits are one digit', () => {
  for (const shape of SIX_SHAPES) assert.equal(isPlaceholderUuid(shape), true, `${shape} is a placeholder`)
  assert.equal(isPlaceholderUuid(SIX_SHAPES[3].toUpperCase()), true, 'case does not matter')
  assert.equal(isPlaceholderUuid('ffffffff-ffff-4fff-bfff-fffffffffffe'), true, 'any repeated digit, one counter digit')
  assert.equal(isPlaceholderUuid(RANDOM_V4), false, 'a random v4 id is not')
  assert.equal(isPlaceholderUuid(TWO_STRAY), false, 'two stray digits are not')
  assert.equal(isPlaceholderUuid('10000000-0000-4000-8000-000000000001'), false, 'two strays at either end are not')
  assert.equal(isPlaceholderUuid('00000000-0000-0000-0000-00000000000'), false, 'a short UUID is not a UUID')
  for (let i = 0; i < 500; i += 1) {
    const id = randomUUID()
    assert.equal(isPlaceholderUuid(id), false, `a random UUID is never a placeholder (${id})`)
  }
})

test('D-046: a session-id-shaped rule skips placeholder ids and still catches real ones', () => {
  const [rule] = parseIdentifiers('re:example-token-[0-9a-f]{8}-\n')
  for (const shape of SIX_SHAPES) {
    assert.equal(liveMatches(`let id = "example-token-${shape}"`, rule).length, 0, `example-token-${shape} is exempt`)
  }
  assert.equal(liveMatches(`let id = "example-token-${RANDOM_V4}"`, rule).length, 1, 'a random v4 id is caught')
  assert.equal(liveMatches(`let id = "example-token-${TWO_STRAY}"`, rule).length, 1, 'two stray digits are caught')
  assert.equal(liveMatches(`a "example-token-${SIX_SHAPES[0]}" b "example-token-${RANDOM_V4}"`, rule).length, 1, 'a real id beside a placeholder is still caught')
  assert.equal(liveMatches('example-token-1234abcd-not-a-uuid', rule).length, 1, 'a match with no full UUID is judged as before')

  const findings = scanText([`ok "example-token-${SIX_SHAPES[2]}"`, `bad "example-token-${RANDOM_V4}"`].join('\n'), [rule])
  assert.equal(findings.length, 1)
  assert.equal(findings[0].line, 2)
})

test('D-046: the gate passes a range of placeholder test vectors and fails one real id', (t) => {
  const sb = sandbox(t)
  const { dir, identity } = repo(t)
  writeFileSync(join(dir, 'vectors.rs'), SIX_SHAPES.map((shape) => `const ID: &str = "example-token-${shape}";`).join('\n') + '\n')
  git(dir, [...identity, 'add', 'vectors.rs'])
  git(dir, [...identity, 'commit', '-q', '-m', 'test vectors'])
  const clean = gate(dir, ['--range', 'HEAD~1..HEAD', '--identifiers', sb.list, '--no-identity'])
  assert.equal(clean.status, OK, clean.output)

  writeFileSync(join(dir, 'real.rs'), `const ID: &str = "example-token-${RANDOM_V4}";\n`)
  git(dir, [...identity, 'add', 'real.rs'])
  git(dir, [...identity, 'commit', '-q', '-m', 'a real id'])
  const caught = gate(dir, ['--range', 'HEAD~1..HEAD', '--identifiers', sb.list, '--no-identity'])
  assert.equal(caught.status, FOUND, caught.output)
  assert.match(caught.output, /content\s+real\.rs:1/)
})

test('a branch behind main is judged on what it adds, not on main changes after it forked', (t) => {
  const sb = sandbox(t)
  const { dir, identity } = repo(t)
  writeFileSync(join(dir, 'leak.md'), 'deployed on example-host-a\n')
  git(dir, [...identity, 'add', 'leak.md'])
  git(dir, [...identity, 'commit', '-q', '-m', 'old leak'])
  git(dir, ['branch', 'seat'])
  // main removes the leak after the seat branch forked
  writeFileSync(join(dir, 'leak.md'), 'deployed\n')
  git(dir, [...identity, 'commit', '-q', '-am', 'main fixes the leak'])
  git(dir, ['checkout', '-q', 'seat'])
  writeFileSync(join(dir, 'clean.md'), 'clean work\n')
  git(dir, [...identity, 'add', 'clean.md'])
  git(dir, [...identity, 'commit', '-q', '-m', 'seat work'])
  git(dir, ['checkout', '-q', '-'])
  const r = gate(dir, ['--range', 'HEAD..seat', '--identifiers', sb.list, '--no-identity'])
  assert.equal(r.status, OK, `main's fix must not be read back as the seat's leak:\n${r.output}`)
})

test('the gate judges and fails when it is invoked through a symlinked path', (t) => {
  const sb = sandbox(t)
  const { dir, identity } = repo(t)
  writeFileSync(join(dir, 'notes.md'), 'deployed on example-host-a today\n')
  git(dir, [...identity, 'add', 'notes.md'])
  git(dir, [...identity, 'commit', '-q', '-m', 'notes'])
  const link = join(sb.dir, 'gate-link.mjs')
  symlinkSync(GATE, link)
  const r = spawnSync(process.execPath, [link, '--range', 'HEAD~1..HEAD', '--identifiers', sb.list, '--no-identity'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } })
  assert.equal(r.status, FOUND, `a symlinked invocation must not silently pass:\n${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /FAIL 1 finding/)
})

// The ruling after D-046: malformed negative vectors made only of placeholder digits.
const NEAR_PLACEHOLDERS = [
  '00000000-0000-0000-0000-00000000000', // eleven digits in the last group (too short)
  '00000000-0000-0000-0000-0000000000000', // thirteen digits (too long)
  '00000000-0000-4000-8000-00000000000g', // a non-hex last character
]

test('a malformed vector made only of placeholder digits is a placeholder near-UUID; two strays or a real id are not', () => {
  for (const vector of NEAR_PLACEHOLDERS) assert.equal(isPlaceholderNearUuid(vector), true, `${vector} is a placeholder near-UUID`)
  assert.equal(isPlaceholderNearUuid('00000000-0000-4000-8000-0000000000gg'), false, 'two non-hex strays are not')
  assert.equal(isPlaceholderNearUuid('00000000-0000-0000-0000-00000000012'), false, 'two stray digits are not')
  assert.equal(isPlaceholderNearUuid('3f9c2a71-5b4e-4d2a-9c1f-7e8b6a5d4c3'), false, 'a truncated real id is not')
  assert.equal(isPlaceholderNearUuid('gggggggg-gggg-gggg-gggg-gggggggggggg'), false, 'the repeated character must be a hex digit')
  assert.equal(isPlaceholderNearUuid(SIX_SHAPES[0]), false, 'a valid UUID is judged by D-046, not here')
})

test('the gate exempts the three malformed placeholder vectors and still catches the sequential id', () => {
  const [rule] = parseIdentifiers('re:example-token-[0-9a-f]{8}-\n')
  for (const vector of NEAR_PLACEHOLDERS) {
    assert.equal(liveMatches(`assert!(parse("example-token-${vector}").is_none())`, rule).length, 0, `example-token-${vector} is exempt`)
  }
  assert.equal(liveMatches('example-token-01234567-89ab-cdef-0123-456789abcdef', rule).length, 1, 'a sequential id is not a placeholder')
  assert.equal(liveMatches('example-token-00000000-0000-4000-8000-0000000000gg', rule).length, 1, 'two strays are caught')
  assert.equal(liveMatches('example-token-3f9c2a71-5b4e-4d2a-9c1f-7e8b6a5d4c3', rule).length, 1, 'a truncated real id is caught')
  for (const shape of SIX_SHAPES) assert.equal(liveMatches(`"example-token-${shape}"`, rule).length, 0, 'the D-046 shapes stay exempt')
})
