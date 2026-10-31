import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * Words a slash command hands on to the model take the composer's own path (developer-ten's review of the UI stack).
 *
 * `sendAsPrompt` used to choose for itself: `anyRunning() ? enqueue : sendNow`. That skipped the two rules an ordinary
 * submit applies on main: a new send resumes a queue that Stop paused (#75), and it waits behind messages that are
 * already queued. A command's prompt after a Stop was therefore sent ahead of the paused queue. Both now go through
 * `submitText`, run here as the page's own code.
 */
const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src/server/page.html'), 'utf8')

function source(name: string): string {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  const end = page.indexOf('\n}', start)
  return page.slice(start, end + 2)
}

interface Page {
  submit(text: string, gesture: string): void
  calls: string[]
  paused(): boolean
}

function harness(state: { running: boolean; pending: number; paused: boolean }): Page {
  return runInNewContext(
    `
    const BUSY_ENTER = 'queue';
    const calls = [];
    const queue = Array.from({ length: ${state.pending} }, (_, index) => ({ id: 'q' + index, status: 'pending' }));
    const stoppedQueues = new Set(${state.paused ? '[queue]' : '[]'});
    function queueOf() { return queue }
    function anyRunning() { return ${state.running} }
    async function deliverSteered(text) { calls.push('steer:' + text) }
    async function sendNow(text) { calls.push('send:' + text) }
    function enqueue(text, where) { calls.push('queue:' + text + ':' + where) }
    ${source('resolveSubmitMode')}
    ${source('submitText')}
    ({ submit: (text, gesture) => submitText(text, [], gesture), calls, paused: () => stoppedQueues.has(queue) })
    `,
  ) as Page
}

test("the page hands a command's words to the model through submitText, the ordinary submit's path", () => {
  assert.match(page, /sendAsPrompt: \(text, attachments = \[\]\) => submitText\(text, attachments, 'enter'\)/)
})

test('after a Stop, words handed on resume the paused queue and wait behind what is queued', () => {
  const after = harness({ running: false, pending: 2, paused: true })
  after.submit('from the command', 'enter')
  assert.equal(after.paused(), false, 'the paused queue resumes, as a typed send makes it')
  assert.deepEqual(Array.from(after.calls), ['queue:from the command:queue'], 'and the words go behind the two that wait, not ahead')
})

test('with nothing running and nothing queued, the words go as their own turn; while a turn runs they queue', () => {
  const idle = harness({ running: false, pending: 0, paused: false })
  idle.submit('hello', 'enter')
  assert.deepEqual(Array.from(idle.calls), ['send:hello'])
  const busy = harness({ running: true, pending: 0, paused: false })
  busy.submit('later', 'enter')
  assert.deepEqual(Array.from(busy.calls), ['queue:later:queue'])
})
