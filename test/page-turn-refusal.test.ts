import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

/**
 * A send the server refuses, run out of the page: `runTurn` with `sendTurn` answering a refusal.
 *
 * Issue #195 (developer-six, J175): a turn into a session the Rust server did not hold showed the server's raw body in
 * the conversation, `the message could not be sent: {"error":"no session session-…","code":"session/not-found"}`. The
 * page now says the server's sentence, its `error`, as it says every other refusal; a body that is not a JSON refusal is
 * still shown as it came, since that text is the only diagnosis there is.
 */

const page = readFileSync(process.env.HEDDLE_TEST_PAGE ?? join(import.meta.dirname, '..', 'src', 'server', 'page.html'), 'utf8')

function source(name: string): string {
  const start = page.search(new RegExp(`(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `the page defines ${name}`)
  return page.slice(start, page.indexOf('\n}\n', start) + 2)
}

/** The error `runTurn` throws when the server answers `status` with `body`, which `sendNow` puts after "the message could not be sent: ". */
async function refusal(status: number, body: string): Promise<string> {
  const run = runInNewContext(
    `
    const QUEUE_KEY_NONE = '__none__'
    const NO_WORKSPACE_REFUSAL = 'Choose a workspace first.'
    let activeFolder = '/work'
    let workspaceRoutes = 'served'
    let liveTurns = 0
    const firstTreeReady = Promise.resolve()
    const newConversationTarget = () => null
    const updateStatusBar = () => {}
    const selectionForTurn = () => ({})
    const events = { whenOpen: async () => {} }
    const sendTurn = async () => ({ ok: false, status: STATUS, text: async () => BODY })
    ${source('runTurn')}
    ;(() => runTurn('are you there?', 'session-00000000-0000-0000-0000-00000000000a'))
    `,
    { STATUS: status, BODY: body, JSON, Promise, TextEncoder, TextDecoder, performance, Error, Array, Object, String, Number, Set, Map },
  ) as () => Promise<void>
  try {
    await run()
  } catch (error) {
    return (error as Error).message
  }
  assert.fail('the refused send throws')
}

test("a refused send says the server's sentence, not its JSON body (#195)", async () => {
  const id = 'session-00000000-0000-0000-0000-00000000000a'
  assert.equal(await refusal(404, `{"error":"no session ${id}","code":"session/not-found"}\n`), `no session ${id}`)
})

test('a refusal that is not a JSON sentence is still shown as it came, and an empty one by its status', async () => {
  assert.equal(await refusal(502, 'Bad Gateway\n'), 'Bad Gateway')
  assert.equal(await refusal(400, '{"code":"x"}'), '{"code":"x"}', 'JSON without a sentence keeps its text, the only diagnosis there is')
  assert.equal(await refusal(503, ''), 'the server refused it (503)')
})
