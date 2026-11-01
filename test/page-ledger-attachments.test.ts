import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/**
 * S151 (R-developer-eleven-21): DSH's trajectory row counts a user record's images and files beside its text, and its
 * inspector lists each attachment by its recorded name, size and type. The page's fenced helpers are judged here.
 */
const page = readFileSync(new URL('../src/server/page.html', import.meta.url), 'utf8')
const begin = page.indexOf('/* ledger-attachments:begin */')
const end = page.indexOf('/* ledger-attachments:end */')
assert.ok(begin !== -1 && end > begin, 'page.html fences ledger-attachments')
type Item = { kind?: string; name?: string; bytes?: number; mimeType?: string }
const helpers = new Function(`${page.slice(begin, end)}; return { attachmentCounts, attachmentLine }`)() as {
  attachmentCounts: (attachments: unknown) => string
  attachmentLine: (item: Item, imageNumber: number) => { name: string; detail: string }
}

test('a row counts the nonzero image and file counts, and nothing when there are none', () => {
  assert.equal(helpers.attachmentCounts([{ kind: 'image' }, { kind: 'file' }, { kind: 'image' }]), '2 images · 1 file')
  assert.equal(helpers.attachmentCounts([{ kind: 'file' }]), '1 file')
  assert.equal(helpers.attachmentCounts([{ kind: 'image' }]), '1 image')
  assert.equal(helpers.attachmentCounts([]), '')
  assert.equal(helpers.attachmentCounts(undefined), '', 'a record without attachments shows no count')
})

test('an inspector row names the attachment, then its size and type; a zero-byte file keeps its size', () => {
  assert.deepEqual(helpers.attachmentLine({ kind: 'image', name: 'screen shot.png', bytes: 2048, mimeType: 'image/png' }, 1), { name: 'screen shot.png', detail: '2.0 KB · image/png' })
  assert.deepEqual(helpers.attachmentLine({ kind: 'file', name: 'notes.txt', bytes: 0 }, 0), { name: 'notes.txt', detail: '0 B' })
  assert.deepEqual(helpers.attachmentLine({ kind: 'image', name: '', bytes: 3 * 1024 * 1024 }, 2), { name: 'Image 2', detail: '3.0 MB' }, 'an unnamed image is numbered among the images')
})
