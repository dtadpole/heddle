import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { repoRoot } from '../_tools_/verify-runner/lib.mjs'

/**
 * R-developer-six-3: a session row's Rename, Fork, Pin and Archive show their failure instead of failing silently.
 *
 * Measured before the fix, on both builds (they serve this one page): with the server stopped under an open page,
 * Rename and Archive changed nothing on screen and left `Failed to fetch` as an unhandled rejection, because the
 * handlers awaited `fetch` unguarded and only handled an HTTP error answer. DSH resolves every call to ok or error and
 * shows the failure (Rename's dialog, the Pin toast). The browser check `_verifiers_/80-web-ui/check-row-errors.mjs`
 * judges the behaviour where it runs; this file runs the one helper the handlers now share, lifted out of the page, and
 * keeps the handlers on it.
 */

const page = readFileSync(join(repoRoot, 'src', 'server', 'page.html'), 'utf8')

/** The page's `sessionRequest`, compiled with a `fetch` and a `console` the test controls. */
function loadSessionRequest(fetchImpl: (...args: unknown[]) => Promise<unknown>, warnings: unknown[][]) {
  const source = /async function sessionRequest\([\s\S]*?\n}\n/.exec(page)?.[0]
  assert.ok(source, 'the page defines sessionRequest')
  const factory = new Function('fetch', 'console', `${source}\nreturn sessionRequest`)
  return factory(fetchImpl, { warn: (...args: unknown[]) => warnings.push(args) }) as (
    path: string,
    init: unknown,
    what: string,
  ) => Promise<{ ok: boolean; error?: string; body?: unknown }>
}

test('a request the server never answers resolves to a shown failure, not a rejection', async () => {
  const warnings: unknown[][] = []
  const sessionRequest = loadSessionRequest(async () => {
    throw new TypeError('Failed to fetch')
  }, warnings)
  const result = await sessionRequest('/api/sessions/x/title', { method: 'POST' }, 'rename that session')
  assert.deepEqual(result, { ok: false, error: 'could not rename that session: Failed to fetch' })
  assert.equal(warnings.length, 1, 'and the rejection is logged, as DSH logs a rejected archive')
})

test('an error answer keeps the server\'s reason, and a success hands back the body', async () => {
  const warnings: unknown[][] = []
  const refused = loadSessionRequest(async () => ({ ok: false, json: async () => ({ error: 'session is running' }) }), warnings)
  assert.deepEqual(await refused('/api/sessions/x/flags', {}, 'archive that session'), { ok: false, error: 'session is running' })
  const silent = loadSessionRequest(async () => ({ ok: false, json: async () => { throw new SyntaxError('not json') } }), warnings)
  assert.deepEqual(await silent('/api/sessions/x/flags', {}, 'archive that session'), { ok: false, error: 'could not archive that session' })
  const fine = loadSessionRequest(async () => ({ ok: true, json: async () => ({ id: 'x' }) }), warnings)
  assert.deepEqual(await fine('/api/sessions/x/flags', {}, 'pin that session'), { ok: true, body: { id: 'x' } })
  assert.equal(warnings.length, 0, 'an answer, even a refusal, is not a rejection')
})

test('Rename, Fork, Pin and Archive all go through it, and none awaits fetch unguarded', () => {
  const body = (name: string) => {
    const match = new RegExp(`async function ${name}\\([\\s\\S]*?\\n}\\n`).exec(page)
    assert.ok(match, `the page defines ${name}`)
    return match[0]
  }
  for (const name of ['forkSession', 'setSessionFlags']) {
    assert.match(body(name), /await sessionRequest\(/, `${name} uses sessionRequest`)
    assert.doesNotMatch(body(name), /await fetch\(/, `${name} no longer awaits fetch itself`)
  }
  /**
   * Rename is DSH's dialog (developer-eight, 9b9b8375), which already guards its request: a rejection is caught and shown
   * in the dialog, which stays open — DSH's own behaviour for a failed rename, so it keeps its fetch rather than the helper.
   */
  const confirm = body('confirmSessionRename')
  assert.match(confirm, /try \{\s*const response = await fetch\(/, 'the rename request is inside a try')
  assert.match(confirm, /\} catch \(error\) \{\s*refuse\('could not rename that session: '/, 'and a rejection is shown in the dialog')
  // The workspace row's "Rename conversation…" item is inline in the menu builder.
  const inline = /label: 'Rename conversation…'[\s\S]*?\n {6}}\)/.exec(page)?.[0] ?? ''
  assert.match(inline, /await sessionRequest\(/)
  assert.doesNotMatch(inline, /await fetch\(/)
  // Archive and Pin reach the route through setSessionFlags, and each failure names its change.
  for (const what of ['archive that session', 'unarchive that session', 'pin that session', 'unpin that session']) {
    assert.ok(body('setSessionFlags').includes(`'${what}'`), `a failed ${what.split(' ')[0]} says so`)
  }
})
