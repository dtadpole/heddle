import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import {
  evidencePath,
  scratchRoot,
  fingerprint,
  hasDependency,
  listFiles,
  parseJson,
  readTranscript,
  skipUnless,
  transcriptFile,
  sessionsUnder,
} from '../../lib.mjs'

/**
 * The check helpers' own **component tests**.
 *
 * A verifier is a delivery claim and lives in `_verifiers_/`; these helpers are the machinery the
 * claims stand on, so their rules get tests of their own. The two worth naming are the ones that have
 * silently judged the wrong file before: `transcriptFile` must find the log a session actually has in
 * either store layout, and `readTranscript` must decode either format. A check that reads a path it
 * guessed is a check that can pass while judging nothing.
 *
 *     node --test _tools_/verify-runner/_tests_/<suite>/unit.test.mjs
 */

/** A scratch directory, removed by the caller. */
function scratch(label) {
  return mkdtempSync(join(tmpdir(), `heddle-helpers-${label}-`))
}

test('parseJson takes the trailing JSON document from a stream with log lines before it', () => {
  const stdout = 'model: 2 endpoint(s)\r\nsome log line\n{"answer": 42}\n'
  assert.deepEqual(parseJson(stdout), { answer: 42 })
  assert.deepEqual(parseJson('note\n[1, 2]\n'), [1, 2], 'an array is a document too')
  assert.equal(parseJson('no json at all'), null)
  assert.equal(parseJson('{broken\n'), null, 'a truncated object is not a document')
})

test('the transcript is found inside the session directory, in either file format', () => {
  const root = scratch('old')
  try {
    const dir = join(root, 'session-20260101-1200')
    mkdirSync(dir)
    writeFileSync(join(dir, 'session.v2.jsonl.zstd'), '')
    assert.equal(transcriptFile(dir), join(dir, 'session.v2.jsonl.zstd'), 'the compressed name is preferred')
    rmSync(join(dir, 'session.v2.jsonl.zstd'))
    writeFileSync(join(dir, 'session.jsonl'), '{"seq":1}\n')
    assert.equal(transcriptFile(dir), join(dir, 'session.jsonl'), 'and the plain name is found when it is the one there')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the transcript is found in the workspace folder or the session directory, as the store files it', () => {
  const root = scratch('layout')
  try {
    const id = 'session-20260101-1201'
    const folder = join(root, '--Users-someone-work--')
    mkdirSync(folder)
    writeFileSync(join(folder, `${id}.v2.jsonl.zstd`), '')
    assert.equal(transcriptFile(join(root, id)), join(folder, `${id}.v2.jsonl.zstd`), 'the current layout is found from the id')
    assert.equal(transcriptFile(join(root, 'session-does-not-exist')), join(root, 'session-does-not-exist', 'session.v2.jsonl.zstd'), 'a missing one names the path it would have had')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a transcript reads as events in both formats the store has written', () => {
  const root = scratch('read')
  try {
    const plain = join(root, 'session.jsonl')
    writeFileSync(plain, '{"seq":1,"type":"user"}\n{"seq":2,"type":"assistant/chunk"}\n')
    assert.deepEqual(readTranscript(plain), [
      { seq: 1, type: 'user' },
      { seq: 2, type: 'assistant/chunk' },
    ])

    /** One zstd frame per event, which is the shape the current writer produces. */
    const compressed = join(root, 'session.v2.jsonl.zstd')
    writeFileSync(
      compressed,
      Buffer.concat([zstdCompressSync(Buffer.from('{"seq":3}\n')), zstdCompressSync(Buffer.from('{"seq":4}\n'))]),
    )
    assert.deepEqual(readTranscript(compressed), [{ seq: 3 }, { seq: 4 }])

    /** A directory is accepted as readily as a path, because that is what a check has. */
    const dir = join(root, 'session-20260101-1300')
    mkdirSync(dir)
    writeFileSync(join(dir, 'session.jsonl'), '{"seq":5}\n')
    assert.deepEqual(readTranscript(dir), [{ seq: 5 }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the sessions of a store are found in both layouts it has used', () => {
  const root = scratch('sessions')
  try {
    mkdirSync(join(root, 'session-20260101-1400'))
    const folder = join(root, '--Users-someone-work--')
    mkdirSync(folder)
    writeFileSync(join(folder, 'session-20260101-1401.json'), '{}')
    assert.deepEqual(sessionsUnder(root).sort(), ['session-20260101-1400', 'session-20260101-1401'])
    assert.deepEqual(sessionsUnder(join(root, 'missing')), [], 'a root that does not exist holds no sessions')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a fingerprint changes when a file changes, and the file list is sorted', () => {
  const root = scratch('fingerprint')
  try {
    mkdirSync(join(root, 'nested'))
    writeFileSync(join(root, 'b.txt'), 'two')
    writeFileSync(join(root, 'a.txt'), 'one')
    writeFileSync(join(root, 'nested', 'c.txt'), 'three')
    assert.deepEqual(listFiles(root), ['a.txt', 'b.txt', 'nested/c.txt'])
    const before = fingerprint(root)
    writeFileSync(join(root, 'a.txt'), 'changed')
    assert.notEqual(fingerprint(root), before, 'a changed file changes the fingerprint')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a declared dependency is found, and an undeclared one is not', () => {
  assert.equal(hasDependency('marked'), true)
  assert.equal(hasDependency('a-package-this-repository-does-not-use'), false)
})

test('a check that cannot judge says so instead of returning quietly', () => {
  const skipped = []
  const context = { skip: (reason) => skipped.push(reason) }
  assert.equal(skipUnless(context, false, 'no browser'), false)
  assert.deepEqual(skipped, ['no browser'])
  assert.equal(skipUnless(context, true, 'no browser'), true)
  assert.equal(skipped.length, 1, 'a judged check skips nothing')
})


test('runtime evidence allocations are unique, under the ignored checkout root and do not rewrite old files', () => {
  const first = evidencePath('panel.png')
  const second = evidencePath('panel.png')
  try {
    assert.notEqual(first, second, 'a second measurement gets its own path')
    const rel = relative(scratchRoot, first)
    assert.ok(rel.startsWith(`verifier-evidence${sep}`), 'evidence stays inside the checkout runtime folder')
    assert.ok(!rel.startsWith('..'), 'and never escapes to historical context or host scratch')
    assert.ok(existsSync(dirname(first)), 'the screenshot parent already exists')
    assert.ok(!existsSync(first), 'allocation does not create or overwrite the artifact')
    writeFileSync(first, 'earlier measurement')
    writeFileSync(second, 'later measurement')
    assert.equal(readFileSync(first, 'utf8'), 'earlier measurement', 'a later measurement preserves the first')
  } finally {
    rmSync(dirname(first), { recursive: true, force: true })
    rmSync(dirname(second), { recursive: true, force: true })
  }
})

test('evidence names cannot introduce directory traversal or absolute paths', () => {
  for (const name of ['', '../old.png', '/tmp/panel.png', 'folder/panel.png', 'folder\\panel.png', '..']) {
    assert.throws(() => evidencePath(name), /filename without directory components/, name)
  }
})
