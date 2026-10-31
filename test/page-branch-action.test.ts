import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * The chat's Branch action when the fork does not happen, run out of the page: `branchAction` with the page's own
 * `WorkspaceTree` words and a stubbed `fetch`.
 *
 * developer-ten's review of stack-2: a refused Branch printed the server's text, which names the session by its raw id
 * (#79), and a request that never got an answer was an unhandled rejection. The row menu's fork already says DSH's words
 * (`WorkspaceTree.forkRefusal`: "This session has no completed turn" for `code: 'unavailable'`, else "Could not fork the
 * session. Try again.", DSH's notice at `dsh-client-ui-workspace` lib/client.js:4647).
 */

const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const begin = page.indexOf('/* workspace-tree:begin */')
const end = page.indexOf('/* workspace-tree:end */')

function source(name: string): string {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  return page.slice(start, page.indexOf('\n}\n', start) + 2)
}

/** Press Branch once with `answer` standing for the fork request, and answer the note it left and what it opened. */
async function branch(answer: () => Promise<unknown>): Promise<{ notes: string[]; opened: string[]; disabled: boolean; words: { unavailable: string; failed: string } }> {
  const api = runInNewContext(
    `
    ${page.slice(begin, end)}
    const document = {
      createElement: (tag) => ({ tagName: tag.toUpperCase(), dataset: {}, attributes: {}, append() {}, setAttribute(name, value) { this.attributes[name] = String(value) } }),
    }
    const branchIcon = () => ({})
    const current = 'session-00000000-0000-0000-0000-000000000001'
    const notes = []
    const opened = []
    const setNote = (text) => notes.push(text)
    const renderTree = async () => {}
    const showSession = async (id) => { opened.push(id); return true }
    const fetch = ANSWER
    ${source('branchAction')}
    ;({
      button: branchAction({ dataset: { forkSeq: '12' } }),
      notes: () => JSON.stringify(notes),
      opened: () => JSON.stringify(opened),
      words: { unavailable: WorkspaceTree.NO_COMPLETED_TURN, failed: WorkspaceTree.FORK_FAILED },
    })
    `,
    { ANSWER: answer, JSON, Number, String, Object, Array, Map, Set, Promise, Error },
  ) as { button: { onclick: () => Promise<void>; disabled: boolean }; notes(): string; opened(): string; words: { unavailable: string; failed: string } }
  await api.button.onclick()
  /** Read back as JSON, so the arrays are this realm's: deepEqual compares prototypes. */
  return { notes: JSON.parse(api.notes()), opened: JSON.parse(api.opened()), disabled: api.button.disabled, words: { ...api.words } }
}

const response = (status: number, body: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const rawId = 'session-00000000-0000-0000-0000-000000000001'

test("a refused Branch says DSH's words, never the server's text with the raw id (#79)", async () => {
  const unavailable = await branch(response(409, { error: `event 12 does not exist in session "${rawId}" (last seq: 9)`, code: 'unavailable' }))
  assert.deepEqual(unavailable.notes, [unavailable.words.unavailable], 'fork-unavailable is "This session has no completed turn"')
  const other = await branch(response(404, { error: `no session ${rawId}` }))
  assert.deepEqual(other.notes, [other.words.failed], 'any other refusal is DSH\'s fork failure')
  for (const result of [unavailable, other]) {
    assert.ok(!result.notes.join(' ').includes(rawId), 'no note carries the raw id')
    assert.deepEqual(result.opened, [], 'and nothing is opened')
    assert.equal(result.disabled, false, 'and the button is usable again')
  }
})

test('a Branch whose request fails says so and leaves no unhandled rejection', async () => {
  const failed = await branch(async () => Promise.reject(new TypeError('Failed to fetch')))
  assert.deepEqual(failed.notes, [failed.words.failed], 'the note is DSH\'s fork failure')
  assert.equal(failed.disabled, false, 'and the button is usable again')
})

test('a Branch that forks opens the child', async () => {
  const forked = await branch(response(200, { session: 'session-00000000-0000-0000-0000-000000000002' }))
  assert.deepEqual(forked.notes, [''], 'the note is cleared')
  assert.deepEqual(forked.opened, ['session-00000000-0000-0000-0000-000000000002'])
})
