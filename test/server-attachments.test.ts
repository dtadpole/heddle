import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { AttachmentInputError, MAX_ATTACHMENTS, readAttachment, readAttachments } from '../src/server/attachments.ts'
import { saveUpload, uploadDirectory, uploadReferencedBy } from '../src/server/uploads.ts'

/**
 * Unit tests for the server half of an attachment: a path from the browser becomes a typed content block.
 *
 * The browser only ever says *which stored file* — the server decides the name, byte size, sha256, media
 * type and whether it is an image. Treating the path as untrusted is the whole job: a hand-made request
 * must not be able to point a message at any file on the machine, and the block it produces must be the
 * canonical reference the request projection reads later.
 */

const withUploads = (run: (home: string) => void): void => {
  const home = mkdtempSync(join(tmpdir(), 'heddle-server-attachments-'))
  const previous = process.env.HEDDLE_HOME
  process.env.HEDDLE_HOME = home
  try {
    run(home)
  } finally {
    if (previous === undefined) delete process.env.HEDDLE_HOME
    else process.env.HEDDLE_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

test('a stored PNG is an image block with the name, size and digest the server measured', () => {
  withUploads((home) => {
    const saved = saveUpload('shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), { home })
    const part = readAttachment(saved.path)
    assert.equal(part.type, 'image')
    assert.equal(part.type === 'image' ? part.mimeType : undefined, 'image/png')
    assert.equal(part.name, 'shot.png', 'the upload timestamp is not part of the display name')
    assert.equal(part.bytes, 4)
    assert.match(part.type === 'image' ? part.sha256 : '', /^[0-9a-f]{64}$/)
    assert.equal(part.path, realpathSync(saved.path), 'the reference is the canonical stored path')
  })
})

test('a stored markdown file is a file block, not an image', () => {
  withUploads((home) => {
    const saved = saveUpload('notes.md', Buffer.from('# notes\n'), { home })
    assert.equal(readAttachment(saved.path).type, 'file')
  })
})

test('a path outside the upload directory is refused', () => {
  withUploads(() => {
    assert.throws(() => readAttachment('/etc/passwd'), (error: unknown) => {
      assert.ok(error instanceof AttachmentInputError)
      assert.match(error.message, /upload directory/)
      return true
    })
  })
})

test('a path that no longer exists, or is a directory, is refused by name', () => {
  withUploads((home) => {
    saveUpload('seed.txt', Buffer.from('seed'), { home })
    assert.throws(() => readAttachment(join(uploadDirectory(home), 'missing.png')), /no longer exists/)
    assert.throws(() => readAttachment(uploadDirectory(home)), /must be a file/)
  })
})

test('the request may carry a bounded list, and a malformed one is refused', () => {
  withUploads((home) => {
    const saved = saveUpload('one.txt', Buffer.from('one'), { home })
    assert.deepEqual(readAttachments(undefined), [], 'no attachments is a valid turn')
    assert.equal(readAttachments([saved.path]).length, 1)
    assert.throws(() => readAttachments('not-an-array'), /array of paths/)
    assert.throws(() => readAttachments([42]), /must be a path/)
    assert.throws(() => readAttachments(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => saved.path)), /at most/)
  })
})

test('an upload is referenced by a session only when one of its logged messages carries that leaf', () => {
  const leaf = '2026-10-29T11-00-00-000Z-pixel.png'
  const events = [
    { type: 'session/created', cwd: '/w' },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', path: `/home/uploads/${leaf}`, name: 'pixel.png' }] } },
    { type: 'message', message: { role: 'user', content: [{ type: 'file', path: '/home/uploads/2026-10-29-notes.md', name: 'notes.md' }] } },
    { type: 'message', message: { role: 'tool', content: [{ type: 'image', path: '/home/uploads/2026-10-29-shot.png' }] } },
  ]
  assert.equal(uploadReferencedBy(events, leaf), true, 'an image in a prompt')
  assert.equal(uploadReferencedBy(events, '2026-10-29-notes.md'), true, 'a file part counts as well')
  assert.equal(uploadReferencedBy(events, '2026-10-29-shot.png'), true, 'and an image a tool result carries')
  // DSH's ATTACHMENT_NOT_REFERENCED: another upload, a name only mentioned in text, or nothing at all.
  assert.equal(uploadReferencedBy(events, '2026-10-29-other.png'), false, 'another upload is not referenced')
  assert.equal(uploadReferencedBy([{ type: 'message', message: { role: 'user', content: [{ type: 'text', text: leaf }] } }], leaf), false, 'a leaf named in text is not an attachment')
  assert.equal(uploadReferencedBy([], leaf), false, 'an empty log references nothing')
  assert.equal(uploadReferencedBy(events, ''), false, 'and an empty leaf matches nothing')
})
