import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * The note under the tree is a live region since follow-up 2 (N9, `aria-live="polite"`), and every tree draw sets it,
 * usually to the text it already holds ("a new conversation in …", or nothing). A screen reader may announce a live
 * region's text again whenever it is written, so a write of the same text is skipped (developer-ten's review of
 * follow-up 2). The test lifts the page's own `setNote` over a stand-in element that counts its writes.
 */

const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')

function lift(name: string): string {
  const start = page.indexOf(`\nfunction ${name}(`)
  assert.ok(start >= 0, `the page defines ${name}`)
  return page.slice(start + 1, page.indexOf('\n}\n', start) + 2)
}

interface Note {
  textContent: string
  hidden: boolean
  writes: number
}

function note(): { setNote: (text: string | null | undefined) => void; element: Note } {
  let text = ''
  let hidden = true
  const element = {
    writes: 0,
    get textContent() {
      return text
    },
    set textContent(value: string) {
      element.writes += 1
      text = value
    },
    get hidden() {
      return hidden
    },
    set hidden(value: boolean) {
      hidden = value
    },
  }
  const setNote = new Function('treeNote', `${lift('setNote')}\nreturn setNote`)(element) as (text: string | null | undefined) => void
  return { setNote, element }
}

test('the tree note, a live region, is written only when its text changes (N9)', () => {
  const { setNote, element } = note()
  setNote('a new conversation in alpha')
  assert.deepEqual([element.textContent, element.hidden, element.writes], ['a new conversation in alpha', false, 1])
  setNote('a new conversation in alpha')
  assert.equal(element.writes, 1, 'the same text again is not written again, so it is not announced again')
  setNote('a new conversation in beta')
  assert.deepEqual([element.textContent, element.writes], ['a new conversation in beta', 2], 'a change is written')
  setNote('')
  assert.deepEqual([element.textContent, element.hidden, element.writes], ['', true, 3], 'emptied, and hidden')
  setNote(null)
  setNote(undefined)
  assert.deepEqual([element.textContent, element.hidden, element.writes], ['', true, 3], 'nothing, said again, writes nothing')
})
