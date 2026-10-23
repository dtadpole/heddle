import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import {
  CANNOT_RUN,
  EXPECTED_IDENTITY,
  FOUND,
  OK,
  checkIdentity,
  describe,
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
