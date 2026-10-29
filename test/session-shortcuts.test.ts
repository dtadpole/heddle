import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * The session shortcuts, judged out of the page that runs them.
 *
 * DSH registers its navigation chords in dsh-client-ui-workspace `client.js:123-187`; on the Web (macOS) they are
 * ⌥⌘N new session, ⌥⌘K search, ⌥⌘O add workspace, ⌥⌘G rename, ⇧⌘F fork and ⌥⌘A archive, matched on the physical key
 * (`event.code`, dsh-client-shortcuts `client.js:1416`). The table and its reader live in `page.html` between two
 * markers, and this file loads that block so the bindings are checked where they are defined.
 */

const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const begin = page.indexOf('/* session-shortcuts:begin */')
const end = page.indexOf('/* session-shortcuts:end */')

interface Press {
  key: string
  code?: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

const block = begin > 0 && end > begin ? page.slice(begin, end) : 'function shortcutFor() { return null }'
const shortcutFor = new Function(`${block}\nreturn shortcutFor`)() as (event: Required<Omit<Press, 'code'>> & { code?: string }) => string | null

/** A key press with every modifier stated, as a browser reports it. */
function press(event: Press) {
  return shortcutFor({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...event })
}

test('the shortcut table is in the page, between its markers', () => {
  assert.ok(begin > 0 && end > begin, 'both markers are present, in order')
})

test('DSH\'s six session chords on macOS Web, Add workspace among them', () => {
  const chords: [Press, string][] = [
    [{ key: 'n', code: 'KeyN', metaKey: true, altKey: true }, 'new-session'],
    [{ key: 'k', code: 'KeyK', metaKey: true, altKey: true }, 'search'],
    [{ key: 'o', code: 'KeyO', metaKey: true, altKey: true }, 'add-workspace'],
    [{ key: 'g', code: 'KeyG', metaKey: true, altKey: true }, 'rename'],
    [{ key: 'F', code: 'KeyF', metaKey: true, shiftKey: true }, 'fork'],
    [{ key: 'a', code: 'KeyA', metaKey: true, altKey: true }, 'archive'],
  ]
  for (const [event, action] of chords) assert.equal(press(event), action, `${JSON.stringify(event)} is ${action}`)
})

test('a Mac\'s option characters still name the key: ⌥⌘O arrives as ø with code KeyO', () => {
  assert.equal(press({ key: 'ø', code: 'KeyO', metaKey: true, altKey: true }), 'add-workspace')
  assert.equal(press({ key: 'å', code: 'KeyA', metaKey: true, altKey: true }), 'archive')
  assert.equal(press({ key: '˚', code: 'KeyK', metaKey: true, altKey: true }), 'search')
  assert.equal(press({ key: 'o', metaKey: true, altKey: true }), 'add-workspace', 'a synthetic press without a code reads its character')
  assert.equal(press({ key: 'o', ctrlKey: true, altKey: true }), 'add-workspace', 'Control stands in for Meta')
})

test('Add workspace needs exactly its modifiers', () => {
  assert.equal(press({ key: 'o', code: 'KeyO', metaKey: true }), null, '⌘O alone is the browser\'s, not the page\'s')
  assert.equal(press({ key: 'O', code: 'KeyO', metaKey: true, altKey: true, shiftKey: true }), null, 'a shifted chord is another gesture')
  assert.equal(press({ key: 'o', code: 'KeyO', altKey: true }), null, 'no Meta or Control, no shortcut')
  assert.equal(press({ key: 'o', code: 'KeyP', metaKey: true, altKey: true }), null, 'the physical key decides when it is named')
})
