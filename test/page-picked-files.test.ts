import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/** #42 executes the shared page's actual picker functions, doubling only transport and DOM ports.
 * No browser, build, live session or settings. Rust embeds this same page.
 */
const page = readFileSync(new URL('../src/server/page.html', import.meta.url), 'utf8')
function source(name: string): string {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  return page.slice(start, page.indexOf('\n}', start) + 2)
}
interface Picked { name: string; type?: string }
interface Harness {
  pick(files: Picked[]): Promise<void>
  cards(): { name: string; bytes: number }[]
  notes: { textContent: string }[]
}
function harness(fetch: (url: string, init: { body: Picked }) => Promise<unknown>): Harness {
  const notes: { textContent: string }[] = []
  return runInNewContext(`
    let pendingAttachments = [{ name: 'existing.txt', path: '/uploads/existing.txt', bytes: 1 }];
    const attachMenu = { replaceChildren() { notes.length = 0 }, append(note) { notes.push(note) }, hidden: true };
    const attachButton = { setAttribute() {} };
    const document = { createElement() { return { textContent: '' } } };
    const URL = { createObjectURL(file) { return 'blob:' + file.name } };
    function renderPendingAttachments() {}
    ${source('showAttachFailure')}
    ${source('addPickedFiles')}
    ({ pick: addPickedFiles, cards: () => pendingAttachments, notes })
  `, { fetch, notes }) as Harness
}
const saved = (file: Picked, bytes = 1) => ({ ok: true, json: async () => ({ path: `/uploads/${file.name}`, bytes }) })

test('#42: good picks survive HTTP and transport failures; every refusal names only its file', { timeout: 5000 }, async () => {
  const attempted: string[] = []
  const at = harness(async (_url, { body: file }) => {
    attempted.push(file.name)
    if (file.name === 'bad.png') return { ok: false, status: 400, text: async () => 'an empty image is not valid\n' }
    if (file.name === 'offline.txt') throw new Error('connection lost')
    return saved(file, file.name === 'empty.txt' ? 0 : 1)
  })
  await at.pick(['first.txt', 'bad.png', 'empty.txt', 'offline.txt', 'last.txt'].map(name => ({ name })))
  assert.deepEqual(attempted, ['first.txt', 'bad.png', 'empty.txt', 'offline.txt', 'last.txt'])
  assert.deepEqual(Array.from(at.cards(), file => file.name), ['existing.txt', 'first.txt', 'empty.txt', 'last.txt'])
  assert.equal(at.cards().find(file => file.name === 'empty.txt')?.bytes, 0)
  assert.deepEqual(at.notes.map(note => note.textContent), [
    'could not add bad.png: an empty image is not valid',
    'could not add offline.txt: connection lost',
  ])
})

test('#42: an admitted file appears before a later upload settles', { timeout: 5000 }, async () => {
  let release!: (value: unknown) => void
  let started!: () => void
  const inFlight = new Promise<void>(resolve => { started = resolve })
  const at = harness(async (_url, { body: file }) => {
    if (file.name !== 'slow.txt') return saved(file)
    started()
    return new Promise(resolve => { release = resolve })
  })
  const picking = at.pick([{ name: 'ready.txt' }, { name: 'slow.txt' }])
  await inFlight
  assert.deepEqual(Array.from(at.cards(), file => file.name), ['existing.txt', 'ready.txt'])
  release(saved({ name: 'slow.txt' }))
  await picking
  assert.deepEqual(Array.from(at.cards(), file => file.name), ['existing.txt', 'ready.txt', 'slow.txt'])
})

test('#42: an all-refused pick leaves existing cards untouched and names each rejection', { timeout: 5000 }, async () => {
  const at = harness(async () => ({ ok: false, status: 503, text: async () => '' }))
  await at.pick([{ name: 'one.txt' }, { name: 'two.txt' }])
  assert.deepEqual(Array.from(at.cards(), file => file.name), ['existing.txt'])
  assert.deepEqual(at.notes.map(note => note.textContent), ['could not add one.txt: the server answered 503', 'could not add two.txt: the server answered 503'])
})

test('#42: an empty pick neither clears cards nor renders a new failure', { timeout: 5000 }, async () => {
  const at = harness(async () => { throw new Error('no request expected') })
  await at.pick([])
  assert.deepEqual(Array.from(at.cards(), file => file.name), ['existing.txt'])
  assert.equal(at.notes.length, 0)
})
