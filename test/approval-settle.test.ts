import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * The approval card's closing rules (DSH parity phase B item 5), read out of the page the browser runs, so the rule
 * tested is the rule served.
 */
const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const begin = page.indexOf('/* approval-settle:begin */')
const end = page.indexOf('/* approval-settle:end */')

interface Rules {
  closesOn: (pendingId: unknown, settled: unknown) => boolean
  staleAfterPoll: (pendingId: unknown, shownAt: number, askedAt: number, requests: unknown) => boolean
}

const rules = new Function(`${page.slice(begin, end)}\nreturn ApprovalSettle`)() as Rules

test('the page carries the rules between its markers', () => {
  assert.ok(begin > 0 && end > begin, 'both markers are in page.html')
})

test('a settled frame closes the card that shows its question, and only that one', () => {
  assert.equal(rules.closesOn('approval-1', { type: 'approval/settled', id: 'approval-1', outcome: 'rejected' }), true)
  assert.equal(rules.closesOn('approval-1', { id: 'approval-2' }), false, "another question's settlement")
  assert.equal(rules.closesOn(undefined, { id: 'approval-1' }), false, 'no card shown')
  assert.equal(rules.closesOn('', { id: '' }), false, 'an empty id names nothing')
  assert.equal(rules.closesOn('approval-1', null), false)
})

test('a pending list asked for after the card was shown closes it once the question is gone', () => {
  assert.equal(rules.staleAfterPoll('approval-1', 100, 200, [{ id: 'approval-2' }]), true, 'settled elsewhere')
  assert.equal(rules.staleAfterPoll('approval-1', 100, 200, []), true, 'nothing waits any more')
  assert.equal(rules.staleAfterPoll('approval-1', 100, 200, [{ id: 'approval-1' }]), false, 'still waiting')
})

test('a list asked for before the card was shown cannot close it: the push may have raced the read', () => {
  assert.equal(rules.staleAfterPoll('approval-1', 200, 100, []), false)
  assert.equal(rules.staleAfterPoll('approval-1', 200, 200, []), false, 'the same instant is not after')
})

test('with no card shown, or a malformed list, nothing is closed by mistake', () => {
  assert.equal(rules.staleAfterPoll(undefined, 0, 100, []), false)
  assert.equal(rules.staleAfterPoll('approval-1', 0, 100, 'not a list'), true, 'a malformed list holds no question')
  assert.equal(rules.staleAfterPoll('approval-1', 0, 100, [null, 7, { id: 'approval-1' }]), false)
})
