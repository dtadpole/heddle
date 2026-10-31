import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

/**
 * Pin and Archive on a session row say they failed when their request gets no answer (GitHub issue #137).
 *
 * Both row controls, their menu items and the archive notice's undo go through the page's `setSessionFlags`, whose
 * `fetch` was not caught: offline, a press changed nothing on screen and left an unhandled `Failed to fetch` in the
 * console. DSH routes every call through a client that resolves to ok or error and never rejects for a carrier
 * problem (dsh-api-gateway README.md:60, "Client service"), and its pin says "Pin failed. Try again later."
 * (dsh-client-ui-workspace lib/client.js:5085-5094, :4955). The function is loaded out of the page and run against a
 * `fetch` that rejects as a browser's does offline.
 */

const page = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')
const start = page.indexOf('async function setSessionFlags(')
const end = page.indexOf('\n}\n', start)
assert.ok(start !== -1 && end > start, 'page.html carries setSessionFlags')
const source = page.slice(start, end + 2)

interface Flags {
  (node: unknown, patch: Record<string, unknown>, extra?: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: unknown }>
}

function load(fetchImpl: (url: string, init: unknown) => Promise<unknown>) {
  const seen = { notes: [] as string[], redraws: 0, confirms: 0 }
  const flags = new Function(
    'fetch',
    'setNote',
    'definitionFolder',
    'captureRowBoxes',
    'renderTree',
    'refreshSessions',
    'glideRows',
    'window',
    `${source}\nreturn setSessionFlags`,
  )(
    fetchImpl,
    (text: string) => seen.notes.push(text),
    () => undefined,
    () => null,
    async () => {
      seen.redraws += 1
    },
    async () => undefined,
    () => undefined,
    {
      confirm: () => {
        seen.confirms += 1
        return false
      },
    },
  ) as Flags
  return { flags, seen }
}

const node = { kind: 'session', session: { id: 'session-00000000-0000-0000-0000-000000000001' }, pinned: false, archived: false }
const offline = async () => {
  throw new TypeError('Failed to fetch')
}

test('a pin or an archive whose request gets no answer resolves as a failure and says so, never rejecting', async () => {
  for (const patch of [{ pinned: true }, { pinned: false }, { archived: true }, { archived: false }]) {
    const { flags, seen } = load(offline)
    let applied = false
    const result = await flags(node, patch, {}, { applied: () => (applied = true) })
    assert.equal(result.ok, false, `${JSON.stringify(patch)}: a failure, not a rejection`)
    assert.equal(result.status, 0, 'with no status, since nothing answered')
    assert.deepEqual(seen.notes, ['could not change that session: Failed to fetch'], `${JSON.stringify(patch)}: the tree's note says it failed, with the browser's reason`)
    assert.equal(seen.redraws, 0, 'the row is left as it was: no redraw from a change the server never confirmed')
    assert.equal(applied, false, 'and nothing that follows a taken change runs')
  }
})

test('a caller that says the failure itself gets the failure without a note', async () => {
  const { flags, seen } = load(offline)
  const result = await flags(node, { archived: true }, { stop: true }, { quiet: () => true })
  assert.equal(result.ok, false)
  assert.deepEqual(seen.notes, [], 'the stop-and-archive dialog says it in its own line')
})

test('an answered refusal still says the server\'s sentence, and a taken change still redraws', async () => {
  const refused = load(async () => ({ ok: false, status: 409, json: async () => ({ error: 'cannot pin an archived session' }) }))
  const answer = await refused.flags(node, { pinned: true })
  assert.equal(answer.ok, false)
  assert.equal(answer.status, 409)
  assert.deepEqual(refused.seen.notes, ['cannot pin an archived session'])

  const taken = load(async () => ({ ok: true, status: 200, json: async () => ({ pinned: true }) }))
  const done = await taken.flags(node, { pinned: true })
  assert.equal(done.ok, true)
  assert.deepEqual(taken.seen.notes, [''], 'the note is cleared')
  assert.equal(taken.seen.redraws, 1, 'and the tree is redrawn')
})
