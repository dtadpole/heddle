import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'

import { harnessEntry, isolatedHome, removeDir, runCli, writeJson } from '../../_tools_/verify-runner/lib.mjs'

/**
 * A request that cannot be sent says why, and never what its URL must not carry (#217).
 *
 * The Rust build said only reqwest's own words, "error sending request for url (...)", where the reason (a refused
 * connection, DNS, TLS, a proxy) sits in the error's source chain; TypeScript says Node's "connect ECONNREFUSED ...".
 * And the URL in reqwest's words was the full one, query and user info included, though a provider may take its key as
 * a query parameter and this sentence lands in the session log, the page and a compaction's failure reason. Now Rust says
 * the whole chain with the URL's query, fragment and user info removed. The runtimes' own words differ (Node's
 * "ECONNREFUSED", the OS's "Connection refused"), so each build is held to its own.
 */

/** A port that was free a moment ago, so the connection is refused on purpose rather than by hope. */
function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePromise(port))
    })
  })
}

test('a refused connection names the refusal and keeps the key, user and fragment out of the sentence', async () => {
  const home = isolatedHome('transport-cause')
  try {
    const port = await freePort()
    const config = writeJson(join(home, 'heddle.json'), {
      default: 'refused',
      endpoints: [{ name: 'refused', kind: 'openai-chat', baseUrl: `http://user:hunter2@127.0.0.1:${port}/v1?key=SECRET#frag`, model: 'm' }],
    })
    const env = { HOME: home, HEDDLE_HOME: join(home, '.heddle'), HEDDLE_CONFIG: config }
    const run = await runCli(['--endpoint', 'refused', '--max-rounds', '1', '--turn', 'hello'], { env, cwd: home })
    const said = `${run.stdout}\n${run.stderr}`
    assert.notEqual(run.code, 0, `the turn fails\n${said}`)
    const line = said.split('\n').find((candidate) => candidate.includes("the request to 'refused' could not be sent")) ?? ''
    assert.notEqual(line, '', `the failure says the request could not be sent\n${said}`)
    const rust = !harnessEntry().endsWith('cli.js')
    assert.match(line, rust ? /Connection refused/ : /ECONNREFUSED/, `the sentence names the refusal\n${line}`)
    for (const secret of ['SECRET', 'key=', 'hunter2', 'user:', '#frag']) assert.ok(!said.includes(secret), `${secret} is not said\n${said}`)
  } finally {
    removeDir(home)
  }
})
