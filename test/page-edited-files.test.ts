import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * Unit tests for the page's live Edited files card (live-testing draft developer-five-8): when a turn ends, only that
 * turn's files are shown, under its own answer. The function is read out of page.html between its markers, so the page
 * and this test judge one source.
 */
const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const begin = page.indexOf('/* edited-files:begin */')
const end = page.indexOf('/* edited-files:end */')
assert.ok(begin !== -1 && end > begin, 'page.html fences lastExchangeFiles with its markers')
type Turn = { kind: string; files?: { path: string }[] }
const lastExchangeFiles = new Function(`${page.slice(begin, end)}\nreturn lastExchangeFiles`)() as (turns: Turn[]) => { path: string }[] | null

const wrote = [{ path: '/work/notes/a.txt' }]

test('a turn that edited nothing has no files, however many earlier turns did', () => {
  const turns: Turn[] = [
    { kind: 'user' }, { kind: 'assistant', files: wrote },
    { kind: 'user' }, { kind: 'assistant' },
  ]
  assert.equal(lastExchangeFiles(turns), null)
  assert.equal(lastExchangeFiles([...turns, { kind: 'user' }, { kind: 'assistant', files: [] }]), null, 'an empty list is no files')
})

test('the newest exchange gives the files on its last answer', () => {
  const turns: Turn[] = [
    { kind: 'user' }, { kind: 'assistant' },
    { kind: 'user' }, { kind: 'assistant' }, { kind: 'tool' }, { kind: 'assistant', files: wrote },
  ]
  assert.deepEqual(lastExchangeFiles(turns), wrote)
})

test('files are read from the last answer only, as the projection places them', () => {
  const turns: Turn[] = [{ kind: 'user' }, { kind: 'assistant', files: wrote }, { kind: 'tool' }, { kind: 'assistant' }]
  assert.equal(lastExchangeFiles(turns), null, 'the projection puts an exchange\'s files on its last answer')
})

test('no turns, or an exchange with no answer yet, has no files', () => {
  assert.equal(lastExchangeFiles([]), null)
  assert.equal(lastExchangeFiles([{ kind: 'user' }, { kind: 'assistant', files: wrote }, { kind: 'user' }]), null)
})
