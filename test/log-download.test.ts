import assert from 'node:assert/strict'
import { test } from 'node:test'

import { logFileName } from '../src/server/log-download.ts'

/**
 * The name a downloaded session log is filed under.
 *
 * A filename is a boundary that a person's typed title must not cross, and `Content-Disposition` is a header where a
 * quote or a newline is a real hazard — so each of these cases is one a wrong implementation would let through
 * silently: a slash becomes a directory, a quote breaks the header, a newline splits it.
 */

test('a title becomes a safe file name, and a missing one falls back to the id', () => {
  assert.equal(logFileName('a conversation', 'session-1'), 'a conversation.jsonl', 'an ordinary title is kept as it is')
  assert.equal(logFileName(undefined, 'session-1'), 'session-1.jsonl', 'no title means the id names the file')
  assert.equal(logFileName('   ', 'session-1'), 'session-1.jsonl', 'a blank title is treated as none')
})

test('characters that would break a path or a header are replaced, not dropped', () => {
  /** A slash would make the name a directory; a colon is reserved on some filesystems. */
  assert.equal(logFileName('a/b:c', 'session-1'), 'a-b-c.jsonl')
  /** Quotes break `Content-Disposition`, and a CR or LF splits the header; none may survive. */
  const quoted = logFileName('he said "no"\r\nand left', 'session-1')
  assert.ok(!/["\r\n]/.test(quoted), `no quote or line break survives: ${JSON.stringify(quoted)}`)
  /** A path separator in any direction is gone, so a download cannot be steered into a folder. */
  for (const name of [logFileName('../../etc/passwd', 'session-1'), logFileName('..\\..\\windows', 'session-1')]) {
    assert.ok(!name.includes('/') && !name.includes('\\'), `no separator in ${name}`)
    assert.ok(!name.startsWith('.'), `and no leading dot in ${name}`)
  }
})

test('a very long or almost-empty title still yields a usable name', () => {
  const long = logFileName('x'.repeat(300), 'session-1')
  assert.ok(long.length <= 86, `the name is bounded (${long.length})`)
  assert.ok(long.endsWith('.jsonl'), 'and keeps its extension')

  /** Control characters are whitespace, and a name of only control characters falls back to the id. */
  assert.equal(logFileName('\u0001\u0002', 'session-1'), 'session-1.jsonl')
  assert.equal(logFileName('...', 'session-1'), 'session-1.jsonl', 'trailing dots are not a name')
})
