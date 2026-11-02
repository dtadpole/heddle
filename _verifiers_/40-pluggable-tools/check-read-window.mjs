// read_file takes a line window, as DSH's read does (`dsh-tool-fs` read): a 1-based `offset` and a `limit`, answered
// with DSH's numbered envelope, `<path>…</path>`, `<type>file</type>`, `<content>` holding `N: line` rows and a footer
// that names the offset to continue from, or says the end of the file was reached. An offset past the end is
// FS_NOT_FOUND, `offset O is out of range for "<path>" (T lines)`, and a window that is not positive integers, or a
// limit over 2000, is refused in DSH's words. A file over one default window (2000 lines or 50 KB) read without one
// is no longer returned whole. Live-testing issue #263: the tool took only a path, so a model could
// not ask for a later part of a large file, and a large file came back whole on both builds.
// Stated difference: a small file read without a window still comes back as its exact text, long lines included,
// where DSH numbers every read. A scripted endpoint asks for one read_file call per run, with an absolute path so
// both builds spell it alike.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { oneToolCall } from './fs-tool-turn.mjs'

// Five lines: a CRLF ending, Chinese and an emoji, a blank line, and a last line without a newline.
const FIVE = 'first\r\n\u4e2d\u6587 \u{1f600}\n\nfourth\nlast'
const MANY = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}\n`).join('')

/** Run one turn whose model reads `name` under the scratch folder with `window`; return the result and the path. */
async function readResult(name, window = {}) {
  const { results, scripted } = await oneToolCall({
    label: 'read-window',
    tool: 'read_file',
    layout: (home) => {
      mkdirSync(join(home, 'scratch'), { recursive: true })
      writeFileSync(join(home, 'scratch', 'five.txt'), FIVE)
      writeFileSync(join(home, 'scratch', 'many.txt'), MANY)
      writeFileSync(join(home, 'scratch', 'empty.txt'), '')
      writeFileSync(join(home, 'scratch', 'long.txt'), `${'z'.repeat(2005)}\n`)
    },
    args: (home) => ({ path: join(home, 'scratch', name), ...window }),
  })
  assert.equal(results.length, 1, JSON.stringify(results))
  return { result: results[0], path: scripted.path }
}

const envelope = (path, body) => `<path>${path}</path>\n<type>file</type>\n<content>\n${body}\n</content>`

test('a window of two lines is numbered and names the next offset', async () => {
  const { result, path } = await readResult('five.txt', { offset: 1, limit: 2 })
  assert.equal(result, envelope(path, '1: first\n2: \u4e2d\u6587 \u{1f600}\n\n(Showing lines 1-2 of 5. Use offset=3 to continue.)'))
})

test('the next window goes on from it, and the last one says the file ended', async () => {
  const middle = await readResult('five.txt', { offset: 3, limit: 2 })
  assert.equal(middle.result, envelope(middle.path, '3: \n4: fourth\n\n(Showing lines 3-4 of 5. Use offset=5 to continue.)'))
  const last = await readResult('five.txt', { offset: 5 })
  assert.equal(last.result, envelope(last.path, '5: last\n\n(End of file - total 5 lines)'))
})

test('an offset past the end is FS_NOT_FOUND and names the file, and an empty file still reads from offset 1', async () => {
  const past = await readResult('five.txt', { offset: 9 })
  assert.equal(past.result, `error (FS_NOT_FOUND): offset 9 is out of range for "${past.path}" (5 lines)`)
  const empty = await readResult('empty.txt', { offset: 1 })
  assert.equal(empty.result, envelope(empty.path, '(End of file - total 0 lines)'))
})

test('a limit over 2000 is refused in DSH words', async () => {
  const { result } = await readResult('five.txt', { limit: 2001 })
  assert.equal(result, 'error (BAD_ARGS): limit must be less than or equal to 2000')
})

test('a file over one default window read without one is not returned whole', async () => {
  const { result, path } = await readResult('many.txt')
  assert.ok(result.startsWith(`<path>${path}</path>\n<type>file</type>\n<content>\n1: line 1\n`), result.slice(0, 200))
  assert.ok(result.endsWith('\n2000: line 2000\n\n(Showing lines 1-2000 of 2500. Use offset=2001 to continue.)\n</content>'), result.slice(-200))
})

test('a small file read without a window still comes back as its exact text', async () => {
  const { result } = await readResult('five.txt')
  assert.equal(result, FIVE)
})

test('a line over 2000 characters is cut in a window, and read whole without one', async () => {
  const windowed = await readResult('long.txt', { offset: 1 })
  assert.equal(windowed.result, envelope(windowed.path, `1: ${'z'.repeat(2000)}... (line truncated to 2000 chars)\n\n(End of file - total 1 lines)`))
  const plain = await readResult('long.txt')
  assert.equal(plain.result, `${'z'.repeat(2005)}\n`)
})
