import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { boot, settle } from '../src/boot.ts'
import * as web from '../src/server/web.ts'

/**
 * Issue #257: the live TS server's event loop stood still for about 12 s, its supervisor killed it as hung, and the
 * server had written nothing: nobody could say what had run. A server now names any stall of 2 s or more on standard
 * error, in words, with the requests that were in flight (their method and path, never a query a person typed).
 *
 * The server and this test share one event loop, so the test stalls it itself, with a request held open.
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const home = mkdtempSync(join(tmpdir(), 'heddle-slow-loop-'))
let app: Awaited<ReturnType<typeof boot>> | undefined
let server: web.WebServer | undefined

before(async () => {
  mkdirSync(join(home, 'work'), { recursive: true })
  process.env.HOME = home
  process.env.HEDDLE_HOME = join(home, 'heddle')
  process.env.HEDDLE_CONFIG = join(home, 'heddle.json')
  writeFileSync(join(home, 'script.json'), JSON.stringify({ steps: [{ text: 'answered' }] }))
  writeFileSync(
    process.env.HEDDLE_CONFIG,
    JSON.stringify({ default: 'scripted', endpoints: [{ name: 'scripted', kind: 'scripted', baseUrl: join(home, 'script.json'), model: 'scripted' }] }),
  )
  app = await boot({
    base: join(repoRoot, 'cordis.yml'),
    includeProjectPatch: true,
    configDir: home,
    logLevel: 0,
    overrides: [{ patch: [{ id: 'session', config: { root: join(home, 'sessions') } }] }],
  })
  await settle(app.ctx)
  server = await web.startWebServer(app.ctx, { port: 0, quiet: true, token: 'slow-loop-token', secretPath: join(home, 'secret') })
})

after(async () => {
  await server?.close()
  await app?.dispose()
  rmSync(home, { recursive: true, force: true })
})

/** Hold the event loop for `ms`, as a synchronous route would. */
function stall(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // spin
  }
}

const settleTicks = (): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, 800))

test('a stall of 2 s or more is named on standard error, with the request in flight and without its query (#257)', async () => {
  assert.ok(server !== undefined)
  const cookie = String((await fetch(server.url, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]
  const lines: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    lines.push(String(chunk))
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write
  const { port } = new URL(server.url)
  /** A turn whose body has not finished arriving: its handler is waiting for the rest, so it is in flight. */
  const held = httpRequest({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: '/api/turn?private=a%20secret%20query',
    headers: { cookie, 'content-type': 'application/json', 'content-length': '1000' },
  })
  held.on('error', () => {})
  try {
    held.write('{"prompt":')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
    stall(2_500)
    await settleTicks()
    const named = lines.filter((line) => line.startsWith('heddle web: the event loop stood still'))
    assert.equal(named.length, 1, `one line named the stall\nsaw: ${JSON.stringify(lines)}`)
    assert.match(named[0]!, /^heddle web: the event loop stood still for 2\.\d s; in flight: POST \/api\/turn \(open 2\.\d s\)\n$/, 'in words, with the route')
    assert.ok(!named[0]!.includes('secret'), 'and never the query')

    held.destroy()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
    lines.length = 0
    stall(1_200)
    await settleTicks()
    assert.deepEqual(lines.filter((line) => line.includes('stood still')), [], 'a shorter stall says nothing')

    stall(2_500)
    await settleTicks()
    assert.deepEqual(
      lines.filter((line) => line.includes('stood still')).map((line) => line.replace(/\d+\.\d s/, 'N s')),
      ['heddle web: the event loop stood still for N s; no request was in flight\n'],
      'and a stall with nothing in flight says so',
    )
  } finally {
    process.stderr.write = original
    held.destroy()
  }
})

test('the line names at most three requests, newest first, and leaves out the page\'s event stream (#257)', () => {
  const slowLoopLine = (web as { slowLoopLine?: typeof web.slowLoopLine }).slowLoopLine
  assert.ok(slowLoopLine !== undefined, 'the server module says how it words the line')
  const now = 10_000
  const line = slowLoopLine(2_450, now, [
    { route: 'GET /api/events', since: 0 },
    { route: 'GET /api/sessions', since: now - 2_600 },
    { route: 'GET /api/sessions/search', since: now - 2_500 },
    { route: 'POST /api/turn', since: now - 9_000 },
    { route: 'GET /api/tree', since: now - 3_000 },
  ])
  assert.equal(line, 'heddle web: the event loop stood still for 2.5 s; in flight: GET /api/sessions/search (open 2.5 s), GET /api/sessions (open 2.6 s), GET /api/tree (open 3.0 s)')
  /** A request that held the loop ends before the watch runs: it is still named, with how long it took. */
  assert.equal(
    slowLoopLine(5_200, now, [{ route: 'POST /api/turn', since: now - 5_400, closed: now - 20 }]),
    'heddle web: the event loop stood still for 5.2 s; in flight: POST /api/turn (ended after 5.4 s)',
  )
})
