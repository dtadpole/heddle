import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

import { repoRoot } from '../_tools_/verify-runner/lib.mjs'

/**
 * The browser tab follows the open session, as DSH's `DocumentTitle` (`dsh-client-ui-layout`) does:
 * `document.title = title === undefined ? productTitle : `${title} — ${productTitle}``. The page's title was the
 * static `Heddle` whatever was open (DSH parity R-developer-seven-4, row S30). The painter is cut from `page.html` and
 * run against a stand-in document; the browser behaviour is judged by `_verifiers_/80-web-ui/check-document-title.mjs`.
 */

const page = readFileSync(join(repoRoot, 'src', 'server', 'page.html'), 'utf8')

function paint(current: string | null, sessions: unknown[]): string {
  const source = /function paintDocumentTitle\(\) \{[\s\S]*?\n\}/.exec(page)
  assert.ok(source, 'the page has a paintDocumentTitle function')
  const document = { title: 'unset' }
  runInNewContext(`const PRODUCT_TITLE = 'Heddle'\n${source[0]}\npaintDocumentTitle()`, { document, current, titledSessions: sessions })
  return document.title
}

test('an open session with a title names the tab, followed by the product', () => {
  assert.equal(paint('s1', [{ id: 's1', title: 'fix the parser' }, { id: 's2', title: 'other' }]), 'fix the parser — Heddle')
})

test('nothing open, an untitled session, or a blank title leaves the product name alone', () => {
  assert.equal(paint(null, [{ id: 's1', title: 'fix the parser' }]), 'Heddle')
  assert.equal(paint('s1', [{ id: 's1' }]), 'Heddle')
  assert.equal(paint('s1', [{ id: 's1', title: '   ' }]), 'Heddle')
  assert.equal(paint('s3', [{ id: 's1', title: 'fix the parser' }]), 'Heddle', 'a session not in the list')
})

test('the title is painted whenever the list or the open session changes', () => {
  assert.match(page, /if \(Array\.isArray\(sessions\)\) titledSessions = sessions\n\s+paintDocumentTitle\(\)/, 'after each list read, so a rename shows')
  assert.match(page, /current = id\n\s+paintEmptyState\(\)\n\s+paintDocumentTitle\(\)/, 'when a session opens')
  assert.match(page, /paintEmptyState\(\)\n\s+paintDocumentTitle\(\)\n\s+applySessionAccess\(null\)/, 'and when the open session vanishes')
})
