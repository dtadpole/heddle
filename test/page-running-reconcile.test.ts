import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * The sessions read that ends a turn the page never saw end (#122), run as the page's own `refreshSessions` with a
 * sessions answer the test releases.
 *
 * - A read issued after a turn's mark, which finds the session not running, ends that turn: the chat settles and the
 *   composer's queue is pumped (the reset path after a server restart).
 * - A read issued before the stream marked a turn running, and answered after, cannot end it (developer-ten's review):
 *   its silence predates the turn, and ending it would settle live rows and flip Stop back to Send mid-turn.
 */
const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src/server/page.html'), 'utf8')
const OPTIONAL = new Map([['markRunning', 'function markRunning(id) { runningSessions.add(id) }']])
function source(name: string): string {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  if (start < 0 && OPTIONAL.has(name)) return OPTIONAL.get(name) as string
  assert.ok(start >= 0, `the page defines ${name}`)
  const end = page.indexOf('\n}', start)
  return page.slice(start, end + 2)
}

interface Page {
  refresh(): Promise<void>
  mark(id: string): void
  answer(sessions: unknown[]): void
  running(id: string): boolean
  pumped: string[]
  settled: number
}

function harness(): Page {
  const waiting: ((sessions: unknown[]) => void)[] = []
  return runInNewContext(
    `
    let searchIndex = null;
    let current = 'X', composerKey = 'X';
    const runningSessions = new Set();
    const runningSince = new Map();
    let runningTick = 0;
    const runningMarkedAt = new Map();
    const pumped = [];
    const counts = { settled: 0 };
    function paintRunningMarks() {}
    function refreshRunningStatus() {}
    function renderComposerState() {}
    function settleChat() { counts.settled += 1 }
    async function renderSettledAnswers() {}
    async function pumpQueue(key) { pumped.push(key) }
    async function showSession() {}
    const fetch = () => new Promise((resolve) => queue((sessions) => resolve({ ok: true, json: async () => sessions })));
    ${source('markRunning')}
    ${source('refreshSessions')}
    ({
      refresh: refreshSessions,
      mark: markRunning,
      answer: (sessions) => release(sessions),
      running: (id) => runningSessions.has(id),
      pumped,
      get settled() { return counts.settled },
    })
  `,
    {
      queue: (resolve: (sessions: unknown[]) => void) => waiting.push(resolve),
      release: (sessions: unknown[]) => {
        const next = waiting.shift()
        assert.ok(next !== undefined, 'a sessions read is in flight')
        next(sessions)
      },
    },
  ) as Page
}

const quiet = [{ id: 'X', running: false }]

test('#122: a sessions read that finds a marked turn no longer running ends it: the chat settles and the queue is sent', { timeout: 5000 }, async () => {
  const at = harness()
  at.mark('X')
  const read = at.refresh()
  at.answer(quiet)
  await read
  assert.equal(at.running('X'), false, 'the running mark goes')
  assert.deepEqual(Array.from(at.pumped), ['X'], 'the composer’s queue is pumped')
  assert.equal(at.settled, 1, 'and the open chat settles')
})

test('#122: a sessions read issued before a turn was marked running cannot end that turn', { timeout: 5000 }, async () => {
  const at = harness()
  const read = at.refresh()
  at.mark('X')
  at.answer(quiet)
  await read
  assert.equal(at.running('X'), true, 'the turn that started after the read was issued stays running')
  assert.deepEqual(Array.from(at.pumped), [], 'nothing is pumped mid-turn')
  assert.equal(at.settled, 0, 'and no live row is settled')
})
