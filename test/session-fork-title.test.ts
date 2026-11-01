import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { forkTitle, SessionService } from '../src/session/service.ts'
import type { SessionHandle } from '../src/session/store.ts'

/**
 * A fork's title comes from its **source's** title alone (#67).
 *
 * DSH names a fork with `increasedForkTitle(sourceTitle)` (`dsh-api-session-controller` lib/client.js:3714-3720), applied
 * once the child exists as `manager.rename(childId, increasedForkTitle(sourceTitle))` (:3992, :4003-4004): a title ending
 * in `(n)` or the full-width `（n）` becomes `n+1`, any other title gains ` (1)`, and no other session is consulted. Measured
 * on both builds before the fix: heddle stepped past every title already in the store, so a second fork of `T` was `T (2)`
 * and the names depended on the order of earlier forks.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-session-fork-title-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

/** One completed turn, so the session has something to fork from. `named: false` writes the prompt without the title fallback. */
function turn(service: SessionService, handle: SessionHandle, prompt: string, options: { readonly named?: boolean } = {}): void {
  if (options.named === false) service.store.message(handle, { role: 'user', content: [{ type: 'text', text: prompt }] })
  else service.user(handle, prompt)
  service.store.assistantChunk(handle, { type: 'text-delta', text: `answer to ${prompt}` })
  service.store.assistantChunk(handle, { type: 'done', finishReason: 'stop' })
  service.store.append(handle, { type: 'assistant/completed', text: `answer to ${prompt}`, finishReason: 'stop', rounds: 1 })
  service.store.append(handle, { type: 'turn/completed' })
}

function forked(service: SessionService, id: string): { readonly id: string; readonly title: string | undefined; readonly definition: Record<string, unknown> } {
  const result = service.fork(id)
  assert.ok(result !== null && 'handle' in result, `${id} forks`)
  return {
    id: result.handle.id,
    title: service.list().find((meta) => meta.id === result.handle.id)?.title,
    definition: JSON.parse(readFileSync(result.definition.file, 'utf8')) as Record<string, unknown>,
  }
}

test("a fork is named from its source's title alone, so a second fork of T is T (1) again (#67)", () => {
  const service = new SessionService(new Context(), { root: join(scratch, 'root-titled') })
  const source = service.start({ cwd: scratch, title: 'T' })
  turn(service, source, 'a question worth forking')

  /** DSH's table in #67: fork T, fork T again, fork the first fork, then fork an archived fork. */
  const first = forked(service, source.id)
  assert.equal(first.title, 'T (1)', 'the first fork of T is T (1)')
  const second = forked(service, source.id)
  assert.equal(second.title, 'T (1)', 'and so is the second: no other session is consulted')
  const ofFirst = forked(service, first.id)
  assert.equal(ofFirst.title, 'T (2)', 'a fork of T (1) is T (2), though another session already holds T (1)')
  service.store.flags(ofFirst.id, { archived: true })
  const ofArchived = forked(service, ofFirst.id)
  assert.equal(ofArchived.title, 'T (3)', 'and a fork of the archived T (2) is T (3)')
  service.store.flags(second.id, { archived: true })
  assert.equal(forked(service, second.id).title, 'T (2)', 'an archived second fork, T (1), forks into T (2)')

  /** The definition, the record a reader of the repository reads, says the same name as the store. */
  for (const one of [first, second, ofFirst, ofArchived]) assert.equal(one.definition.title, one.title, `${one.id}'s definition names it as the store does`)
  const titles = service.list().map((meta) => meta.title)
  assert.equal(titles.filter((title) => title === 'T (1)').length, 2, `two sessions share T (1), as they do in DSH\nsaw: ${JSON.stringify(titles)}`)
})

test('a fork of an untitled session is left untitled, as DSH renames a fork only from a title', () => {
  const service = new SessionService(new Context(), { root: join(scratch, 'root-untitled') })
  const source = service.start({ cwd: scratch })
  turn(service, source, 'a question', { named: false })
  assert.equal(service.list().find((meta) => meta.id === source.id)?.title, undefined, 'the source has no title')

  /** DSH reads `list.byId[id]?.title`, which is absent until something names the session, and skips the rename then. */
  const child = forked(service, source.id)
  assert.equal(child.title, undefined, `the fork has no title either, rather than an invented one\nsaw: ${JSON.stringify(child.title)}`)
  assert.equal(child.definition.title, undefined, 'and its definition writes none')
})

test("forkTitle is DSH's increasedForkTitle, edge cases included", () => {
  /** Each pair is what DSH's two regexes and BigInt produce for that title. */
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['T', 'T (1)'],
    ['T (1)', 'T (2)'],
    ['全角标题（1）', '全角标题（2）'],
    ['Plan (2023)', 'Plan (2024)'],
    ['x(1)', 'x(2)'],
    ['(3)', '(4)'],
    ['a (1) (2)', 'a (1) (3)'],
    ['a (1) b', 'a (1) b (1)'],
    ['x (1)（2）', 'x (1)（3）'],
    ['x（1）(2)', 'x（1）(3)'],
    ['T (01)', 'T (2)'],
    ['T (x1)', 'T (x1) (1)'],
    ['T ()', 'T () (1)'],
    ['T (99999999999999999999)', 'T (100000000000000000000)'],
    ['T (12345678901234567891)', 'T (12345678901234567892)'],
  ]
  for (const [title, expected] of cases) assert.equal(forkTitle(title), expected, `${title} forks into ${expected}`)
  assert.equal(forkTitle(''), undefined, 'an empty title names nothing')
})
