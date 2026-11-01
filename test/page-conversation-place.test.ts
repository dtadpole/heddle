import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * Where the next message starts a conversation, named on screen while no session is open (#134), run out of the page.
 *
 * developer-ten's N4 on follow-up 1: choosing a workspace row (`chooseWorkspace`) or a row (`chooseSelected`) moves the
 * target `newConversationTarget` reads, but only a tree redraw repainted the hero chip and the note, so they could name
 * A while the next message went to B. N9: the note, which carries DSH's notice words, was no live region.
 */

const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')

function source(name: string): string {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  return page.slice(start, page.indexOf('\n}\n', start) + 2)
}

interface Place {
  choose(path: string | null): void
  select(path: string): void
  note(): string
  painted(): number
  set(state: { current?: string | null; settled?: boolean; note?: string }): void
  empty(): void
}

function harness(): Place {
  return runInNewContext(
    `
    let current = null
    let firstTreeSettled = true
    let chosenWorkspace = null
    let selectedPath = null
    let painted = 0
    // The note's English, as the page's t() says it (#80); the note is marked as the new-conversation note.
    const t = (key, vars = {}) => (key === 'tree.note.newConversation' ? 'a new conversation in ' + vars.place : key)
    const treeNote = { textContent: '', hidden: true, dataset: {} }
    function setNote(text) { delete treeNote.dataset.newConversation; treeNote.textContent = text ?? ''; treeNote.hidden = !text }
    function paintConversationTarget() { painted += 1 }
    function markSelection() {}
    const labels = { '/work/a': 'Alpha', '/work/b': 'Beta' }
    function newConversationTarget() {
      const path = chosenWorkspace?.path ?? (selectedPath !== null && selectedPath.startsWith('/work/') ? selectedPath : '/work/a')
      return { path, label: labels[path] ?? path }
    }
    ${source('setNewConversationNote')}
    ${source('paintNewConversationPlace')}
    ${source('chooseWorkspace')}
    ${source('chooseSelected')}
    ;({
      choose: (path) => chooseWorkspace(path),
      select: (path) => chooseSelected(path),
      note: () => treeNote.textContent,
      painted: () => painted,
      empty: () => { treeNote.textContent = '' },
      set(state) {
        if ('current' in state) current = state.current
        if ('settled' in state) firstTreeSettled = state.settled
        if ('note' in state) {
          const place = /^a new conversation in (.+)$/.exec(state.note ?? '')
          if (place !== null) setNewConversationNote(place[1])
          else setNote(state.note)
        }
      },
    })
    `,
    {},
  ) as Place
}

test('with no session open, choosing a workspace or a row repaints the chip and the note that name the place (N4)', () => {
  const place = harness()
  place.set({ note: 'a new conversation in Alpha' })
  place.choose('/work/b')
  assert.equal(place.note(), 'a new conversation in Beta', 'the note follows the chosen workspace')
  assert.equal(place.painted(), 1, 'and the chip and the composer are repainted')
  place.choose(null)
  assert.equal(place.note(), 'a new conversation in Alpha', 'and goes back when the choice is forgotten')
  place.select('/work/b')
  assert.equal(place.note(), 'a new conversation in Beta', 'a selected row moves it too')
  assert.equal(place.painted(), 3)
})

test('a note that says something else, an open session, or a tree not yet drawn is left as it is', () => {
  const place = harness()
  place.set({ note: 'No archived sessions yet' })
  place.choose('/work/b')
  assert.equal(place.note(), 'No archived sessions yet', 'another note is not replaced')
  assert.equal(place.painted(), 1, 'though the chip is repainted')
  const open = harness()
  open.set({ current: 'session-1', note: 'a new conversation in Alpha' })
  open.choose('/work/b')
  assert.equal(open.note(), 'a new conversation in Alpha', 'with a session open the page names its folder, as the tree drew it')
  assert.equal(open.painted(), 0)
  const early = harness()
  early.set({ settled: false, note: '' })
  early.select('/work/b')
  assert.equal(early.painted(), 0, 'before the boot drew the tree nothing is painted')
})

test('the note under the tree is a polite live region (N9)', () => {
  assert.match(page, /<p id="tree-note" class="meta" aria-live="polite" hidden><\/p>/)
})

test('a new-conversation note emptied since it was said is not said again, in any language (#80)', () => {
  // The note is known by the text it was said with, not by its English prefix, so an emptied note stays empty.
  const place = harness()
  place.set({ note: 'a new conversation in Alpha' })
  place.empty()
  place.choose('/work/b')
  assert.equal(place.note(), '', 'the emptied note is left empty')
})
