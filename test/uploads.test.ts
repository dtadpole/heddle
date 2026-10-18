import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { SandboxService } from '../src/sandbox/service.ts'
import { MAX_UPLOAD_BYTES, safeUploadName, saveUpload, uploadDirectory } from '../src/server/uploads.ts'

/**
 * Unit tests for the Add File substrate.
 *
 * The browser check judges the gesture — the `+` menu, the picker, the draft. What it cannot cheaply
 * judge is the part that turns a person's file name into a path on this machine, and that part has rules
 * that are easy to get wrong in a way a browser never notices: a name is untrusted input, and a path
 * outside `$HEDDLE_HOME/uploads` is one the agent cannot read back in a confined sandbox. Every test
 * below is one of those rules.
 */

const withTempHome = (run: (home: string) => void): void => {
  const home = mkdtempSync(join(tmpdir(), 'heddle-uploads-'))
  try {
    run(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('a file name is reduced to one safe leaf, wherever it came from', () => {
  /**
   * Measured against a native picker: `File.name` is usually a leaf already, but the server must not
   * assume the client is the page it shipped — a hand-made request can send any string. The path
   * separators are removed before anything is joined, so no name can leave the upload directory.
   */
  assert.equal(safeUploadName('../../etc/passwd'), 'passwd', 'traversal becomes a leaf')
  assert.equal(safeUploadName('C:\\Users\\someone\\report.txt'), 'report.txt', 'a Windows path becomes a leaf')
  assert.equal(safeUploadName('notes/2026 plan.md'), '2026 plan.md', 'a relative folder becomes a leaf')
  assert.equal(safeUploadName('a:b*c?.txt'), 'a_b_c_.txt', 'characters a filesystem refuses are replaced')
  assert.equal(safeUploadName('a\u0000b.txt'), 'a_b.txt', 'a control character is not part of a path')
})

test('a name with nothing usable still names a file', () => {
  /**
   * `'..'`, `'.'` and an empty name are what a client sends when it has nothing to say. Each would
   * otherwise resolve back to the upload directory itself, so the fallback is a real name rather than
   * an empty string.
   */
  assert.equal(safeUploadName(''), 'file')
  assert.equal(safeUploadName('..'), 'file')
  assert.equal(safeUploadName('...'), 'file')
  assert.equal(safeUploadName('   '), 'file')
})

test('a long name keeps its extension and stays under the leaf limit', () => {
  const long = `${'a'.repeat(300)}.md`
  const safe = safeUploadName(long)
  assert.ok(safe.length <= 120, `the leaf is capped (${safe.length})`)
  assert.ok(safe.endsWith('.md'), 'the extension survives the cap')
})

test('a unicode name is preserved rather than stripped to ASCII', () => {
  assert.equal(safeUploadName('笔记.md'), '笔记.md')
  assert.equal(safeUploadName('résumé final.txt'), 'résumé final.txt')
})

test('an upload lands under $HEDDLE_HOME/uploads with its bytes and a private mode', () => {
  withTempHome((home) => {
    const saved = saveUpload('note.md', Buffer.from('# a note\n'), { home })
    assert.equal(saved.name, 'note.md')
    assert.equal(saved.bytes, 9)
    const leaf = saved.path.slice(saved.path.lastIndexOf('/') + 1)
    assert.equal(saved.path, join(home, 'uploads', leaf), 'the path is inside the upload directory')
    assert.ok(saved.path.startsWith(uploadDirectory(home)), 'and nothing above it')
    assert.equal(readFileSync(saved.path, 'utf8'), '# a note\n', 'the bytes are the file')
    assert.equal(statSync(saved.path).mode & 0o777, 0o600, 'the file is not world-readable')
  })
})

test('two uploads of one name at one instant get distinct paths', () => {
  /**
   * Two files named `note.md` are ordinary — a person attaches the same name from two folders. A store
   * that overwrote the first would make the draft point at the second file's bytes with no way to tell.
   */
  withTempHome((home) => {
    const now = new Date('2026-10-17T12:00:00.000Z')
    const first = saveUpload('note.md', Buffer.from('first'), { home, now })
    const second = saveUpload('note.md', Buffer.from('second'), { home, now })
    assert.notEqual(first.path, second.path, 'the second path does not overwrite the first')
    assert.equal(readFileSync(first.path, 'utf8'), 'first')
    assert.equal(readFileSync(second.path, 'utf8'), 'second')
  })
})

test('an uploaded path is readable by the agent in the confined sandbox', () => {
  /**
   * The claim Add File makes is that the file becomes a path the agent can read. The sandbox admits the
   * harness's own configuration directory for exactly that kind of read, and `$HEDDLE_HOME` is where that
   * directory is — so an upload under a non-default home must be admitted too, or the draft would carry a
   * path `read_file` refuses.
   */
  withTempHome((home) => {
    const workspace = join(home, 'workspace')
    const saved = saveUpload('readable.md', Buffer.from('read me'), { home })
    const previous = process.env.HEDDLE_HOME
    process.env.HEDDLE_HOME = home
    try {
      const sandbox = new SandboxService(new Context(), { mode: 'workspace-write', workspaceRoot: workspace })
      assert.ok(sandbox.assertReadable(saved.path).endsWith('readable.md'), 'the upload is readable')
    } finally {
      if (previous === undefined) delete process.env.HEDDLE_HOME
      else process.env.HEDDLE_HOME = previous
    }
  })
})

test('the upload limit is a number the route can state', () => {
  assert.equal(MAX_UPLOAD_BYTES, 10 * 1024 * 1024)
})
