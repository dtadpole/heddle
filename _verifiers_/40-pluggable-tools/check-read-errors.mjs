// A failed read is classified and names the file, as DSH's read tool does (`dsh-tool-fs` resolveRegularReadTarget):
// a missing file is `FS_NOT_FOUND`, `cannot read "<path>": not found`, and a directory `FS_NOT_REGULAR_FILE`,
// `cannot read "<path>": not a regular file`, with DSH's absolute display spelling of the path (`dsh-fs-local`
// localDisplayPath). Live-testing issue #4: the TypeScript build returned Node's raw ENOENT text and the Rust build the
// raw OS error with no path at all, both as TOOL_FAILED, so a model reading several files could not tell which failed.
// A file that is not UTF-8 text is `FS_NOT_TEXT`, `cannot read "<path>": invalid UTF-8 text`, as DSH's fatal decode
// says it (`dsh-fs-local` decodeUtf8). Live-testing issue #234: the TypeScript build read the bytes C3 28 as `\uFFFD(`
// and reported success, and the Rust build refused with the unnamed `stream did not contain valid UTF-8` as TOOL_FAILED.
// A scripted endpoint asks for one read_file call per run, with an absolute path so both builds spell it alike.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { oneToolCall } from './fs-tool-turn.mjs'

/** Run one turn whose model reads `relative` under the home, given as an absolute path; return the tool results. */
async function readResult(relative, layout = () => {}) {
  const { results, scripted } = await oneToolCall({
    label: 'read-errors',
    tool: 'read_file',
    layout,
    args: (home) => ({ path: join(home, relative) }),
  })
  return { results, path: scripted.path }
}

test('a missing file is FS_NOT_FOUND and names the file, as DSH says it', async () => {
  const { results, path } = await readResult('notes/missing.txt')
  assert.deepEqual(results, [`error (FS_NOT_FOUND): cannot read "${path}": not found`])
})

test('a directory is FS_NOT_REGULAR_FILE and names it', async () => {
  const { results, path } = await readResult('notes', (home) => mkdirSync(join(home, 'notes'), { recursive: true }))
  assert.deepEqual(results, [`error (FS_NOT_REGULAR_FILE): cannot read "${path}": not a regular file`])
})

test('a file that is not UTF-8 text is FS_NOT_TEXT and names it, not read with replacement characters', async () => {
  const { results, path } = await readResult('notes/binary.dat', (home) => {
    mkdirSync(join(home, 'notes'), { recursive: true })
    writeFileSync(join(home, 'notes', 'binary.dat'), Buffer.from([0xc3, 0x28]))
  })
  assert.deepEqual(results, [`error (FS_NOT_TEXT): cannot read "${path}": invalid UTF-8 text`])
})

test('a UTF-8 file of several-byte characters still reads exactly', async () => {
  const { results } = await readResult('notes/wide.txt', (home) => {
    mkdirSync(join(home, 'notes'), { recursive: true })
    writeFileSync(join(home, 'notes', 'wide.txt'), 'caf\u00e9 \u4e2d\u6587 \u{1f600}')
  })
  assert.deepEqual(results, ['caf\u00e9 \u4e2d\u6587 \u{1f600}'])
})

test('a readable file still reads as before', async () => {
  const { results } = await readResult('notes/here.txt', (home) => {
    mkdirSync(join(home, 'notes'), { recursive: true })
    writeFileSync(join(home, 'notes', 'here.txt'), 'hello')
  })
  assert.deepEqual(results, ['hello'])
})
