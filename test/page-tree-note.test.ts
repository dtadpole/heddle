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

/** A stand-in for `#tree-note` that counts the writes of its text, holding `initial` to begin with. */
function notePair(initial = ''): { setNote: (text: string | null | undefined) => void; element: Note } {
  let text = initial
  let hidden = initial === ''
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
  const setNote = new Function('treeNote', `let noteTicket = 0\n${lift('setNote')}\nreturn setNote`)(element) as (text: string | null | undefined) => void
  return { setNote, element }
}

test('the tree note, a live region, is written only when its text changes (N9)', () => {
  const { setNote, element } = notePair()
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

test('picking a workspace takes back "Choose a workspace first." and names the new conversation\'s place (N3)', () => {
  /**
   * developer-ten's N3 on f3adbf49: with several workspaces and nothing remembered, Enter in the inert composer says
   * DSH's "Choose a workspace first."; a workspace row picked after that moved the target, but the note kept the
   * refusal until the next tree draw, because only a note naming the place was repainted.
   */
  const paint = (note: string, target: { label: string } | null) => {
    const { setNote, element } = note === '' ? notePair() : notePair(note)
    const run = new Function(
      'treeNote',
      'setNote',
      'TARGET',
      `let current = null, firstTreeSettled = true
      const NEW_CONVERSATION_NOTE = 'a new conversation in '
      const NO_WORKSPACE_REFUSAL = 'Choose a workspace first.'
      function paintConversationTarget() {}
      function newConversationTarget() { return TARGET }
      ${lift('paintNewConversationPlace')}
      return paintNewConversationPlace`,
    )(element, setNote, target) as () => void
    run()
    return [element.textContent, element.hidden]
  }
  assert.deepEqual(paint('Choose a workspace first.', { label: 'alpha' }), ['a new conversation in alpha', false], 'the refusal gives way to the place')
  assert.deepEqual(paint('Choose a workspace first.', null), ['Choose a workspace first.', false], 'while there is still nowhere, it stays')
  assert.deepEqual(paint('a new conversation in beta', { label: 'alpha' }), ['a new conversation in alpha', false], 'the place follows the pick, as before')
  assert.deepEqual(paint('could not read the workspaces: offline', { label: 'alpha' }), ['could not read the workspaces: offline', false], 'any other note is left as it is')
})

test('the same refusal after a repeated press is said again: cleared, then written (N4)', () => {
  /**
   * developer-ten's N4 on bc78a4c1: with identical writes skipped, a second press that is refused the same way changed
   * nothing in the live region, so a screen reader said nothing and, with the hero hidden (an Ungrouped session open),
   * the press looked ignored. A person's action says its note through sayNote: the same text is cleared, then written
   * again a moment later; any other note written in between wins.
   */
  const timers: (() => void)[] = []
  const { element } = notePair()
  const make = new Function(
    'treeNote',
    'setTimeout',
    `let noteTicket = 0
    ${lift('setNote')}
    ${lift('sayNote')}
    return { setNote, sayNote }`,
  )
  const { setNote, sayNote } = make(element, (callback: () => void) => timers.push(callback)) as { setNote: (text: string) => void; sayNote: (text: string) => void }
  sayNote('Choose a workspace first.')
  assert.deepEqual([element.textContent, element.writes, timers.length], ['Choose a workspace first.', 1, 0], 'the first press writes it')
  sayNote('Choose a workspace first.')
  assert.deepEqual([element.textContent, element.writes], ['', 2], 'the second press clears it')
  timers.shift()?.()
  assert.deepEqual([element.textContent, element.hidden, element.writes], ['Choose a workspace first.', false, 3], 'and writes it again, so it is announced again')
  sayNote('Choose a workspace first.')
  setNote('a new conversation in alpha')
  timers.shift()?.()
  assert.equal(element.textContent, 'a new conversation in alpha', 'a note written meanwhile is not overwritten by the repeat')
})
